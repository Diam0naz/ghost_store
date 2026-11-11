"use client";
// Treasury dashboard. Shows AI-drafted proposals with an optional, verifiable
// attestation record, lets signers create, approve, reject and expire
// proposals, and pause allocations. Reads live data from the treasury contract
// via near-api-js view calls and signs governance actions with wallet-selector.
//
// Proposals from `propose_attested` carry an on-chain attestation: the contract
// itself verified the TEE signature, so the card shows that and skips the
// off-chain record. Older AI proposals keep the off-chain proof flow, where the
// badge only says "Verified AI draft" when the server route passed every check.
//
// Autonomy lane: an attested payout within the on-chain limits runs after its
// veto window unless one signer rejects it; anyone can then execute it.

import { useState, useEffect } from "react";
import EmptyState from "@/components/EmptyState";
import AccessBar from "@/components/AccessBar";
import ErrorState, { friendlyError } from "@/components/ErrorState";
import ConfirmDialog from "@/components/ConfirmDialog";
import ProposeModal, { type ProposeKind } from "@/components/ProposeModal";
import YieldPanel from "@/components/YieldPanel";
import AutonomyPanel from "@/components/AutonomyPanel";
import { OnChainProofBadge, OnChainProofDetails } from "@/components/OnChainProof";
import Icon from "@/components/Icon";
import { explorerAccountUrl } from "@/lib/explorer";
import ProofBadge from "@/components/ProofBadge";
import ProofDrawer from "@/components/ProofDrawer";
import { useAttestation } from "@/lib/attestation-client";
import {
  attestationStatusLabel,
  isAiProposal,
  type AttestationStatus,
} from "@/lib/attestation";
import {
  useTreasuryProposals,
  useTreasuryConfig,
  useTreasuryPaused,
  useProposalAction,
  useProposalPoll,
  useExpire,
  usePause,
  useExecuteAuto,
  useInvoice,
  formatAmount,
  laneState,
  countdown,
  kindLabel,
  kindIcon,
  expiresIn,
  isStale,
  isAsyncKind,
  failureReason,
  type Proposal,
  type ProposalStatus,
} from "@/lib/proposals";
import { useAccountId, TREASURY_CONTRACT_ID } from "@/lib/near";

const STATUS_CLASSES: Record<string, string> = {
  Pending: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/70",
  Executed: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70",
  Failed: "bg-red-50 text-red-700 ring-1 ring-red-200/70",
  Rejected: "bg-surface text-ink-600 ring-1 ring-line",
  Expired: "bg-surface text-ink-600 ring-1 ring-line",
};

type StatusFilter = "Needs you" | "All" | "Pending" | "Executed" | "Failed" | "Rejected" | "Expired";
const TAB_ORDER: StatusFilter[] = [
  "Needs you",
  "All",
  "Pending",
  "Executed",
  "Failed",
  "Rejected",
  "Expired",
];

/** What a PayInvoice proposal pays: amount, reference and the current holder (the payee). */
function InvoiceSummary({ id }: { id: number }) {
  const inv = useInvoice(id);
  if (inv.isPending) return <p className="mt-2 h-4 w-48 animate-pulse rounded bg-primary-100" />;
  if (!inv.data) return <p className="mt-2 text-xs text-red-600">Invoice #{id} not found.</p>;
  const i = inv.data;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
      <span className="font-mono text-ink-900">{formatAmount(i.amount, 6, 2)} USDT</span>
      <span>·</span>
      <span>{i.reference}</span>
      <span>·</span>
      <span>
        pays <span className="font-mono text-ink-900">{i.holder}</span>
        {i.holder !== i.issuer && <span className="text-primary-700"> (bought from {i.issuer})</span>}
      </span>
      <a href="/invoices" className="text-primary-700 underline underline-offset-2">
        view invoice
      </a>
    </p>
  );
}

