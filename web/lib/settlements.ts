// Incoming checkout settlements, read live from the NEAR Intents 1Click status API.
//
// 1Click has no "list my payments" endpoint, so the deposit addresses of settled checkouts are
// listed here (plus NEXT_PUBLIC_SETTLED_DEPOSITS, comma-separated). Each one is looked up live,
// so amounts, status and transaction hashes come from 1Click, not from this file.
// Next step: persist each checkout's deposit address server-side and read them from there.

import { useQueries } from "@tanstack/react-query";
import { fetchStatus, type StatusResponse } from "./intents";

/** Proven mainnet payment of 2026-11-12 (README, "Proven on mainnet"). */
const KNOWN_DEPOSITS = ["0x146a3d10a89163b2ee0006b1de2af49ea2d02609"];

export function settledDepositAddresses(): string[] {
  const extra = (process.env.NEXT_PUBLIC_SETTLED_DEPOSITS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...KNOWN_DEPOSITS, ...extra])];
}

export interface Settlement {
  depositAddress: string;
  status: StatusResponse["status"];
  /** Amount credited to the merchant, e.g. "1.199876". */
  amountOut: string | null;
  /** Amount the customer paid, e.g. "1.2". */
  amountIn: string | null;
  updatedAt: number;
  nearTx: string | null;
}

export function toSettlement(depositAddress: string, s: StatusResponse): Settlement {
  const d = s.swapDetails;
  return {
    depositAddress,
    status: s.status,
    amountOut: d?.amountOutFormatted ?? null,
    amountIn: d?.amountInFormatted ?? null,
    updatedAt: Date.parse(s.updatedAt) || 0,
    nearTx: d?.destinationChainTxHashes?.[0]?.hash ?? null,
  };
}

/** Live status of every known checkout deposit; finished ones are cached for 5 min. */
export function useSettlements() {
  const addresses = settledDepositAddresses();
  const results = useQueries({
    queries: addresses.map((a) => ({
      queryKey: ["intents-status", a],
      queryFn: () => fetchStatus(a),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });
  return {
    data: results.flatMap((r, i) => (r.data ? [toSettlement(addresses[i], r.data)] : [])),
    isPending: results.some((r) => r.isPending),
    failed: results.filter((r) => r.isError).length,
  };
}
