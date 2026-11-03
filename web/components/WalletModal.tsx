"use client";
// Ghost-branded NEAR wallet connect modal. Replaces the stock wallet-selector
// modal so sign-in matches the app's purple rounded design. Options come from
// WALLET_OPTIONS (registered providers in lib/near.ts).

import { useEffect, useState } from "react";
import { connectWallet, WALLET_OPTIONS } from "@/lib/near";
import Logo from "@/components/Logo";

export default function WalletModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Wallets whose icon failed to load fall back to the monogram tile.
  const [brokenIcons, setBrokenIcons] = useState<Record<string, boolean>>({});

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function connect(id: string) {
    setError(null);
    setConnectingId(id);
    try {
      // Redirect wallets navigate away; extension wallets resolve in place.
      await connectWallet(id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not installed|no provider/i.test(msg)) {
        setError("That wallet isn't installed in this browser.");
      } else {
        setError(msg);
      }
      setConnectingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Connect a NEAR wallet"
    >
      <div
        className="card w-full max-w-sm overflow-hidden p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Logo size={38} />
            <div>
              <h2 className="text-lg font-extrabold leading-tight text-primary-950">
                Connect a NEAR wallet
              </h2>
              <p className="text-xs font-medium text-ink-400">
                Function-call access keys only — never your full key
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-primary-100 hover:text-primary-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          {WALLET_OPTIONS.map((w) => {
            const busy = connectingId === w.id;
            return (
              <button
                key={w.id}
                onClick={() => connect(w.id)}
                disabled={connectingId !== null}
                className="group flex w-full items-center gap-3 rounded-xl border border-primary-100 bg-white px-4 py-3 text-left transition-all hover:border-primary-300 hover:bg-primary-50 disabled:cursor-wait disabled:opacity-60"
              >
                {brokenIcons[w.id] ? (
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-black text-white shadow-soft ${w.gradient}`}
                  >
                    {w.monogram}
                  </span>
                ) : (
                  <img
                    src={w.icon}
                    alt=""
                    width={40}
                    height={40}
                    aria-hidden="true"
                    onError={() =>
                      setBrokenIcons((prev) => ({ ...prev, [w.id]: true }))
                    }
                    className={`h-10 w-10 shrink-0 rounded-xl object-cover shadow-soft transition-transform group-hover:scale-105 ${busy ? "opacity-60" : ""}`}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-bold text-primary-950">
                    {w.name}
                  </span>
                  <span className="block text-xs font-medium text-ink-400">
                    {busy ? "Opening…" : w.description}
                  </span>
                </span>
                <span className="text-ink-400 transition-all group-hover:translate-x-0.5 group-hover:text-primary-600">
                  →
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
            {error}
          </p>
        )}

        <p className="mt-4 text-center text-[11px] font-medium text-ink-400">
          Redirect wallets return to this page automatically after sign-in.
        </p>
      </div>
    </div>
  );
}
