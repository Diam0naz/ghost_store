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
  refundTo: string; // refunded if swap fails
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
      depositType: params.depositType ?? "ORIGIN_CHAIN",
      recipientType: params.recipientType ?? "DESTINATION_CHAIN",
      referral: "ghost-store",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /v0/quote failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<QuoteResponse>;
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
      !!params.originAsset &&
      !!params.destinationAsset,
    refetchInterval: 10_000,
    retry: 2,
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
 */
export function useExecuteSwap(
  sendTx: (depositAddress: string, amountIn: string) => Promise<string>,
  apiKey?: string
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: QuoteParams) => {
      const wet = await fetchQuote({ ...params, dry: false }, apiKey);
      const { depositAddress, amountIn } = wet.quote;
      if (!depositAddress) throw new Error("No deposit address in wet quote");

      const txHash = await sendTx(depositAddress, amountIn);

      // Non-critical — fire and forget
      submitDepositTx(depositAddress, txHash, params.refundTo, apiKey).catch(
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
