// NEAR Intents 1Click API helpers.
// Flow: GET /v0/tokens → POST /v0/quote (dry:true = preview) →
//       POST /v0/quote (dry:false = deposit address) → deposit TX →
//       POST /v0/deposit/submit → GET /v0/status (poll to terminal)
//
// No testnet. All calls hit mainnet. Use dry:true during development.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE =
  process.env.NEXT_PUBLIC_INTENTS_BASE_URL ?? "https://1click.chaindefuser.com";

function authHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntentsToken {
  assetId: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  contractAddress?: string;
  price?: string;
}

export interface QuoteResult {
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut?: string;
  deadline?: string;
  timeEstimate?: number;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  quote: QuoteResult;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED"
  | "INCOMPLETE_DEPOSIT";

export const TERMINAL_STATUSES: SwapStatus[] = [
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "INCOMPLETE_DEPOSIT",
];

export interface StatusResponse {
  correlationId: string;
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: {
    amountIn?: string;
    amountInFormatted?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    originChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    refundedAmount?: string;
    refundReason?: string;
  };
}

export interface QuoteParams {
  originAsset: string;
  destinationAsset: string;
  amount: string; // smallest units
  recipient: string; // receives output
  refundTo: string; // refunded if swap fails — required by the API
  refundType?: string; // ORIGIN_CHAIN (default) | INTENTS | CONFIDENTIAL_INTENTS
  depositType?: string;
  recipientType?: string;
  slippageTolerance?: number; // bps, default 100 = 1%
}

// ---------------------------------------------------------------------------
// Raw fetch helpers (used by both hooks and direct calls)
// ---------------------------------------------------------------------------

export async function fetchTokens(apiKey?: string): Promise<IntentsToken[]> {
  const res = await fetch(`${BASE}/v0/tokens`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`GET /v0/tokens failed: ${res.status}`);
  return res.json() as Promise<IntentsToken[]>;
}

export async function fetchQuote(
  params: QuoteParams & { dry: boolean },
  apiKey?: string
): Promise<QuoteResponse> {
  const res = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      dry: params.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: params.slippageTolerance ?? 100,
      originAsset: params.originAsset,
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      recipient: params.recipient,
      refundTo: params.refundTo,
      // The API rejects quotes without these three — they are not optional in
      // practice even though only some of them are documented as required.
      refundType: params.refundType ?? "ORIGIN_CHAIN",
      depositType: params.depositType ?? "ORIGIN_CHAIN",
      recipientType: params.recipientType ?? "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      referral: "ghost-store",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(describeQuoteError(res.status, body));
  }
  return res.json() as Promise<QuoteResponse>;
}

/** Turn an API error body into something short enough to show a customer. */
function describeQuoteError(status: number, body: string): string {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    message = parsed.message ?? parsed.error ?? body;
  } catch {
    // body is not JSON — keep the raw text
  }
  return `quote ${status}: ${message}`;
}

/**
 * Plain-language version of an Intents failure. The API reports upstream
 * pricing outages as "Internal server error", which means nothing to a payer.
 */
export function friendlyIntentsError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const m = raw.toLowerCase();
  if (m.includes("internal server error")) {
    return "The swap service can't price this right now. Try again in a moment.";
  }
  if (m.includes("is not valid") || m.includes("should not be empty")) {
    return "The swap service rejected this payment request. Check the amount and try again.";
  }
  if (m.includes("invalid token") || m.includes("unauthorized")) {
    return "Payments are temporarily unavailable (service credentials). Please contact the merchant.";
  }
  if (m.includes("failed to fetch") || m.includes("networkerror")) {
    return "Couldn't reach the swap service. Check your connection and try again.";
  }
  if (m.includes("not installed") || m.includes("no provider")) {
    return "That wallet isn't installed in this browser.";
  }
  if (m.includes("reject") || m.includes("denied") || m.includes("cancel")) {
    return "The payment was cancelled in your wallet.";
  }
  return raw || "Something went wrong while paying. Please try again.";
}

export async function submitDepositTx(
  depositAddress: string,
  txHash: string,
  nearSenderAccount?: string,
  apiKey?: string
): Promise<void> {
  await fetch(`${BASE}/v0/deposit/submit`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      txHash,
      depositAddress,
      ...(nearSenderAccount ? { nearSenderAccount } : {}),
    }),
  });
}

/** Whether the configured API base actually answers (useful for setup errors). */
export const INTENTS_BASE_URL = BASE;

export async function fetchStatus(
  depositAddress: string,
  apiKey?: string
): Promise<StatusResponse> {
  const res = await fetch(
    `${BASE}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
  );
  if (!res.ok) throw new Error(`GET /v0/status failed: ${res.status}`);
  return res.json() as Promise<StatusResponse>;
}

// ---------------------------------------------------------------------------
// TanStack Query hooks
// ---------------------------------------------------------------------------

/** Fetch and cache supported tokens for 5 min. */
export function useIntentsTokens(apiKey?: string) {
  return useQuery<IntentsToken[]>({
    queryKey: ["intents-tokens"],
    queryFn: () => fetchTokens(apiKey),
    staleTime: 5 * 60 * 1000,
  });
}

/** Dry quote — preview only, refreshes every 10 s. Disabled when params are null. */
export function useDryQuote(params: QuoteParams | null, apiKey?: string) {
  return useQuery<QuoteResponse>({
    queryKey: ["intents-dry-quote", params],
    queryFn: () => fetchQuote({ ...params!, dry: true }, apiKey),
    enabled:
      !!params &&
      !!params.amount &&
      params.amount !== "0" &&
      !!params.recipient &&
      !!params.refundTo && // required by the API, so don't fire an invalid quote
      !!params.originAsset &&
      !!params.destinationAsset,
    refetchInterval: 10_000,
    retry: 1,
  });
}

/** Poll swap status; auto-stops at terminal states. */
export function useSwapStatus(depositAddress: string | null, apiKey?: string) {
  return useQuery<StatusResponse>({
    queryKey: ["intents-status", depositAddress],
    queryFn: () => fetchStatus(depositAddress!, apiKey),
    enabled: !!depositAddress,
    refetchInterval: (query) =>
      TERMINAL_STATUSES.includes(query.state.data?.status as SwapStatus)
        ? false
        : 2_000,
  });
}

/**
 * Mutation: get wet quote → caller sends deposit TX → submit hash.
 * Returns { depositAddress, txHash }.
 * `nearSender` (NEAR account) is only required when depositing from NEAR.
 */
export function useExecuteSwap(
  sendTx: (depositAddress: string, amountIn: string) => Promise<string>,
  apiKey?: string
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: QuoteParams & { nearSender?: string }) => {
      const wet = await fetchQuote({ ...params, dry: false }, apiKey);
      const { depositAddress, amountIn } = wet.quote;
      if (!depositAddress) throw new Error("No deposit address in wet quote");

      const txHash = await sendTx(depositAddress, amountIn);

      // Non-critical — fire and forget
      submitDepositTx(depositAddress, txHash, params.nearSender, apiKey).catch(
        () => {}
      );

      return { depositAddress, txHash };
    },
    onSuccess: ({ depositAddress }) => {
      // Kick off status polling immediately
      qc.invalidateQueries({ queryKey: ["intents-status", depositAddress] });
    },
  });
}
