"use client";
// Invoices: vendors (or their agents) submit invoices to the treasury; the AI matches them
// against the merchant's private books and pays them, autonomously when the issuer is
// allowlisted and the amount fits the limits. Every invoice is an NFT: the holder gets paid,
// so a vendor can sell an unpaid invoice for early cash (factoring), atomically on chain.

import { useMemo, useState } from "react";
import AccessBar from "@/components/AccessBar";
import ConfirmDialog from "@/components/ConfirmDialog";
import EmptyState from "@/components/EmptyState";
import ErrorState, { friendlyError } from "@/components/ErrorState";
import Icon from "@/components/Icon";
import { explorerAccountUrl } from "@/lib/explorer";
import { TREASURY_CONTRACT_ID, useAccountId } from "@/lib/near";
import {
  formatAmount,
  parseAmount,
  useFactoringFee,
  useInvoiceAction,
  useInvoices,
  useTokenMetadata,
  useTreasuryConfig,
  useVendors,
  type Invoice,
} from "@/lib/proposals";

const STABLE = process.env.NEXT_PUBLIC_STABLE_TOKEN ?? "";
const DAY_MS = 86_400_000;

type Filter = "All" | "Open" | "For sale" | "Paid" | "Mine";

function Account({ id }: { id: string }) {
  return (
    <a
      href={explorerAccountUrl(id)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-ink-900 underline decoration-line underline-offset-2 hover:decoration-ink-400"
    >
      {id}
    </a>
  );
}

function dueLabel(inv: Invoice): { text: string; tone: string } {
  if (inv.status !== "Open") return { text: new Date(inv.due_ms).toLocaleDateString(), tone: "text-ink-400" };
  const days = Math.ceil((inv.due_ms - Date.now()) / DAY_MS);
  if (days < 0) return { text: `Overdue ${-days}d`, tone: "text-red-600" };
  if (days === 0) return { text: "Due today", tone: "text-amber-700" };
  return { text: `Due in ${days}d`, tone: days <= 3 ? "text-amber-700" : "text-ink-600" };
}

const STATUS_STYLE: Record<Invoice["status"], string> = {
  Open: "bg-primary-50 text-primary-700 ring-primary-200",
  Paid: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
  Cancelled: "bg-surface text-ink-400 ring-line",
};

/** sha256 hex of a file, computed in the browser. The file itself is never uploaded. */
async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function SubmitForm({ decimals, symbol, onDone }: { decimals: number; symbol: string; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(() => new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [docHash, setDocHash] = useState<string | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useInvoiceAction((m) => setError(friendlyError(m)));

  const raw = parseAmount(amount, decimals);
  const problems = [
    !STABLE && "No stable token configured (NEXT_PUBLIC_STABLE_TOKEN).",
    amount && raw === "0" && "Enter an amount above zero.",
    reference.length > 64 && "Keep the reference under 64 characters.",
  ].filter(Boolean) as string[];
  const ready = !!STABLE && raw !== "0" && reference.trim().length > 0 && reference.length <= 64 && !!due;

  return (
    <form
      className="card space-y-4 p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setError(null);
        action.mutate(
          {
            type: "submit",
            token: STABLE,
            amount: raw,
            due_ms: new Date(`${due}T12:00:00Z`).getTime(),
            reference: reference.trim(),
            document_hash: docHash,
          },
          { onSuccess: () => onDone(`Invoice ${reference.trim()} submitted. It is now an NFT you hold.`) }
        );
      }}
    >
      <div>
        <h2 className="font-semibold text-ink-900">Submit an invoice</h2>
        <p className="mt-1 text-sm text-ink-600">
          For vendors and vendor agents. You hold the invoice as an NFT and get paid when the treasury
          pays it. Attaches 0.01 NEAR for storage.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="eyebrow">Amount ({symbol})</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="40.00"
            className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="eyebrow">Due date</span>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="eyebrow">Reference</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="PKG-2291"
            maxLength={64}
            className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="eyebrow">Invoice document (optional)</span>
        <input
          type="file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) {
              setDocHash(null);
              setDocName(null);
              return;
            }
            setDocName(f.name);
            setDocHash(await sha256File(f));
          }}
          className="mt-1.5 block w-full text-sm text-ink-600 file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink-900"
        />
        <span className="mt-1 block text-xs text-ink-400">
          {docHash
            ? `Only the SHA-256 of ${docName} goes on chain: ${docHash.slice(0, 16)}…`
            : "Hashed in your browser; the file is never uploaded."}
        </span>
      </label>
      {problems.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-800">
          {problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200/70">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      <button type="submit" disabled={!ready || action.isPending} className="btn-primary">
        {action.isPending ? "Submitting…" : "Submit invoice"}
      </button>
    </form>
  );
}

