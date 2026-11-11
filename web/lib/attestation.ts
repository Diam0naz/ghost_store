// AI proposal attestations: shared, browser-safe types and canonical helpers.
//
// This module deliberately imports nothing from node:crypto. The browser needs
// the types, labels and canonical JSON helper for the proof drawer; signature
// and evidence verification live in ./attestation-verify.ts, which is only
// imported by the server route and by unit tests.
//
// What a record proves (and what it does not) is documented in
// docs/ATTESTATION.md. In short:
//
// - `inference.signature` is NEAR AI Cloud's signature over the exact request
//   and response bytes. It is checked against the signing address recovered
//   from the signature itself, and bound to preflight TEE evidence captured by
//   the agent.
// - `signature`/`agentPublicKey` is a secondary agent-held ed25519 signature
//   over the proposal content. It is labelled "agent signature (not attested)"
//   and never presented as TEE proof.
//
// Neither layer proves which serving instance handled the request, nor that the
// agent software itself was unmodified.

export type AttestationStatus =
  | "verified"
  | "partial"
  | "mismatch"
  | "none"
  | "error";

export type CheckStatus = "pass" | "fail" | "not_performed";

export type AttestationCheckId =
  | "record"
  | "evidence"
  | "tag"
  | "content"
  | "agent_signature"
  | "signature"
  | "signature_text"
  | "draft_kind"
  | "heavy_verification"
  | "measurement"
  | "timing"
  | "report"
  | "issued_at";

export interface AttestationCheck {
  id: AttestationCheckId;
  label: string;
  status: CheckStatus;
  reason: string;
}

export type SigningAlgo = "ecdsa" | "ed25519";
export type SignatureKind = "provider_tee" | "gateway";

/** The response signature returned by GET /v1/signature/<chat id>. */
export interface InferenceSignature {
  /** The exact text the provider signed. */
  text: string;
  /** Hex signature (EIP-191 secp256k1 for ecdsa, raw ed25519 for ed25519). */
  signature: string;
  /** Ethereum-style address for ecdsa, hex public key for ed25519. */
  signing_address: string;
  signing_algo: SigningAlgo;
  signature_kind: SignatureKind;
}

export interface EvidenceCheck {
  id: string;
  label: string;
  status: CheckStatus;
  reason: string;
}

/**
 * The heavy verification the agent ran at draft time with dcap-qvl and NRAS.
 * The web verifier checks that this result exists with its timestamp; it does
 * not re-run quote verification.
 */
export interface StoredVerification {
  performed: boolean;
  status: "pass" | "fail" | "partial" | "not_performed";
  checks: EvidenceCheck[];
  modelId: string;
  measurement?: string;
  tcbStatus?: string;
  nvidiaVerdict?: string;
  verifiedAt: string;
}

/**
 * Exact bytes exchanged with NEAR AI Cloud for one completion, plus the
 * preflight TEE evidence and response signature that bind them.
 *
 * One completion can back several proposals: the model returns an array of
 * drafts, so `draftIndex` selects the entry this record commits to.
 */
export interface InferenceEvidence {
  draftIndex: number;
  chatId: string;
  /** Canonical model id sent with the request. */
  model: string;
  /** SHA-256 hex of the exact request body bytes. */
  requestHash: string;
  /** Exact request body, present unless EVIDENCE_INCLUDE_REQUEST=false. */
  requestBody?: string;
  /** SHA-256 hex of the exact response body bytes. */
  responseHash: string;
  /** Exact response bytes, base64. */
  responseBody: string;
  /** Null when no signature was available after the bounded retry. */
  signature: InferenceSignature | null;
  /** The preflight GET /v1/attestation/report response body. */
  preflight: unknown;
  /** Client-generated 32-byte hex nonce used for the preflight request. */
  nonce: string;
  preflightFetchedAt: string;
  completionRequestedAt: string;
  completionCompletedAt: string;
  signatureFetchedAt: string | null;
  verification: StoredVerification | null;
}

/**
 * The off-chain record an AI proposer publishes for one proposal.
 *
 * `contentHash` is the lowercase SHA-256 hex of canonical JSON of
 * `{ proposalId, kind, rationale }`, where `rationale` is the full on-chain
 * rationale including its `[att:<tag>]` suffix.
 *
 * `signature` is base64 ed25519 over the UTF-8 bytes of `contentHash`, made
 * with an agent-held key. `agentPublicKey` is a PEM SPKI ed25519 public key.
 *
 * `rationaleTag` is the 12-hex tag embedded in the on-chain rationale:
 * the first 12 hex of SHA-256 of canonical JSON of
 * `{ kind, rationaleBase, chatId, responseHash }`. It commits the on-chain
 * proposal to the inference evidence. The proposal id is assigned by the
 * contract after submission, so the tag cannot include it.
 */
