"use client";
// Dashboard bindings: treasury balances (NEAR + stablecoin), live venue values
// and the derived aggregates shown on /dashboard (recipients, signer activity).
// Everything here reads public view calls — no wallet required.

import { useQuery } from "@tanstack/react-query";
import {
  TREASURY_CONTRACT_ID,
  viewAccountBalance,
  viewCall,
} from "@/lib/near";
import { type Proposal } from "@/lib/proposals";

/** Treasury account balance in yoctoNEAR. */
export function useTreasuryBalance() {
  return useQuery<string>({
    queryKey: ["treasury-balance"],
    queryFn: () => viewAccountBalance(TREASURY_CONTRACT_ID),
    enabled: !!TREASURY_CONTRACT_ID,
    refetchInterval: 30_000,
  });
}

/** Stablecoin balance held by the treasury (NEP-141 `ft_balance_of`). */
export function useStableBalance() {
  const token = process.env.NEXT_PUBLIC_STABLE_TOKEN;
  return useQuery<string>({
    queryKey: ["stable-balance", token],
    queryFn: () =>
      viewCall<string>(token as string, "ft_balance_of", {
        account_id: TREASURY_CONTRACT_ID,
      }),
    enabled: !!token && !!TREASURY_CONTRACT_ID,
    refetchInterval: 30_000,
  });
}

/** NEP-141 metadata (symbol, decimals) — cached for the session. */
export function useTokenMetadata(token: string | null | undefined) {
  return useQuery<{ symbol: string; decimals: number; name?: string }>({
    queryKey: ["ft-metadata", token],
    queryFn: () => viewCall(token as string, "ft_metadata", {}),
    enabled: !!token,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * Live balance per venue via the venue's own `balance_of(treasury)` view.
 * Real venues may not expose that method — failures resolve to null so the UI
 * falls back to the principal recorded by the treasury.
 */
export function useVenueBalances(venues: string[]) {
  const key = venues.join(",");
  return useQuery<Record<string, string | null>>({
    queryKey: ["venue-balances", key],
    queryFn: async () => {
      const out: Record<string, string | null> = {};
      await Promise.all(
        venues.map(async (venue) => {
          try {
            out[venue] = await viewCall<string>(venue, "balance_of", {
              account_id: TREASURY_CONTRACT_ID,
            });
          } catch {
            out[venue] = null;
          }
        })
      );
      return out;
    },
    enabled: venues.length > 0 && !!TREASURY_CONTRACT_ID,
    staleTime: 30_000,
  });
}

// ---- derived stats ----------------------------------------------------------

export interface TokenTotal {
  /** null = native NEAR. */
  token: string | null;
  /** Sum in raw units. */
  total: string;
  count: number;
}

export interface RecipientSummary {
  to: string;
  /** Executed payouts to this recipient. */
  payouts: number;
  byToken: TokenTotal[];
  lastMs: number;
}

/** Aggregate executed `Payout` proposals per recipient (merchants/beneficiaries). */
export function summarizeRecipients(proposals: Proposal[]): RecipientSummary[] {
  const map = new Map<string, RecipientSummary>();
  for (const p of proposals) {
    if (p.status !== "Executed" || !("Payout" in p.kind)) continue;
    const { to, token, amount } = p.kind.Payout;
    let entry = map.get(to);
    if (!entry) {
      entry = { to, payouts: 0, byToken: [], lastMs: 0 };
      map.set(to, entry);
    }
    entry.payouts += 1;
    entry.lastMs = Math.max(entry.lastMs, p.created_at_ms);
    const key = token ?? null;
    let bucket = entry.byToken.find((b) => b.token === key);
    if (!bucket) {
      bucket = { token: key, total: "0", count: 0 };
      entry.byToken.push(bucket);
    }
    bucket.total = (BigInt(bucket.total) + BigInt(amount)).toString();
    bucket.count += 1;
  }
  return [...map.values()].sort((a, b) => b.lastMs - a.lastMs);
}

export interface SignerActivity {
  account: string;
  /** Approvals cast across all proposals. */
  approvals: number;
  /** Approvals on proposals still pending. */
  pendingApprovals: number;
}

/** Per-signer approval participation, in the roster's order. */
export function signerActivity(
  proposals: Proposal[],
  signers: string[]
): SignerActivity[] {
  return signers.map((account) => ({
    account,
    approvals: proposals.filter((p) => p.approvals.includes(account)).length,
    pendingApprovals: proposals.filter(
      (p) => p.status === "Pending" && p.approvals.includes(account)
    ).length,
  }));
}
