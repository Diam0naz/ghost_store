"use client";
// Yield policy + position summary. Reads the live policy, recorded principal,
// venue caps, treasury liquid balance and pause state. Amounts use the token's
// real ft_metadata decimals — never a hardcoded 6.

import {
  formatAmount,
  useTokenBalance,
  useTokenMetadata,
  useTreasuryPaused,
  useTreasuryPolicy,
  useTreasuryPositions,
  useVenueCap,
} from "@/lib/proposals";
import { TREASURY_CONTRACT_ID } from "@/lib/near";

const ENV_VENUES = (process.env.NEXT_PUBLIC_YIELD_VENUES ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function VenueRow({
  venue,
  principal,
  decimals,
  symbol,
}: {
  venue: string;
  principal: string;
  decimals: number | undefined;
  symbol: string;
}) {
  const cap = useVenueCap(venue);
  const fmt = (raw: string | null | undefined) =>
    raw === null || raw === undefined || decimals === undefined
      ? "…"
      : `${formatAmount(raw, decimals, 2)} ${symbol}`;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-primary-100 bg-primary-50/60 px-3 py-2">
      <span className="min-w-0 break-all font-mono text-xs font-semibold text-primary-900">
        {venue}
      </span>
      <span className="text-xs font-medium text-ink-600">
        Recorded principal:{" "}
        <span className="font-mono font-bold text-primary-950">
          {fmt(principal)}
        </span>
        <span className="ml-2 text-ink-400">
          Cap:{" "}
          {cap.isPending
            ? "…"
            : cap.data
            ? fmt(cap.data)
            : "not whitelisted"}
        </span>
      </span>
    </div>
  );
}

export default function YieldPanel() {
  const policy = useTreasuryPolicy();
  const positions = useTreasuryPositions();
  const paused = useTreasuryPaused();

  const stableToken = policy.data?.stable_token ?? null;
  const metadata = useTokenMetadata(stableToken);
  const balance = useTokenBalance(stableToken, TREASURY_CONTRACT_ID);

  const decimals = metadata.data?.decimals;
  const symbol = metadata.data?.symbol ?? "stable token";
  const fmt = (raw: string | null | undefined) =>
    raw === null || raw === undefined || decimals === undefined
      ? "…"
      : `${formatAmount(raw, decimals, 2)} ${symbol}`;

  const recorded = new Map(positions.data?.positions ?? []);
  const venues = Array.from(
    new Set([...ENV_VENUES, ...Array.from(recorded.keys())])
  );

  return (
    <section className="card space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-primary-950">
            Yield layer
          </h2>
          <p className="text-xs font-medium text-ink-400">
            Recorded principal supplied to venues — not current market value.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
            paused.data
              ? "bg-amber-100 text-amber-700"
              : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {paused.data === undefined
            ? "Checking…"
            : paused.data
            ? "Paused"
            : "Active"}
        </span>
      </div>

      {policy.isError ? (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">
          Couldn&apos;t load the yield policy.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-primary-100 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
              Stable token
            </p>
            <p className="mt-0.5 break-all font-mono text-xs font-semibold text-primary-950">
              {stableToken ?? "Not configured"}
            </p>
            {metadata.data && (
              <p className="text-xs font-medium text-ink-400">
                {metadata.data.symbol} · {metadata.data.decimals} decimals
              </p>
            )}
          </div>
          <div className="rounded-xl border border-primary-100 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
              Total allocated
            </p>
            <p className="mt-0.5 font-mono text-sm font-bold text-primary-950">
              {fmt(positions.data?.totalAllocated)}
            </p>
            <p className="text-xs font-medium text-ink-400">
              of {fmt(policy.data?.max_total_allocated)} max
            </p>
          </div>
          <div className="rounded-xl border border-primary-100 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
              Reserve floor
            </p>
            <p className="mt-0.5 font-mono text-sm font-bold text-primary-950">
              {fmt(policy.data?.reserve_floor)}
            </p>
            <p className="text-xs font-medium text-ink-400">
              must stay liquid after allocations
            </p>
          </div>
          <div className="rounded-xl border border-primary-100 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
              Liquid balance
            </p>
            <p className="mt-0.5 font-mono text-sm font-bold text-primary-950">
              {fmt(balance.data)}
            </p>
            <p className="text-xs font-medium text-ink-400">
              treasury&apos;s free {symbol}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
          Venue positions
        </p>
        {venues.length === 0 ? (
          <p className="text-xs font-medium text-ink-400">
            No venues configured. Set NEXT_PUBLIC_YIELD_VENUES or propose a
            venue cap to whitelist one.
          </p>
        ) : (
          venues.map((venue) => (
            <VenueRow
              key={venue}
              venue={venue}
              principal={recorded.get(venue) ?? "0"}
              decimals={decimals}
              symbol={symbol}
            />
          ))
        )}
      </div>
    </section>
  );
}