function InvoiceRow({
  inv,
  me,
  isSigner,
  trustedIssuer,
  decimals,
  symbol,
  onNotice,
  onError,
}: {
  inv: Invoice;
  me: string | null;
  isSigner: boolean;
  trustedIssuer: boolean;
  decimals: number;
  symbol: string;
  onNotice: (m: string) => void;
  onError: (m: string) => void;
}) {
  const action = useInvoiceAction((m) => onError(friendlyError(m)));
  const [mode, setMode] = useState<null | "price" | "transfer">(null);
  const [input, setInput] = useState("");
  const [confirmBuy, setConfirmBuy] = useState(false);
  const fmt = (raw: string) => `${formatAmount(raw, decimals, 2)} ${symbol}`;
  const isHolder = !!me && me === inv.holder;
  const open = inv.status === "Open";
  const sold = inv.holder !== inv.issuer;
  const due = dueLabel(inv);
  const busy = action.isPending;

  const run = (a: Parameters<typeof action.mutate>[0], msg: string) =>
    action.mutate(a, {
      onSuccess: () => {
        setMode(null);
        setInput("");
        onNotice(msg);
      },
    });

  return (
    <li className="card p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3.5">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
            <Icon name="receipt" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">
              <span className="mr-2 font-mono text-xs font-normal text-ink-400">#{inv.id}</span>
              {inv.reference}
            </p>
            <dl className="mt-1.5 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-ink-600">
              <dt className="text-ink-400">Issuer</dt>
              <dd className="min-w-0 truncate">
                <Account id={inv.issuer} />
                {trustedIssuer && <span className="ml-1.5 text-emerald-700">· allowlisted</span>}
              </dd>
              <dt className="text-ink-400">Paid to</dt>
              <dd className="min-w-0 truncate">
                <Account id={inv.holder} />
                {sold && <span className="ml-1.5 text-primary-700">· bought from issuer</span>}
              </dd>
            </dl>
          </div>
        </div>
        <div className="flex shrink-0 flex-row items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-1.5">
          <span className="font-mono text-lg text-ink-900">{fmt(inv.amount)}</span>
          <div className="flex items-center gap-2 text-xs">
            <span className={due.tone}>{due.text}</span>
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_STYLE[inv.status]}`}>
              {inv.status}
            </span>
          </div>
        </div>
      </div>

      {(inv.sale_price || inv.pending_proposal !== null || inv.paid_by_proposal !== null) && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {inv.sale_price && open && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-amber-800 ring-1 ring-amber-200/70">
              <Icon name="store" className="h-3.5 w-3.5" /> For sale at {fmt(inv.sale_price)}
            </span>
          )}
          {inv.pending_proposal !== null && (
            <a
              href="/treasury"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary-50 px-2 py-1 text-primary-700 ring-1 ring-primary-200 hover:bg-primary-100"
            >
              <Icon name="clock" className="h-3.5 w-3.5" /> Payment proposed (#{inv.pending_proposal})
            </a>
          )}
          {inv.paid_by_proposal !== null && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-emerald-700 ring-1 ring-emerald-200/70">
              <Icon name="check" className="h-3.5 w-3.5" /> Paid by proposal #{inv.paid_by_proposal}
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {isHolder && (
            <>
              <button className="btn-ghost h-8 px-3 text-xs" disabled={busy} onClick={() => setMode(mode === "price" ? null : "price")}>
                <Icon name="store" className="h-3.5 w-3.5" /> {inv.sale_price ? "Change price" : "Sell early"}
              </button>
              {inv.sale_price && (
                <button
                  className="btn-ghost h-8 px-3 text-xs"
                  disabled={busy}
                  onClick={() => run({ type: "price", id: inv.id, price: null }, `Invoice #${inv.id} is no longer for sale.`)}
                >
                  Unlist
                </button>
              )}
              <button className="btn-ghost h-8 px-3 text-xs" disabled={busy} onClick={() => setMode(mode === "transfer" ? null : "transfer")}>
                <Icon name="send" className="h-3.5 w-3.5" /> Transfer
              </button>
              {me === inv.issuer && inv.pending_proposal === null && (
                <button
                  className="h-8 rounded-lg px-3 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                  disabled={busy}
                  onClick={() => run({ type: "cancel", id: inv.id }, `Invoice #${inv.id} cancelled.`)}
                >
                  Cancel invoice
                </button>
              )}
            </>
          )}
          {!isHolder && inv.sale_price && (
            <button className="btn-primary h-8 px-3 text-xs" disabled={busy || !me} onClick={() => setConfirmBuy(true)} title={me ? undefined : "Connect a wallet to buy"}>
              Buy for {fmt(inv.sale_price)}
            </button>
          )}
          {isSigner && inv.pending_proposal === null && (
            <button
              className="btn-ghost h-8 px-3 text-xs"
              disabled={busy}
              onClick={() =>
                run(
                  { type: "propose-pay", id: inv.id, rationale: `Pay invoice ${inv.reference} from ${inv.issuer}` },
                  `Payment for invoice #${inv.id} proposed. It needs the signer threshold.`
                )
              }
            >
              <Icon name="payout" className="h-3.5 w-3.5" /> Propose payment
            </button>
          )}
          {!me && <span className="text-xs text-ink-400">Connect a wallet to act on this invoice</span>}
        </div>
      )}

      {mode && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "price") {
              const price = parseAmount(input, decimals);
              if (price === "0") return onError("Enter a price above zero.");
              run({ type: "price", id: inv.id, price }, `Invoice #${inv.id} listed at ${fmt(price)}.`);
            } else {
              const to = input.trim();
              if (!/^[a-z0-9._-]+$/.test(to)) return onError("Enter a valid NEAR account id.");
              run({ type: "transfer", id: inv.id, receiver: to }, `Invoice #${inv.id} transferred to ${to}.`);
            }
          }}
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === "price" ? `Price in ${symbol}, e.g. ${formatAmount(inv.amount, decimals, 2)}` : "receiver.testnet"}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-white px-3 font-mono text-xs"
          />
          <button type="submit" className="btn-primary h-8 px-3 text-xs" disabled={busy}>
            {mode === "price" ? "List" : "Send"}
          </button>
          {mode === "price" && (
            <span className="w-full text-xs text-ink-400">
              A buyer pays you this now and receives the full {fmt(inv.amount)} when the treasury pays the invoice.
            </span>
          )}
        </form>
      )}

      <ConfirmDialog
        open={confirmBuy}
        title={`Buy invoice #${inv.id}?`}
        description={
          <>
            You pay {inv.sale_price ? fmt(inv.sale_price) : ""} now and become the holder. When the treasury pays
            the invoice, the full {fmt(inv.amount)} goes to you. Payment is not guaranteed: the merchant&apos;s
            signers or AI may decline to pay it.
          </>
        }
        confirmLabel="Buy invoice"
        busy={busy}
        onConfirm={() => {
          setConfirmBuy(false);
          if (inv.sale_price)
            run({ type: "buy", id: inv.id, token: inv.token, price: inv.sale_price }, `You bought invoice #${inv.id}.`);
        }}
        onClose={() => setConfirmBuy(false)}
      />
    </li>
  );
}

