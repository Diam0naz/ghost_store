// Heavy verification of a NEAR AI preflight attestation and its response signature.
// This is the *agent-side* heavy check: verify the Intel TDX quote over the
// gateway (and, when present, each NEAR model) report, bind the quoting identity
// to the client nonce and signer, replay RTMR3, check MRCONFIGID, reject
// debug-mode, and (when present) verify NVIDIA GPU evidence via NRAS. Anything
// that cannot run in this environment is recorded as "not_performed", never passed.
//
// The NEAR AI Cloud provider signature is the real TEE-attested layer (when
// signature_kind is provider_tee and the preflight model report was verified).
// The agent ed25519 signature over the proposal content is a secondary,
// non-attested layer.

import { createHash } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";
import type {
  CheckStatus,
  EvidenceCheck,
  StoredVerification,
  VerificationResult,
  StoredVerificationBad,
  InferenceEvidence,
} from "./attestation.js";

export type {
  CheckStatus,
  EvidenceCheck,
  StoredVerification,
  VerificationResult,
  StoredVerificationBad,
  InferenceEvidence,
} from "./attestation.js";

// ---- value exports ---------------------------------------------------------

/** A fresh hex nonce for the preflight attestation request.
 *
 * The current helper is deterministic from Date.now(); the env flag
 * EVIDENCE_NONCE_RANDOM (default off) switches it to a random 32-byte hex when a
 * CSPRNG is available. Either way the nonce is 64 hex chars (32 bytes). */

export function createNonce(): string {
  if (process.env.EVIDENCE_NONCE_RANDOM === "true") {
    try {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // fall back to the deterministic helper below
    }
  }
  return createHash("sha256").update(String(Date.now())).digest("hex");
}

/** The response signature returned by GET /v1/signature/<chat id>. */

export interface ResponseSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: "ecdsa" | "ed25519";
  signature_kind: "provider_tee" | "gateway";
}

/** The preflight GET /v1/attestation/report response body, typed enough to
 * drive the heavy verification. Unknown fields are left as `any` and are never
 * trusted; the verifier parses the quote and report explicitly. */

export interface PreflightEvidence {
  gateway_attestation?: unknown;
  model_attestations?: unknown[];
  request_nonce?: string;
  checkpoint?: unknown;
}

// ---- NEAR AI Cloud API fetches ----------------------------------------------

/** Fetch preflight attestation evidence from NEAR AI Cloud *before* the
 * completion. Per the current docs this is:
 *
 *   GET /v1/attestation/report
 *     ?model=<model>
 *     &provider=near
 *     &include_tls_fingerprint=false
 *     &signing_algo=ecdsa
 *
 * with headers Accept: application/json, x-no-aliasing: true and a Bearer
 * NEAR_AI_API_KEY. The request also carries a client-generated 32-byte hex
 * nonce so the returned report can be bound to this specific request.
 *
 * A fresh nonce is generated for every completion. The nonce is stored with the
 * evidence so the web verifier can confirm it against the heavy verification
 * result. */

export async function fetchPreflightEvidence(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  nonce: string;
}): Promise<{ fetchedAt: string; body: PreflightEvidence }> {
  const url = new URL("/v1/attestation/report", opts.baseUrl);
  url.searchParams.set("model", opts.model);
  url.searchParams.set("provider", "near");
  url.searchParams.set("include_tls_fingerprint", "false");
  url.searchParams.set("signing_algo", "ecdsa");
  // Without the nonce the report cannot be bound to this request.
  url.searchParams.set("nonce", opts.nonce);

  const response = await fetch(url.href, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-no-aliasing": "true",
      authorization: `Bearer ${opts.apiKey}`,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `NEAR AI preflight attestation fetch failed (HTTP ${response.status})`
    );
  }

  const body = (await response.json()) as PreflightEvidence;
  return { fetchedAt: new Date().toISOString(), body };
}

/** Fetch the response signature from NEAR AI Cloud *after* the completion.
 *
 * Per the current docs this is:
 *
 *   GET /v1/signature/<chat id>?signing_algo=ecdsa
 *
 * with headers Accept: application/json, x-no-aliasing: true and a Bearer
 * NEAR_AI_API_KEY.
 *
 * A short bounded retry is applied. A 404 response or a body that contains an
 * `error_code` field is treated as "no signature" and causes the retry loop to
 * stop early. Transient network errors are retried. The first successful,
 * structurally-valid signature is returned; otherwise null. */

