"use client";
// Treasury dashboard. Shows AI-drafted proposals with TEE attestation, lets
// signers approve or reject. Reads from the treasury contract via near-api-js.

import { useState } from "react";
import WalletButton from "@/components/WalletButton";

type ProposalKind =
  | { Payout: { to: string; token: string | null; amount: string } }
  | { Allocate: { venue: string; token: string; amount: string } };

interface Proposal {
  id: number;
  kind: ProposalKind;
  proposer: string;
  rationale: string;
  approvals: string[];
  status: "Pending" | "Executed" | "Rejected";
  created_at_ms: number;
}

// Stub data until the contract view is wired
const STUB_PROPOSALS: Proposal[] = [
  {
    id: 0,
    kind: { Payout: { to: "vendor.near", token: null, amount: "5000000000000000000000000" } },
    proposer: "ai-proposer.near",
    rationale: "Monthly infrastructure vendor payment",
    approvals: [],
    status: "Pending",
    created_at_ms: Date.now(),
  },
];

function kindLabel(kind: ProposalKind) {
  if ("Payout" in kind) {
    const { to, token, amount } = kind.Payout;
    const tokenStr = token ?? "NEAR";
    const humanAmount = (Number(amount) / 1e24).toFixed(4);
    return `Payout ${humanAmount} ${tokenStr} → ${to}`;
  }
  const { venue, token, amount } = kind.Allocate;
  const humanAmount = (Number(amount) / 1e24).toFixed(4);
  return `Allocate ${humanAmount} ${token} → ${venue}`;
}

export default function TreasuryPage() {
  const [proposals] = useState<Proposal[]>(STUB_PROPOSALS);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Treasury</h1>
          <p className="text-gray-400 text-sm">AI-drafted proposals — approve with M-of-N signers</p>
        </div>
        <WalletButton />
      </div>

      {/* TODO: load real proposals from treasury contract view */}
      <div className="space-y-4">
        {proposals.length === 0 && (
          <p className="text-gray-500 text-sm">No pending proposals.</p>
        )}
        {proposals.map((p) => (
          <div key={p.id} className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-xs text-gray-500 font-mono">#{p.id}</span>
                <p className="font-semibold text-white mt-0.5">{kindLabel(p.kind)}</p>
                <p className="text-sm text-gray-400 mt-1">{p.rationale}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                p.status === "Pending"
                  ? "bg-yellow-900/50 text-yellow-300"
                  : p.status === "Executed"
                  ? "bg-green-900/50 text-green-300"
                  : "bg-red-900/50 text-red-300"
              }`}>
                {p.status}
              </span>
            </div>

            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>Proposed by {p.proposer}</span>
              <span>·</span>
              <span>{p.approvals.length} approval(s)</span>
              <span>·</span>
              <span>{new Date(p.created_at_ms).toLocaleString()}</span>
            </div>

            {p.status === "Pending" && (
              <div className="flex gap-2 pt-1">
                {/* TODO: wire approve/reject to contract call via near-api-js */}
                <button
                  disabled
                  className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-1.5 text-xs font-semibold text-white transition-colors"
                >
                  Approve
                </button>
                <button
                  disabled
                  className="rounded-lg border border-red-800 hover:bg-red-900/30 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-1.5 text-xs font-semibold text-red-400 transition-colors"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
