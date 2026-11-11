"use client";

import { useEffect } from "react";
import { OnChainProofBadge, OnChainProofDetails } from "@/components/OnChainProof";
import {
  attestationStatusMessage,
  formatUtc,
  isAiProposal,
  type AttestationCheck,
  type AttestationVerification,
} from "@/lib/attestation";
import {
  failureReason,
  kindLabel,
  type Proposal,
} from "@/lib/proposals";
import { NETWORK, TREASURY_CONTRACT_ID } from "@/lib/near";
import ProofBadge from "@/components/ProofBadge";

const EXPLORER_BASE =
  NETWORK === "mainnet"
    ? "https://nearblocks.io"
    : "https://testnet.nearblocks.io";

function addressUrl(accountId: string): string {
  return `${EXPLORER_BASE}/address/${encodeURIComponent(accountId)}`;
}

function CheckRow({ check }: { check: AttestationCheck }) {
  const icon =
    check.status === "pass" ? "✓" : check.status === "fail" ? "✕" : "–";
  const iconClass =
    check.status === "pass"
      ? "bg-emerald-100 text-emerald-700"
      : check.status === "fail"
        ? "bg-red-100 text-red-700"
        : "bg-amber-100 text-amber-700";
  return (
    <li className="flex gap-3 py-2">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${iconClass}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-bold text-primary-950">
          {check.label}
          <span className="ml-1.5 font-medium text-ink-400">
            {check.status === "not_performed" ? "not performed" : check.status}
          </span>
        </span>
        <span className="mt-0.5 block break-words text-xs font-medium text-ink-600">
          {check.reason}
        </span>
      </span>
    </li>
  );
}

