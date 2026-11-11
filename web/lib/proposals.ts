"use client";
// Treasury contract bindings: types mirroring contracts/treasury/src/lib.rs,
// JSON formatting helpers, and query/mutation hooks shared by the treasury
// and flows pages. U128 fields serialize as strings in the contract's JSON.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { IconName } from "@/components/Icon";
import {
  TREASURY_CONTRACT_ID,
  viewCall,
  callContract,
  callContractOn,
  assertTestnetNetwork,
  assertTestnetAccountId,
} from "@/lib/near";

// ---- gas -------------------------------------------------------------------

/**
 * Approve attaches 150 Tgas. Allocations chain `ft_balance_of`,
 * `ft_transfer_call` and two callbacks; anything less runs out of gas at the
 * callback and the proposal stays Executed with the work half-done.
 */
export const APPROVE_GAS = "150000000000000"; // 150 Tgas

/** execute_auto chains ft_balance_of, ft_transfer and two callbacks: 100 Tgas. */
export const AUTO_EXECUTE_GAS = "100000000000000"; // 100 Tgas

/** Governance-only calls (propose / reject / expire / pause): 30 Tgas. */
export const GOVERNANCE_GAS = "30000000000000"; // 30 Tgas

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
  | { SetProposer: { account_id: string } }
  | { SetVendor: { account_id: string; enabled: boolean } }
  | { SetAutonomy: { policy: AutonomyPolicy | null } }
  | { SetModelSigner: { address: string; model: string } }
  | { PayInvoice: { invoice_id: number } }
  | { SetFactoringFee: { fee_bps: number; recipient: string | null } };

export type InvoiceStatus = "Open" | "Paid" | "Cancelled";

/** An invoice submitted to the treasury. Also an NFT: `holder` owns it and gets paid. */
export interface Invoice {
  id: number;
  issuer: string;
  holder: string;
  token: string;
  amount: string;
  due_ms: number;
  reference: string;
  document_hash: string | null;
  status: InvoiceStatus;
  created_at_ms: number;
  pending_proposal: number | null;
  paid_by_proposal: number | null;
  sale_price: string | null;
}

/** Limits on attested AI payouts that run without signer approval. */
export interface AutonomyPolicy {
  token: string;
  max_per_payout: string;
  daily_cap: string;
  veto_window_ms: number;
  /** Only PayInvoice proposals may use the autonomy lane, never raw payouts. */
  invoices_only?: boolean;
}

/** What the contract itself verified about an AI proposal (`propose_attested`). */
export interface AiAttestation {
  model: string;
  /** TEE signing address recovered on chain with ecrecover. */
  signer: string;
  request_hash: string;
  response_hash: string;
  created_s: number;
}

/** get_autonomy(): today's autonomy budget. */
export interface AutonomyStatus {
  policy: AutonomyPolicy | null;
  day: number;
  spent: string;
  committed: string;
  remaining: string;
}

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
  /** Present when the TEE signature was verified on chain. Absent on v1 proposals. */
  attestation?: AiAttestation | null;
  /** Autonomy lane: anyone may execute after this time unless one signer rejects. */
  auto_execute_after_ms?: number | null;
}

export interface TreasuryConfig {
  /** Return shape of get_config(): (signers, threshold, proposer). */
  signers: string[];
  threshold: number;
  proposer: string;
}

/** Mirror of the contract's `Policy` (get_policy returns `Option<Policy>`). */
export interface Policy {
  stable_token: string;
  max_total_allocated: string;
  reserve_floor: string;
}

