"use client";
// Flows page. Shows incoming payments (checkout settlements) and outgoing
// payments from the treasury contract: executed and failed proposal payouts,
// allocations and withdrawals, read live via `list_proposals`.

import { useState, useEffect } from "react";
import { friendlyError } from "@/components/ErrorState";
import EmptyState from "@/components/EmptyState";
import {
  useTreasuryProposals,
  kindLabel,
  tokenDecimals,
  formatAmount,
  type ProposalKind,
  type Proposal,
} from "@/lib/proposals";
import ErrorState from "@/components/ErrorState";

interface FlowRow {
  id: string;
  type: "in" | "out";
  description: string;
  token: string;
  amount: string;
  ts: number;
  status?: string;
}

function tokenOf(kind: ProposalKind): string | null {
  if ("Payout" in kind) return kind.Payout.token ?? "NEAR";
  if ("Allocate" in kind) return kind.Allocate.token;
  return null;
}

function amountOf(kind: ProposalKind): string | null {
  if ("Payout" in kind) return kind.Payout.amount;
  if ("Allocate" in kind) return kind.Allocate.amount;
  if ("Withdraw" in kind) return kind.Withdraw.amount;
  if ("SetVenueCap" in kind) return kind.SetVenueCap.cap;
  return null;
}

/**
 * Map on-chain proposals to outgoing flow rows. Includes Executed (money
 * actually moved) and Failed (attempted, worth showing); Pending/Rejected/
 * Expired are excluded since no funds moved.
 */
function outgoingFromProposals(proposals: Proposal[] | undefined): FlowRow[] {
  if (!proposals) return [];
  return proposals
    .filter((p) => p.status === "Executed" || p.status === "Failed")
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .map((p) => {
      const token = tokenOf(p.kind);
      const amount = amountOf(p.kind);
      return {
        id: `p${p.id}`,
        type: "out" as const,
        description: `${kindLabel(p.kind)} (proposal #${p.id})`,
        token: token ?? "—",
        amount: amount !== null ? formatAmount(amount, tokenDecimals(token)) : "—",
        ts: p.created_at_ms,
        status: p.status,
      };
    });
}

// Incoming settlements come from checkout (NEAR Intents), not contract state.
// TODO: index on-chain events / Intents history instead of stub data.
const STUB_INCOMING: FlowRow[] = [];

export default function FlowsPage() {
  const proposals = useTreasuryProposals();
  const outgoing = outgoingFromProposals(proposals.data);
  const rows = [...STUB_INCOMING, ...outgoing];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 text-2xl font-extrabold tracking-tight text-primary-950">
          Flows
        </h1>
        <p className="text-sm font-medium text-ink-600">
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
                          f.status === "Failed"
                            ? "bg-red-100 text-red-700"
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
        Outgoing flows are read live from the treasury contract every 10 s.
        Incoming settlement indexing is coming soon.
      </p>
    </div>
  );
}