export default function InvoicesPage() {
  const invoices = useInvoices();
  const vendors = useVendors();
  const config = useTreasuryConfig();
  const fee = useFactoringFee();
  const meta = useTokenMetadata(STABLE || null);
  const me = useAccountId();
  const [filter, setFilter] = useState<Filter>("All");
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decimals = meta.data?.decimals ?? 6;
  const symbol = meta.data?.symbol ?? "USDT";
  const isSigner = !!me && (config.data?.signers ?? []).includes(me);
  const list = useMemo(() => [...(invoices.data ?? [])].sort((a, b) => b.id - a.id), [invoices.data]);
  const filters: Filter[] = me ? ["All", "Open", "For sale", "Paid", "Mine"] : ["All", "Open", "For sale", "Paid"];
  const shown = list.filter((i) =>
    filter === "All"
      ? i.status !== "Cancelled"
      : filter === "Open"
        ? i.status === "Open"
        : filter === "For sale"
          ? i.status === "Open" && !!i.sale_price
          : filter === "Paid"
            ? i.status === "Paid"
            : i.holder === me || i.issuer === me
  );
  const openTotal = list.filter((i) => i.status === "Open").reduce((s, i) => s + BigInt(i.amount), 0n);

  return (
    <AccessBar
      copy={{
        guest: "Everything here is public on chain. Connect any NEAR wallet to submit, sell or buy invoices.",
        viewer: "You can submit invoices, sell the ones you hold and buy listed ones. Paying invoices is up to the treasury's signers and AI.",
      }}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow mb-2">Receivables</p>
            <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">Invoices</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-ink-600">
              Vendors submit invoices to {TREASURY_CONTRACT_ID || "the treasury"}. The AI pays the ones that match the
              merchant&apos;s private books. Each invoice is an NFT, so vendors can sell it for early cash.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            <Icon name={showForm ? "x" : "plus"} /> {showForm ? "Close" : "New invoice"}
          </button>
        </div>

        <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line text-sm sm:grid-cols-3">
          {[
            ["01", "Vendor agent submits", "An invoice NFT is minted to the vendor. Anyone can submit; only matching ones get paid."],
            ["02", "AI reconciles privately", "Inside the TEE the AI matches invoices to the books. Unknown or duplicate invoices are skipped."],
            [
              "03",
              "Treasury pays the holder",
              `Allowlisted vendors are paid autonomously after the veto window.${
                fee.data && fee.data[1] ? ` Invoice sales carry a ${(fee.data[0] / 100).toFixed(2)}% fee.` : ""
              }`,
            ],
          ].map(([n, t, b]) => (
            <li key={n} className="bg-white p-4">
              <span className="font-mono text-xs text-ink-400">{n}</span>
              <p className="mt-1 font-medium text-ink-900">{t}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-600">{b}</p>
            </li>
          ))}
        </ol>

        {showForm && (
          <SubmitForm
            decimals={decimals}
            symbol={symbol}
            onDone={(m) => {
              setShowForm(false);
              setNotice(m);
            }}
          />
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 animate-fade-in">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss" className="text-red-400 hover:text-red-700">
              <Icon name="x" />
            </button>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 animate-fade-in">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="text-emerald-500 hover:text-emerald-800">
              <Icon name="x" />
            </button>
          </div>
        )}

        {invoices.isError ? (
          <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} retrying={invoices.isRefetching} />
        ) : invoices.isPending ? (
          <div className="h-40 animate-pulse rounded-xl bg-primary-100" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-white p-1 shadow-soft" role="tablist">
                {filters.map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      filter === f ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-primary-50 hover:text-ink-900"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <span className="text-xs text-ink-600">
                Open: <span className="font-mono text-ink-900">{formatAmount(openTotal.toString(), decimals, 2)} {symbol}</span>
              </span>
            </div>
            {shown.length === 0 ? (
              <EmptyState
                title={list.length === 0 ? "No invoices yet" : `No ${filter.toLowerCase()} invoices`}
                description={
                  list.length === 0
                    ? "Vendors and vendor agents can submit the first one with “New invoice”."
                    : "Try another filter."
                }
              />
            ) : (
              <ul className="space-y-3">
                {shown.map((inv) => (
                  <InvoiceRow
                    key={inv.id}
                    inv={inv}
                    me={me}
                    isSigner={isSigner}
                    trustedIssuer={(vendors.data ?? []).includes(inv.issuer)}
                    decimals={decimals}
                    symbol={symbol}
                    onNotice={(m) => {
                      setError(null);
                      setNotice(m);
                    }}
                    onError={(m) => {
                      setNotice(null);
                      setError(m);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </AccessBar>
  );
}
