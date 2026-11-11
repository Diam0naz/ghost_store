import { NextResponse } from "next/server";
import {
  emptyVerification,
  parseProposalAttestation,
  verifyProposalAttestation,
  type ProposalForVerification,
} from "@/lib/attestation-verify";
import type { AttestationVerification } from "@/lib/attestation";
import {
  SERVER_TREASURY_CONTRACT_ID,
  viewCallServer,
} from "@/lib/near-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_TTL_MS = 15_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 6_000;

type CacheEntry = { expiresAt: number; value: AttestationVerification };
const cache = new Map<number, CacheEntry>();

function expectedMeasurements(): string[] {
  return (process.env.EXPECTED_MEASUREMENTS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function issuedAtToleranceMs(): number {
  const raw = Number(process.env.ATTESTATION_CLOCK_TOLERANCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60 * 1000;
}

function json(value: AttestationVerification, httpStatus = 200) {
  return NextResponse.json(value, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}

function remember(value: AttestationVerification): AttestationVerification {
  const ttl =
    value.status === "verified" || value.status === "partial" || value.status === "mismatch"
      ? CACHE_TTL_MS
      : NEGATIVE_CACHE_TTL_MS;
  cache.set(value.proposalId, { expiresAt: Date.now() + ttl, value });
  return value;
}

async function fetchRecord(
  baseUrl: string,
  proposalId: number
): Promise<
  | { kind: "ok"; body: unknown }
  | { kind: "none" }
  | { kind: "error"; reason: string }
> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${proposalId}`;
  const headers: HeadersInit = { accept: "application/json" };
  const token = process.env.ATTESTATION_FETCH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: "none" };
    if (!response.ok) {
      return {
        kind: "error",
        reason: `The attestation service returned HTTP ${response.status}.`,
      };
    }
    return { kind: "ok", body: await response.json() };
  } catch {
    return {
      kind: "error",
      reason: "The attestation service could not be reached.",
    };
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ proposalId: string }> }
) {
  const { proposalId: rawId } = await params;
  const proposalId = Number(rawId);
  if (!Number.isInteger(proposalId) || proposalId < 0) {
    return NextResponse.json(
      { error: "proposalId must be a non-negative integer" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const cached = cache.get(proposalId);
  if (cached && cached.expiresAt > Date.now()) {
    return json(cached.value);
  }

  let proposal: ProposalForVerification | null;
  try {
    if (!SERVER_TREASURY_CONTRACT_ID) {
      throw new Error("TREASURY_CONTRACT_ID is not configured");
    }
    proposal = await viewCallServer<ProposalForVerification | null>(
      SERVER_TREASURY_CONTRACT_ID,
      "get_proposal",
      { id: proposalId }
    );
  } catch {
    return json(
      remember(
        emptyVerification(
          proposalId,
          "error",
          "The server could not read the proposal from the treasury RPC."
        )
      ),
      502
    );
  }

  if (!proposal) {
    return json(
      remember(
        emptyVerification(proposalId, "none", "The treasury has no proposal with this id.")
      ),
      404
    );
  }

  const baseUrl = process.env.ATTESTATION_BASE_URL;
  if (!baseUrl) {
    return json(
      remember(
        emptyVerification(
          proposalId,
          "none",
          "No attestation service is configured on the server (ATTESTATION_BASE_URL is unset)."
        )
      )
    );
  }

  const fetched = await fetchRecord(baseUrl, proposalId);
  if (fetched.kind === "none") {
    return json(
      remember(
        emptyVerification(
          proposalId,
          "none",
          "The attestation service has no record for this proposal."
        )
      )
    );
  }
  if (fetched.kind === "error") {
    return json(remember(emptyVerification(proposalId, "error", fetched.reason)), 502);
  }

  const record = parseProposalAttestation(fetched.body);
  if (!record) {
    return json(
      remember(
        emptyVerification(
          proposalId,
          "error",
          "The attestation service returned a malformed record."
        )
      ),
      502
    );
  }

  const result = verifyProposalAttestation(proposal, record, {
    expectedMeasurements: expectedMeasurements(),
    issuedAtToleranceMs: issuedAtToleranceMs(),
    // No report verifier is passed in production. The default reports
    // "not performed" until the provider's documented verifier is wired in.
  });
  return json(remember(result));
}