function ProposalCard({
  p,
  myAccountId,
  config,
  onAction,
  onExpire,
  onExecuteAuto,
  busy,
  liveProposal = null,
  executing = false,
  delay = 0,
}: {
  p: Proposal;
  myAccountId: string | null;
  config: { signers: string[]; threshold: number } | undefined;
  onAction: (id: number, action: "approve" | "reject") => void;
  onExpire: (id: number) => void;
  onExecuteAuto: (id: number) => void;
  busy: boolean;
  /** Freshest get_proposal result while this proposal is being polled. */
  liveProposal?: Proposal | null;
  /** True while an approval that reached the threshold is still settling. */
  executing?: boolean;
  /** Staggered entrance delay so a list of cards doesn't pop in all at once. */
  delay?: number;
}) {
  const current = liveProposal ?? p;
  const status: ProposalStatus = current.status;
  const statusText = executing ? "Executing..." : status;
  const statusClass = executing
    ? "bg-primary-50 text-primary-700 ring-1 ring-primary-200"
    : STATUS_CLASSES[status] ?? "bg-red-50 text-red-700 ring-1 ring-red-200/70";
  const isSigner = !!myAccountId && (config?.signers ?? []).includes(myAccountId);
  const alreadyApproved = !!myAccountId && current.approvals.includes(myAccountId);
  const isAi = isAiProposal(current.proposer);
  const onChain = current.attestation ?? null;
  // On-chain attested proposals need no off-chain record lookup.
  const proof = useAttestation(
    current.id,
    isAi && !onChain,
    isAi && !onChain && current.status === "Pending"
  );
  const [now, setNow] = useState(() => Date.now());
  const lane = laneState(current, now);
  useEffect(() => {
    if (lane.lane !== "auto" || lane.due) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [lane.lane, lane.lane === "auto" && lane.due]);
  const [proofOpen, setProofOpen] = useState(false);
  // Approval count only counts current signers (mirrors contract logic).
  const validApprovals = current.approvals.filter((a) =>
    (config?.signers ?? []).includes(a)
  ).length;
  const threshold = config?.threshold ?? 1;
  const canAct = status === "Pending" && isSigner && !alreadyApproved && !busy;
  const canVeto = status === "Pending" && isSigner && !busy;
  const stale = isStale(current);

  return (
    <div
      className="card space-y-4 p-5 sm:p-6"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3.5">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
            <Icon name={kindIcon(p.kind)} />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">
              <span className="mr-2 font-mono text-xs font-normal text-ink-400">#{p.id}</span>
              {kindLabel(p.kind)}
            </p>
            <p className="mt-1 text-sm text-ink-600">{p.rationale}</p>
            {"PayInvoice" in p.kind && <InvoiceSummary id={p.kind.PayInvoice.invoice_id} />}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${statusClass}`}
        >
          {statusText}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-3 text-xs text-ink-400">
        {onChain ? (
          <OnChainProofBadge attestation={onChain} />
        ) : (
          <ProofBadge
            status={proof.data?.status}
            human={!isAi}
            loading={isAi && proof.isPending}
          />
        )}
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          Proposed by{" "}
          <a
            href={explorerAccountUrl(p.proposer)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-ink-600 underline decoration-line underline-offset-2 hover:text-ink-900"
          >
            {p.proposer}
          </a>
        </span>
        <span>·</span>
        <span className="inline-flex items-center gap-1">
          <Icon name="check" className="h-3.5 w-3.5" />
          <span className="font-mono">{validApprovals}/{threshold}</span> approvals
        </span>
        {status === "Pending" && (
          <>
            <span>·</span>
            <span className={stale ? "font-medium text-red-600" : undefined}>
              {expiresIn(p.created_at_ms)}
            </span>
          </>
        )}
        {alreadyApproved && <span className="text-emerald-600">· you approved</span>}
        <button
          onClick={() => setProofOpen(true)}
          className="ml-auto rounded-md border border-line bg-white px-2 py-0.5 text-[11px] font-medium text-ink-600 transition-colors hover:border-primary-300 hover:text-ink-900"
        >
          {isAi && !onChain ? "Proof & timeline" : "Timeline"}
        </button>
      </div>

      {lane.lane === "auto" && (
        <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 ring-1 ring-amber-200/60">
          <Icon name="clock" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
          Autonomy lane:{" "}
          {lane.due
            ? "the veto window is over. Anyone can execute this payout now."
            : `executes in ${countdown(lane.executableAt - now)} unless one signer vetoes it.`}{" "}
          No approvals needed: it is within the AI&apos;s on-chain limits.
          </span>
        </p>
      )}

      {onChain && <OnChainProofDetails attestation={onChain} />}

      {status === "Failed" && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
          {failureReason(current)}
        </p>
      )}

      {status === "Pending" && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
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
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            disabled={lane.lane === "auto" ? !canVeto : !canAct}
            onClick={() => onAction(p.id, "reject")}
            className="rounded-full border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            title={lane.lane === "auto" ? "One signer is enough to stop an autonomous payout" : undefined}
          >
            {lane.lane === "auto" ? "Veto" : "Reject"}
          </button>
          {lane.lane === "auto" && lane.due && (
            <button
              disabled={busy || !myAccountId}
              onClick={() => onExecuteAuto(p.id)}
              className="rounded-full border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
              title="Permissionless: the contract re-checks the limits and the reserve floor"
            >
              Execute payout
            </button>
          )}
          {stale && (
            <button
              disabled={busy}
              onClick={() => onExpire(p.id)}
              className="rounded-full border border-primary-200 bg-white px-4 py-2 text-xs font-semibold text-ink-600 transition-colors hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-40"
              title="Past the 7-day TTL — anyone can expire it"
            >
              Expire
            </button>
          )}
          {!myAccountId && (
            <span className="text-xs font-medium text-ink-400">
              Connect a wallet to act
            </span>
          )}
        </div>
      )}

      <ProofDrawer
        open={proofOpen}
        proposal={current}
        verification={proof.data}
        loading={isAi && proof.isPending}
        error={proof.error as Error | null}
        onClose={() => setProofOpen(false)}
        onRefresh={() => proof.refetch()}
        refreshing={proof.isRefetching}
      />
    </div>
  );
}

export default function TreasuryPage() {
  const proposals = useTreasuryProposals();
  const config = useTreasuryConfig();
  const paused = useTreasuryPaused();
  const myAccountId = useAccountId();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<number | null>(null);
  const [tab, setTab] = useState<StatusFilter>("All");

  // After an approve, callbacks can still flip Executed → Failed. Poll that
  // proposal for 20s while the card shows "Executing...".
  const [execution, setExecution] = useState<{
    id: number;
    until: number;
    willExecute: boolean;
    settled: boolean;
  } | null>(null);
  const liveProposal = useProposalPoll(
    execution?.id ?? null,
    !!execution && !execution.settled
  );

  useEffect(() => {
    if (!execution || execution.settled) return;
    const p = liveProposal.data;
    if (!p || p.id !== execution.id) return;
    // Async kinds keep polling through Executed; a callback may still fail it.
    const settled =
      p.status === "Failed" ||
      p.status === "Rejected" ||
      p.status === "Expired" ||
      (p.status === "Executed" && !isAsyncKind(p.kind));
    if (settled) {
      // Keep the last polled proposal on screen until the list refetch lands.
      setExecution({ ...execution, settled: true });
      proposals.refetch();
    }
  }, [execution, liveProposal.data, proposals]);

  useEffect(() => {
    if (!execution) return;
    const timer = window.setTimeout(() => {
      proposals.refetch();
      setExecution(null);
    }, Math.max(0, execution.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [execution, proposals]);

  // Propose modal + confirm dialogs.
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeKind, setProposeKind] = useState<ProposeKind | undefined>();
  const [confirmApprove, setConfirmApprove] = useState<Proposal | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);

  const action = useProposalAction(setError);
  const expire = useExpire(setError);
  const pause = usePause(setError);
  const executeAuto = useExecuteAuto(setError);

  const isSigner =
    !!myAccountId && (config.data?.signers ?? []).includes(myAccountId);

  const confirmSigners = config.data?.signers ?? [];
  const confirmThreshold = config.data?.threshold ?? 1;
  const confirmApprovals = (confirmApprove?.approvals ?? []).filter((a) =>
    confirmSigners.includes(a)
  ).length;
  const confirmWillExecute =
    !!confirmApprove &&
    confirmApprovals + 1 >= confirmThreshold;

  // Proof shown in the approve dialog. A signer should know whether an AI
  // draft can be authenticated before recording an approval.
  const confirmIsAi = confirmApprove
    ? isAiProposal(confirmApprove.proposer)
    : false;
  const confirmOnChain = confirmApprove?.attestation ?? null;
  const confirmProof = useAttestation(
    confirmApprove?.id ?? null,
    confirmIsAi && !confirmOnChain
  );
  const confirmProofStatus: AttestationStatus | undefined =
    confirmProof.data?.status;
  const confirmProofInvalid =
    confirmProofStatus === "none" ||
    confirmProofStatus === "mismatch" ||
    confirmProofStatus === "error";
  const confirmProofPartial = confirmProofStatus === "partial";

  function onAction(id: number, kind: "approve" | "reject") {
    setError(null);
    setConfetti(null);
    action.mutate(
      { id, action: kind },
      {
        onSuccess: () => {
          if (kind !== "approve") return;
          const target = (proposals.data ?? []).find((x) => x.id === id);
          const signers = config.data?.signers ?? [];
          const valid = (target?.approvals ?? []).filter((a) =>
            signers.includes(a)
          ).length;
          const willExecute =
            !!target && valid + 1 >= (config.data?.threshold ?? 1);
          // Poll regardless; only show "Executing..." when this approval is
          // the one that reached the threshold and started execution.
          setExecution({
            id,
            until: Date.now() + 20_000,
            willExecute,
            settled: false,
          });
          if (!willExecute) setConfetti(id);
        },
      }
    );
  }

  function openPropose(kind?: ProposeKind) {
    setProposeKind(kind);
    setProposeOpen(true);
  }

  function onProposeSuccess() {
    setNotice(
      "Proposal created — it needs the signer threshold before anything executes."
    );
  }

  // Newest first: what needs attention is usually the latest proposal.
  const list = [...(proposals.data ?? [])].sort((a, b) => b.id - a.id);
  // Pending proposals the connected signer has not approved yet.
  const needsMe = (p: Proposal) =>
    isSigner && p.status === "Pending" && !isStale(p) && !p.approvals.includes(myAccountId ?? "");
  const counts: Record<StatusFilter, number> = {
    "Needs you": list.filter(needsMe).length,
    All: list.length,
    Pending: list.filter((p) => p.status === "Pending").length,
    Executed: list.filter((p) => p.status === "Executed").length,
    Failed: list.filter((p) => p.status === "Failed").length,
    Rejected: list.filter((p) => p.status === "Rejected").length,
    Expired: list.filter((p) => p.status === "Expired").length,
  };
  const filtered =
    tab === "All"
      ? list
      : tab === "Needs you"
        ? list.filter(needsMe)
        : list.filter((p) => p.status === tab);
  const tabs = isSigner ? TAB_ORDER : TAB_ORDER.filter((t) => t !== "Needs you");

  return (
    <AccessBar>
      <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">Governance</p>
          <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">
            Treasury
          </h1>
          <p className="mt-1.5 text-sm font-medium text-ink-600">
            {config.data
              ? `${config.data.threshold}-of-${config.data.signers.length} signers · ${
                  TREASURY_CONTRACT_ID || "contract not configured"
                }`
              : "AI-drafted proposals with optional attestation proof — approve with M-of-N signers"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openPropose()}
            className="btn-primary text-sm"
            title={
              isSigner
                ? undefined
                : "Submitting needs a signer or proposer account — anyone can draft one"
            }
          >
            <Icon name="plus" /> New proposal
          </button>
        </div>
      </div>

      <AutonomyPanel />

      <YieldPanel />

      {/* Pause kill switch — signer-only, one transaction. */}
      {isSigner && paused.data === false && !confirmPause && (
        <div className="flex justify-end">
          <button
            onClick={() => setConfirmPause(true)}
            disabled={pause.isPending}
            className="rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-40"
            title="Single-signer kill switch for allocations and autonomous payouts"
          >
            <Icon name="pause" className="h-3.5 w-3.5" />
            {pause.isPending ? "Pausing…" : "Pause allocations & autonomy"}
          </button>
        </div>
      )}

      {paused.data === true && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 animate-fade-in">
          <Icon name="pause" className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            Paused: allocations and autonomous payouts are stopped. Signer-approved
            payouts and governance still work. Unpausing needs an approved
            SetPaused proposal.
          </span>
          {isSigner && (
            <button
              onClick={() => openPropose("SetPaused")}
              className="rounded-full border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100"
            >
              Unpause via proposal
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 animate-fade-in">
          <Icon name="alert" className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {friendlyError(error)}
            <span className="block text-xs font-medium text-red-500">
              {error.replace(/\n+/g, " ").slice(0, 160)}
            </span>
          </span>
        </div>
      )}

      {notice && (
        <div className="flex items-center gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm font-semibold text-primary-800 animate-fade-in">
          <Icon name="info" className="h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="text-primary-400 transition-colors hover:text-primary-700"
          >
            ✕
          </button>
        </div>
      )}

      {confetti !== null && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 animate-fade-in">
          Approval recorded — proposal #{confetti} executes automatically once
          the threshold is met.
        </div>
      )}

      {/* Status filter tabs with live counts. */}
      {!proposals.isPending && !proposals.isError && list.length > 0 && (
        <div
          className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line bg-white p-1 shadow-soft"
          role="tablist"
          aria-label="Filter proposals"
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t
                  ? "bg-ink-900 text-white"
                  : "text-ink-600 hover:bg-primary-50 hover:text-ink-900"
              }`}
            >
              {t}
              <span
                className={`ml-1.5 font-mono ${
                  tab === t
                    ? "text-white/60"
                    : t === "Needs you" && counts[t] > 0
                      ? "rounded bg-amber-100 px-1 text-amber-800"
                      : "text-ink-400"
                }`}
              >
                {counts[t]}
              </span>
            </button>
          ))}
        </div>
      )}

      {proposals.isPending && (
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-xl bg-primary-100" />
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
              description={
                isSigner
                  ? "No proposals yet. Use “New proposal” to create one, or wait for the AI to draft one."
                  : "No pending proposals. When the AI drafts one, it shows up here for signers to approve."
              }
            />
          )}
          {list.length > 0 && filtered.length === 0 && (
            <EmptyState
              title={`No ${tab.toLowerCase()} proposals`}
              description="Try another status tab."
            />
          )}
          {filtered.map((p, i) => {
            const isPolled = execution?.id === p.id;
            const polled = isPolled ? liveProposal.data ?? null : null;
            const liveStatus = polled?.status;
            const executingNow =
              isPolled &&
              !!execution?.willExecute &&
              (liveStatus === undefined ||
                liveStatus === "Pending" ||
                (liveStatus === "Executed" &&
                  !!polled &&
                  isAsyncKind(polled.kind)));
            return (
              <ProposalCard
                key={p.id}
                p={p}
                myAccountId={myAccountId}
                config={config.data}
                liveProposal={polled}
                executing={executingNow}
                onAction={(id, kind) => {
                  if (kind === "approve") {
                    const target = list.find((x) => x.id === id);
                    setConfirmApprove(target ?? null);
                  } else {
                    onAction(id, kind);
                  }
                }}
                onExpire={(id) => expire.mutate({ id })}
                onExecuteAuto={(id) => {
                  setError(null);
                  executeAuto.mutate(
                    { id },
                    {
                      onSuccess: () =>
                        setExecution({
                          id,
                          until: Date.now() + 20_000,
                          willExecute: true,
                          settled: false,
                        }),
                    }
                  );
                }}
                busy={action.isPending || expire.isPending || executeAuto.isPending}
                delay={Math.min(120 + i * 90, 600)}
              />
            );
          })}
        </div>
      )}

      <ProposeModal
        open={proposeOpen}
        initialKind={proposeKind}
        onClose={() => setProposeOpen(false)}
        onSuccess={onProposeSuccess}
      />

      {/* Approve moves money once the threshold is met — confirm first. */}
      <ConfirmDialog
        open={confirmApprove !== null}
        title={`Approve proposal #${confirmApprove?.id ?? ""}?`}
        description={
          <>
            <span className="block font-semibold text-primary-950">
              {confirmApprove ? kindLabel(confirmApprove.kind) : ""}
            </span>
            <span className="mt-1 block text-xs font-medium text-ink-400">
              {confirmApprovals}/{confirmThreshold} valid approvals recorded
              {confirmWillExecute
                ? " · this is the deciding approval"
                : " · execution starts at the threshold"}
            </span>
            {confirmWillExecute ? (
              <span className="mt-2 block rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                This approval reaches the threshold and will execute
                immediately. It cannot be undone.
              </span>
            ) : (
              <span className="mt-2 block text-xs font-medium text-ink-600">
                Approving records your signature; nothing moves until the
                threshold is reached.
              </span>
            )}

            {confirmOnChain ? (
              <span className="mt-2 block rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                <span className="flex flex-wrap items-center gap-2">
                  <OnChainProofBadge attestation={confirmOnChain} />
                  <span>
                    The contract verified that {confirmOnChain.model} wrote this exact
                    proposal inside its TEE. That proves origin, not judgment: check the
                    recipient and amount.
                  </span>
                </span>
              </span>
            ) : (
            <span
              className={`mt-2 block rounded-xl border px-3 py-2 text-xs font-semibold ${
                !confirmIsAi
                  ? "border-primary-100 bg-primary-50 text-ink-600"
                  : confirmProof.isPending
                    ? "border-primary-100 bg-primary-50 text-ink-600"
                    : confirmProofInvalid
                      ? "border-red-200 bg-red-50 text-red-700"
                      : confirmProofPartial
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              <span className="flex flex-wrap items-center gap-2">
                <ProofBadge
                  status={confirmProofStatus}
                  human={!confirmIsAi}
                  loading={confirmIsAi && confirmProof.isPending}
                />
                <span>
                  {!confirmIsAi
                    ? "No AI attestation is expected for a human-proposed item."
                    : confirmProof.isPending
                      ? "Checking whether this AI draft has a valid proof…"
                      : confirmProofInvalid
                        ? "Warning: this proposal came from the AI proposer but has no valid proof. You are approving an AI draft that cannot be authenticated."
                        : confirmProofPartial
                          ? "The content signature matches, but the TEE report was not verified. This is not proof of TEE execution."
                          : `Proof passed: ${attestationStatusLabel(
                              confirmProofStatus ?? "none"
                            )}.`}
                </span>
              </span>
            </span>
            )}
          </>
        }
        confirmLabel="Approve"
        busy={action.isPending}
        onConfirm={() => {
          if (confirmApprove) onAction(confirmApprove.id, "approve");
          setConfirmApprove(null);
        }}
        onClose={() => setConfirmApprove(null)}
      />

      <ConfirmDialog
        open={confirmPause}
        title="Pause allocations and autonomy?"
        description="This single-signer kill switch stops every Allocate and every autonomous AI payout immediately. Signer-approved payouts and governance proposals keep working. Unpausing needs a SetPaused proposal and signer approvals."
        confirmLabel="Pause"
        danger
        busy={pause.isPending}
        onConfirm={() => {
          pause.mutate();
          setConfirmPause(false);
        }}
        onClose={() => setConfirmPause(false)}
      />
      </div>
    </AccessBar>
  );
}
