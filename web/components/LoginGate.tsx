"use client";
// Login gate used by the treasury page: Privy sign-in when configured, with a
// NEAR wallet-selector fallback when Privy is not configured.
//
// On first successful login a NEAR function-call keypair (ed25519) is issued
// client-side, its public key is persisted in localStorage and shown in the
// UI so the merchant can register it on the treasury account with add_key
// (FunctionCall-only for propose/approve/reject) — the credential the merchant
// infrastructure uses to sign treasury calls from this device.
//
// NOTE: privyAvailable is read at module scope from the public env var, so the
// Privy hook is only ever mounted when PrivyProviderWrapper is active above.

import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { KeyPair } from "near-api-js";
import WalletButton from "@/components/WalletButton";
import Logo from "@/components/Logo";
import { getAccountId } from "@/lib/near";

export const privyAvailable = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const FC_KEY_STORAGE = "ghost-store-fc-key";

interface FcKeyRecord {
  publicKey: string;
  createdAt: string;
}

function getFcKey(): FcKeyRecord | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(FC_KEY_STORAGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FcKeyRecord;
  } catch {
    return null;
  }
}

function issueFcKey(): FcKeyRecord {
  const pair = KeyPair.fromRandom("ed25519");
  const record: FcKeyRecord = {
    publicKey: pair.getPublicKey().toString(),
    createdAt: new Date().toISOString(),
  };
  window.localStorage.setItem(FC_KEY_STORAGE, JSON.stringify(record));
  return record;
}

/** Sign-out screen shared by both auth paths. */
function SignedOutScreen({ onPrivyLogin }: { onPrivyLogin?: () => void }) {
  return (
    <div className="card p-10 text-center">
      <Logo size={64} className="mx-auto mb-6" />
      <h2 className="mb-2 text-xl font-extrabold text-primary-950">
        Sign in to the Treasury
      </h2>
      <p className="mx-auto mb-6 max-w-sm text-sm font-medium text-ink-600">
        Treasury actions are restricted to M-of-N signer accounts. Sign in to
        view proposals and approve with your signer key.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {onPrivyLogin && (
          <button onClick={onPrivyLogin} className="btn-primary">
            Continue with email / social
          </button>
        )}
        <WalletButton />
      </div>
      {!privyAvailable && (
        <p className="mt-3 text-xs font-medium text-ink-400">
          Privy is not configured (NEXT_PUBLIC_PRIVY_APP_ID) — NEAR wallet login
          is enabled instead.
        </p>
      )}
    </div>
  );
}

/** Key-issued banner shared by both signed-in paths. */
function FcKeyBanner() {
  const fcKey = useState(() => getFcKey())[0];
  if (!fcKey) return null;
  return (
    <div className="mb-4 rounded-2xl border border-primary-100 bg-primary-50 px-4 py-3 text-xs font-medium text-ink-600">
      🔑 Function-call key issued on first login:{" "}
      <code className="font-mono text-primary-800">{fcKey.publicKey}</code>
      <span className="text-ink-400">
        {" "}
        · register it with add_key on the treasury (propose/approve/reject only)
        so this device can sign treasury calls.
      </span>
    </div>
  );
}

export default function LoginGate({ children }: { children: React.ReactNode }) {
  return privyAvailable ? <PrivyGate>{children}</PrivyGate> : <WalletGate>{children}</WalletGate>;
}

/** Privy-authenticated gate (PrivyProviderWrapper is mounted in layout). */
function PrivyGate({ children }: { children: React.ReactNode }) {
  const { authenticated, login, ready } = usePrivy();
  const [nearAccountId, setNearAccountId] = useState<string | null>(null);
  const [keyIssued, setKeyIssued] = useState(false);

  useEffect(() => {
    getAccountId()
      .then(setNearAccountId)
      .catch(() => setNearAccountId(null));
  }, []);

  // Issue the NEAR function-call key on first login.
  useEffect(() => {
    if (!authenticated) return;
    if (getFcKey()) {
      setKeyIssued(true);
      return;
    }
    try {
      issueFcKey();
      setKeyIssued(true);
    } catch (e) {
      console.error("Failed to issue function-call key:", e);
    }
  }, [authenticated]);

  if (ready && !authenticated && !nearAccountId) {
    return <SignedOutScreen onPrivyLogin={() => login()} />;
  }

  return (
    <>
      {keyIssued && <FcKeyBanner />}
      {children}
    </>
  );
}

/** Fallback gate: NEAR wallet only (used while Privy is unconfigured). */
function WalletGate({ children }: { children: React.ReactNode }) {
  const [nearAccountId, setNearAccountId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [keyIssued, setKeyIssued] = useState(false);

  useEffect(() => {
    getAccountId()
      .then(setNearAccountId)
      .catch(() => setNearAccountId(null))
      .finally(() => setChecked(true));
  }, []);

  useEffect(() => {
    if (!nearAccountId) return;
    if (getFcKey()) {
      setKeyIssued(true);
      return;
    }
    try {
      issueFcKey();
      setKeyIssued(true);
    } catch (e) {
      console.error("Failed to issue function-call key:", e);
    }
  }, [nearAccountId]);

  if (checked && !nearAccountId) {
    return <SignedOutScreen />;
  }

  return (
    <>
      {keyIssued && <FcKeyBanner />}
      {children}
    </>
  );
}
