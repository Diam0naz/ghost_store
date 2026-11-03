"use client";
// Wallet connect/disconnect button. Reads wallet state client-side to avoid
// SSR mismatches. Shows account ID when connected.

import { useEffect, useState } from "react";
import { getAccountId, signIn, signOut } from "@/lib/near";

export default function WalletButton() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAccountId()
      .then(setAccountId)
      .catch(() => setAccountId(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="h-8 w-28 rounded-lg bg-gray-800 animate-pulse" />
    );
  }

  if (accountId) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 font-mono max-w-[140px] truncate">{accountId}</span>
        <button
          onClick={() => signOut().then(() => setAccountId(null))}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => signIn().catch(console.error)}
      className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors"
    >
      Connect Wallet
    </button>
  );
}
