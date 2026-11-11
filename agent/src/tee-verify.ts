// Verify that a NEAR AI Cloud model signing key lives inside an Intel TDX confidential VM.
//
// What is checked:
//   1. The report echoes our fresh 32-byte nonce (no replayed report).
//   2. The model's Intel TDX quote verifies against Intel collateral (via @phala/dcap-qvl,
//      collateral from Phala's PCCS) and its TCB status.
//   3. The TD is not in debug mode (TDATTRIBUTES bit 0).
//   4. The quote's REPORTDATA is `signing_address (20 bytes) || 12 zero bytes || nonce`, so the
//      hardware report binds the exact key that signs completions, and this request.
//
// What is NOT checked here (reported as such):
//   - NVIDIA GPU attestation (nvidia_payload via NRAS).
//   - That the measured software (MRTD, RTMR0-3, the compose hash in the event log) matches a
//     published NEAR AI release. The measurements are returned so signers can compare them.
import { randomBytes } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";

export interface TeeCheck {
  label: string;
  ok: boolean | null; // null = not checked
  detail: string;
}

export interface TeeKeyVerification {
  model: string;
  signingAddress: string;
  ok: boolean;
  checks: TeeCheck[];
  measurements: Record<string, string>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export async function verifyModelKey(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<TeeKeyVerification> {
  const nonce = randomBytes(32).toString("hex");
  const url = new URL("attestation/report", opts.baseUrl.replace(/\/*$/, "/"));
  url.search = new URLSearchParams({ model: opts.model, signing_algo: "ecdsa", nonce }).toString();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`attestation report: HTTP ${res.status}`);
  const report = (await res.json()) as { model_attestations?: Array<Record<string, any>> };
  const att = report.model_attestations?.find((m) => typeof m.signing_address === "string");
  if (!att) throw new Error(`No model attestation with a signing_address for ${opts.model}`);

  const signingAddress = String(att.signing_address).toLowerCase();
  const checks: TeeCheck[] = [];

  checks.push({
    label: "Report bound to our nonce",
    ok: att.request_nonce === nonce,
    detail: att.request_nonce === nonce ? "request_nonce echoes the fresh nonce" : "request_nonce differs",
  });

  let measurements: Record<string, string> = {};
  try {
    const v: any = await getCollateralAndVerify(Buffer.from(String(att.intel_quote), "hex"));
    const d = v?.report?.data ?? {};
    const upToDate = v?.status === "UpToDate";
    checks.push({
      label: "Intel TDX quote verifies",
      ok: typeof v?.status === "string",
      detail: `TCB status ${v?.status}${v?.advisory_ids?.length ? `, advisories ${v.advisory_ids.join(",")}` : ""}${upToDate ? "" : " (not UpToDate)"}`,
    });

    const tdAttributes: Uint8Array = d.tdAttributes ?? new Uint8Array(8);
    const debug = (tdAttributes[0] & 1) === 1;
    checks.push({ label: "TD is not in debug mode", ok: !debug, detail: `TDATTRIBUTES ${hex(tdAttributes)}` });

    const rd = hex(d.reportData ?? new Uint8Array());
    const expected = signingAddress.slice(2) + "0".repeat(24) + nonce;
    checks.push({
      label: "Quote binds the signing key and nonce",
      ok: rd === expected,
      detail: rd === expected ? "REPORTDATA = signing_address || 0x00*12 || nonce" : `REPORTDATA ${rd}`,
    });

    measurements = Object.fromEntries(
      ["mrTd", "rtMr0", "rtMr1", "rtMr2", "rtMr3", "mrConfigId"]
        .filter((k) => d[k])
        .map((k) => [k, hex(d[k])])
    );
  } catch (err) {
    checks.push({
      label: "Intel TDX quote verifies",
      ok: false,
      detail: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  checks.push({
    label: "NVIDIA GPU attestation",
    ok: null,
    detail: "not checked by this tool",
  });
  checks.push({
    label: "Measurements match a published NEAR AI release",
    ok: null,
    detail: "not checked; compare the measurements below with NEAR AI's published values",
  });

  return {
    model: opts.model,
    signingAddress,
    ok: checks.every((c) => c.ok !== false),
    checks,
    measurements,
  };
}

export function printVerification(v: TeeKeyVerification): void {
  console.log(`Model ${v.model}`);
  console.log(`TEE signing address ${v.signingAddress}`);
  for (const c of v.checks) {
    const mark = c.ok === null ? "not checked" : c.ok ? "pass" : "FAIL";
    console.log(`  ${mark.padEnd(11)} ${c.label}: ${c.detail}`);
  }
  for (const [k, val] of Object.entries(v.measurements)) console.log(`  ${k.padEnd(10)} ${val}`);
}
