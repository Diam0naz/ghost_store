// Sweep settled checkout revenue from the merchant's NEAR Intents balance into the treasury.
//
// Checkout settles customers' payments into `intents.near` for the merchant (recipientType
// INTENTS), so the merchant needs no NEAR or storage deposit to get paid. This moves that
// balance into the treasury contract with `intents.near::ft_withdraw`, where the AI's proposals
// and the autonomy lane can spend it. The treasury accepts a plain transfer (empty msg) as a deposit.
//
//   npm run sweep                  # dry run: reads balances and prints what it would do
//   npm run sweep -- --execute     # signs ft_withdraw with the merchant's key (mainnet funds)
//
// Env: MERCHANT_ACCOUNT_ID (default diamonaz.near), SWEEP_TREASURY_ID (the mainnet treasury),
// SWEEP_VAULT_ID + SWEEP_VAULT_SHARE (cold vault and its percent, default 80; docs/COLD-VAULT.md),
// SWEEP_TOKEN (default native USDC on NEAR), SWEEP_KEEP (base units to leave behind, default 0),
// MERCHANT_PRIVATE_KEY (only for --execute; a key on the merchant account).
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import { connect, keyStores, KeyPair } from "near-api-js";

const RPC = process.env.SWEEP_RPC_URL ?? "https://rpc.mainnet.fastnear.com";
const INTENTS = "intents.near";
/** Native USDC on NEAR (Circle). */
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const EXECUTE = process.argv.includes("--execute");

async function view<T>(contract: string, method: string, args: object): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: { result: number[] }; error?: { cause?: { name?: string }; message?: string } };
  if (!body.result) throw new Error(`${contract}.${method}: ${body.error?.cause?.name ?? body.error?.message ?? "RPC error"}`);
  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

function fmt(raw: bigint, dec: number): string {
  const s = raw.toString().padStart(dec + 1, "0");
  return `${s.slice(0, -dec)}.${s.slice(-dec)}`.replace(/\.?0+$/, "");
}

async function main(): Promise<void> {
  const merchant = process.env.MERCHANT_ACCOUNT_ID ?? "diamonaz.near";
  const treasury = process.env.SWEEP_TREASURY_ID ?? "";
  const token = process.env.SWEEP_TOKEN ?? USDC;
  const keep = BigInt(process.env.SWEEP_KEEP ?? "0");

  const meta = await view<{ symbol: string; decimals: number }>(token, "ft_metadata", {});
  const balance = BigInt(await view<string>(INTENTS, "mt_balance_of", { account_id: merchant, token_id: `nep141:${token}` }));
  const amount = balance > keep ? balance - keep : 0n;
  console.log(`Merchant ${merchant} holds ${fmt(balance, meta.decimals)} ${meta.symbol} in ${INTENTS}.`);

  if (!treasury) {
    console.log("No SWEEP_TREASURY_ID set: there is no mainnet treasury to sweep into yet. Nothing to do.");
    return;
  }
  if (amount === 0n) {
    console.log(`Nothing to sweep (keeping ${fmt(keep, meta.decimals)}).`);
    return;
  }

  // Split: SWEEP_VAULT_SHARE percent goes to the cold vault, the rest to the operating treasury.
  const vault = process.env.SWEEP_VAULT_ID ?? "";
  const share = BigInt(process.env.SWEEP_VAULT_SHARE ?? (vault ? "80" : "0"));
  if (share < 0n || share > 100n) throw new Error("SWEEP_VAULT_SHARE must be 0-100");
  if (share > 0n && !vault) throw new Error("SWEEP_VAULT_SHARE is set but SWEEP_VAULT_ID is not");
  const toVault = (amount * share) / 100n;
  const toTreasury = amount - toVault;

  // Each receiver must be registered with the token or ft_withdraw's transfer fails and refunds.
  for (const r of [toTreasury > 0n && treasury, toVault > 0n && vault].filter(Boolean) as string[]) {
    const reg = await view<{ total: string } | null>(token, "storage_balance_of", { account_id: r });
    if (!reg) throw new Error(`${r} is not registered with ${token}: call storage_deposit for it first.`);
  }

  // The vault books deposits in ft_on_transfer, so its share goes as ft_transfer_call (a msg).
  const calls = [
    ...(toTreasury > 0n ? [{ to: treasury, args: { token, receiver_id: treasury, amount: toTreasury.toString() } }] : []),
    ...(toVault > 0n ? [{ to: vault, args: { token, receiver_id: vault, amount: toVault.toString(), msg: "deposit" } }] : []),
  ];
  for (const c of calls) {
    console.log(`Plan: ${INTENTS}.ft_withdraw(${JSON.stringify(c.args)}) with 1 yoctoNEAR, signed by ${merchant}.`);
  }
  console.log(
    `Moves ${fmt(toTreasury, meta.decimals)} ${meta.symbol} to ${treasury}` +
      (toVault > 0n ? ` and ${fmt(toVault, meta.decimals)} ${meta.symbol} (${share}%) to the cold vault ${vault}.` : ".")
  );
  if (!EXECUTE) {
    console.log("Dry run. Re-run with --execute to sign it.");
    return;
  }

  const key = process.env.MERCHANT_PRIVATE_KEY;
  if (!key) throw new Error("MERCHANT_PRIVATE_KEY is required for --execute");
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("mainnet", merchant, KeyPair.fromString(key as `ed25519:${string}`));
  const near = await connect({ networkId: "mainnet", keyStore, nodeUrl: RPC });
  const account = await near.account(merchant);
  for (const c of calls) {
    const out = await account.functionCall({
      contractId: INTENTS,
      methodName: "ft_withdraw",
      args: c.args,
      gas: 100_000_000_000_000n,
      attachedDeposit: 1n,
    });
    console.log(`Swept to ${c.to}. Tx ${out.transaction.hash}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
