// Attestation records for AI-drafted proposals, with per-draft NEAR AI inference
// evidence.
//
// HONESTY: this signs with an AGENT-HELD ed25519 key. It does NOT prove that
// the agent or the inference ran inside a TEE. The on-chain rationale now
// carries the 12-hex tag described below; the payload of that tag includes the
// NEAR AI chat id and the response hash, so the on-chain proposal commits to
// the inference evidence. The provider's signed response signature and the
// heavy verification the agent ran at draft time are stored with the record and
// checked by the web verifier.
//
// The provider signature is the real TEE-attested layer (when signature_kind is
// provider_tee and the preflight model report was verified). The agent signature
// is a secondary, non-attested layer labelled "agent signature (not attested)".

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_RATIONALE_LENGTH = 500;
export const ATTESTATION_TAG_SUFFIX_LENGTH = 19; // " [att:" + 12 hex + "]"

export type CheckStatus = "pass" | "fail" | "not_performed";

export interface EvidenceCheck {
  id: string;
  label: string;
  status: CheckStatus;
  reason: string;
}

export interface StoredVerification {
  /** Whether the agent attempted the heavy verification at draft time. */
  performed: boolean;
  /** Overall result: "pass" | "fail" | "partial" | "not_performed". */
  status: "pass" | "fail" | "partial" | "not_performed";
  checks: EvidenceCheck[];
  modelId: string;
  /** When the heavy verification completed (or was attempted). */
  verifiedAt: string;
  measurement?: string;
  tcbStatus?: string;
  nvidiaVerdict?: string;
}

export interface StoredVerificationBad {
  performed: boolean;
  status: "not_performed";
  checks: EvidenceCheck[];
}

export type StoredVerificationRecord = StoredVerification | StoredVerificationBad;
export type VerificationResult = StoredVerification;

/** Every field in InferenceEvidence must be JSON-serialisable. */

export interface InferenceEvidence {
  draftIndex: number;
  chatId: string;
  model: string;
  requestHash: string;
  requestBody?: string;
  responseHash: string;
  responseBody: string;
  signature: any;
  preflight: any;
  nonce: string;
  preflightFetchedAt: string;
  signatureFetchedAt: string | null;
  heavyVerification: any;
}

export interface AttestationRecord {
  proposalId: number;
  contentHash: string;
  signature: string;
  agentPublicKey: string;
  provider: string;
  measurement: string;
  issuedAt: string;
  rationaleTag: string;
  algorithm: "ed25519";
  inference: InferenceEvidence | null;
}

export interface SigningKey {
  privateKey: KeyObject;
  publicKeyPem: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value ${typeof value}`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function includeRequest(): boolean {
  return process.env.EVIDENCE_INCLUDE_REQUEST !== "false";
}

export function computeRationaleTag(
  kind: unknown,
  rationaleBase: string,
  chatId: string,
  responseHash: string
): string {
  return sha256Hex(
    canonicalJson({ kind, rationaleBase: rationaleBase.trimEnd(), chatId, responseHash })
  ).slice(0, 12);
}

export function computeContentHash(
  proposalId: number,
  kind: unknown,
  rationale: string
): string {
  return sha256Hex(canonicalJson({ proposalId, kind, rationale }));
}

export function appendAttestationTag(
  kind: unknown,
  rationaleBase: string,
  chatId: string,
  responseHash: string
): { rationale: string; tag: string } {
  const base = rationaleBase.trimEnd();
  const tag = computeRationaleTag(kind, base, chatId, responseHash);
  const rationale = `${base} [att:${tag}]`;
  const bytes = Buffer.byteLength(rationale, "utf8");
  if (bytes > MAX_RATIONALE_LENGTH) {
    throw new Error(
      `rationale is ${bytes} UTF-8 bytes with the attestation tag; the contract limit is ${MAX_RATIONALE_LENGTH}.`
    );
  }
  return { rationale, tag };
}

export function loadSigningKey(): SigningKey | null {
  const raw = process.env.ATTESTATION_SIGNING_KEY?.trim();
  if (!raw) return null;

  const privateKey =
    raw.includes("BEGIN")
      ? createPrivateKey({ key: raw, format: "pem" })
      : createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });

  const configuredPublicKey = process.env.ATTESTATION_PUBLIC_KEY?.trim();
  const publicKeyPem = configuredPublicKey
    ? configuredPublicKey
    : createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

  return { privateKey, publicKeyPem };
}

export interface BuildRecordArgs {
  proposalId: number;
  kind: unknown;
  rationale: string;
  rationaleTag: string;
  signingKey: SigningKey;
  provider?: string;
  measurement?: string;
  issuedAt?: Date;
  inference?: InferenceEvidence;
}

export function buildAttestationRecord(args: BuildRecordArgs): AttestationRecord {
  const contentHash = computeContentHash(args.proposalId, args.kind, args.rationale);
  const signature = sign(null, Buffer.from(contentHash, "utf8"), args.signingKey.privateKey).toString(
    "base64"
  );

  return {
    proposalId: args.proposalId,
    contentHash,
    signature,
    agentPublicKey: args.signingKey.publicKeyPem,
    provider: args.provider ?? process.env.ATTESTATION_PROVIDER ?? "local-agent",
    measurement: args.measurement ?? process.env.ATTESTATION_MEASUREMENT ?? "",
    issuedAt: (args.issuedAt ?? new Date()).toISOString(),
    rationaleTag: args.rationaleTag,
    algorithm: "ed25519",
    inference: args.inference ?? null,
  };
}

export async function publishAttestation(
  record: AttestationRecord
): Promise<{ path: string; published: boolean }> {
  const outputDir = resolve(process.env.ATTESTATION_OUTPUT_DIR ?? "./attestations");
  await mkdir(outputDir, { recursive: true });
  const path = resolve(outputDir, `${record.proposalId}.json`);
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");

  const baseUrl = process.env.ATTESTATION_PUBLISH_URL?.trim();
  if (!baseUrl) return { path, published: false };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const token = process.env.ATTESTATION_PUBLISH_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/${record.proposalId}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(8_000),
    }
  );
  if (!response.ok) {
    throw new Error(`attestation publish failed with HTTP ${response.status}`);
  }
  return { path, published: true };
}
