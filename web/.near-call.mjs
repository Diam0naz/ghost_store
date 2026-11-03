// TEMPORARY helper: send one signed testnet function call using ~/.near-credentials.
// Usage: node .near-call.mjs <signer> <contract> <method> <argsJson> [gas] [depositYocto]
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const [, , signerId, contractId, methodName, argsJson, gasArg, depositArg] = process.argv;
if (!signerId || !contractId || !methodName) {
  console.error("usage: node .near-call.mjs <signer> <contract> <method> <argsJson> [gas] [depositYocto]");
  process.exit(2);
}

const cred = JSON.parse(
  readFileSync(`${homedir()}/.near-credentials/testnet/${signerId}/${signerId}.json`, "utf8")
);

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });
const signer = KeyPairSigner.fromSecretKey(cred.private_key);
const account = new Account(signerId, provider, signer);

const result = await account.functionCall({
  contractId,
  methodName,
  args: JSON.parse(argsJson),
  gas: BigInt(gasArg ?? "30000000000000"),
  attachedDeposit: BigInt(depositArg ?? "0"),
});

console.log(
  JSON.stringify(
    {
      txHash: result.transaction_outcome?.id,
      status: result.status,
      logs: result.receipts_outcome?.flatMap((r) => r.outcome.logs ?? []) ?? [],
    },
    null,
    2
  )
);
