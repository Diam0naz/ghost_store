"use client";
// Merchant onboarding: create a shop's own treasury through the factory, then apply a starting
// configuration (stable token, spending limits, the hosted agent's model key, regular vendors)
// through the treasury's governance proposals. Everything is signed by the merchant's wallet.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import WalletModal from "@/components/WalletModal";
import { FACTORY_CONTRACT_ID, switchShop, useAccountId, viewCall } from "@/lib/near";
import {
  PRESETS,
  applySetup,
  createShop,
  setupKinds,
  shopAccount,
  useFactoryConfig,
  useNameAvailable,
  useShop,
  validShopName,
  validPayoutAccount,
  setPayoutAccount,
  checkoutLink,
  ONE_NEAR,
} from "@/lib/factory";
import CopyButton from "@/components/CopyButton";

const PENDING_KEY = "ghost.onboard.pending";
const STABLE_TOKEN = process.env.NEXT_PUBLIC_STABLE_TOKEN ?? "usdt.fakes.testnet";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            done ? "bg-emerald-100 text-emerald-700" : "bg-primary-100 text-primary-800"
          }`}
        >
          {done ? <Icon name="check" className="h-3.5 w-3.5" /> : n}
        </span>
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 240 ? `${m.slice(0, 240)}…` : m;
}

export default function OnboardPage() {
  const accountId = useAccountId();
  const config = useFactoryConfig();
  const [walletOpen, setWalletOpen] = useState(false);

  // Step 2: shop details
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [coSigners, setCoSigners] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [depositNear, setDepositNear] = useState(1);
  const [payout, setPayout] = useState("");
  const [payoutEdit, setPayoutEdit] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Creation in flight survives the wallet's redirect.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    try {
      setPending(window.sessionStorage.getItem(PENDING_KEY));
    } catch {
      /* storage blocked */
    }
  }, []);
  const shop = useShop(pending);
  const active = shop.data?.status === "Active";

  // Step 3: starting configuration
  const [preset, setPreset] = useState<keyof typeof PRESETS>("standard");
  const [vendors, setVendors] = useState("");
  const [setupState, setSetupState] = useState<"idle" | "sending" | "done">("idle");
  const [proposalCount, setProposalCount] = useState<number | null>(null);

  useEffect(() => {
    if (!nameTouched) setName(slugify(displayName));
  }, [displayName, nameTouched]);

  const available = useNameAvailable(validShopName(name) ? name : "");
  const signers = useMemo(() => {
    const extra = coSigners
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set([accountId ?? "", ...extra].filter(Boolean))];
  }, [accountId, coSigners]);
  const badSigner = signers.find((s) => !s.endsWith(".testnet"));
  const vendorList = vendors
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const badVendor = vendorList.find((s) => !s.endsWith(".testnet"));
  useEffect(() => setThreshold((t) => Math.min(Math.max(t, 1), Math.max(signers.length, 1))), [signers.length]);

  const payoutTrim = payout.trim();
  const badPayout = payoutTrim !== "" && !validPayoutAccount(payoutTrim);
  const minNear = config.data ? Number(BigInt(config.data.min_deposit) * 1000n / ONE_NEAR) / 1000 : 0.5;
  const canCreate =
    !!accountId &&
    displayName.trim().length > 0 &&
    validShopName(name) &&
    available.data === true &&
    !badSigner &&
    !badPayout &&
    depositNear >= minNear &&
    !busy;

  // A new shop's setup can only be batched while it has no proposals yet.
  useEffect(() => {
    if (!active || !pending) return;
    viewCall<unknown[]>(pending, "list_proposals", { from: 0, limit: 100 })
      .then((p) => setProposalCount(p.length))
      .catch(() => setProposalCount(null));
  }, [active, pending, setupState]);

  async function onCreate() {
    setError(null);
    setBusy(true);
    const treasury = shopAccount(name);
    try {
      window.sessionStorage.setItem(PENDING_KEY, treasury);
    } catch {
      /* storage blocked */
    }
    setPending(treasury);
    try {
      await createShop({
        name,
        displayName: displayName.trim(),
        signers,
        threshold,
        depositNear,
        payoutAccount: payoutTrim || null,
      });
    } catch (e) {
      setError(errorText(e));
      setPending(null);
      try {
        window.sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* storage blocked */
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSetup() {
    if (!pending) return;
    setError(null);
    setSetupState("sending");
    try {
      const p = PRESETS[preset];
      const kinds = await setupKinds({ ...p, token: STABLE_TOKEN, decimals: 6, vendors: vendorList });
      await applySetup(pending, kinds);
      setSetupState("done");
    } catch (e) {
      setError(errorText(e));
      setSetupState("idle");
    }
  }

  async function onSavePayout() {
    if (!pending) return;
    setError(null);
    setPayoutBusy(true);
    try {
      await setPayoutAccount(pending, payoutEdit.trim() || null);
      await shop.refetch();
      setPayoutEdit("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPayoutBusy(false);
    }
  }

  function startOver() {
    try {
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* storage blocked */
    }
    setPending(null);
    setSetupState("idle");
  }

  if (!FACTORY_CONTRACT_ID) {
    return (
      <div className="card p-6 text-sm text-ink-600">
        Shop creation is not configured on this deployment. Set{" "}
        <code className="font-mono">NEXT_PUBLIC_FACTORY_CONTRACT_ID</code>.
      </div>
    );
  }

  const shopThreshold = shop.data?.threshold ?? threshold;
  const setupDone = setupState === "done" || (proposalCount !== null && proposalCount > 0);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <p className="eyebrow mb-2">Get started</p>
        <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">Create your shop&apos;s treasury</h1>
        <p className="mt-1.5 text-sm font-medium text-ink-600">
          Your own vault on NEAR {`testnet`}. The AI can suggest payments; your limits and your signers decide what
          happens. About a minute, three wallet confirmations.
        </p>
      </div>

      <Step n={1} title="Connect your NEAR wallet" done={!!accountId}>
        {accountId ? (
          <p className="text-sm text-ink-600">
            Connected as <span className="font-mono text-ink-900">{accountId}</span>. You will be the first signer.
          </p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-600">The wallet that creates the shop becomes its first signer.</p>
            <button type="button" className="btn-primary" onClick={() => setWalletOpen(true)}>
              <Icon name="wallet" className="h-4 w-4" /> Connect wallet
            </button>
          </div>
        )}
      </Step>

      <Step n={2} title="Name your shop and choose who signs" done={active}>
        {pending ? (
          <div className="space-y-3 text-sm">
            {active ? (
              <p className="text-ink-600">
                <span className="font-semibold text-ink-900">{shop.data?.display_name}</span> is live at{" "}
                <span className="font-mono text-ink-900">{pending}</span>, {shop.data?.threshold}-of-
                {shop.data?.signers.length} signers.
              </p>
            ) : shop.isFetched && shop.data === null && !busy ? (
              <div className="space-y-2">
                <p className="text-ink-600">
                  No shop found at <span className="font-mono">{pending}</span>. The transaction may have been cancelled
                  or failed; any deposit was refunded.
                </p>
                <button type="button" className="btn-ghost" onClick={startOver}>
                  Try again
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-ink-600">
                <Icon name="clock" className="h-4 w-4" /> Creating <span className="font-mono">{pending}</span>… confirm
                in your wallet.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <label className="block">
              <span className="mb-1 block font-medium text-ink-900">Business name</span>
              <input
                className="w-full rounded-lg border border-line bg-white px-3 py-2"
                value={displayName}
                maxLength={64}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Acme Coffee"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-ink-900">Treasury address</span>
              <div className="flex items-center rounded-lg border border-line bg-white">
                <input
                  className="min-w-0 flex-1 rounded-l-lg bg-transparent px-3 py-2 font-mono"
                  value={name}
                  maxLength={32}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value.toLowerCase());
                  }}
                  placeholder="acme-coffee"
                />
                <span className="shrink-0 px-3 font-mono text-xs text-ink-400">.{FACTORY_CONTRACT_ID}</span>
              </div>
              <span className="mt-1 block text-xs text-ink-400">
                {name && !validShopName(name)
                  ? "2-32 lowercase letters, digits, - or _; start and end with a letter or digit."
                  : available.data === false
                  ? "Taken. Try another."
                  : available.data
                  ? "Available."
                  : " "}
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-ink-900">Co-signers (optional)</span>
              <input
                className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono"
                value={coSigners}
                onChange={(e) => setCoSigners(e.target.value)}
                placeholder="partner.testnet, accountant.testnet"
              />
              <span className="mt-1 block text-xs text-ink-400">
                {badSigner ? `${badSigner} is not a testnet account.` : "People who can approve, reject, veto and pause."}
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-ink-900">Where customers' payments go (optional)</span>
              <input
                className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono"
                value={payout}
                onChange={(e) => setPayout(e.target.value.toLowerCase())}
                placeholder="yourshop.near"
              />
              <span className="mt-1 block text-xs text-ink-400">
                {badPayout
                  ? "Use a mainnet account ending in .near (customer payments settle on mainnet)."
                  : "A mainnet NEAR account. Checkout settles customers' payments to it in USDC; it needs no NEAR balance. Only you can change it later."}
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block font-medium text-ink-900">Approvals needed</span>
                <select
                  className="w-full rounded-lg border border-line bg-white px-3 py-2"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                >
                  {signers.map((_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1} of {signers.length}
                    </option>
                  ))}
                  {signers.length === 0 && <option value={1}>1 of 1</option>}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block font-medium text-ink-900">Deposit (NEAR)</span>
                <input
                  type="number"
                  min={minNear}
                  step={0.1}
                  className="w-full rounded-lg border border-line bg-white px-3 py-2"
                  value={depositNear}
                  onChange={(e) => setDepositNear(Number(e.target.value))}
                />
                <span className="mt-1 block text-xs text-ink-400">
                  Pays for the treasury&apos;s storage; stays in your treasury. Minimum {minNear}.
                </span>
              </label>
            </div>
            <button type="button" className="btn-primary w-full sm:w-auto" disabled={!canCreate} onClick={onCreate}>
              <Icon name="store" className="h-4 w-4" /> {busy ? "Confirm in your wallet…" : "Create treasury"}
            </button>
          </div>
        )}
      </Step>

      <Step n={3} title="Set your limits" done={setupDone}>
        {!active ? (
          <p className="text-sm text-ink-400">Available once your treasury is live.</p>
        ) : setupDone ? (
          <p className="text-sm text-ink-600">
            {shopThreshold > 1
              ? `Setup proposals sent with your approval. ${shopThreshold - 1} more signer approval${shopThreshold > 2 ? "s are" : " is"} needed on the Treasury page before they take effect.`
              : "Your limits, vendors and the AI model key are in effect."}
          </p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              {Object.entries(PRESETS).map(([k, p]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setPreset(k as keyof typeof PRESETS)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    preset === k ? "border-ink-900 bg-primary-50" : "border-line bg-white hover:bg-primary-50"
                  }`}
                >
                  <span className="block font-semibold text-ink-900">{p.label}</span>
                  <span className="block text-xs text-ink-600">{p.blurb}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-400">
              Applies to payments the AI makes on its own, in {STABLE_TOKEN}. Anything larger, or to a vendor not on your
              list, always waits for your signers. Reserve floor: {PRESETS[preset].reserveFloor}.
            </p>
            <label className="block">
              <span className="mb-1 block font-medium text-ink-900">Regular vendors (optional)</span>
              <input
                className="w-full rounded-lg border border-line bg-white px-3 py-2 font-mono"
                value={vendors}
                onChange={(e) => setVendors(e.target.value)}
                placeholder="packaging.testnet, courier.testnet"
              />
              <span className="mt-1 block text-xs text-ink-400">
                {badVendor ? `${badVendor} is not a testnet account.` : "Only these can be paid without approvals. You can add more later."}
              </span>
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={setupState === "sending" || !!badVendor || proposalCount === null}
              onClick={onSetup}
            >
              <Icon name="shield" className="h-4 w-4" /> {setupState === "sending" ? "Confirm in your wallet…" : "Apply limits"}
            </button>
          </div>
        )}
      </Step>

      <Step n={4} title="Start using it" done={false}>
        {!active ? (
          <p className="text-sm text-ink-400">Available once your treasury is live.</p>
        ) : (
          <div className="space-y-3 text-sm text-ink-600">
            <div className="rounded-lg border border-line bg-primary-50/50 p-3">
              <p className="font-medium text-ink-900">Take payments</p>
              {shop.data?.payout_account ? (
                <>
                  <p className="mt-1 text-xs">
                    Customers pay in any token; you receive USDC at{" "}
                    <span className="font-mono text-ink-900">{shop.data.payout_account}</span> (mainnet).
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-ink-900">
                      {checkoutLink(pending!)}
                    </code>
                    <CopyButton value={checkoutLink(pending!)} />
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs">No payout account yet, so checkout is off for this shop.</p>
              )}
              {shop.data?.created_by === accountId && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-1.5 font-mono text-xs"
                    value={payoutEdit}
                    onChange={(e) => setPayoutEdit(e.target.value.toLowerCase())}
                    placeholder={shop.data?.payout_account ? "new payout account (.near)" : "yourshop.near"}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={payoutBusy || (payoutEdit.trim() !== "" && !validPayoutAccount(payoutEdit.trim())) || (payoutEdit.trim() === "" && !shop.data?.payout_account)}
                    onClick={onSavePayout}
                  >
                    {payoutBusy ? "Confirm in wallet…" : payoutEdit.trim() ? "Save payout account" : "Turn off checkout"}
                  </button>
                </div>
              )}
            </div>
            <ul className="space-y-2">
              <li>
                <span className="font-medium text-ink-900">Fund it:</span> send {STABLE_TOKEN} to{" "}
                <span className="font-mono text-ink-900">{pending}</span>.
              </li>
              <li>
                <span className="font-medium text-ink-900">Bills:</span> your vendors submit invoices on the Invoices page,
                and the AI proposes the ones that match your books.
              </li>
              <li>
                <span className="font-medium text-ink-900">Your books:</span> connecting books to the hosted AI is not
                self-serve yet. Until it is, the agent runs from the repo with your books file.
              </li>
            </ul>
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className="btn-primary" onClick={() => switchShop(pending, "/treasury")}>
                Open my treasury <Icon name="arrowRight" className="h-4 w-4" />
              </button>
              <button type="button" className="btn-ghost" onClick={() => switchShop(pending, "/invoices")}>
                Invoices
              </button>
              <Link href="/onboard" className="btn-ghost" onClick={startOver}>
                Create another
              </Link>
            </div>
          </div>
        )}
      </Step>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
    </div>
  );
}
