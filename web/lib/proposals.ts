"use client";
// Treasury contract bindings: types mirroring contracts/treasury/src/lib.rs,
// JSON formatting helpers, and query/mutation hooks shared by the treasury
// and flows pages. U128 fields serialize as strings in the contract's JSON.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TREASURY_CONTRACT_ID,
  viewCall,
  callContract,
} from "@/lib/near";

// ---- contract types --------------------------------------------------------

export type ProposalKind =
  | { Payout: { to: string; token: string | null; amount: string } }
  | { Allocate: { venue: string; token: string; amount: string } }
  | { Withdraw: { venue: string; amount: string } }
  | { SetVenueCap: { venue: string; cap: string } }
  | {
      SetPolicy: {
        stable_token: string;
        max_total_allocated: string;
        reserve_floor: string;
      };
    }
  | { SetPaused: { paused: boolean } }
  | { AddSigner: { account_id: string } }
  | { RemoveSigner: { account_id: string } }
  | { SetThreshold: { threshold: number } }
  | { SetProposer: { account_id: string } };

export type ProposalStatus =
  | "Pending"
  | "Executed"
  | "Failed"
  | "Rejected"
  | "Expired";

export interface Proposal {
  id: number;
  kind: ProposalKind;
  proposer: string;
  rationale: string;
  approvals: string[];
  status: ProposalStatus;
  created_at_ms: number;
}

export interface TreasuryConfig {
  /** Return shape of get_config(): (signers, threshold, proposer). */
  signers: string[];
  threshold: number;
  proposer: string;
}

// ---- formatting ------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Native NEAR uses 24 decimals; most FT stablecoins use 6. */
export function tokenDecimals(token: string | null): number {
  return token === null ? 24 : 6;
}

export function formatAmount(
  raw: string,
  decimals: number,
  places = 4
): string {
  const n = Number(BigInt(raw)) / 10 ** decimals;
  return n.toLocaleString("en-US", {
    maximumFractionDigits: places,
    minimumFractionDigits: 0,
  });
}

/** Human label for any proposal kind, e.g. "Payout 5.0000 NEAR → vendor.near". */
export function kindLabel(kind: ProposalKind): string {
  if ("Payout" in kind) {
    const { to, token, amount } = kind.Payout;
    const tokenStr = token ?? "NEAR";
    return `Payout ${formatAmount(amount, tokenDecimals(token))} ${tokenStr} → ${to}`;
  }
  if ("Allocate" in kind) {
    const { venue, token, amount } = kind.Allocate;
    return `Allocate ${formatAmount(amount, tokenDecimals(token))} ${token} → ${venue}`;
  }
  if ("Withdraw" in kind) {
    const { venue, amount } = kind.Withdraw;
    return `Withdraw ${formatAmount(amount, 6)} from ${venue}`;
  }
  if ("SetVenueCap" in kind) {
    const { venue, cap } = kind.SetVenueCap;
    return `Set venue cap ${formatAmount(cap, 6)} ${venue}`;
  }
  if ("SetPolicy" in kind) {
    const { stable_token, max_total_allocated, reserve_floor } = kind.SetPolicy;
    return `Set policy: ${stable_token}, cap ${formatAmount(max_total_allocated, 6)}, reserve floor ${formatAmount(reserve_floor, 6)}`;
  }
  if ("SetPaused" in kind) {
    return kind.SetPaused.paused ? "Pause allocations" : "Unpause allocations";
  }
  if ("AddSigner" in kind) {
    return `Add signer ${kind.AddSigner.account_id}`;
  }
  if ("RemoveSigner" in kind) {
    return `Remove signer ${kind.RemoveSigner.account_id}`;
  }
  if ("SetThreshold" in kind) {
    return `Set approval threshold to ${kind.SetThreshold.threshold}`;
  }
  if ("SetProposer" in kind) {
    return `Rotate AI proposer to ${kind.SetProposer.account_id}`;
  }
  return "Unknown proposal";
}

export function kindEmoji(kind: ProposalKind): string {
  if ("Payout" in kind) return "💸";
  if ("Allocate" in kind) return "📈";
  if ("Withdraw" in kind) return "📉";
  if ("SetVenueCap" in kind || "SetPolicy" in kind) return "⚙️";
  if ("SetPaused" in kind) return "🛑";
  if ("AddSigner" in kind || "RemoveSigner" in kind) return "👤";
  if ("SetThreshold" in kind) return "🔢";
  if ("SetProposer" in kind) return "🤖";
  return "❓";
}

export function expiresIn(created_at_ms: number): string {
  const remaining = created_at_ms + MS_PER_DAY * 7 - Date.now();
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / MS_PER_DAY);
  if (days > 0) return `${days}d left`;
  const hours = Math.floor(remaining / 3_600_000);
  return `${Math.max(hours, 1)}h left`;
}

// ---- queries & mutations ---------------------------------------------------

export function useTreasuryProposals() {
  return useQuery<Proposal[]>({
    queryKey: ["proposals"],
    queryFn: () =>
      viewCall<Proposal[]>(TREASURY_CONTRACT_ID, "list_proposals", {
        from: null,
        limit: null,
      }),
    enabled: !!TREASURY_CONTRACT_ID,
    refetchInterval: 10_000,
  });
}

export function useTreasuryConfig() {
  return useQuery<TreasuryConfig>({
    queryKey: ["treasury-config"],
    queryFn: async () => {
      const [signers, threshold, proposer] = await viewCall<
        [string[], number, string]
      >(TREASURY_CONTRACT_ID, "get_config", {});
      return { signers, threshold, proposer };
    },
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 60_000,
  });
}

/** Approve or reject. Approve attaches 150 Tgas (async kinds chain callbacks). */
export function useProposalAction(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: number;
      action: "approve" | "reject";
    }) =>
      callContract(
        action,
        { id },
        "0",
        action === "approve" ? "150000000000000" : "30000000000000"
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["treasury-config"] });
    },
    onError: (err) => onError?.(err instanceof Error ? err.message : String(err)),
  });
}
