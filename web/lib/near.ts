// NEAR wallet utility — near-api-js v7 + @near-wallet-selector.
// WalletConnection was removed in near-api-js v4; we use wallet-selector instead.
// Contract calls use function-call access keys — no full access key exposure.

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { JsonRpcProvider } from "near-api-js";
import { actionCreators } from "@near-js/transactions";

const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet";
const RPC_URL =
  process.env.NEXT_PUBLIC_NEAR_RPC_URL ??
  (NETWORK === "mainnet"
    ? "https://rpc.mainnet.near.org"
    : "https://rpc.testnet.near.org");

export const TREASURY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID ?? "";

// Singletons — only initialised in the browser
let _selector: WalletSelector | null = null;
let _modal: WalletSelectorModal | null = null;

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
    ],
  });
  return _selector;
}

function getModal(selector: WalletSelector): WalletSelectorModal {
  if (!_modal) {
    _modal = setupModal(selector, { contractId: TREASURY_CONTRACT_ID });
  }
  return _modal;
}

/** Opens the wallet-selector sign-in modal. Browser-only. */
export async function signIn() {
  const selector = await getSelector();
  getModal(selector).show();
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
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    finality: "optimistic",
  }) as unknown as { result: number[] };
  return JSON.parse(Buffer.from(rawResult.result).toString()) as T;
}

/** Send a signed function call transaction via the active wallet. */
export async function callContract(
  methodName: string,
  args: object,
  attachedDeposit = "0"
): Promise<unknown> {
  const selector = await getSelector();
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: TREASURY_CONTRACT_ID,
    actions: [
      actionCreators.functionCall(
        methodName,
        args,
        BigInt("30000000000000"),
        BigInt(attachedDeposit)
      ),
    ],
  });
}
