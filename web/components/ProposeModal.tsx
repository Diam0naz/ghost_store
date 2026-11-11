"use client";
// New-proposal form covering every ProposalKind the contract accepts. Amounts
// are parsed to raw units without float math (native NEAR = 24 decimals, NEP-141
// defaults to 6); yield fields prefill from the live policy so first-time setup
// (SetPolicy / SetVenueCap) is fill-in-the-blanks rather than copy-paste.

import { useEffect, useState } from "react";
import { friendlyError } from "@/components/ErrorState";
import { TREASURY_CONTRACT_ID, useAccountId } from "@/lib/near";
import {
  formatAmount,
  parseAmount,
  usePropose,
  useTokenBalance,
  useTokenMetadata,
  useTreasuryConfig,
  useTreasuryPaused,
  useTreasuryPolicy,
  useTreasuryPositions,
  useVenueCap,
  type ProposalKind,
} from "@/lib/proposals";

export type ProposeKind =
  | "Payout"
  | "Allocate"
  | "Withdraw"
  | "SetVenueCap"
  | "SetPolicy"
  | "SetPaused"
  | "AddSigner"
  | "RemoveSigner"
  | "SetThreshold"
  | "SetProposer";

const KIND_OPTIONS: { group: string; kinds: ProposeKind[] }[] = [
  { group: "Payments", kinds: ["Payout", "Allocate", "Withdraw"] },
  { group: "Yield setup", kinds: ["SetVenueCap", "SetPolicy", "SetPaused"] },
  {
    group: "Governance",
    kinds: ["AddSigner", "RemoveSigner", "SetThreshold", "SetProposer"],
  },
];

const KIND_LABELS: Record<ProposeKind, string> = {
  Payout: "Payout — pay a recipient",
  Allocate: "Allocate — supply a venue",
  Withdraw: "Withdraw — pull back from a venue",
  SetVenueCap: "Set venue cap — whitelist a venue",
  SetPolicy: "Set policy — configure the yield layer",
  SetPaused: "Set paused — pause / unpause allocations",
  AddSigner: "Add signer",
  RemoveSigner: "Remove signer",
  SetThreshold: "Set threshold",
  SetProposer: "Set proposer — rotate the AI account",
};

const KIND_HINTS: Record<ProposeKind, string> = {
  Payout: "Pay a vendor or contributor in NEAR or an NEP-141 token.",
  Allocate: "Supply the stablecoin to a whitelisted yield venue.",
  Withdraw: "Pull principal back from a venue that holds a position.",
  SetVenueCap: "Whitelist a venue with a cumulative principal cap (0 removes it).",
  SetPolicy: "Set the stable token, total allocation cap and reserve floor.",
  SetPaused: "Pausing is a single-signer kill switch; unpausing needs this proposal.",
  AddSigner: "Add an account to the M-of-N signer roster.",
  RemoveSigner: "Remove a signer — lower the threshold first if needed.",
  SetThreshold: "Change how many approvals execute a proposal.",
  SetProposer: "Rotate the AI service account that may create proposals.",
};

const INPUT =
  "w-full rounded-xl border border-primary-200 bg-white px-3 py-2 text-sm font-semibold text-primary-950 focus:border-primary-400 focus:outline-none";
const LABEL = "mb-1 block text-xs font-bold uppercase tracking-wide text-ink-400";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs font-medium text-ink-400">
          {hint}
        </span>
      )}
    </label>
  );
}