export interface ProposalAttestation {
  proposalId: number;
  contentHash: string;
  /** Agent-held ed25519 signature over contentHash (not TEE proof). */
  signature: string;
  /** PEM SPKI ed25519 public key of the agent key (not a TEE key). */
  agentPublicKey: string;
  /** Provider label. */
  provider: string;
  /** Measured app_compose hash from the verified report, when available. */
  measurement: string;
  /** ISO-8601 timestamp of the agent signature. */
  issuedAt: string;
  algorithm?: "ed25519";
  /** The 12-hex tag that should be present in the on-chain rationale. */
  rationaleTag?: string;
  /** NEAR AI Cloud inference evidence for this draft. */
  inference: InferenceEvidence | null;
  /** TEEClaim signing public key (optional, set by agent attestation flow). */
  teePublicKey?: string;
  /** Attestation report from the AI provider (optional). */
  attestationReport?: unknown;
}

export interface AttestationVerification {
  status: AttestationStatus;
  proposalId: number;
  checks: AttestationCheck[];
  record: ProposalAttestation | null;
  provider?: string;
  measurement?: string;
  issuedAt?: string;
  fetchedAt: string;
  message: string;
}

/** Default proposer account used by the agent and docs. */
export const DEFAULT_AI_PROPOSER = "ai-proposer.treasury-dev.testnet";

export function aiProposerId(): string {
  return process.env.NEXT_PUBLIC_AI_PROPOSER || DEFAULT_AI_PROPOSER;
}

export function isAiProposal(proposer: string): boolean {
  return proposer === aiProposerId();
}

/** Suffix the agent appends to the on-chain rationale. */
export const ATTESTATION_TAG_PREFIX = "[att:";
export const ATTESTATION_TAG_HEX_LENGTH = 12;

/** The public verification centre linked from the proof drawer. */
export const NEAR_AI_VERIFY_URL = "https://cloud.near.ai/verify";

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` object values
 * omitted. Both the agent and the verifier must use exactly this form.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
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
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value ${typeof value}`);
}

/**
 * Split `text [att:0123456789ab]` into its base text and tag.
 * Returns null when no well-formed tag is present.
 */
export function extractAttestationTag(
  rationale: string
): { rationaleBase: string; tag: string } | null {
  const match = rationale.match(/\s*\[att:([0-9a-f]{12})\]\s*$/);
  if (!match) return null;
  const index = rationale.lastIndexOf(ATTESTATION_TAG_PREFIX);
  if (index < 0) return null;
  return {
    rationaleBase: rationale.slice(0, index).trimEnd(),
    tag: match[1],
  };
}

/**
 * The canonical payload the on-chain tag commits to. `chatId` and
 * `responseHash` bind the proposal to the NEAR AI inference evidence.
 */
export function rationaleTagPayload(
  kind: unknown,
  rationaleBase: string,
  chatId: string,
  responseHash: string
) {
  return { kind, rationaleBase, chatId, responseHash };
}

/** The canonical payload the agent ed25519 key signs. */
export function contentHashPayload(
  proposalId: number,
  kind: unknown,
  rationale: string
) {
  return { proposalId, kind, rationale };
}

const STATUS_LABELS: Record<AttestationStatus, string> = {
  verified: "Verified private AI draft",
  partial: "Partially verified",
  mismatch: "Proof mismatch",
  none: "No AI proof",
  error: "Proof unavailable",
};

const STATUS_MESSAGES: Record<AttestationStatus, string> = {
  verified:
    "The response signature, exact request/response hashes, draft content and stored preflight evidence all passed.",
  partial:
    "The record matches this proposal, but at least one check was not performed. This is not a full verification.",
  mismatch:
    "At least one attestation check failed. Do not treat this proposal as AI-attested.",
  none: "No attestation record was found for this proposal.",
  error: "The attestation service could not be reached or returned an invalid response.",
};

export function attestationStatusLabel(status: AttestationStatus): string {
  return STATUS_LABELS[status];
}

export function attestationStatusMessage(status: AttestationStatus): string {
  return STATUS_MESSAGES[status];
}

/** Stable UTC display, avoiding server/client locale mismatches. */
export function formatUtc(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "unknown";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
