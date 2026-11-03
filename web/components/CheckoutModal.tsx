"use client";
// Payment progress modal for checkout. Shows the three things a customer cares
// about while paying: confirm in wallet → money arrives → converted to USDC.
// It only closes itself when the payment reaches a terminal state, so a
// half-finished swap can't be dismissed by accident.

import { useEffect } from "react";

export type StepState = "todo" | "active" | "done" | "error";

export interface CheckoutStep {
  label: string;
  state: StepState;
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "active") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
      </span>
    );
  }
  const styles: Record<Exclude<StepState, "active">, string> = {
    done: "bg-primary-600 text-white",
    error: "bg-red-500 text-white",
    todo: "border border-primary-200 text-ink-400",
  };
  const glyph: Record<Exclude<StepState, "active">, string> = {
    done: "✓",
    error: "✕",
    todo: "•",
  };
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-black ${styles[state]}`}
    >
      {glyph[state]}
    </span>
  );
}

export default function CheckoutModal({
  open,
  title,
  description,
  steps,
  error,
  summary,
  reference,
  txUrl,
  onClose,
  canClose,
}: {
  open: boolean;
  title: string;
  description: string;
  steps: CheckoutStep[];
  error?: string | null;
  summary?: React.ReactNode;
  reference: string;
  txUrl?: string | null;
  onClose: () => void;
  canClose: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && canClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, canClose, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary-950/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Payment progress"
    >
      <div className="card w-full max-w-sm p-6">
        <h2 className="text-lg font-extrabold leading-tight text-primary-950">
          {title}
        </h2>
        <p className="mt-1 text-sm font-medium text-ink-600">{description}</p>

        <ul className="mt-5 space-y-3">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-3">
              <StepIcon state={step.state} />
              <span
                className={`text-sm font-semibold ${
                  step.state === "todo"
                    ? "text-ink-400"
                    : step.state === "error"
                    ? "text-red-600"
                    : "text-primary-950"
                }`}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ul>

        {summary && (
          <div className="mt-5 rounded-xl bg-primary-50 px-4 py-3 text-xs font-medium text-ink-600">
            {summary}
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
            {error}
          </p>
        )}

        {txUrl && (
          <a
            href={txUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-xs font-bold text-primary-700 underline decoration-primary-300 underline-offset-2 hover:text-primary-800"
          >
            View the transaction ↗
          </a>
        )}

        <p className="mt-4 text-[11px] font-medium text-ink-400">
          Order reference: <span className="font-mono">{reference}</span>
        </p>

        {canClose ? (
          <button onClick={onClose} className="btn-primary mt-4 w-full">
            Close
          </button>
        ) : (
          <p className="mt-4 text-center text-[11px] font-medium text-ink-400">
            Keep this window open while the payment completes.
          </p>
        )}
      </div>
    </div>
  );
}