/** Yield positions: venue → principal supplied, plus the running total. */
export interface TreasuryPositions {
  positions: [string, string][];
  totalAllocated: string;
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
  places = 4,
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
  if ("SetVendor" in kind) {
    const { account_id, enabled } = kind.SetVendor;
    return enabled
      ? `Allow autonomous payouts to ${account_id}`
      : `Remove ${account_id} from the autonomy allowlist`;
  }
  if ("SetAutonomy" in kind) {
    const a = kind.SetAutonomy.policy;
    return a
      ? `Autonomy: ≤ ${formatAmount(a.max_per_payout, 6)} per payout, ${formatAmount(a.daily_cap, 6)}/day, ${Math.round(a.veto_window_ms / 60_000)} min veto window`
      : "Turn off autonomous payouts";
  }
  if ("SetModelSigner" in kind) {
    const { address, model } = kind.SetModelSigner;
    return model
      ? `Trust TEE key ${address.slice(0, 10)}… for ${model}`
      : `Revoke TEE key ${address.slice(0, 10)}…`;
  }
  if ("PayInvoice" in kind) {
    return `Pay invoice #${kind.PayInvoice.invoice_id}`;
  }
  if ("SetFactoringFee" in kind) {
    const { fee_bps, recipient } = kind.SetFactoringFee;
    return fee_bps
      ? `Invoice sale fee ${(fee_bps / 100).toFixed(2)}% → ${recipient}`
      : "Remove the invoice sale fee";
  }
  return "Unknown proposal";
}

/** Line icon for a proposal kind (see components/Icon.tsx). */
export function kindIcon(kind: ProposalKind): IconName {
  if ("Payout" in kind) return "payout";
  if ("Allocate" in kind) return "allocate";
  if ("Withdraw" in kind) return "withdraw";
  if ("SetPaused" in kind) return "pause";
  if ("AddSigner" in kind || "RemoveSigner" in kind) return "user";
  if ("SetThreshold" in kind) return "hash";
  if ("SetProposer" in kind) return "bot";
  if ("SetVendor" in kind) return "tag";
  if ("SetAutonomy" in kind) return "clock";
  if ("SetModelSigner" in kind) return "key";
  if ("PayInvoice" in kind) return "receipt";
  if ("SetFactoringFee" in kind) return "coins";
  return "settings";
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
  if ("SetVendor" in kind) return "🏷️";
  if ("SetAutonomy" in kind) return "⏱️";
  if ("SetModelSigner" in kind) return "🔐";
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

/** The contract's PROPOSAL_TTL_MS: pending proposals expire after 7 days. */
export const PROPOSAL_TTL_MS = MS_PER_DAY * 7;

/** True when a pending proposal is past its TTL and can be `expire`d. */
export function isStale(p: Proposal): boolean {
  return (
    p.status === "Pending" && Date.now() >= p.created_at_ms + PROPOSAL_TTL_MS
  );
}

/**
 * Convert a human-entered decimal string ("12.5") to raw on-chain units
 * without float precision loss. Returns "0" for anything unparseable.
 */
export function parseAmount(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed)) return "0";
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = `${whole || "0"}${fracPadded}`;
  return raw.replace(/^0+(?=\d)/, "");
}

// ---- queries & mutations ---------------------------------------------------

