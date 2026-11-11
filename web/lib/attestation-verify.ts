// Server-only attestation verification.
// Do not import this module from a client component: it uses node:crypto and
// is intended for the API route and unit tests.

import {
  createHash,
  createPublicKey,
  verify as verifySignatureBytes,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  contentHashPayload,
  extractAttestationTag,
  rationaleTagPayload,
  type AttestationCheck,
  type AttestationStatus,
  type AttestationVerification,
  type CheckStatus,
  type ProposalAttestation,
} from "./attestation.ts";

/** Minimal shape needed from the treasury contract's Proposal. */
export interface ProposalForVerification {
  id: number;
  kind: unknown;
  rationale: string;
  created_at_ms: number;
}

export interface ReportVerification {
  status: CheckStatus;
  reason: string;
}

export interface VerifyOptions {
  /** Server-side allow-list. Empty means "not performed". */
  expectedMeasurements?: string[];
  /** Default: 10 minutes. */
  issuedAtToleranceMs?: number;
  /** Injection point for a provider's documented report verifier. The production
   * route does not pass this, so reports are reported as "not performed".
   * Tests use it to exercise the aggregation logic only.
   */
  verifyReport?: (record: ProposalAttestation) => ReportVerification;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** First 12 hex of SHA-256(canonical({ kind, rationaleBase })). */
export function computeRationaleTag(kind: unknown, rationaleBase: string): string {
  return sha256Hex(
    canonicalJson({ kind, rationaleBase: rationaleBase.trimEnd() })
  ).slice(0, 12);
}

/** SHA-256(canonical({ proposalId, kind, rationale })). */
export function computeContentHash(
  proposalId: number,
  kind: unknown,
  rationale: string
): string {
  return sha256Hex(
    canonicalJson(contentHashPayload(proposalId, kind, rationale))
  );
}

export function isHex(value: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

function check(
  id: AttestationCheck["id"],
  label: string,
  status: CheckStatus,
  reason: string
): AttestationCheck {
  return { id, label, status, reason };
}

function signatureValid(
  contentHash: string,
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    const key: KeyObject = createPublicKey(publicKeyPem);
    return verifySignatureBytes(
      null,
      Buffer.from(contentHash, "utf8"),
      key,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

/** Default report verifier. We do not claim a report is valid without the
 * provider's documented verifier. NEAR AI Cloud documents Intel TDX/NVIDIA
 * verification (dcap-qvl/NRAS) and attestation endpoints, but this build does
 * not include that verifier and the agent does not request a report yet.
 */
export function defaultReportVerifier(
  record: ProposalAttestation
): ReportVerification {
  if (record.attestationReport === null || record.attestationReport === undefined) {
    return {
      status: "not_performed",
      reason:
        "The record contains no attestation report. The agent has not requested provider evidence.",
    };
  }
  const provider = (record.provider || "").toLowerCase();
  if (provider.includes("near")) {
    return {
      status: "not_performed",
      reason:
        "NEAR AI Cloud reports need Intel TDX/NVIDIA verification (dcap-qvl/NRAS), which this build does not include.",
    };
  }
  return {
    status: "not_performed",
    reason: `No documented report verifier is configured for provider "${record.provider || "unknown"}".`,
  };
}

function normalizeRecord(raw: unknown): ProposalAttestation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate =
    "attestation" in raw && typeof (raw as { attestation?: unknown }).attestation === "object"
      ? (raw as { attestation: unknown }).attestation
      : "record" in raw && typeof (raw as { record?: unknown }).record === "object"
        ? (raw as { record: unknown }).record
        : raw;
  if (typeof candidate !== "object" || candidate === null) return null;
  const r = candidate as Record<string, unknown>;
  const proposalId =
    typeof r.proposalId === "number"
      ? r.proposalId
      : typeof r.proposalId === "string"
        ? Number(r.proposalId)
        : NaN;
  if (!Number.isInteger(proposalId) || proposalId < 0) return null;
  if (
    typeof r.contentHash !== "string" ||
    typeof r.signature !== "string" ||
    typeof r.provider !== "string" ||
    typeof r.measurement !== "string" ||
    typeof r.issuedAt !== "string"
  ) {
    return null;
  }
  return {
    proposalId,
    contentHash: r.contentHash,
    signature: r.signature,
    agentPublicKey: typeof r.agentPublicKey === "string" ? r.agentPublicKey : "",
    teePublicKey: typeof r.teePublicKey === "string" ? r.teePublicKey : "",
    attestationReport: r.attestationReport ?? null,
    provider: r.provider,
    measurement: r.measurement,
    issuedAt: r.issuedAt,
    algorithm: "ed25519",
    rationaleTag: typeof r.rationaleTag === "string" ? r.rationaleTag : undefined,
    inference: null,
  };
}

export { normalizeRecord as parseProposalAttestation };

function aggregateStatus(checks: AttestationCheck[]): AttestationStatus {
  if (checks.some((c) => c.status === "fail")) return "mismatch";
  if (checks.every((c) => c.status === "pass")) return "verified";
  return "partial";
}

const STATUS_MESSAGE: Record<AttestationStatus, string> = {
  verified: "The signed record matches this proposal and every required check passed.",
  partial:
    "The signed record matches this proposal, but some checks were not performed. This is not proof of TEE execution.",
  mismatch:
    "At least one attestation check failed. Do not treat this proposal as AI-attested.",
  none: "No attestation record was found for this proposal.",
  error: "The attestation service could not be reached or returned an invalid response.",
};

export function emptyVerification(
  proposalId: number,
  status: "none" | "error",
  reason: string
): AttestationVerification {
  return {
    status,
    proposalId,
    // Availability problems are not proof failures: the check was not
    // performed. The overall status ("none" / "error") carries the distinction.
    checks: [
      check(
        "record",
        "Attestation record",
        "not_performed",
        reason
      ),
    ],
    record: null,
    fetchedAt: new Date().toISOString(),
    message: STATUS_MESSAGE[status],
  };
}

/** Verify a record against the CURRENT on-chain proposal.
 * Any failed check makes the result `mismatch`. If nothing failed but at least
 * one check was not performed, the result is `partial` and can never be
 * `verified`.
 */
export function verifyProposalAttestation(
  proposal: ProposalForVerification,
  record: ProposalAttestation | null,
  options: VerifyOptions = {}
): AttestationVerification {
  if (!record) return emptyVerification(proposal.id, "none", "No record was provided.");

  const checks: AttestationCheck[] = [];

  // 1. The record must be for this proposal.
  if (record.proposalId !== proposal.id) {
    checks.push(
      check(
        "record",
        "Record identity",
        "fail",
        `The record is for proposal #${record.proposalId}, but this is proposal #${proposal.id}.`
      )
    );
  } else {
    checks.push(check("record", "Record identity", "pass", "Record is for this proposal."));
  }

  // 2. The on-chain rationale must carry a well-formed tag.
  const tagInfo = extractAttestationTag(proposal.rationale);
  if (!tagInfo) {
    checks.push(
      check(
        "tag",
        "On-chain tag",
        "fail",
        "The rationale has no [att:<12 hex>] suffix, so it does not commit to an attestation record."
      )
    );
  } else {
    const computedTag = computeRationaleTag(proposal.kind, tagInfo.rationaleBase);
    if (computedTag !== tagInfo.tag) {
      checks.push(
        check(
          "tag",
          "On-chain tag",
          "fail",
          `The tag commits to different content (expected ${computedTag}, found ${tagInfo.tag}).`
        )
      );
    } else if (record.rationaleTag && record.rationaleTag !== tagInfo.tag) {
      checks.push(
        check(
          "tag",
          "On-chain tag",
          "fail",
          `The record's tag ${record.rationaleTag} does not match the on-chain tag ${tagInfo.tag}.`
        )
      );
    } else if (!record.rationaleTag) {
      checks.push(
        check(
          "tag",
          "On-chain tag",
          "not_performed",
          "The record does not expose the tag separately; the tag is bound by contentHash but was not directly compared."
        )
      );
    } else {
      checks.push(
        check("tag", "On-chain tag", "pass", "The on-chain tag matches the record.")
      );
    }
  }

  // 3. contentHash must match the CURRENT on-chain kind + rationale.
  const expectedHash = computeContentHash(
    proposal.id,
    proposal.kind,
    proposal.rationale
  );
  const recordHash = record.contentHash.toLowerCase();
  if (!isHex(recordHash, 32)) {
    checks.push(
      check("content", "Content hash", "fail", "contentHash is not a 32-byte hex string.")
    );
  } else if (recordHash !== expectedHash) {
    checks.push(
      check(
        "content",
        "Content hash",
        "fail",
        `The on-line content has changed since signing (expected ${expectedHash}, record has ${recordHash}).`
      )
    );
  } else {
    checks.push(
      check("content", "Content hash", "pass", "The hash matches the current on-chain kind and rationale.")
    );
  }

  // 4. The signature must be valid over the record's contentHash.
  if (!record.signature) {
    checks.push(check("signature", "Signature", "fail", "The record has no signature."));
  } else if (signatureValid(record.contentHash, record.signature, record.agentPublicKey)) {
    checks.push(
      check("signature", "Signature", "pass", "ed25519 signature over contentHash is valid.")
    );
  } else {
    checks.push(
      check(
        "signature",
        "Signature",
        "fail",
        "The ed25519 signature does not verify with the record's agent public key."
      )
    );
  }

  // 5. Provider report: only a documented verifier may pass this check.
  const report = (options.verifyReport ?? defaultReportVerifier)(record);
  checks.push(check("report", "Attestation report", report.status, report.reason));

  // 6. Measurement allow-list.
  const expectedMeasurements = (options.expectedMeasurements ?? [])
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (expectedMeasurements.length === 0) {
    checks.push(
      check(
        "measurement",
        "Measurement",
        "not_performed",
        "EXPECTED_MEASUREMENTS is not configured on the server."
      )
    );
  } else if (!record.measurement) {
    checks.push(
      check("measurement", "Measurement", "fail", "The record has no measurement.")
    );
  } else if (expectedMeasurements.includes(record.measurement.toLowerCase())) {
    checks.push(
      check("measurement", "Measurement", "pass", "The measurement is in the server allow-list.")
    );
  } else {
    checks.push(
      check(
        "measurement",
        "Measurement",
        "fail",
        `The measurement ${record.measurement} is not in EXPECTED_MEASUREMENTS.`
      )
    );
  }

  // 7. issuedAt must not be after proposal creation plus a clock tolerance.
  const issuedAtMs = Date.parse(record.issuedAt);
  const toleranceMs = options.issuedAtToleranceMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(issuedAtMs)) {
    checks.push(
      check("issued_at", "Issued at", "fail", `issuedAt is not a valid timestamp: ${record.issuedAt}`)
    );
  } else if (issuedAtMs > proposal.created_at_ms + toleranceMs) {
    checks.push(
      check(
        "issued_at",
        "Issued at",
        "fail",
        `The record was issued ${Math.round(
          (issuedAtMs - proposal.created_at_ms) / 1000
        )}s after the proposal was created (tolerance ${Math.round(toleranceMs / 1000)}s).`
      )
    );
  } else {
    checks.push(
      check("issued_at", "Issued at", "pass", "The record was issued within the clock tolerance.")
    );
  }

  const status = aggregateStatus(checks);
  return {
    status,
    proposalId: proposal.id,
    checks,
    record,
    provider: record.provider,
    measurement: record.measurement,
    issuedAt: record.issuedAt,
    fetchedAt: new Date().toISOString(),
    message: STATUS_MESSAGE[status],
  };
}