export default function ProposeModal({
  open,
  initialKind,
  onClose,
  onSuccess,
}: {
  open: boolean;
  /** Preselect a kind (used by the "unpause via proposal" shortcut). */
  initialKind?: ProposeKind;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const policy = useTreasuryPolicy();
  const config = useTreasuryConfig();
  const myAccountId = useAccountId();
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = usePropose((msg) => setFormError(msg));

  // Who's allowed to submit: needs a NEAR wallet, and the contract only
  // accepts proposals from current signers or the AI proposer account.
  const walletReady = !!myAccountId;
  const isSigner =
    walletReady && (config.data?.signers ?? []).includes(myAccountId as string);
  const isProposer =
    walletReady && myAccountId === config.data?.proposer;
  const notAllowed = walletReady && !!config.data && !isSigner && !isProposer;

  const [kind, setKind] = useState<ProposeKind>("Payout");
  const [to, setTo] = useState("");
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const [venue, setVenue] = useState("");
  const [cap, setCap] = useState("");
  const [stableToken, setStableToken] = useState("");
  const [maxAlloc, setMaxAlloc] = useState("");
  const [floor, setFloor] = useState("");
  const [paused, setPaused] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [threshold, setThreshold] = useState("");
  const [rationale, setRationale] = useState("");

  // Live yield data used to block impossible Allocate proposals before submit.
  const policyToken = policy.data?.stable_token ?? null;
  const metadataToken =
    kind === "SetPolicy"
      ? stableToken.trim() || null
      : kind === "Payout"
      ? token.trim() || null
      : policyToken;
  const tokenMeta = useTokenMetadata(metadataToken);
  const tokenBalance = useTokenBalance(policyToken, TREASURY_CONTRACT_ID);
  const venueCap = useVenueCap(
    kind === "Allocate" ? venue.trim() || null : null
  );
  const treasuryPaused = useTreasuryPaused();
  const positions = useTreasuryPositions();

  const decimals = tokenMeta.data?.decimals;
  const symbol =
    tokenMeta.data?.symbol ??
    (kind === "Payout" && !token.trim() ? "NEAR" : "tokens");

  function fmtRaw(raw: string | bigint): string {
    const value = typeof raw === "bigint" ? raw.toString() : raw;
    return decimals === undefined
      ? value
      : `${formatAmount(value, decimals, 2)} ${symbol}`;
  }

  // Prefill yield fields from the live policy once it loads.
  useEffect(() => {
    const stable = policy.data?.stable_token;
    if (!stable) return;
    setToken((t) => t || stable);
    setStableToken((t) => t || stable);
  }, [policy.data?.stable_token]);

  // Close on Escape; clear stale errors when the modal reopens or the kind changes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setFormError(null);
  }, [open, kind]);

  useEffect(() => {
    if (open && initialKind) setKind(initialKind);
  }, [open, initialKind]);

  if (!open) return null;

  function fail(msg: string): null {
    setFormError(msg);
    return null;
  }

  function needDecimals(): string | null {
    if (decimals !== undefined) return null;
    return tokenMeta.isError
      ? "Couldn't read that token's ft_metadata — check the token account id."
      : "Loading token metadata — try again in a moment.";
  }

  function buildKind(): ProposalKind | null {
    const t = (s: string) => s.trim();
    switch (kind) {
      case "Payout": {
        if (!t(to)) return fail("Recipient account is required.");
        const isNative = !t(token);
        if (!isNative) {
          const metaError = needDecimals();
          if (metaError) return fail(metaError);
        }
        const raw = parseAmount(amount, isNative ? 24 : (decimals as number));
        if (BigInt(raw) <= BigInt(0)) return fail("Enter a positive amount.");
        return { Payout: { to: t(to), token: t(token) || null, amount: raw } };
      }
      case "Allocate": {
        if (!policy.data) {
          return fail("The yield policy isn't configured. Propose SetPolicy first.");
        }
        if (!t(venue)) return fail("Venue account is required.");
        if (!t(token)) return fail("Token is required — use the policy stable token.");
        if (t(token) !== policy.data.stable_token) {
          return fail(
            `Only ${policy.data.stable_token} — the policy's stable token — can be allocated.`
          );
        }
        const metaError = needDecimals();
        if (metaError) return fail(metaError);
        const raw = parseAmount(amount, decimals as number);
        if (BigInt(raw) <= BigInt(0)) return fail("Enter a positive amount.");
        if (treasuryPaused.data) {
          return fail(
            "Allocations are paused. Unpause with a SetPaused proposal before allocating."
          );
        }
        if (positions.isPending) {
          return fail("Loading current positions — try again in a moment.");
        }
        if (venueCap.isPending) {
          return fail("Checking the venue cap — try again in a moment.");
        }
        if (!venueCap.data) {
          return fail(
            `${t(venue)} isn't whitelisted. Propose a venue cap for it first.`
          );
        }
        const cap = BigInt(venueCap.data);
        const venuePrincipal = BigInt(
          positions.data?.positions.find(([v]) => v === t(venue))?.[1] ?? "0"
        );
        const nextVenue = venuePrincipal + BigInt(raw);
        if (nextVenue > cap) {
          return fail(
            `This would take ${t(venue)} to ${fmtRaw(nextVenue)} recorded principal, above its ${fmtRaw(cap)} cap.`
          );
        }
        const maxTotal = BigInt(policy.data.max_total_allocated);
        const nextTotal =
          BigInt(positions.data?.totalAllocated ?? "0") + BigInt(raw);
        if (nextTotal > maxTotal) {
          return fail(
            `This would take total allocated to ${fmtRaw(nextTotal)}, above the ${fmtRaw(maxTotal)} policy limit.`
          );
        }
        if (tokenBalance.isPending) {
          return fail("Checking the treasury's liquid balance — try again in a moment.");
        }
        if (tokenBalance.data === undefined) {
          return fail(
            "Couldn't read the treasury's liquid balance — try again before allocating."
          );
        }
        const after = BigInt(tokenBalance.data) - BigInt(raw);
        if (after < BigInt(policy.data.reserve_floor)) {
          return fail(
            `This would leave ${fmtRaw(after)} liquid, below the ${fmtRaw(policy.data.reserve_floor)} reserve floor.`
          );
        }
        return { Allocate: { venue: t(venue), token: t(token), amount: raw } };
      }
      case "Withdraw": {
        if (!t(venue)) return fail("Venue account is required.");
        const metaError = needDecimals();
        if (metaError) return fail(metaError);
        const raw = parseAmount(amount, decimals as number);
        if (BigInt(raw) <= BigInt(0)) return fail("Enter a positive amount.");
        return { Withdraw: { venue: t(venue), amount: raw } };
      }
      case "SetVenueCap": {
        if (!t(venue)) return fail("Venue account is required.");
        const metaError = needDecimals();
        if (metaError) return fail(metaError);
        return {
          SetVenueCap: {
            venue: t(venue),
            cap: parseAmount(cap, decimals as number),
          },
        };
      }
      case "SetPolicy": {
        if (!t(stableToken)) return fail("Stable token account is required.");
        const metaError = needDecimals();
        if (metaError) return fail(metaError);
        return {
          SetPolicy: {
            stable_token: t(stableToken),
            max_total_allocated: parseAmount(maxAlloc, decimals as number),
            reserve_floor: parseAmount(floor, decimals as number),
          },
        };
      }
      case "SetPaused":
        return { SetPaused: { paused } };
      case "AddSigner":
      case "RemoveSigner": {
        if (!t(accountId)) return fail("Account id is required.");
        return kind === "AddSigner"
          ? { AddSigner: { account_id: t(accountId) } }
          : { RemoveSigner: { account_id: t(accountId) } };
      }
      case "SetThreshold": {
        const n = Number(threshold);
        if (!Number.isInteger(n) || n < 1) {
          return fail("Threshold must be a positive whole number.");
        }
        if (config.data && n > config.data.signers.length) {
          return fail(
            `Only ${config.data.signers.length} signers exist today — add signers first.`
          );
        }
        return { SetThreshold: { threshold: n } };
      }
      case "SetProposer": {
        if (!t(accountId)) return fail("Account id is required.");
        return { SetProposer: { account_id: t(accountId) } };
      }
    }
  }

  /** Human-readable preview, shown before the wallet is asked to sign. */
  function proposalSentence(): string | null {
    const t = (s: string) => s.trim();
    switch (kind) {
      case "Payout":
        if (!t(to) || !t(amount)) return null;
        return `Pay ${t(amount)} ${t(token) ? symbol : "NEAR"} to ${t(to)}`;
      case "Allocate":
        if (!t(venue) || !t(amount)) return null;
        return `Allocate ${t(amount)} ${symbol} to ${t(venue)}`;
      case "Withdraw":
        if (!t(venue) || !t(amount)) return null;
        return `Withdraw ${t(amount)} ${symbol} from ${t(venue)}`;
      case "SetVenueCap":
        if (!t(venue)) return null;
        return `Set ${t(venue)}'s recorded-principal cap to ${t(cap) || "0"} ${symbol}`;
      case "SetPolicy":
        return `Set ${t(stableToken) || "the stable token"} policy: ${t(maxAlloc) || "0"} ${symbol} max total allocated, ${t(floor) || "0"} ${symbol} reserve floor`;
      case "SetPaused":
        return paused ? "Pause allocations" : "Unpause allocations";
      case "AddSigner":
        return t(accountId) ? `Add signer ${t(accountId)}` : null;
      case "RemoveSigner":
        return t(accountId) ? `Remove signer ${t(accountId)}` : null;
      case "SetThreshold":
        return t(threshold) ? `Set approval threshold to ${t(threshold)}` : null;
      case "SetProposer":
        return t(accountId) ? `Rotate the AI proposer to ${t(accountId)}` : null;
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!walletReady) return;
    const built = buildKind();
    if (!built) return;
    mutation.mutate(
      { kind: built, rationale: rationale.trim() },
      {
        onSuccess: () => {
          onClose();
          onSuccess?.();
        },
      }
    );
  }

  const needsAmount =
    kind === "Payout" || kind === "Allocate" || kind === "Withdraw";
  const needsVenue =
    kind === "Allocate" || kind === "Withdraw" || kind === "SetVenueCap";
  const needsAccount =
    kind === "AddSigner" || kind === "RemoveSigner" || kind === "SetProposer";
  const preview = proposalSentence();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary-950/40 p-4 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="New proposal"
    >
      <form
        onSubmit={onSubmit}
        className="card max-h-[85vh] w-full max-w-lg overflow-y-auto p-6 animate-modal-in"
        style={{ animationDelay: "120ms" }}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold leading-tight text-primary-950">
              New proposal
            </h2>
            <p className="text-xs font-medium text-ink-400">
              {config.data
                ? `${config.data.threshold}-of-${config.data.signers.length} signers must approve it`
                : "Signers approve it before anything executes"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-primary-100 hover:text-primary-700"
          >
            ✕
          </button>
        </div>

        {/* Who can actually submit — the modal is open to everyone for drafting,
            but only a NEAR wallet held by a signer (or the proposer) passes the
            contract's check. */}
        {!walletReady && (
          <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            No NEAR wallet connected — connect one from the header to submit.
            You can fill out the form now.
          </p>
        )}
        {notAllowed && (
          <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            <span className="font-mono">{myAccountId}</span> isn&apos;t a signer
            or the proposer — the contract will reject this submission. Switch
            to a signer wallet to submit.
          </p>
        )}

        <div className="space-y-4">
          <Field label="Proposal type" hint={KIND_HINTS[kind]}>
            <select
              className={INPUT}
              value={kind}
              onChange={(e) => setKind(e.target.value as ProposeKind)}
            >
              {KIND_OPTIONS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.kinds.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          {kind === "Payout" && (
            <Field label="Recipient">
              <input
                className={INPUT}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="vendor.near"
                autoComplete="off"
              />
            </Field>
          )}

          {needsVenue && (
            <Field
              label="Venue"
              hint={
                kind === "SetVenueCap"
                  ? "Account of the yield venue to whitelist."
                  : "Venue that holds (or will hold) the position."
              }
            >
              <input
                className={INPUT}
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="venue.testnet"
                autoComplete="off"
              />
            </Field>
          )}

          {(kind === "Payout" || kind === "Allocate") && (
            <Field
              label="Token"
              hint={
                kind === "Payout"
                  ? "NEP-141 account id. Leave empty to pay native NEAR."
                  : "Must equal the policy's stable token — prefilled."
              }
            >
              <input
                className={INPUT}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={kind === "Payout" ? "native NEAR (empty)" : "usdc.testnet"}
                autoComplete="off"
              />
            </Field>
          )}

          {needsAmount && (
            <Field
              label="Amount"
              hint="Whole tokens — parsed to raw units with the token's real ft_metadata decimals."
            >
              <input
                type="text"
                inputMode="decimal"
                className={INPUT}
                value={amount}
                onChange={(e) =>
                  setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))
                }
                placeholder="0.00"
              />
            </Field>
          )}

          {kind === "SetVenueCap" && (
            <Field label="Cumulative cap" hint="0 removes the venue from the whitelist.">
              <input
                type="text"
                inputMode="decimal"
                className={INPUT}
                value={cap}
                onChange={(e) =>
                  setCap(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))
                }
                placeholder="10000.00"
              />
            </Field>
          )}

          {kind === "SetPolicy" && (
            <>
              <Field label="Stable token" hint="The only token the yield layer may allocate.">
                <input
                  className={INPUT}
                  value={stableToken}
                  onChange={(e) => setStableToken(e.target.value)}
                  placeholder="usdc.testnet"
                  autoComplete="off"
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Max total allocated">
                  <input
                    type="text"
                    inputMode="decimal"
                    className={INPUT}
                    value={maxAlloc}
                    onChange={(e) =>
                      setMaxAlloc(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))
                    }
                    placeholder="50000.00"
                  />
                </Field>
                <Field label="Reserve floor">
                  <input
                    type="text"
                    inputMode="decimal"
                    className={INPUT}
                    value={floor}
                    onChange={(e) =>
                      setFloor(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))
                    }
                    placeholder="1000.00"
                  />
                </Field>
              </div>
            </>
          )}

          {kind === "SetPaused" && (
            <label className="flex items-center gap-2 text-sm font-semibold text-ink-600">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="h-4 w-4 rounded border-primary-300 text-primary-600 focus:outline-none"
              />
              {paused ? "Pause allocations" : "Unpause allocations"}
            </label>
          )}

          {needsAccount && (
            <Field label="Account id">
              <input
                className={INPUT}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="account.testnet"
                autoComplete="off"
              />
            </Field>
          )}

          {kind === "SetThreshold" && (
            <Field
              label="New threshold"
              hint={
                config.data
                  ? `Currently ${config.data.threshold}-of-${config.data.signers.length}.`
                  : "Approvals required to execute."
              }
            >
              <input
                type="number"
                min={1}
                className={INPUT}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder="2"
              />
            </Field>
          )}

          <Field label="Rationale (optional)" hint="Shown to every signer · max 500 characters.">
            <textarea
              rows={2}
              maxLength={500}
              className={`${INPUT} resize-none`}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this proposal?"
            />
          </Field>

          {preview && (
            <div className="rounded-xl border border-primary-100 bg-primary-50 px-3 py-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
                You are proposing
              </p>
              <p className="text-sm font-bold text-primary-950">{preview}</p>
            </div>
          )}

          {formError && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
              {friendlyError(formError)}
            </p>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost flex-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !walletReady}
            className="btn-primary flex-1 disabled:opacity-40"
          >
            {mutation.isPending
              ? "Waiting for wallet…"
              : walletReady
              ? "Create proposal"
              : "Connect wallet to submit"}
          </button>
        </div>
      </form>
    </div>
  );
}