function TimelineRow({
  tone,
  title,
  children,
  last = false,
}: {
  tone: "done" | "current" | "bad" | "muted";
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  const dot =
    tone === "done"
      ? "bg-emerald-500"
      : tone === "bad"
        ? "bg-red-500"
        : tone === "current"
          ? "bg-amber-500"
          : "bg-primary-200";
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && (
        <span className="absolute left-[5px] top-3 h-full w-px bg-primary-100" aria-hidden="true" />
      )}
      <span className={`relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-xs font-bold text-primary-950">{title}</span>
        <span className="mt-0.5 block break-words text-xs font-medium text-ink-600">
          {children}
        </span>
      </span>
    </li>
  );
}

export default function ProofDrawer({
  open,
  proposal,
  verification,
  loading,
  error,
  onClose,
  onRefresh,
  refreshing = false,
}: {
  open: boolean;
  proposal: Proposal;
  verification?: AttestationVerification;
  loading: boolean;
  error: Error | null;
  onClose: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onChain = proposal.attestation ?? null;
  // On-chain attested proposals are verified by the contract: skip the off-chain record views.
  const human = !isAiProposal(proposal.proposer);
  const offChain = !human && !onChain;
  const status = verification?.status;
  const checks = verification?.checks ?? [];
  const record = verification?.record ?? null;
  const outcome =
    proposal.status === "Executed"
      ? "Executed on chain"
      : proposal.status === "Failed"
        ? "Execution failed"
        : proposal.status === "Rejected"
          ? "Rejected by signers"
          : proposal.status === "Expired"
            ? "Expired before approval"
            : "Waiting for approvals";

  function download() {
    const payload = verification ?? {
      status: "none",
      proposalId: proposal.id,
      checks: [],
      record: null,
      fetchedAt: new Date().toISOString(),
      message: "No attestation verification was available.",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `proposal-${proposal.id}-attestation.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-primary-950/40 p-0 backdrop-blur-sm animate-fade-in sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${human ? "Timeline" : "Proof and timeline"} for proposal ${proposal.id}`}
      onClick={onClose}
    >
      <div
        className="card max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-6 animate-modal-in sm:rounded-xl"
        style={{ animationDelay: "80ms" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-ink-400">#{proposal.id}</p>
            <h2 className="mt-0.5 text-lg font-semibold leading-tight text-primary-950">
              {human ? "Proposal timeline" : "AI draft proof & timeline"}
            </h2>
            <p className="mt-1 text-sm font-semibold text-ink-600">
              {kindLabel(proposal.kind)}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {onChain ? (
              <OnChainProofBadge attestation={onChain} />
            ) : (
              <ProofBadge status={status} human={human} loading={loading} />
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-ink-400 transition-colors hover:text-primary-700"
            >
              ✕
            </button>
          </div>
        </div>

        {onChain && (
          <div className="mt-4">
            <OnChainProofDetails attestation={onChain} />
          </div>
        )}

        {offChain && (
          <div
            className={`mt-4 rounded-xl px-3 py-2 text-xs font-semibold ${
              loading
                ? "bg-primary-50 text-ink-600"
                : status === "verified"
                  ? "bg-emerald-50 text-emerald-800"
                  : status === "mismatch"
                    ? "bg-red-50 text-red-700"
                    : status === "partial"
                      ? "bg-amber-50 text-amber-800"
                      : "bg-gray-100 text-gray-700"
            }`}
          >
            {loading
              ? "Checking the attestation service…"
              : error
                ? "The attestation service could not be reached. No proof status is available."
                : attestationStatusMessage(status ?? "none")}
          </div>
        )}

        {human && (
          <div className="mt-4 rounded-xl bg-primary-50 px-3 py-2 text-xs font-semibold text-ink-600">
            This proposal was created by a signer, not the AI proposer. No AI
            attestation is expected.
          </div>
        )}

        {offChain && (
          <>
            <section className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-primary-950">
                  Verification checklist
                </h3>
                <button
                  onClick={onRefresh}
                  disabled={refreshing}
                  className="rounded-full border border-primary-200 bg-white px-3 py-1 text-[11px] font-semibold text-primary-700 transition-colors hover:border-primary-400 hover:bg-primary-50 disabled:opacity-40"
                >
                  {refreshing ? "Refreshing…" : "Refresh proof"}
                </button>
              </div>
              {loading && checks.length === 0 ? (
                <div className="mt-3 space-y-2">
                  <div className="h-10 animate-pulse rounded-lg bg-primary-100" />
                  <div className="h-10 animate-pulse rounded-lg bg-primary-100" />
                </div>
              ) : checks.length > 0 ? (
                <ul className="mt-2 divide-y divide-primary-50">
                  {checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs font-medium text-ink-600">
                  {error
                    ? "No checklist is available because the proof service could not be reached."
                    : "No checklist is available. There may be no record for this proposal."}
                </p>
              )}
            </section>

            <section className="mt-5 rounded-xl border border-primary-100 bg-primary-50/60 p-4">
              <h3 className="text-sm font-semibold text-primary-950">
                What this does and does not prove
              </h3>
              <p className="mt-1 text-xs font-medium text-ink-600">
                A valid signature proves that the holder of the listed ed25519
                key signed this exact proposal content. It does not prove that
                the AI model ran inside a TEE, that the rationale is correct, or
                that the payment is a good idea. Those claims require a verified
                hardware report and a trusted measurement.
              </p>
              {status === "partial" && (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  At least one check was not performed, so the status is
                  “partially verified” even when the signature is valid.
                </p>
              )}
              {status === "none" && (
                <p className="mt-2 text-xs font-semibold text-gray-600">
                  No record was published. This is an ordinary on-chain
                  proposal, not an AI-attested one.
                </p>
              )}
            </section>

            {record && (
              <section className="mt-5">
                <h3 className="text-sm font-semibold text-primary-950">
                  Record details
                </h3>
                <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-ink-400">Provider</dt>
                    <dd className="break-words font-medium text-primary-950">
                      {verification?.provider || record?.provider || "unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-ink-400">Issued at</dt>
                    <dd className="font-medium text-primary-950">
                      {formatUtc(verification?.issuedAt ?? record?.issuedAt)}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-semibold text-ink-400">Measurement</dt>
                    <dd className="break-all font-mono text-[11px] text-primary-950">
                      {verification?.measurement || record?.measurement || "not provided"}
                    </dd>
                  </div>
                  {record?.contentHash && (
                    <div className="sm:col-span-2">
                      <dt className="font-semibold text-ink-400">Content hash</dt>
                      <dd className="break-all font-mono text-[11px] text-primary-950">
                        {record.contentHash}
                      </dd>
                    </div>
                  )}
                </dl>
                {record?.teePublicKey && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-primary-700">
                      Show signing public key
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-primary-950 p-3 text-[10px] leading-relaxed text-primary-100">
                      {record.teePublicKey}
                    </pre>
                  </details>
                )}
                <button
                  onClick={download}
                  className="mt-3 rounded-full border border-primary-200 bg-white px-4 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:border-primary-400 hover:bg-primary-50"
                >
                  ⬇ Download proof JSON
                </button>
              </section>
            )}
          </>
        )}

        <section className="mt-5 border-t border-primary-100 pt-4">
          <h3 className="text-sm font-semibold text-primary-950">Timeline</h3>
          <ol className="mt-3">
            <TimelineRow tone="done" title="Proposed">
              {formatUtc(proposal.created_at_ms)} ·{" "}
              <a
                href={addressUrl(proposal.proposer)}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary-700 underline decoration-primary-200 underline-offset-2 hover:text-primary-900"
              >
                {proposal.proposer}
              </a>
            </TimelineRow>

            {offChain && (
              <TimelineRow
                tone={
                  status === "verified"
                    ? "done"
                    : status === "mismatch" || status === "error"
                      ? "bad"
                      : "current"
                }
                title="Proof"
              >
                {loading
                  ? "Checking the attestation service…"
                  : error
                    ? "Attestation service unreachable"
                    : `${verification?.status ?? "none"} · ${
                        formatUtc(verification?.issuedAt ?? null)
                      }`}
                {status === "partial" && " · report not performed"}
              </TimelineRow>
            )}

            <TimelineRow
              tone={
                proposal.approvals.length > 0
                  ? "done"
                  : proposal.status === "Pending"
                    ? "current"
                    : "muted"
              }
              title={`Approvals (${proposal.approvals.length})`}
            >
              {proposal.approvals.length === 0 ? (
                "No approvals recorded yet."
              ) : (
                <span className="flex flex-wrap gap-x-2 gap-y-1">
                  {proposal.approvals.map((signer) => (
                    <a
                      key={signer}
                      href={addressUrl(signer)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-primary-700 underline decoration-primary-200 underline-offset-2 hover:text-primary-900"
                    >
                      {signer}
                    </a>
                  ))}
                </span>
              )}
            </TimelineRow>

            <TimelineRow
              tone={
                proposal.status === "Executed"
                  ? "done"
                  : proposal.status === "Failed"
                    ? "bad"
                    : proposal.status === "Pending"
                      ? "current"
                      : "muted"
              }
              title={outcome}
              last
            >
              {proposal.status === "Failed" ? (
                failureReason(proposal)
              ) : (
                <span>
                  {proposal.status === "Pending"
                    ? "Executes automatically when the signer threshold is met."
                    : "Status read from the treasury contract."}{" "}
                  {TREASURY_CONTRACT_ID && (
                    <a
                      href={addressUrl(TREASURY_CONTRACT_ID)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-primary-700 underline decoration-primary-200 underline-offset-2 hover:text-primary-900"
                    >
                      View treasury on NEAR Blocks ↗
                    </a>
                  )}
                </span>
              )}
            </TimelineRow>
          </ol>
          <p className="mt-2 text-[11px] font-medium text-ink-400">
            The contract stores proposer and signer account ids, not transaction
            hashes. Explorer links open the accounts and treasury contract.
          </p>
        </section>
      </div>
    </div>
  );
}
