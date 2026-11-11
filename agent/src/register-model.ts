// Register a NEAR AI Cloud model's TEE signing key with the treasury.
//
// 1. Fetches the model's attestation report with a fresh nonce and verifies it (tee-verify.ts):
//    Intel TDX quote, debug bit, and that the quote binds the signing address and the nonce.
// 2. Prints what passed and what was not checked.
// 3. With --propose, submits a `SetModelSigner` governance proposal. The contract trusts the key
//    only after M-of-N signers approve it.
//
//   npm run register-model                 # verify and print
//   npm run register-model -- --propose    # also create the proposal
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });

import { DEFAULT_MODEL, getEnv, nearAccount } from "./near.js";
import { printVerification, verifyModelKey } from "./tee-verify.js";

async function main(): Promise<void> {
  const model = process.env.NEAR_AI_MODEL || DEFAULT_MODEL;
  const v = await verifyModelKey({
    baseUrl: getEnv("NEAR_AI_BASE_URL"),
    apiKey: getEnv("NEAR_AI_API_KEY"),
    model,
  });
  printVerification(v);

  if (!process.argv.includes("--propose")) {
    console.log("\nVerify-only run. Add `-- --propose` to create the SetModelSigner proposal.");
    return;
  }
  if (!v.ok) throw new Error("A check failed; refusing to propose this key.");

  const contractId = getEnv("TREASURY_CONTRACT_ID");
  const account = await nearAccount();
  const rationale =
    `Register TEE key ${v.signingAddress} for ${model}. TDX quote verified, key and nonce bound ` +
    `in REPORTDATA, not debug. MRTD ${v.measurements.mrTd?.slice(0, 16) ?? "?"}…. ` +
    `GPU attestation and release measurements not checked by the tool.`;
  const outcome = await account.functionCall({
    contractId,
    methodName: "propose",
    args: { kind: { SetModelSigner: { address: v.signingAddress, model } }, rationale: rationale.slice(0, 500) },
  });
  const status = outcome.status as { SuccessValue?: string };
  const id = status.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) : null;
  console.log(`\nProposed SetModelSigner as #${id}. Signers must approve it.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
