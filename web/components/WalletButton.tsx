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
      <div className="h-9 w-28 animate-pulse rounded-full bg-primary-200" />
    );
  }

  if (accountId) {
    return (
      <div className="flex items-center gap-2">
        <span className="max-w-[140px] truncate rounded-full bg-primary-100 px-3 py-1 font-mono text-xs font-semibold text-primary-800">
          {accountId}
        </span>
        <button
          onClick={() => signOut().catch(console.error)}
          className="rounded-full border border-primary-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-600 transition-colors hover:border-primary-400 hover:text-primary-700"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        className="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-bold text-white shadow-soft transition-colors hover:bg-primary-700"
      >
        Connect Wallet
      </button>
      <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