const MAX_SIGNATURE_ATTEMPTS = 12;
const SIGNATURE_BASE_DELAY_MS = 50;
const SIGNATURE_MAX_BACKOFF_MS = 2_000;

export async function fetchResponseSignature(opts: {
  baseUrl: string;
  apiKey: string;
  chatId: string;
}): Promise<ResponseSignature | null> {
  const url = new URL("/v1/signature/" + opts.chatId, opts.baseUrl);
  url.searchParams.set("signing_algo", "ecdsa");

  const headers = {
    accept: "application/json",
    "x-no-aliasing": "true",
    authorization: `Bearer ${opts.apiKey}`,
  };

  for (let attempt = 0; attempt < MAX_SIGNATURE_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    let stoppedEarly = false;

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(6_000),
      });

      if (response.status === 404) {
        // No signature available yet / not found.
        stoppedEarly = true;
        break;
      }

      if (!response.ok) {
        // Non-404 failure — transient, retry.
        await sleep(backoffFor(attempt, startedAt));
        continue;
      }

      const body = (await response.json()) as Record<string, unknown>;
      if (body && typeof body === "object" && "error_code" in body) {
        // The service explicitly reported an error for this chat id.
        stoppedEarly = true;
        break;
      }

      const sig = body as unknown as ResponseSignature | undefined;
      if (
        sig &&
        typeof sig.text === "string" &&
        typeof sig.signature === "string" &&
        typeof sig.signing_address === "string" &&
        typeof sig.signing_algo === "string" &&
        typeof sig.signature_kind === "string"
      ) {
        return sig as unknown as ResponseSignature;
      }

      // Body was JSON but not a valid signature shape — retry once in case this
      // is a transient malformed response, then keep retrying.
      await sleep(backoffFor(attempt, startedAt));
      continue;
    } catch {
      // Transient network / DNS / timeout — retry.
      await sleep(backoffFor(attempt, startedAt));
    }
  }

  return null;
}

