"use client";
// Role-aware access bar shown above the treasury, dashboard and flows pages.
//
// Treasury data is public on chain, so nothing is hidden behind sign-in. The bar tells the
// visitor what they can do: view only, act as a signer, or (for the AI proposer account)
// propose but not approve. Every action is still signed by the connected NEAR wallet, and the
// contract enforces roles regardless of what the UI shows.

import Icon, { type IconName } from "@/components/Icon";
import { NETWORK, TREASURY_CONTRACT_ID, useAccountId } from "@/lib/near";
import { useTreasuryConfig } from "@/lib/proposals";
import { explorerAccountUrl } from "@/lib/explorer";

type Role = "guest" | "signer" | "proposer" | "viewer" | "wrong-network";

function roleOf(accountId: string | null, signers: string[], proposer: string | undefined): Role {
  if (!accountId) return "guest";
  const suffix = NETWORK === "mainnet" ? ".near" : ".testnet";
  if (!accountId.endsWith(suffix) && !/^[0-9a-f]{64}$/.test(accountId)) return "wrong-network";
  if (signers.includes(accountId)) return "signer";
  if (accountId === proposer) return "proposer";
  return "viewer";
}

const COPY: Record<Role, { icon: IconName; tone: string; title: string; body: string }> = {
  guest: {
    icon: "eyeOff",
    tone: "border-line bg-white text-ink-600",
    title: "Read-only view",
    body: "Everything here is public on chain. Use Connect wallet (top right) with a signer account to approve, veto or pause.",
  },
  signer: {
    icon: "shield",
    tone: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
    title: "Signer",
    body: "You can approve, reject and veto proposals, and pause the treasury.",
  },
  proposer: {
    icon: "bot",
    tone: "border-primary-200 bg-primary-50 text-primary-900",
    title: "AI proposer account",
    body: "This account can create proposals but can never approve or execute them.",
  },
  viewer: {
    icon: "info",
    tone: "border-amber-200 bg-amber-50/70 text-amber-900",
    title: "Not a signer",
    body: "This account isn't a signer on this treasury, so approve and veto are disabled. Anyone can still execute an autonomy payout after its veto window.",
  },
  "wrong-network": {
    icon: "alert",
    tone: "border-red-200 bg-red-50 text-red-800",
    title: "Wrong network",
    body: `This treasury runs on NEAR ${NETWORK}. Switch your wallet to a ${NETWORK} account.`,
  },
};

/** Page-specific wording for visitors who aren't signers (e.g. vendors on /invoices). */
export interface AccessCopy {
  guest?: string;
  viewer?: string;
}

export default function AccessBar({ children, copy }: { children: React.ReactNode; copy?: AccessCopy }) {
  const accountId = useAccountId();
  const config = useTreasuryConfig();
  const role = roleOf(accountId, config.data?.signers ?? [], config.data?.proposer);
  const base = COPY[role];
  const c = {
    ...base,
    body: (role === "guest" && copy?.guest) || (role === "viewer" && copy?.viewer) || base.body,
    tone: role === "viewer" && copy?.viewer ? COPY.guest.tone : base.tone,
    title: role === "viewer" && copy?.viewer ? "Connected" : base.title,
  };

  return (
    <>
      {!TREASURY_CONTRACT_ID && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No treasury contract is configured. Set <code className="font-mono">NEXT_PUBLIC_TREASURY_CONTRACT_ID</code> in{" "}
            <code className="font-mono">web/.env.local</code> and restart the app.
          </span>
        </div>
      )}
      <div
        className={`mb-6 flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${c.tone}`}
        role="status"
      >
        <div className="flex items-start gap-3">
          <Icon name={c.icon} className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-medium">{c.title}</span>
            {accountId && role !== "guest" && (
              <a
                href={explorerAccountUrl(accountId)}
                target="_blank"
                rel="noreferrer"
                className="ml-2 font-mono text-xs underline decoration-current/30 underline-offset-2 hover:decoration-current"
              >
                {accountId}
              </a>
            )}
            <p className="mt-0.5 text-[13px] opacity-80">{c.body}</p>
          </div>
        </div>
        {role === "guest" || role === "wrong-network" ? null : config.data ? (
          <span className="shrink-0 font-mono text-xs opacity-70">
            {config.data.threshold}-of-{config.data.signers.length} signers
          </span>
        ) : null}
      </div>
      {children}
    </>
  );
}