export function useTreasuryProposals() {
  return useQuery<Proposal[]>({
    queryKey: ["proposals"],
    // The contract returns at most 100 per call, starting at `from`; page until a short page.
    queryFn: async () => {
      const all: Proposal[] = [];
      for (let from = 0; ; from += 100) {
        const page = await viewCall<Proposal[]>(TREASURY_CONTRACT_ID, "list_proposals", {
          from,
          limit: 100,
        });
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
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

export function useTreasuryPolicy() {
  return useQuery<Policy | null>({
    queryKey: ["treasury-policy"],
    queryFn: () =>
      viewCall<Policy | null>(TREASURY_CONTRACT_ID, "get_policy", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 60_000,
  });
}

export function useTreasuryPositions() {
  return useQuery<TreasuryPositions>({
    queryKey: ["treasury-positions"],
    queryFn: async () => {
      const [positions, totalAllocated] = await Promise.all([
        viewCall<[string, string][]>(TREASURY_CONTRACT_ID, "get_positions", {}),
        viewCall<string>(TREASURY_CONTRACT_ID, "get_total_allocated", {}),
      ]);
      return { positions, totalAllocated };
    },
    enabled: !!TREASURY_CONTRACT_ID,
    refetchInterval: 15_000,
  });
}

export function useTreasuryPaused() {
  return useQuery<boolean>({
    queryKey: ["treasury-paused"],
    queryFn: () => viewCall<boolean>(TREASURY_CONTRACT_ID, "is_paused", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 30_000,
  });
}

/** NEP-141 `ft_metadata()`; decimals is read live, never hardcoded. */
export interface TokenMetadata {
  decimals: number;
  symbol: string;
  name?: string;
  icon?: string | null;
  reference?: string | null;
  reference_hash?: string | null;
}

export function useTokenMetadata(token: string | null) {
  return useQuery<TokenMetadata>({
    queryKey: ["ft-metadata", token],
    queryFn: () => viewCall<TokenMetadata>(token as string, "ft_metadata", {}),
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Treasury's liquid balance of a NEP-141 token via `ft_balance_of`. */
export function useTokenBalance(
  token: string | null,
  accountId: string | null,
) {
  return useQuery<string>({
    queryKey: ["ft-balance", token, accountId],
    queryFn: () =>
      viewCall<string>(token as string, "ft_balance_of", {
        account_id: accountId,
      }),
    enabled: !!token && !!accountId,
    refetchInterval: 15_000,
  });
}

/** Cumulative principal cap for a venue; null means it isn't whitelisted. */
export function useVenueCap(venue: string | null) {
  return useQuery<string | null>({
    queryKey: ["venue-cap", venue],
    queryFn: () =>
      viewCall<string | null>(TREASURY_CONTRACT_ID, "get_venue_cap", { venue }),
    enabled: !!TREASURY_CONTRACT_ID && !!venue,
    refetchInterval: 15_000,
  });
}

/**
 * Poll one proposal. Execution callbacks run after the approval transaction
 * returns, so `Executed` can still flip to `Failed`; the treasury page polls
 * every 2s for up to 20s after an approve.
 */
export function useProposalPoll(id: number | null, enabled = true) {
  return useQuery<Proposal | null>({
    queryKey: ["proposal", id],
    queryFn: () =>
      viewCall<Proposal | null>(TREASURY_CONTRACT_ID, "get_proposal", { id }),
    enabled: !!TREASURY_CONTRACT_ID && id !== null && enabled,
    refetchInterval: 2_000,
    staleTime: 0,
  });
}

// ---- autonomy lane -----------------------------------------------------------

/** Retry transient RPC errors once; a missing method (v1 contract) will not appear on retry. */
const retryUnlessMissing = (count: number, err: unknown) =>
  count < 1 && !/method is not found|MethodNotFound|MethodResolveError/i.test(String(err));

export function useAutonomy() {
  return useQuery<AutonomyStatus>({
    queryKey: ["autonomy"],
    queryFn: () => viewCall<AutonomyStatus>(TREASURY_CONTRACT_ID, "get_autonomy", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    refetchInterval: 10_000,
    retry: retryUnlessMissing,
  });
}

export function useVendors() {
  return useQuery<string[]>({
    queryKey: ["vendors"],
    queryFn: () => viewCall<string[]>(TREASURY_CONTRACT_ID, "list_vendors", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 30_000,
    retry: retryUnlessMissing,
  });
}

/** Registered TEE signing keys: [address, model][]. */
export function useModelSigners() {
  return useQuery<[string, string][]>({
    queryKey: ["model-signers"],
    queryFn: () =>
      viewCall<[string, string][]>(TREASURY_CONTRACT_ID, "list_model_signers", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 30_000,
    retry: retryUnlessMissing,
  });
}

export type LaneState =
  | { lane: "signers" }
  | { lane: "auto"; executableAt: number; due: boolean };

/** Where a pending proposal stands: waiting for signers, or in the autonomy lane. */
export function laneState(p: Proposal, now = Date.now()): LaneState {
  if (p.status !== "Pending" || !p.auto_execute_after_ms) return { lane: "signers" };
  return {
    lane: "auto",
    executableAt: p.auto_execute_after_ms,
    due: now >= p.auto_execute_after_ms,
  };
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Execute an autonomy-lane payout after its veto window. Anyone may call it. */
export function useExecuteAuto(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) => {
      assertTestnetNetwork();
      assertTestnetAccountId(TREASURY_CONTRACT_ID);
      return callContract("execute_auto", { id }, "0", AUTO_EXECUTE_GAS);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
    onError: (err) => onError?.(err instanceof Error ? err.message : String(err)),
  });
}

/** True when execution continues in an async callback after approval. */
export function isAsyncKind(kind: ProposalKind): boolean {
  return "Payout" in kind || "Allocate" in kind || "Withdraw" in kind || "PayInvoice" in kind;
}

// ---- invoices ------------------------------------------------------------------

/** 0.01 NEAR storage deposit required by submit_invoice. */
export const INVOICE_DEPOSIT = "10000000000000000000000";
const ONE_YOCTO = "1";

export function useInvoices() {
  return useQuery<Invoice[]>({
    queryKey: ["invoices"],
    queryFn: async () => {
      const all: Invoice[] = [];
      for (let from = 0; ; from += 100) {
        const page = await viewCall<Invoice[]>(TREASURY_CONTRACT_ID, "list_invoices", { from, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
    enabled: !!TREASURY_CONTRACT_ID,
    refetchInterval: 10_000,
    retry: retryUnlessMissing,
  });
}

export function useInvoice(id: number | null) {
  return useQuery<Invoice | null>({
    queryKey: ["invoice", id],
    queryFn: () => viewCall<Invoice | null>(TREASURY_CONTRACT_ID, "get_invoice", { invoice_id: id }),
    enabled: !!TREASURY_CONTRACT_ID && id !== null,
    staleTime: 10_000,
    retry: retryUnlessMissing,
  });
}

/** [fee in basis points, recipient]; the fee applies only when a recipient is set. */
export function useFactoringFee() {
  return useQuery<[number, string | null]>({
    queryKey: ["factoring-fee"],
    queryFn: () => viewCall<[number, string | null]>(TREASURY_CONTRACT_ID, "get_factoring_fee", {}),
    enabled: !!TREASURY_CONTRACT_ID,
    staleTime: 60_000,
    retry: retryUnlessMissing,
  });
}

type InvoiceAction =
  | { type: "submit"; token: string; amount: string; due_ms: number; reference: string; document_hash: string | null }
  | { type: "cancel"; id: number }
  | { type: "price"; id: number; price: string | null }
  | { type: "transfer"; id: number; receiver: string }
  | { type: "buy"; id: number; token: string; price: string }
  | { type: "propose-pay"; id: number; rationale: string };

/** Every signed invoice action, routed to the right contract with the right deposit and gas. */
export function useInvoiceAction(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: InvoiceAction) => {
      assertTestnetNetwork();
      assertTestnetAccountId(TREASURY_CONTRACT_ID);
      switch (a.type) {
        case "submit":
          return callContract(
            "submit_invoice",
            { token: a.token, amount: a.amount, due_ms: a.due_ms, reference: a.reference, document_hash: a.document_hash },
            INVOICE_DEPOSIT,
            GOVERNANCE_GAS
          );
        case "cancel":
          return callContract("cancel_invoice", { invoice_id: a.id }, "0", GOVERNANCE_GAS);
        case "price":
          return callContract("set_invoice_price", { invoice_id: a.id, price: a.price }, "0", GOVERNANCE_GAS);
        case "transfer":
          return callContract(
            "nft_transfer",
            { receiver_id: a.receiver, token_id: String(a.id), approval_id: null, memo: null },
            ONE_YOCTO,
            GOVERNANCE_GAS
          );
        case "buy":
          // ft_transfer_call on the invoice token; the treasury's ft_on_transfer settles the sale.
          return callContractOn(
            a.token,
            "ft_transfer_call",
            { receiver_id: TREASURY_CONTRACT_ID, amount: a.price, msg: JSON.stringify({ buy_invoice: a.id }) },
            ONE_YOCTO,
            APPROVE_GAS
          );
        case "propose-pay":
          return callContract(
            "propose",
            { kind: { PayInvoice: { invoice_id: a.id } }, rationale: a.rationale },
            "0",
            GOVERNANCE_GAS
          );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (err) => onError?.(err instanceof Error ? err.message : String(err)),
  });
}

/**
 * Plain-language reason for a Failed proposal. The contract only stores the
 * final status (callbacks log the detail on-chain), so infer the most useful
 * explanation from the kind for the UI.
 */
export function failureReason(p: Proposal): string {
  if (p.status !== "Failed") return "";
  if ("Payout" in p.kind) {
    return p.kind.Payout.token
      ? "The token transfer didn't complete. Check the recipient, the token contract and the treasury's token balance."
      : "The treasury didn't have enough free NEAR for this payout.";
  }
  if ("Allocate" in p.kind) {
    return "The venue refused the allocation or the transfer failed. The recorded principal was rolled back — check the venue, token balance and reserve floor.";
  }
  if ("Withdraw" in p.kind) {
    return "The venue didn't pay out — it may have refused the withdrawal or returned zero. The recorded principal is unchanged.";
  }
  return "The on-chain execution failed. Check the proposal details and the treasury state before retrying.";
}

/** Create a proposal. Any signer or the AI proposer may call `propose`. */
export function usePropose(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      rationale,
    }: {
      kind: ProposalKind;
      rationale: string;
    }) => callContract("propose", { kind, rationale }, "0", GOVERNANCE_GAS),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (err) =>
      onError?.(err instanceof Error ? err.message : String(err)),
  });
}

/** Anyone may `expire` a proposal that is past the 7-day TTL. */
export function useExpire(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) =>
      callContract("expire", { id }, "0", GOVERNANCE_GAS),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
    },
    onError: (err) =>
      onError?.(err instanceof Error ? err.message : String(err)),
  });
}

/** Kill switch: a single signer can pause allocations immediately. */
export function usePause(onError?: (msg: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callContract("pause", {}, "0", GOVERNANCE_GAS),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["treasury-paused"] });
    },
    onError: (err) =>
      onError?.(err instanceof Error ? err.message : String(err)),
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
    }) => {
      assertTestnetNetwork();
      assertTestnetAccountId(TREASURY_CONTRACT_ID);

      return callContract(
        action,
        { id },
        "0",
        action === "approve" ? APPROVE_GAS : GOVERNANCE_GAS,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      qc.invalidateQueries({ queryKey: ["treasury-config"] });
    },
    onError: (err) =>
      onError?.(err instanceof Error ? err.message : String(err)),
  });
}

// ---- rate-limit envelope for Phase 4 server-side propose ----
// Server-only. Baked here so the same limits are visible to the web and to any
// CI check that inspects server code.

export const PROPOSER_RATE_LIMIT = {
  requestsPerMinute: 20,
  /** Reject an Allocate above 1,000 USDT.e. Must match the contract's policy cap. */
  maxAllocateAmount: BigInt("1000") * BigInt(10 ** 6),
  /** Stable token decimals assumed when ft_metadata is unreachable (USDT.e = 6). */
  stableDecimals: 6,
};

export function assertWithinReserveFloor(
  currentBalance: string,
  spendAmount: string,
  reserveFloor: string,
): void {
  const after = BigInt(currentBalance) - BigInt(spendAmount);
  if (after < BigInt(reserveFloor)) {
    throw new Error(
      `Spending ${spendAmount} would leave ${after} below the reserve floor ${reserveFloor}.`,
    );
  }
}

// Governance proposal creation is restricted to a signer or the AI proposer.
// When the AI proposer is a server-side account, creation happens server-side
// (Phase 4) and must not expose the proposer key to the browser. Until that is
// wired in, keep proposing available to the connected signer only.
export const ALLOWED_CONTRACTS = [
  TREASURY_CONTRACT_ID,
  "usdt.fakes.testnet",
  "mock-venue.treasury-dev.testnet",
] as const;

export function isWhitelistedContract(accountId: string): boolean {
  if (!accountId.endsWith(".testnet")) return false;
  return ALLOWED_CONTRACTS.some((c) => c === accountId);
}
