// Minimal file-backed attestation record service.
//
// Run: npm run attestation:serve
// The agent PUTs records here; the web app's /api/attestation/[id] route
// fetches them from ATTESTATION_BASE_URL. This service stores public records
// (public key, signature, hashes) only. It is not a TEE and it does not verify
// hardware reports.
//
// This is a real record store, not a mock verifier: it never invents a
// "verified" status. The web verifier decides the status from the record.

import { config } from "dotenv";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

const outputDir = resolve(process.env.ATTESTATION_OUTPUT_DIR ?? "./attestations");
const port = Number(process.env.ATTESTATION_SERVICE_PORT ?? "8787");
const host = process.env.ATTESTATION_SERVICE_HOST ?? "127.0.0.1";
const token = process.env.ATTESTATION_SERVICE_TOKEN?.trim();

const MAX_BODY_BYTES = 10_000_000; // response evidence plus preflight can be large

function authorized(request: import("node:http").IncomingMessage): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function isRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.proposalId === "number" &&
    typeof r.contentHash === "string" &&
    typeof r.signature === "string" &&
    typeof r.agentPublicKey === "string" &&
    typeof r.provider === "string" &&
    typeof r.measurement === "string" &&
    typeof r.issuedAt === "string" &&
    typeof r.rationaleTag === "string"
  );
}

await mkdir(outputDir, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { ok: true, records: outputDir });
      return;
    }

    const match = url.pathname.match(/^\/(\d+)$/);
    if (!match) {
      send(response, 404, { error: "not found" });
      return;
    }
    const proposalId = Number(match[1]);
    const file = resolve(outputDir, `${proposalId}.json`);

    if (request.method === "GET") {
      try {
        const body = await readFile(file, "utf8");
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(body);
      } catch {
        send(response, 404, { error: "no record for this proposal" });
      }
      return;
    }

    if (request.method === "PUT") {
      if (!authorized(request)) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      const raw = await readBody(request);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(response, 400, { error: "invalid JSON" });
        return;
      }
      if (!isRecord(parsed) || (parsed as { proposalId: number }).proposalId !== proposalId) {
        send(response, 400, { error: "invalid attestation record" });
        return;
      }
      await writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      send(response, 201, { ok: true, proposalId });
      return;
    }

    send(response, 405, { error: "method not allowed" });
  } catch (error) {
    send(response, 500, {
      error: error instanceof Error ? error.message : "internal error",
    });
  }
});

server.listen(port, host, () => {
  console.log(
    `Attestation record service listening on http://${host}:${port} (records: ${outputDir})`
  );
  console.log(
    token
      ? "PUT requires the configured bearer token."
      : "PUT is unauthenticated; bind to localhost or set ATTESTATION_SERVICE_TOKEN."
  );
});
