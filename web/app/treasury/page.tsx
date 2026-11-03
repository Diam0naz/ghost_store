"use client";
// Treasury dashboard. Shows AI-drafted proposals with TEE attestation, lets
// signers approve or reject. Reads live data from the treasury contract via
// near-api-js view calls and signs governance actions with wallet-selector.

import { useState, useEffect } from "react";
import WalletButton from "@/components/WalletButton";
import EmptyState from "@/components/EmptyState";
import LoginGate from "@/components/LoginGate";
import ErrorState, { friendlyError } from "@/components/ErrorState";
import {
  useTreasuryProposals,
  useTreasuryConfig,
  useProposalAction,
  kindLabel,
  kindEmoji,
  expiresIn,
  type Proposal,
} from "@/lib/proposals";
import {
  getAccountId,
  subscribeAccountId,
  TREASURY_CONTRACT_ID,
} from "@/lib/near";

const STATUS_CLASSES: Record<string, string> = {
  Pending: "bg-amber-100 text-amber-700",
  Executed: "bg-emerald-100 text-emerald-700",
  Failed: "bg-red-100 text-red-700",
  Rejected: "bg-gray-200 text-gray-600",
  Expired: "bg-gray-200 text-gray-600",
};

function ProposalCard({
  p,
  myAccountId,
  config,
  onAction,
  busy,
}: {
  p: Proposal;
  myAccountId: string | null;
  config: { signers: string[]; threshold: number } | undefined;
  onAction: (id: number, action: "approve" | "reject") => void;
  busy: boolean;
}) {
  const isSigner = !!myAccountId && (config?.signers ?? []).includes(myAccountId);
  const alreadyApproved = !!myAccountId && p.approvals.includes(myAccountId);
  // Approval count only counts current signers (mirrors contract logic).
  const validApprovals = p.approvals.filter((a) =>
    (config?.signers ?? []).includes(a)
  ).length;
  const threshold = config?.threshold ?? 1;
  const canAct = p.status === "Pending" && isSigner && !alreadyApproved && !busy;

  return (
    <div className="card space-y-3 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-mono text-xs text-ink-400">#{p.id}</span>
          <p className="mt-0.5 font-bold text-primary-950">
            <span className="mr-1">{kindEmoji(p.kind)}</span>
            {kindLabel(p.kind)}
          </p>
          <p className="mt-1 text-sm font-medium text-ink-600">{p.rationale}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${
            STATUS_CLASSES[p.status] ?? "bg-red-100 text-red-700"
          }`}
        >
          {p.status}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs font-medium text-ink-400">
        <span>Proposed by {p.proposer}</span>
        <span>·</span>
        <span>
          ✅ {validApprovals}/{threshold}
        </span>
        <span>·</span>
        <span>{expiresIn(p.created_at_ms)}</span>
        {alreadyApproved && <span className="text-emerald-600">· you approved</span>}
      </div>

      {p.status === "Pending" && (
        <div className="flex items-center gap-2 pt-1">
          <button
            disabled={!canAct}
            onClick={() => onAction(p.id, "approve")}
            className="btn-primary text-xs"
            title={
              !isSigner
                ? "Only signers can approve"
                : alreadyApproved
                ? "Already approved"
                : undefined
            }
          >
            {busy ? "Approving…" : "Approve"}
          </button>
          <button
            disabled={!canAct}
            onClick={() => onAction(p.id, "reject")}
            className="rounded-full border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reject
          </button>
          {!myAccountId && (
            <span className="text-xs font-medium text-ink-400">
              Connect a wallet to act
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function TreasuryPage() {
  const proposals = useTreasuryProposals();
  const config = useTreasuryConfig();
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<number | null>(null);

  // Track wallet connect/disconnect live (the header button may change it).
  useEffect(() => {
    let unsub: (() => void) | undefined;
    getAccountId()
      .then(setMyAccountId)
      .catch(() => setMyAccountId(null))
      .finally(() => {
        subscribeAccountId(setMyAccountId)
          .then((u) => (unsub = u))
          .catch(() => {});
      });
    return () => unsub?.();
  }, []);

  const action = useProposalAction(setError);

  function onAction(id: number, kind: "approve" | "reject") {
    setError(null);
    setConfetti(null);
    action.mutate(
      { id, action: kind },
      {
        onSuccess: () => {
          if (kind === "approve") setConfetti(id);
        },
      }
    );
  }

  const list = proposals.data ?? [];

  return (
    <LoginGate>
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="mb-1 text-2xl font-extrabold tracking-tight text-primary-950">
            Treasury
          </h1>
          <p className="text-sm font-medium text-ink-600">
            {config.data
              ? `${config.data.threshold}-of-${config.data.signers.length} signers · ${
                  TREASURY_CONTRACT_ID || "contract not configured"
                }`
              : "AI-drafted proposals — approve with M-of-N signers"}
          </p>
        </div>
        <WalletButton />
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          <span className="text-lg">👻</span>
          <span className="flex-1">
            {friendlyError(error)}
            <span className="block text-xs font-medium text-red-500">
              {error.replace(/\n+/g, " ").slice(0, 160)}
            </span>
          </span>
        </div>
      )}

      {confetti !== null && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          🎉 Approvals recorded — proposal #{confetti} executes automatically once
          the threshold is met.
        </div>
      )}

      {proposals.isPending && (
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-2xl bg-primary-100" />
        </div>
      )}

      {proposals.isError && (
        <ErrorState
          error={proposals.error}
          onRetry={() => proposals.refetch()}
          retrying={proposals.isRefetching}
        />
      )}

      {!proposals.isPending && !proposals.isError && (
        <div className="space-y-4">
          {list.length === 0 && (
            <EmptyState
              title="All clear"
              description="No pending proposals. When the AI drafts one, it shows up here for signers to approve."
            />
          )}
          {list.map((p) => (
            <ProposalCard
              key={p.id}
              p={p}
              myAccountId={myAccountId}
              config={config.data}
              onAction={onAction}
              busy={action.isPending}
            />
          ))}
        </div>
      )}
      </div>
    </LoginGate>
  );
}