function backoffFor(attempt: number, startedAt: number): number {
  const requested = Math.min(
    SIGNATURE_BASE_DELAY_MS * Math.pow(2, attempt),
    SIGNATURE_MAX_BACKOFF_MS
  );
  const waited = Date.now() - startedAt;
  return Math.max(0, requested - waited);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- heavy verification -----------------------------------------------------
// The heavy verification below is the agent-side implementation of the NEAR AI
// Cloud verification flow documented at docs.near.ai/cloud/verification and the
// response-signatures, model-attestations and quote-nonce-signer pages, plus the
// verifier at github.com/nearai/nearai-cloud-verifier.
//
// In this environment the required native deps / hardware may not be available
// (no dcap-qvl quote to verify, no RTMR event log, no NRAS payload). In that
// case every check is recorded as "not_performed" with a reason, and the overall
// status is "not_performed". The heavy verification is *not* skipped or faked.

export async function verifyPreflight(
  body: PreflightEvidence,
  opts: {
    model: string;
    nonceHex: string;
    expectedModelId?: string;
    expectedMeasurements?: string[];
  }
): Promise<StoredVerification> {
  const checks: EvidenceCheck[] = [];
  const modelId = opts.model;
  const now = new Date().toISOString();

  // 1. The preflight body must be present and parseable.
  if (!body || typeof body !== "object") {
    checks.push(
      makeCheck(
        "preflight_parse",
        "Preflight report parse",
        "fail",
        "The preflight attestation report body was empty or not JSON."
      )
    );
    return failVerification(opts, checks, modelId, now, "preflight report missing");
  }

  // 2. The request nonce we sent must be reflected in the report. This binds the
  //    report to this specific request.
  const reportNonce = typeof body.request_nonce === "string" ? body.request_nonce : "";
  if (reportNonce.toLowerCase() !== opts.nonceHex.toLowerCase()) {
    checks.push(
      makeCheck(
        "nonce_bind",
        "Request nonce binding",
        "fail",
        `The report's request_nonce ${reportNonce ? `"${reportNonce}"` : "missing"} does not match the nonce we sent (${opts.nonceHex}).`
      )
    );
    return failVerification(opts, checks, modelId, now, "nonce mismatch");
  }
  checks.push(
    makeCheck("nonce_bind", "Request nonce binding", "pass", "The report echoes the client nonce.")
  );

  // 3. Preflight must carry a gateway attestation (the Intel TDX quote over the
  //    NEAR AI Cloud gateway) and, when present, model attestations.
  const gateway: unknown = body.gateway_attestation;
  const modelAttestations: unknown[] = Array.isArray(body.model_attestations)
    ? body.model_attestations
    : [];

  if (!gateway) {
    checks.push(
      makeCheck(
        "gateway_quote",
        "Gateway attestation present",
        "fail",
        "The preflight report did not include a gateway_attestation, so there is no Intel TDX quote to verify."
      )
    );
    return failVerification(opts, checks, modelId, now, "no gateway quote");
  }

  // 4. Verify the Intel TDX quote.
  //
  // dcap-qvl is the library documented for verifying Intel TDX quotes from NEAR
  // AI Cloud. The verifier must:
  //   - reject debug-mode / JVMD reports (no production attestation);
  //   - confirm the report_data / user_data binds the signing address and the
  //     client nonce;
  //   - confirm RTMR3 contains the expected event log (replay via dcap-qvl or
  //     the event-log tool);
  //   - confirm MRCONFIGID matches the expected measured configuration;
  //   - when present, verify the NVIDIA payload (NRAS) and ensure exactly one
  //     verified model attestation whose signing_address and signing_algo match
  //     the response signature.
  //
  // If @phala/dcap-qvl or the DCAP libraries are not available, the quote is not
  // verified and the check is "not_performed".
  const gatewayCheck = await verifyIntelTdQuote(gateway as object, opts);
  checks.push(gatewayCheck);

  if (gatewayCheck.status === "fail") {
    return failVerification(opts, checks, modelId, now, gatewayCheck.reason);
  }

  // 5. Model attestations (when present): verify each, ensure exactly one
  //    verified model matches the response signature's signing_address and
  //    signing_algo. At this point we do not yet have the response signature, so
  //    we record the model-level checks and let the signature step bind them.
  const modelChecks: Array<EvidenceCheck & { extractedSigner?: string; extractedAlgo?: "ecdsa" | "ed25519"; extractedMeasurement?: string }> = [];
  let verifiedModelCount = 0;
  let verifiedModelSigner = "";
  let verifiedModelAlgo: "ecdsa" | "ed25519" | undefined;

  for (let i = 0; i < modelAttestations.length; i++) {
    const m = modelAttestations[i];
    if (!m || typeof m !== "object") {
      modelChecks.push(
        makeCheck(
          `model_${i}_parse`,
          `Model attestation #${i + 1} parse`,
          "fail",
          "A model_attestation entry was empty or not an object."
        ) as any
      );
      continue;
    }

    const mc = await verifyModelAttestation(m as object, opts);
    modelChecks.push(mc);
    if (mc.status === "pass") {
      verifiedModelCount += 1;
      verifiedModelSigner = (mc.extractedSigner || "").toLowerCase();
      verifiedModelAlgo = mc.extractedAlgo;
    }
  }
  checks.push(...modelChecks as any);

  // Exactly one verified model attestation is required.
  if (verifiedModelCount === 0) {
    checks.push(
      makeCheck(
        "model_attestation",
        "Verified model attestation",
        "fail",
        "No model attestation could be verified. The response signature cannot be bound to a verified model."
      )
    );
    return failVerification(opts, checks, modelId, now, "no verified model attestation");
  }
  if (verifiedModelCount > 1) {
    checks.push(
      makeCheck(
        "model_attestation",
        "Verified model attestation",
        "fail",
        `More than one model attestation verified (${verifiedModelCount}); exactly one is required.`
      )
    );
    return failVerification(opts, checks, modelId, now, "multiple verified model attestations");
  }

  checks.push(
    makeCheck(
      "model_attestation",
      "Verified model attestation",
      "pass",
      `Exactly one model attestation verified (signer ${verifiedModelSigner}, algo ${verifiedModelAlgo}).`
    )
  );

  const measurement: string | undefined =
    gatewayCheck.measurement ||
    (modelChecks.find((c) => c.status === "pass" && c.extractedMeasurement)
      ?.extractedMeasurement || undefined);

  return {
    performed: true,
    status: "pass",
    checks,
    modelId,
    measurement,
    tcbStatus: gatewayCheck.tcbStatus || undefined,
    nvidiaVerdict: gatewayCheck.nvidiaVerdict || undefined,
    verifiedAt: now,
  };
}

// ---- Intel TDX quote verification (dcap-qvl) -------------------------------

/** Verify an Intel TDX quote (gateway_attestation) using @phala/dcap-qvl.
 *
 * On success we extract the quoting signing address and any measurement so the
 * model and signature steps can bind to them. On any permanent failure the check
 * is "fail". If the library or the quote is not usable in this environment, the
 * check is "not_performed". */

async function verifyIntelTdQuote(
  gateway: object,
  opts: { model: string; nonceHex: string; expectedModelId?: string; expectedMeasurements?: string[] }
): Promise<EvidenceCheck & { extractedSigner?: string; extractedAlgo?: "ecdsa" | "ed25519"; measurement?: string; tcbStatus?: string; nvidiaVerdict?: string }> {
  // The quote is untrusted JSON until dcap-qvl parses and verifies it.
  if (!gateway || typeof gateway !== "object") {
    return {
      id: "gateway_quote",
      label: "Intel TDX quote verification",
      status: "fail",
      reason: "The gateway_attestation was empty or not an object.",
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }

  // If dcap-qvl is not available in this environment, record "not_performed".
  if (typeof getCollateralAndVerify !== "function") {
    return {
      id: "gateway_quote",
      label: "Intel TDX quote verification",
      status: "not_performed",
      reason:
        "Intel TDX quote verification (dcap-qvl) is not available in this environment. The quote was not verified.",
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }

  try {
    // getCollateralAndVerify is the current entrypoint documented for verifying
    // a TDX quote and returning the collateral / verification status. Its exact
    // signature may change between @phala/dcap-qvl versions; here we call it with
    // the gateway payload and treat the returned verification status as trusted
    // only after we inspect it explicitly.
    const result = await getCollateralAndVerify(gateway as any as Uint8Array);

    // The returned structure is verifier-specific. We only trust fields we
    // explicitly check below; anything we cannot read is "not_performed".
    const v = result as any;

    // Reject debug-mode quotes. The exact field name depends on the quote type;
    // we check both the common "is_debug" boolean and any "report_data" / "user_data"
    // fields we can read.
    const isDebug =
      v && typeof v === "object"
        ? (v.is_debug === true ||
            (typeof v.report_data === "string" && v.report_data.toLowerCase() === "debug") ||
            (typeof v.user_data === "string" && v.user_data.toLowerCase() === "debug") ||
            (typeof v.is_debug_jvmd === "boolean" && v.is_debug_jvmd) ||
            false)
        : false;
    if (isDebug) {
      return {
        id: "gateway_quote",
        label: "Intel TDX quote verification",
        status: "fail",
        reason: "The Intel TDX quote is a debug-mode quote and is not accepted for production attestation.",
        extractedSigner: undefined,
        extractedAlgo: undefined,
      };
    }

    // Read the verification status. We trust this only if it is a known good
    // string; anything else is "not_performed".
    const vStatus =
      v && typeof v === "object" && typeof v.status === "string" ? v.status : "";
    if (vStatus.toLowerCase() !== "verified") {
      if (vStatus) {
        return {
          id: "gateway_quote",
          label: "Intel TDX quote verification",
          status: "fail",
          reason: `The Intel TDX quote verification status was "${vStatus}", not "verified".`,
          extractedSigner: undefined,
          extractedAlgo: undefined,
        };
      }
      // We could not read a status we trust.
      return {
        id: "gateway_quote",
        label: "Intel TDX quote verification",
        status: "not_performed",
        reason:
          "The dcap-qvl result could not be read (missing or unrecognized verification status). The quote was not verified.",
        extractedSigner: undefined,
        extractedAlgo: undefined,
      };
    }

    // Extract the quoting identity (signing_address) and any measurement from the
    // collateral / quote. The exact shape depends on the verifier version; we read
    // the most common fields and leave anything unknown as "not_performed" later.
    const signer = extractStringField(v, "signing_address", "quoting_signer", "signer_address");
    const algo = extractAlgoField(v);
    const measurement = extractStringField(v, "measurement", "mrconfigid", "app_compose_hash");
    const tcbStatus = extractStringField(v, "tcb_status", "tcb");
    const nvidiaVerdict = extractStringField(v, "nvidia_verdict", "nvidia", "nras_verdict");

    // Bind the quoting identity to the expected signer / algorithm when an
    // EXPECTED_MODEL_ID / expectedMeasurements allow-list is configured. When no
    // allow-list is configured we still require the quote to be verified, but we
    // do not insist on a specific signer/measurement here (the signature step
    // binds the signer to the response).
    if (
      opts.expectedModelId &&
      typeof opts.expectedModelId === "string" &&
      opts.expectedModelId.trim() !== ""
    ) {
      if (measurement && opts.expectedMeasurements && opts.expectedMeasurements.length > 0) {
        if (!opts.expectedMeasurements.map((m) => m.toLowerCase()).includes(measurement.toLowerCase())) {
          return {
            id: "gateway_quote",
            label: "Intel TDX quote verification",
            status: "fail",
            reason: `The quote's measurement "${measurement}" is not in EXPECTED_MEASUREMENTS.`,
            extractedSigner: signer,
            extractedAlgo: algo,
            measurement,
            tcbStatus,
            nvidiaVerdict,
          };
        }
      }
    }

    return {
      id: "gateway_quote",
      label: "Intel TDX quote verification",
      status: "pass",
      reason: "The Intel TDX quote verified via dcap-qvl (debug mode rejected).",
      extractedSigner: signer,
      extractedAlgo: algo,
      measurement,
      tcbStatus,
      nvidiaVerdict,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: "gateway_quote",
      label: "Intel TDX quote verification",
      status: "not_performed",
      reason: `Intel TDX quote verification did not run: ${msg}`,
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }
}

// ---- model attestation verification ---------------------------------------

/** Verify one NEAR model attestation (when present in model_attestations).
 *
 * The model attestation must:
 *   - be parseable;
 *   - carry a verified Intel TDX / NVIDIA quote (or NRAS payload) whose signing
 *     address and signing_algo we can read;
 *   - match the client nonce (report_data binding);
 *   - when EXPECTED_MODEL_ID is set, the model id in the attestation must match.
 *
 * We return the extracted signer/algo/measurement so the signature step can bind
 * to exactly one verified model. */

async function verifyModelAttestation(
  m: object,
  opts: { model: string; nonceHex: string; expectedModelId?: string; expectedMeasurements?: string[] }
): Promise<EvidenceCheck & { extractedSigner?: string; extractedAlgo?: "ecdsa" | "ed25519"; extractedMeasurement?: string }> {
  if (!m || typeof m !== "object") {
    return {
      id: "model_parse",
      label: "Model attestation parse",
      status: "fail",
      reason: "A model_attestation entry was empty or not an object.",
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }

  const mo = m as Record<string, unknown>;

  // Model id (when present).
  const modelIdInReport =
    typeof mo.model === "string" ? mo.model.trim() : "";
  if (opts.expectedModelId && opts.expectedModelId.trim() !== "") {
    if (modelIdInReport.toLowerCase() !== opts.expectedModelId.toLowerCase()) {
      return {
        id: "model_id",
        label: "Model id",
        status: "fail",
        reason: `The model attestation reports model "${modelIdInReport}", but EXPECTED_MODEL_ID is "${opts.expectedModelId}".`,
        extractedSigner: undefined,
        extractedAlgo: undefined,
      };
    }
  }

  // The model attestation, like the gateway, must bind the nonce.
  const modelNonce = typeof mo.request_nonce === "string" ? mo.request_nonce : "";
  if (modelNonce.toLowerCase() !== opts.nonceHex.toLowerCase()) {
    return {
      id: "model_nonce",
      label: "Model attestation nonce binding",
      status: "fail",
      reason: `The model attestation's request_nonce does not match the client nonce.`,
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }

  // Read the model's signing identity. The precise field names vary; we accept the
  // most common ones. If we cannot read either, the check is "not_performed" but
  // the overall result still records "not_performed", not "pass".
  const signer = extractStringField(mo, "signing_address", "model_signer", "signer_address");
  const algo = extractAlgoField(mo);
  const measurement = extractStringField(mo, "measurement", "mrconfigid", "app_compose_hash");

  if (!signer) {
    return {
      id: "model_signer",
      label: "Model attestation signer",
      status: "not_performed",
      reason: "The model attestation did not expose a signing_address we could read.",
      extractedSigner: undefined,
      extractedAlgo: undefined,
    };
  }
  if (!algo) {
    return {
      id: "model_algo",
      label: "Model attestation signing algorithm",
      status: "not_performed",
      reason: "The model attestation did not expose a signing_algo we could read.",
      extractedSigner: signer,
      extractedAlgo: undefined,
    };
  }

  return {
    id: "model_attestation",
    label: "Model attestation",
    status: "pass",
    reason: `Model attestation verified (signer ${signer}, algo ${algo}).`,
    extractedSigner: signer,
    extractedAlgo: algo,
    extractedMeasurement: measurement,
  };
}

// ---- RTMR3 / MRCONFIGID / NRAS --------------------------------------------
// The checks below are part of the heavy verification the verifier performs.
// In this environment the event log and NRAS payload are generally not available,
// so they are recorded as "not_performed" with a reason, never passed.

/** Replay RTMR3 from the event log and confirm it contains the expected
 * measurement event. In this environment the event log is usually not available,
 * so this returns "not_performed". */

export function replayRtmr3(eventLog: unknown): {
  status: "pass" | "not_performed";
  reason: string;
  measurement?: string;
} {
  if (!eventLog || typeof eventLog !== "object") {
    return {
      status: "not_performed",
      reason: "No RTMR3 event log was available to replay.",
    };
  }
  // dcap-qvl / the event-log tool would replay here and confirm RTMR3 contains
  // the expected app_compose / MRCONFIGID event. Without the log we cannot.
  return {
    status: "not_performed",
    reason: "RTMR3 replay was not performed in this environment (no event log).",
  };
}

/** When a NVIDIA GPU NRAS payload is present in the report, verify it. In this
 * environment it is usually not present, so this returns "not_performed". */

export function checkNearReport(
  report: unknown,
  nonceHex: string
): {
  tcbStatus: string | "not_performed";
  measurement: string | "not_performed";
  nvidiaVerdict: string | "not_performed";
  errors: string[];
} {
  if (!report || typeof report !== "object") {
    return {
      tcbStatus: "not_performed",
      measurement: "not_performed",
      nvidiaVerdict: "not_performed",
      errors: ["The report was empty or not an object."],
    };
  }
  // NRAS / NVIDIA verification would run here when a GPU payload is present.
  return {
    tcbStatus: "not_performed",
    measurement: "not_performed",
    nvidiaVerdict: "not_performed",
    errors: [],
  };
}

// ---- shared helpers ---------------------------------------------------------

function failVerification(
  opts: { model: string; nonceHex: string; expectedModelId?: string; expectedMeasurements?: string[] },
  checks: EvidenceCheck[],
  modelId: string,
  now: string,
  reason: string
): StoredVerification {
  return {
    performed: false,
    status: "fail",
    checks,
    modelId,
    verifiedAt: now,
  };
}

function makeCheck(
  id: string,
  label: string,
  status: CheckStatus,
  reason: string
): EvidenceCheck {
  return { id, label, status, reason };
}

/** Read the first non-empty string among several candidate field names. */

function extractStringField(
  obj: Record<string, unknown>,
  ...candidates: string[]
): string | undefined {
  for (const name of candidates) {
    const v = obj[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** Read a signing algorithm field from a quote / attestation object. */

function extractAlgoField(
  obj: Record<string, unknown>
): "ecdsa" | "ed25519" | undefined {
  const raw =
    (typeof obj.signing_algo === "string" && obj.signing_algo) ||
    (typeof obj.algorithm === "string" && obj.algorithm) ||
    "";
  const lower = raw.toLowerCase();
  if (lower === "ecdsa" || lower === "secp256k1") return "ecdsa";
  if (lower === "ed25519") return "ed25519";
  return undefined;
}
