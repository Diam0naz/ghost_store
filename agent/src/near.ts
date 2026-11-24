// Shared NEAR connection and env helpers for the agent scripts.
import { connect, keyStores, KeyPair, type Account } from "near-api-js";

/** A model NEAR AI Cloud runs inside its own TEE (owned_by "nearai"), so the merchant's books
 * never leave attested hardware. Models proxied to third parties (openai/*, anthropic/*, ...)
 * would send the books outside the TEE. */
export const DEFAULT_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

export function getEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

let cached: Account | null = null;

/** The proposer account. Its key should be a function-call key limited to
 * `propose` and `propose_attested` on the treasury. */
export async function nearAccount(): Promise<Account> {
  if (cached) return cached;
  const network = process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl =
    process.env.NEAR_RPC_URL ??
    (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");
  const accountId = getEnv("PROPOSER_ACCOUNT_ID");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(
    network,
    accountId,
    KeyPair.fromString(getEnv("PROPOSER_PRIVATE_KEY") as `ed25519:${string}`)
  );
  const near = await connect({ networkId: network, keyStore, nodeUrl });
  cached = await near.account(accountId);
  return cached;
}

/** Any account with a key from the environment (e.g. the keeper's vault key). */
export async function accountFor(accountId: string, privateKey: string): Promise<Account> {
  const network = process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl =
    process.env.NEAR_RPC_URL ??
    (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(network, accountId, KeyPair.fromString(privateKey as `ed25519:${string}`));
  const near = await connect({ networkId: network, keyStore, nodeUrl });
  return near.account(accountId);
}
