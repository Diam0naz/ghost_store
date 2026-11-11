"use client";

import Icon from "@/components/Icon";
import {
  attestationStatusLabel,
  type AttestationStatus,
} from "@/lib/attestation";

const STYLES: Record<AttestationStatus, string> = {
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
  partial: "bg-amber-50 text-amber-700 ring-amber-200/70",
  mismatch: "bg-red-50 text-red-700 ring-red-200/70",
  none: "bg-surface text-ink-600 ring-line",
  error: "bg-surface text-ink-600 ring-line",
};

const TITLES: Record<AttestationStatus, string> = {
  verified:
    "The signed record matches this proposal and every required check passed.",
  partial:
    "The signed record matches this proposal, but some checks were not performed. Not proof of TEE execution.",
  mismatch:
    "At least one attestation check failed. Do not treat this proposal as AI-attested.",
  none: "No attestation record was published for this proposal.",
  error: "The attestation service could not be reached.",
};

export default function ProofBadge({
  status,
  human = false,
  loading = false,
  className = "",
}: {
  status?: AttestationStatus;
  human?: boolean;
  loading?: boolean;
  className?: string;
}) {
  if (human) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-600 ring-1 ring-line ${className}`}
        title="A signer created this proposal. No AI attestation is expected."
      >
        <Icon name="user" className="h-3.5 w-3.5" /> Human-proposed
      </span>
    );
  }

  if (loading || !status) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-400 ring-1 ring-line ${className}`}
        title="Checking the attestation service."
      >
        … Checking proof
      </span>
    );
  }

  const icon =
    status === "verified"
      ? "✓"
      : status === "partial"
        ? "◐"
        : status === "mismatch"
          ? "✕"
          : status === "none"
            ? "—"
            : "?";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${STYLES[status]} ${className}`}
      title={TITLES[status]}
    >
      <span aria-hidden="true">{icon}</span>
      {attestationStatusLabel(status)}
    </span>
  );
}
