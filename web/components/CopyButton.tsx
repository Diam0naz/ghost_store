"use client";
// Small copy-to-clipboard button for account ids, hashes and keys.

import { useState } from "react";
import Icon from "@/components/Icon";

export default function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === "copied" ? "Copied" : `${label}: ${value}`}
      title={state === "failed" ? "Clipboard unavailable" : state === "copied" ? "Copied" : label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-primary-100 hover:text-ink-900"
    >
      {state === "copied" ? (
        <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" />
      ) : state === "failed" ? (
        <Icon name="x" className="h-3.5 w-3.5 text-red-600" />
      ) : (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 012-2h10" />
        </svg>
      )}
    </button>
  );
}
