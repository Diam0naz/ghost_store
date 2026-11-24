"use client";
// Flows page. Shows incoming payments (checkout settlements via 1Click) and outgoing
// payments from the treasury contract: executed and failed proposal payouts,
// allocations and withdrawals, read live via `list_proposals`.
// Data is public on chain; AccessBar shows the visitor's role above it.

import AccessBar from "@/components/AccessBar";
import EmptyState from "@/components/EmptyState";
import {
  useTreasuryProposals,
  useInvoices,
  tokenDecimals,
  formatAmount,
  type Invoice,
  type Proposal,
} from "@/lib/proposals";
import ErrorState from "@/components/ErrorState";
import { useSettlements, type Settlement } from "@/lib/settlements";

interface FlowRow {
  id: string;
  type: "in" | "out";
  description: string;
  token: string;
  amount: string;
  ts: number;
  status?: string;
}

/** Short token label: null is native NEAR, `usdt.fakes.testnet` becomes USDT. */
function tokenLabel(token: string | null): string {
  if (token === null) return "NEAR";
  return token.split(".")[0].toUpperCase();
}

/**
 * Map on-chain proposals that move money to flow rows. Governance changes (policy, signers,
 * vendors, caps, model keys) move no funds and are left out; the Treasury page lists them.
 * Includes Executed (money moved) and Failed (attempted, worth showing).
 */
function flowsFromProposals(proposals: Proposal[] | undefined, invoices: Invoice[] | undefined): FlowRow[] {
  if (!proposals) return [];
  const byId = new Map((invoices ?? []).map((i) => [i.id, i]));
  return proposals
    .filter((p) => p.status === "Executed" || p.status === "Failed")
    .flatMap((p): FlowRow[] => {
      const base = { id: `p${p.id}`, ts: p.created_at_ms, status: p.status };
      const k = p.kind;
      if ("PayInvoice" in k) {
        const inv = byId.get(k.PayInvoice.invoice_id);
        return [{
          ...base,
          type: "out",
          description: inv
            ? `Pay invoice ${inv.reference} to ${inv.issuer} (proposal #${p.id}${p.approvals.length === 0 ? ", no approvals" : ""})`
            : `Pay invoice #${k.PayInvoice.invoice_id} (proposal #${p.id})`,
          token: inv ? tokenLabel(inv.token) : "—",
          amount: inv ? formatAmount(inv.amount, tokenDecimals(inv.token)) : "—",
        }];
      }
      if ("Payout" in k) {
        return [{
          ...base,
          type: "out",
          description: `Payout to ${k.Payout.to} (proposal #${p.id})`,
          token: tokenLabel(k.Payout.token),
          amount: formatAmount(k.Payout.amount, tokenDecimals(k.Payout.token)),
        }];
      }
      if ("Allocate" in k) {
        return [{
          ...base,
          type: "out",
          description: `Allocate to ${k.Allocate.venue} (proposal #${p.id})`,
          token: tokenLabel(k.Allocate.token),
          amount: formatAmount(k.Allocate.amount, tokenDecimals(k.Allocate.token)),
        }];
      }
      if ("Withdraw" in k) {
        return [{
          ...base,
          type: "in",
          description: `Withdraw from ${k.Withdraw.venue} (proposal #${p.id})`,
          token: "—",
          amount: formatAmount(k.Withdraw.amount, 6),
        }];
      }
      return [];
    });
}

const SETTLEMENT_LABEL: Record<string, string> = {
  SUCCESS: "Settled",
  PROCESSING: "Processing",
  KNOWN_DEPOSIT_TX: "Processing",
  PENDING_DEPOSIT: "Awaiting deposit",
  REFUNDED: "Refunded",
  FAILED: "Failed",
  INCOMPLETE_DEPOSIT: "Incomplete",
};

/** Checkout payments settled through NEAR Intents (mainnet), read live from 1Click. */
function incomingFromSettlements(settlements: Settlement[]): FlowRow[] {
  return settlements.map((s) => ({
    id: `in-${s.depositAddress}`,
    type: "in" as const,
    description: `Checkout payment via NEAR Intents${s.amountIn ? ` (customer paid ${s.amountIn})` : ""}`,
    token: "USDC",
    amount: s.amountOut ?? "—",
    ts: s.updatedAt,
    status: SETTLEMENT_LABEL[s.status] ?? s.status,
  }));
}

export default function FlowsPage() {
  return (
    <AccessBar>
      <FlowsContent />
    </AccessBar>
  );
}

function FlowsContent() {
  const proposals = useTreasuryProposals();
  const settlements = useSettlements();
  const invoices = useInvoices();
  const treasury = flowsFromProposals(proposals.data, invoices.data);
  const rows = [...incomingFromSettlements(settlements.data), ...treasury].sort((a, b) => b.ts - a.ts);

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-2">Money movement</p>
        <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">
          Flows
        </h1>
        <p className="mt-1.5 text-sm font-medium text-ink-600">
          Incoming payments and outgoing treasury actions
        </p>
      </div>

      {proposals.isPending && (
        <div className="card h-32 animate-pulse" />
      )}

      {proposals.isError && (
        <ErrorState
          error={proposals.error}
          onRetry={() => proposals.refetch()}
          retrying={proposals.isRefetching}
        />
      )}

      {!proposals.isPending && !proposals.isError && rows.length === 0 && (
        <EmptyState
          title="No flows yet"
          description="Payments and payouts will appear here automatically once they settle on-chain."
        />
      )}

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-primary-100 text-xs font-bold uppercase tracking-wider text-ink-400">
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-right">Token</th>
                <th className="px-4 py-3 text-right">Status</th>
                <th className="px-4 py-3 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-100">
              {rows.map((f) => (
                <tr key={f.id} className="transition-colors hover:bg-primary-50">
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                        f.type === "in"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-primary-100 text-primary-700"
                      }`}
                    >
                      {f.type === "in" ? "IN" : "OUT"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-ink-900">
                    {f.description}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-primary-950">
                    {f.amount}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-ink-600">
                    {f.token}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {f.status && (
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                          ["Failed", "Refunded", "Incomplete"].includes(f.status)
                            ? "bg-red-100 text-red-700"
                            : ["Processing", "Awaiting deposit"].includes(f.status)
                            ? "bg-amber-100 text-amber-700"
                            : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {f.status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-medium text-ink-400">
                    {new Date(f.ts).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs font-medium text-ink-400">
        Outgoing flows are read live from the treasury contract (testnet) every 10 s. Incoming
        checkout payments are mainnet NEAR Intents settlements, read live from the 1Click status
        API; they land in the merchant&apos;s Intents balance, not yet in the treasury.
        {settlements.failed > 0 && ` ${settlements.failed} settlement lookup(s) failed.`}
      </p>
    </div>
  );
}
