"use client";
// Cold vault page (docs/COLD-VAULT.md). Savings that only the registered device can ask for,
// after a delay, in installments, into the shop's operating treasury. Any one guardian can
// cancel a request or freeze the vault; rule changes need the threshold plus a long delay.
// Everything here is read live from the vault contract and signed by the visitor's wallet;
// the contract enforces every rule regardless of what the page shows.

import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import ConfirmDialog from "@/components/ConfirmDialog";
import ErrorState from "@/components/ErrorState";
import EmptyState from "@/components/EmptyState";
import { useAccountId } from "@/lib/near";
import { formatAmount, useTokenMetadata } from "@/lib/proposals";
import { explorerAccountUrl } from "@/lib/explorer";
import {
  describeChange,
  dueInstallments,
  humanDuration,
  nextInstallmentAt,
  resolveVaultId,
  toUnits,
  useAccountKeys,
  useVault,
  vaultCalls,
  type VaultRequest,
} from "@/lib/vault";

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const hit = m.match(/Smart contract panicked: ([^"\\]+)/);
  return hit ? hit[1] : m.length > 240 ? `${m.slice(0, 240)}…` : m;
}

type Pending = { title: string; body: string; label: string; danger?: boolean; run: () => Promise<unknown> } | null;

export default function VaultPage() {
  const [vaultId, setVaultId] = useState<string | null>(null);
  useEffect(() => setVaultId(resolveVaultId()), []);
  if (vaultId === null) return <div className="card h-40 animate-pulse" />;
  if (!vaultId) {
    return (
      <EmptyState
        title="No cold vault linked"
        description="Open this page with ?vault=<vault account>, or set NEXT_PUBLIC_COLD_VAULT_ID. See docs/COLD-VAULT.md to deploy one."
      />
    );
  }
  return <VaultView vault={vaultId} />;
}

function VaultView({ vault }: { vault: string }) {
  const accountId = useAccountId();
  const q = useVault(vault);
  const keys = useAccountKeys(accountId);
  const meta = useTokenMetadata(q.data?.status.token ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [newKey, setNewKey] = useState("");

  if (q.isPending) return <div className="card h-40 animate-pulse" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isRefetching} />;

  const { status: s, requests, changes } = q.data;
  const dec = meta.data?.decimals ?? 6;
  const sym = meta.data?.symbol ?? s.token;
  const fmt = (raw: string) => `${formatAmount(raw, dec)} ${sym}`;
  const isGuardian = !!accountId && s.guardians.includes(accountId);
  const holdsDevice = !!keys.data?.includes(s.device_key);
  const cap = BigInt(s.limits.weekly_cap);
  const weekPct = cap > 0n ? Math.min(100, Number((BigInt(s.released_this_week) * 100n) / cap)) : 0;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  let amountRaw = "0";
  try {
    amountRaw = amount ? toUnits(amount, dec) : "0";
  } catch {
    amountRaw = "0";
  }
  const amountOk = BigInt(amountRaw) > 0n && BigInt(amountRaw) <= BigInt(s.available);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow mb-2">Savings</p>
          <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">Cold vault</h1>
          <p className="mt-1.5 text-sm font-medium text-ink-600">
            <a href={explorerAccountUrl(vault)} target="_blank" rel="noreferrer" className="font-mono underline decoration-ink-200 underline-offset-2">
              {vault}
            </a>{" "}
            · releases only to <span className="font-mono">{s.destination}</span>
          </p>
        </div>
        {isGuardian &&
          (s.frozen ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={busy || s.unfreeze_approvals.includes(accountId!)}
              onClick={() => run(() => vaultCalls.approveUnfreeze(vault))}
            >
              <Icon name="check" className="h-4 w-4" />
              {s.unfreeze_approvals.includes(accountId!) ? "You approved unfreezing" : "Approve unfreeze"}
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  title: "Freeze the vault?",
                  body: `No requests or releases until ${s.threshold} guardian(s) approve unfreezing. Use it if anything looks wrong.`,
                  label: "Freeze now",
                  danger: true,
                  run: () => vaultCalls.freeze(vault),
                })
              }
            >
              <Icon name="pause" className="h-4 w-4" /> Freeze vault
            </button>
          ))}
      </div>

      {s.frozen && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="status">
          <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Frozen.</span> Nothing can be requested or released. Unfreeze approvals:{" "}
            {s.unfreeze_approvals.length}/{s.threshold}
            {s.unfreeze_approvals.length > 0 && ` (${s.unfreeze_approvals.join(", ")})`}.
          </span>
        </div>
      )}

      {/* Overview */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="eyebrow">In the vault</p>
          <p className="mt-1 font-mono text-xl font-semibold text-ink-900">{fmt(s.held)}</p>
          <p className="text-xs text-ink-400">{fmt(s.available)} free to request</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">On its way out</p>
          <p className="mt-1 font-mono text-xl font-semibold text-ink-900">{fmt(s.committed)}</p>
          <p className="text-xs text-ink-400">owed to pending requests</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Released this week</p>
          <p className="mt-1 font-mono text-xl font-semibold text-ink-900">{fmt(s.released_this_week)}</p>
          {cap > 0n ? (
            <>
              <div className="mt-2 h-1.5 rounded-full bg-primary-100">
                <div className="h-1.5 rounded-full bg-ink-900" style={{ width: `${weekPct}%` }} />
              </div>
              <p className="mt-1 text-xs text-ink-400">of a {fmt(s.limits.weekly_cap)} weekly cap</p>
            </>
          ) : (
            <p className="text-xs text-ink-400">no weekly cap</p>
          )}
        </div>
      </div>

      <div className="card p-5 text-sm text-ink-600">
        <p className="mb-2 font-semibold text-ink-900">The rules (enforced by the contract)</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          <li>Only the registered device can ask for funds.</li>
          <li>
            First payment {humanDuration(s.limits.release_delay_ms)} after asking, then {s.limits.installments} installment
            {s.limits.installments === 1 ? "" : "s"}, one every {humanDuration(s.limits.installment_interval_ms)}.
          </li>
          <li>Money only ever goes to {s.destination}.</li>
          <li>Any one guardian can cancel a request or freeze the vault.</li>
          <li>
            Rule changes need {s.threshold} of {s.guardians.length} guardians, then wait{" "}
            {humanDuration(s.limits.change_delay_ms)}.
          </li>
          <li className="font-mono text-xs">Guardians: {s.guardians.join(", ")}</li>
        </ul>
      </div>

      {/* Request funds: the device only */}
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="font-semibold text-ink-900">Request funds</p>
          <span className="font-mono text-[11px] text-ink-400" title={s.device_key}>
            device {s.device_key.slice(0, 16)}…
          </span>
        </div>
        {!accountId ? (
          <p className="text-sm text-ink-600">Connect the wallet on the registered device to request funds.</p>
        ) : !holdsDevice ? (
          <p className="text-sm text-ink-600">
            <span className="font-mono">{accountId}</span> does not hold the registered device key, so the vault would refuse a
            request from it. Use the device you set up (for example the Ledger in the office).
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-ink-400">
              Sign with the device key itself. If your wallet signs with a different key on this account, the vault refuses it.
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
              <input
                className="rounded-lg border border-line bg-white px-3 py-2 font-mono"
                inputMode="decimal"
                placeholder={`Amount (${sym})`}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              />
              <input
                className="rounded-lg border border-line bg-white px-3 py-2"
                maxLength={200}
                placeholder="What it's for (guardians see this)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy || s.frozen || !amountOk}
                onClick={() =>
                  setConfirm({
                    title: `Request ${fmt(amountRaw)}?`,
                    body: `Guardians are alerted now. The first of ${s.limits.installments} installment(s) arrives in ${s.destination} after ${humanDuration(s.limits.release_delay_ms)} unless a guardian cancels.`,
                    label: "Send request",
                    run: () => vaultCalls.request(vault, amountRaw, note.trim()),
                  })
                }
              >
                Request
              </button>
            </div>
            {amount && !amountOk && <p className="text-xs text-red-600">Up to {fmt(s.available)} can be requested.</p>}
          </div>
        )}
      </div>

      {/* Requests */}
      <div className="space-y-3">
        <p className="font-semibold text-ink-900">Requests</p>
        {requests.length === 0 && <p className="text-sm text-ink-400">No requests yet.</p>}
        {requests.map((r) => (
          <RequestCard
            key={r.id}
            r={r}
            now={now}
            fmt={fmt}
            frozen={s.frozen}
            canCancel={isGuardian}
            busy={busy}
            onRelease={() => run(() => vaultCalls.release(vault, r.id))}
            onCancel={() =>
              setConfirm({
                title: `Cancel request #${r.id}?`,
                body: `${fmt((BigInt(r.amount) - BigInt(r.paid)).toString())} not yet paid stays in the vault.`,
                label: "Cancel request",
                danger: true,
                run: () => vaultCalls.cancel(vault, r.id),
              })
            }
          />
        ))}
      </div>

      {/* Rule changes */}
      <div className="space-y-3">
        <p className="font-semibold text-ink-900">Rule changes</p>
        {changes.length === 0 && <p className="text-sm text-ink-400">None proposed.</p>}
        {changes.map((c) => {
          const ready = c.executable_after_ms !== null && now >= c.executable_after_ms;
          return (
            <div key={c.id} className="card flex flex-col gap-3 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-ink-900">
                  #{c.id} {describeChange(c.kind)}
                </p>
                <p className="text-xs text-ink-400">
                  {c.status !== "Pending"
                    ? c.status
                    : c.executable_after_ms === null
                    ? `Approvals ${c.approvals.length}/${s.threshold}: ${c.approvals.join(", ")}`
                    : ready
                    ? "Delay passed: anyone can apply it"
                    : `Takes effect after ${when(c.executable_after_ms)} unless a guardian cancels`}
                </p>
              </div>
              {c.status === "Pending" && (
                <div className="flex gap-2">
                  {isGuardian && c.executable_after_ms === null && !c.approvals.includes(accountId!) && (
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => run(() => vaultCalls.approveChange(vault, c.id))}>
                      Approve
                    </button>
                  )}
                  {ready && (
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => run(() => vaultCalls.applyChange(vault, c.id))}>
                      Apply
                    </button>
                  )}
                  {isGuardian && (
                    <button type="button" className="btn-ghost text-red-700" disabled={busy} onClick={() => run(() => vaultCalls.cancelChange(vault, c.id))}>
                      Cancel
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {isGuardian && (
          <div className="card p-4 text-sm">
            <p className="font-medium text-ink-900">Lost or replaced the device?</p>
            <p className="mb-3 text-xs text-ink-400">
              Propose the new device&apos;s public key. It needs {s.threshold} guardian approval(s), then waits{" "}
              {humanDuration(s.limits.change_delay_ms)}.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs"
                placeholder="ed25519:…"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.trim())}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(newKey)}
                onClick={() => run(() => vaultCalls.proposeDevice(vault, newKey)).then(() => setNewKey(""))}
              >
                Propose new device
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        description={confirm?.body ?? ""}
        confirmLabel={confirm?.label ?? ""}
        danger={confirm?.danger}
        busy={busy}
        onConfirm={() => confirm && run(confirm.run)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function RequestCard({
  r,
  now,
  fmt,
  frozen,
  canCancel,
  busy,
  onRelease,
  onCancel,
}: {
  r: VaultRequest;
  now: number;
  fmt: (raw: string) => string;
  frozen: boolean;
  canCancel: boolean;
  busy: boolean;
  onRelease: () => void;
  onCancel: () => void;
}) {
  const due = r.status === "Pending" && !frozen && dueInstallments(r, now) > r.installments_paid;
  const tone =
    r.status === "Cancelled" ? "bg-red-100 text-red-700" : r.status === "Completed" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700";
  return (
    <div className="card p-4 text-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-ink-900">
            #{r.id} · {fmt(r.amount)}
            {r.note && <span className="font-normal text-ink-600"> · {r.note}</span>}
          </p>
          <p className="text-xs text-ink-400">
            Asked {when(r.created_at_ms)} · {r.installments_paid}/{r.installments} installments paid ({fmt(r.paid)})
            {r.status === "Pending" && ` · next ${due ? "due now" : `at ${when(nextInstallmentAt(r))}`}`}
            {r.cancelled_by && ` · cancelled by ${r.cancelled_by}`}
          </p>
          <div className="mt-2 flex gap-1">
            {Array.from({ length: r.installments }, (_, i) => (
              <span key={i} className={`h-1.5 w-6 rounded-full ${i < r.installments_paid ? "bg-ink-900" : "bg-primary-100"}`} />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${tone}`}>{r.status}</span>
          {due && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={onRelease}>
              Release installment
            </button>
          )}
          {r.status === "Pending" && canCancel && (
            <button type="button" className="btn-ghost text-red-700" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
