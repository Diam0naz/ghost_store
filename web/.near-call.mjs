// TEMPORARY helper: send one signed testnet function call using ~/.near-credentials.
// Usage: node .near-call.mjs <signer> <contract> <method> <argsJson> [gas] [depositYocto]
import nearApi from "near-api-js";
const { Account, JsonRpcProvider, KeyPairSigner } = nearApi;
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const [, , signerId, contractId, methodName, argsJson, gasArg, depositArg] = process.argv;
if (!signerId || !contractId || !methodName) {
  console.error("usage: node .near-call.mjs <signer> <contract> <method> <argsJson> [gas] [depositYocto]");
  process.exit(2);
}

// Keychain layout varies: the JSON may sit next to the account directory or inside it.
const candidates = [
  `${homedir()}/.near-credentials/testnet/${signerId}.json`,
  `${homedir()}/.near-credentials/testnet/${signerId}/${signerId}.json`,
];
const credPath = candidates.find((p) => existsSync(p));
if (!credPath) {
  console.error(`no keychain credentials for ${signerId} in testnet`);
  process.exit(1);
}
const cred = JSON.parse(readFileSync(credPath, "utf8"));

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
const signer = KeyPairSigner.fromSecretKey(cred.private_key);
const account = new Account(signerId, provider, signer);

const result = await account.callFunctionRaw({
  contractId,
  methodName,
  args: JSON.parse(argsJson),
  gas: BigInt(gasArg ?? "30000000000000"),
  deposit: BigInt(depositArg ?? "0"),
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
