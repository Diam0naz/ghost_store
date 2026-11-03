// NEAR wallet utility — near-api-js v7 + @near-wallet-selector.
// WalletConnection was removed in near-api-js v4; we use wallet-selector instead.
// Contract calls use function-call access keys — no full access key exposure.

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { JsonRpcProvider } from "near-api-js";
import { actionCreators, type Action } from "@near-js/transactions";

export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet";
export const RPC_URL =
  process.env.NEXT_PUBLIC_NEAR_RPC_URL ??
  (NETWORK === "mainnet"
    ? "https://rpc.mainnet.near.org"
    : "https://rpc.testnet.near.org");

export const TREASURY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID ?? "";

// Singletons — only initialised in the browser
let _selector: WalletSelector | null = null;

async function getSelector(): Promise<WalletSelector> {
  if (_selector) return _selector;
  _selector = await setupWalletSelector({
    network: NETWORK as "mainnet" | "testnet",
    modules: [
      setupMyNearWallet({
        walletUrl:
          NETWORK === "mainnet"
            ? "https://wallet.near.org"
            : "https://testnet.mynearwallet.com",
      }),
      setupHereWallet(),
      setupMeteorWallet(),
      setupNightly(),
    ],
  });
  return _selector;
}

/** NEAR wallet modules registered with wallet-selector (for the connect UI).
 * `icon` is the wallet's own mark in /public/wallets; `gradient` + `monogram`
 * are the fallback tile used if the icon fails to load. */
export const WALLET_OPTIONS = [
  {
    id: "my-near-wallet",
    name: "MyNearWallet",
    description: "Web wallet · redirect sign-in",
    icon: "/wallets/mynear.jpg",
    gradient: "from-teal-400 to-teal-600",
    monogram: "MW",
  },
  {
    id: "here-wallet",
    name: "Here Wallet",
    description: "Mobile-first NEAR wallet",
    icon: "/wallets/here.jpg",
    gradient: "from-lime-400 to-emerald-500",
    monogram: "H",
  },
  {
    id: "meteor-wallet",
    name: "Meteor",
    description: "Browser & mobile wallet",
    icon: "/wallets/meteor.jpg",
    gradient: "from-orange-400 to-rose-500",
    monogram: "M",
  },
  {
    id: "nightly",
    name: "Nightly",
    description: "Browser extension",
    icon: "/wallets/nightly.png",
    gradient: "from-indigo-500 to-violet-600",
    monogram: "N",
  },
] as const;

/** Connect with a specific wallet module. Browser-only. */
export async function connectWallet(moduleId: string): Promise<void> {
  const selector = await getSelector();
  const wallet = await selector.wallet(moduleId);
  // All registered providers are redirect/extension wallets; the `accounts`
  // field only matters for hardware/bridge wallets and is a no-op here.
  await wallet.signIn({
    contractId: TREASURY_CONTRACT_ID,
    successUrl: window.location.href,
    failureUrl: window.location.href,
    accounts: [],
  });
}

/** Signs out from the currently active wallet. */
export async function signOut() {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  await wallet.signOut();
}

/** Returns the signed-in account ID, or null. */
export async function getAccountId(): Promise<string | null> {
  const selector = await getSelector();
  const state = selector.store.getState();
  return state.accounts[0]?.accountId ?? null;
}

/** Subscribes to account changes; returns an unsubscribe function. Browser-only. */
export async function subscribeAccountId(
  cb: (accountId: string | null) => void
): Promise<() => void> {
  const selector = await getSelector();
  const subscription = selector.store.observable.subscribe({
    next: (state) => cb(state.accounts[0]?.accountId ?? null),
  });
  return () => subscription.unsubscribe();
}

/** utf8-safe JSON → base64 without relying on Node's Buffer (browser-safe). */
function jsonToBase64(obj: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** JSON-RPC view call — no signing needed. */
export async function viewCall<T>(
  contractId: string,
  methodName: string,
  args: object = {}
): Promise<T> {
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const rawResult = await provider.query({
    request_type: "call_function",
    account_id: contractId,
    method_name: methodName,
    args_base64: jsonToBase64(args),
    finality: "optimistic",
  }) as unknown as { result: number[] };
  const bytes = new Uint8Array(rawResult.result);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Send one or more actions from the active wallet in a single transaction.
 * Used by checkout deposits (wrap + ft_transfer in one tx).
 * Returns the transaction hash.
 */
export async function sendActions(
  receiverId: string,
  actions: Action[]
): Promise<string> {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  const result = await wallet.signAndSendTransaction({
    receiverId,
    actions,
  });
  const tx = result as { transaction?: { hash?: string } };
  if (!tx.transaction?.hash) throw new Error("Transaction returned no hash");
  return tx.transaction.hash;
}

/**
 * Send a signed function call via the active wallet.
 * gas defaults to 30 Tgas for governance/reject, use "50000000000000" for approve-payout,
 * "150000000000000" for approve-allocate.
 */
export async function callContract(
  methodName: string,
  args: object,
  attachedDeposit = "0",
  gas = "30000000000000"
): Promise<unknown> {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: TREASURY_CONTRACT_ID,
    actions: [
      actionCreators.functionCall(
        methodName,
        args,
        BigInt(gas),
        BigInt(attachedDeposit)
      ),
    ],
  });
}
