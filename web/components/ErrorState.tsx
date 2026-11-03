"use client";
// Error-state illustration: the floating, blinking mascot with a question
// mark "confused" look, a user-facing message and a collapsible technical
// detail section with a Retry action. Used wherever a data load fails.

import { GHOST_BODY } from "@/components/Logo";

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/GuestPanic|deserialize|wasm execution/i.test(raw)) {
    return "The treasury contract couldn't answer that request. It may need to be updated or redeployed.";
  }
  if (/Failed to fetch|networkerror|NetworkError|when all errors are/i.test(raw)) {
    return "Can't reach the NEAR network right now. Check your connection and try again.";
  }
  if (/account .* has not been found|does not exist while viewing/i.test(raw)) {
    return "The treasury contract doesn't exist at the configured address. Check NEXT_PUBLIC_TREASURY_CONTRACT_ID.";
  }
  if (/unsupported scheme|no such method|MethodNotFound/i.test(raw)) {
    return "The treasury contract is missing a method — it may need redeployment.";
  }
  return "Something went wrong while talking to the treasury.";
}

function cleanDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\n+/g, " ").trim().slice(0, 220);
}

export default function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="card relative overflow-hidden px-8 py-12 text-center">
      {/* Floating mascot with a "?" badge */}
      <div className="relative mx-auto h-24 w-24">
        <svg
          viewBox="0 0 64 64"
          className="animate-ghost-float mx-auto h-24 w-24 drop-shadow-[0_12px_20px_rgb(122_47_240_/_0.28)]"
          aria-hidden="true"
        >
          <path d={GHOST_BODY} fill="var(--color-primary-200)" />
          <ellipse cx="26.5" cy="20" rx="2.4" ry="3.2" fill="var(--color-primary-950)" />
          <ellipse cx="37.5" cy="20" rx="2.4" ry="3.2" fill="var(--color-primary-950)" />
          {/* worried angled brows */}
          <path d="M23 14.6 L29 15.8" stroke="var(--color-primary-950)" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M41 15.8 L35 14.6" stroke="var(--color-primary-950)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="absolute -right-1 top-0 flex h-7 w-7 items-center justify-center rounded-full bg-red-100 text-sm font-black text-red-600 shadow-soft">
          !
        </span>
      </div>

      <h3 className="mt-5 text-lg font-bold text-primary-950">
        {friendlyError(error)}
      </h3>

      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="btn-ghost mt-4 text-sm"
        >
          {retrying ? "Retrying…" : "Try again"}
        </button>
      )}

      <details className="mt-4 text-left">
        <summary className="cursor-pointer text-center text-xs font-semibold text-ink-400 hover:text-primary-700">
          Technical details
        </summary>
        <code className="mt-2 block break-words rounded-xl bg-primary-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-600">
          {cleanDetail(error)}
        </code>
      </details>
    </div>
  );
}
