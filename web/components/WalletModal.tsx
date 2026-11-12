"use client";
import { friendlyError } from "@/components/ErrorState";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connectWallet, WALLET_OPTIONS } from "@/lib/near";
import Logo from "@/components/Logo";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { findMetaMask, METAMASK_FALLBACK_ICON, METAMASK_MISSING } from "@/lib/evm";

// ---------------------------------------------------------------------------
// Wallet connect modal — Ghost-branded NEAR wallet connect dialog.
//
// Rendered through a single React portal into document.body so no ancestor with
// transform, filter, will-change, contain, overflow or position can clip or
// contain the fixed overlay. z-index layering: sticky navbar z-40, backdrop
// z-50, modal card z-60.
// ---------------------------------------------------------------------------

type WalletId = (typeof WALLET_OPTIONS)[number]["id"];

// ---------------------------------------------------------------------------
// Scroll lock with layout-shift protection.
// ---------------------------------------------------------------------------

function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    // Preserve whatever the user already had, and restore it on cleanup.
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevScrollbarGutter = document.documentElement.style.scrollbarGutter;

    // Keep the page size stable when the scrollbar disappears under overflow:
    // hidden. `scrollbar-gutter: stable` reserves the scrollbar track so the
    // content does not reflow when the modal opens.
    document.documentElement.style.scrollbarGutter = "stable";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.documentElement.style.scrollbarGutter = prevScrollbarGutter;
    };
  }, [active]);
}

// ---------------------------------------------------------------------------
// WalletModal
// ---------------------------------------------------------------------------

export default function WalletModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [connectingId, setConnectingId] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brokenIcons, setBrokenIcons] = useState<Record<WalletId, boolean>>(
    () =>
      Object.fromEntries(
        WALLET_OPTIONS.map((w) => [w.id, false])
      ) as Record<WalletId, boolean>
  );

  // EVM wallet (MetaMask) via wagmi: the same connection the checkout uses to pay.
  const evm = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect: disconnectEvm } = useDisconnect();
  const [evmBusy, setEvmBusy] = useState(false);
  const metaMask = findMetaMask(connectors);
  const metaMaskIcon = metaMask?.icon ?? METAMASK_FALLBACK_ICON;

  async function connectMetaMask() {
    setError(null);
    if (!metaMask) {
      setError(METAMASK_MISSING);
      return;
    }
    setEvmBusy(true);
    try {
      await connectAsync({ connector: metaMask });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied/i.test(msg) ? "You cancelled the MetaMask request." : msg);
    } finally {
      setEvmBusy(false);
    }
  }

  const cardRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<() => void>(() => {});

  // Lock page scroll while the modal is open.
  useScrollLock(open);

  // Escape closes the modal from anywhere on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus trap: active only while the modal is mounted and open.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (!card) return;

    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const first = focusable[0] ?? null;
    const last = focusable[focusable.length - 1] ?? null;

    const previousFocus = document.activeElement as HTMLElement | null;
    first?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || focusable.length === 0) return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };

    card.addEventListener("keydown", trap);
    return () => {
      card.removeEventListener("keydown", trap);
      // Return focus to the "Connect Wallet" trigger on close.
      const trigger = document.querySelector<HTMLButtonElement>("[data-connect-wallet-trigger]");
      trigger?.focus();
    };
  }, [open]);

  // Reset transient state when the modal reopens.
  useEffect(() => {
    if (open) {
      setError(null);
      setConnectingId(null);
    }
  }, [open]);

  async function connect(id: WalletId) {
    setError(null);
    setConnectingId(id);
    try {
      await connectWallet(id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not installed|no provider/i.test(msg)) {
        setError("That wallet isn't installed in this browser.");
      } else {
        const friendly = friendlyError(e);
        setError(friendly.startsWith("Something went wrong") ? msg : friendly);
      }
      setConnectingId(null);
    }
  }

  if (!open) return null;

  const overlay = (
    <div
      className="fixed inset-0 z-50 flex min-h-screen items-center justify-center bg-[rgba(36,14,77,0.55)] p-4 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
      aria-hidden="false"
      tabIndex={-1}
    >
      <div
        ref={cardRef}
        className="relative z-60 w-full max-w-[420px] max-h-[90dvh] overflow-y-auto rounded-xl border border-primary-100 bg-white p-6 shadow-2xl animate-modal-in"
        style={{ animationDelay: "80ms" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo size={38} />
            <div>
              <h2
                id="wallet-modal-title"
                className="text-lg font-semibold leading-tight text-primary-950"
              >
                Connect a wallet
              </h2>
              <p className="text-xs font-medium text-ink-400">
                Function-call access keys only — never your full key
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet connect modal"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-primary-100 hover:text-primary-700"
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
                type="button"
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

        <div className="mt-5 border-t border-line pt-4">
          <p className="eyebrow mb-2">Pay at checkout (mainnet)</p>
          {evm.isConnected && evm.address ? (
            <div className="flex items-center gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3">
              <img src={metaMaskIcon} alt="" width={40} height={40} aria-hidden="true" className="h-10 w-10 shrink-0 rounded-xl" />
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-primary-950">{evm.connector?.name ?? "EVM wallet"} connected</span>
                <span className="block truncate font-mono text-xs text-ink-400" title={evm.address}>{evm.address}</span>
              </span>
              <button type="button" onClick={() => disconnectEvm()} className="text-xs font-medium text-ink-600 hover:text-ink-900">
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={connectMetaMask}
              disabled={evmBusy || connectingId !== null}
              className="group flex w-full items-center gap-3 rounded-xl border border-primary-100 bg-white px-4 py-3 text-left transition-all hover:border-primary-300 hover:bg-primary-50 disabled:cursor-wait disabled:opacity-60"
            >
              <img src={metaMaskIcon} alt="" width={40} height={40} aria-hidden="true" className="h-10 w-10 shrink-0 rounded-xl shadow-soft transition-transform group-hover:scale-105" />
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-primary-950">MetaMask</span>
                <span className="block text-xs font-medium text-ink-400">
                  {evmBusy ? "Check MetaMask…" : "Pay from BNB Chain, Base, Arbitrum, Polygon or Ethereum"}
                </span>
              </span>
              <span className="text-ink-400 transition-all group-hover:translate-x-0.5 group-hover:text-primary-600">→</span>
            </button>
          )}
          <p className="mt-2 text-[11px] font-medium text-ink-400">
            For paying only. Approving or vetoing treasury actions needs a NEAR wallet above.
          </p>
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

  return createPortal(overlay, document.body);
}
