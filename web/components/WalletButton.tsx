"use client";
// Wallet connect/disconnect button. Reads wallet state client-side to avoid
// SSR mismatches and stays live across connect/disconnect. Connect opens the
// ghost-branded WalletModal with the registered NEAR wallet providers instead
// of the stock wallet-selector modal.

import { useEffect, useState } from "react";
import { getAccountId, signOut, subscribeAccountId } from "@/lib/near";
import WalletModal from "@/components/WalletModal";

export default function WalletButton() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    subscribeAccountId(setAccountId)
      .then((u) => (unsub = u))
      .catch(() => {});
    getAccountId()
      .then(setAccountId)
      .catch(() => setAccountId(null))
      .finally(() => setLoading(false));
    return () => unsub?.();
  }, []);

  if (loading) {
    return (
      <div className="h-9 w-32 animate-pulse rounded-lg bg-primary-100" />
    );
  }

  if (accountId) {
    return (
      <div className="flex items-center gap-1.5 animate-fade-in">
        <span className="inline-flex h-9 max-w-[180px] items-center gap-2 rounded-lg border border-line bg-white px-3 shadow-soft">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="truncate font-mono text-xs text-ink-900" title={accountId}>
            {accountId}
          </span>
        </span>
        <button
          onClick={() => signOut().catch(console.error)}
          className="inline-flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-ink-600 transition-colors hover:bg-primary-50 hover:text-ink-900"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        data-connect-wallet-trigger
        onClick={() => setModalOpen(true)}
        className="btn-primary h-9 animate-fade-in"
      >
        Connect wallet
      </button>
      <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
