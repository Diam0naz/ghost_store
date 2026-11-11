"use client";
// Treasury dashboard: balances (NEAR + stablecoin), the yield layer
// (policy, allocation cap, per-venue positions vs live venue value), payout
// recipients (merchants/beneficiaries) and signer activity.
// Data is public on chain; AccessBar shows the visitor's role above it.

import Link from "next/link";
import Icon, { type IconName } from "@/components/Icon";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import AccessBar from "@/components/AccessBar";
import {
  useTreasuryProposals,
  useTreasuryConfig,
  useTreasuryPolicy,
  useTreasuryPositions,
  useTreasuryPaused,
  formatAmount,
  tokenDecimals,
} from "@/lib/proposals";
import {
  useTreasuryBalance,
  useStableBalance,
  useTokenMetadata,
  useVenueBalances,
  summarizeRecipients,
  signerActivity,
} from "@/lib/stats";
import { useAccountId, TREASURY_CONTRACT_ID } from "@/lib/near";

/** Small labelled stat tile. */
function StatCard({
  label,
  value,
  sub,
  icon,
  delay = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: IconName;
  delay?: number;
}) {
  return (
    <div className="card p-5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary-100 text-primary-700">
          <Icon name={icon} className="h-3.5 w-3.5" />
        </span>
      </div>
      <p className="mt-3 font-mono text-2xl font-medium tracking-tight text-ink-900">
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-ink-400">{sub}</p>}
    </div>
  );
}

function SectionCard({
  title,
  hint,
  children,
  delay = 0,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <section className="card p-6" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-primary-950">{title}</h2>
        {hint && <span className="text-xs font-medium text-ink-400">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  return (
    <AccessBar>
      <DashboardContent />
    </AccessBar>
  );
}

function DashboardContent() {
  const proposals = useTreasuryProposals();
  const config = useTreasuryConfig();
  const policy = useTreasuryPolicy();
  const positions = useTreasuryPositions();
  const paused = useTreasuryPaused();
  const balance = useTreasuryBalance();
  const stable = useStableBalance();
  const myAccountId = useAccountId();

  const stableToken = process.env.NEXT_PUBLIC_STABLE_TOKEN;
  const stableMeta = useTokenMetadata(stableToken);
  const stableDecimals = stableMeta.data?.decimals ?? 6;
  const stableSymbol = stableMeta.data?.symbol ?? "STABLE";

  const list = proposals.data ?? [];

  // Venues = every venue mentioned by a position or an Allocate/Withdraw proposal.
  const venues = [...new Set([
    ...(positions.data?.positions.map(([v]) => v) ?? []),
    ...list.flatMap((p) => {
      if ("Allocate" in p.kind) return [p.kind.Allocate.venue];
      if ("Withdraw" in p.kind) return [p.kind.Withdraw.venue];
      return [];
    }),
  ])];
  const venueBalances = useVenueBalances(venues);

  const recipients = summarizeRecipients(list);
  const activity = signerActivity(list, config.data?.signers ?? []);

  const pending = list.filter((p) => p.status === "Pending").length;
  const executed = list.filter((p) => p.status === "Executed").length;
  const failed = list.filter((p) => p.status === "Failed").length;

  const positionsTotal = positions.data?.totalAllocated ?? "0";
  const totalAllocatedNum = Number(BigInt(positionsTotal)) / 10 ** stableDecimals;

  // Execution status is not proof of money movement. The treasury marks a
  // proposal Executed once its async callbacks start, but the actual venue-side
  // balances/positions may still be zero (or the venue may not expose the right
  // query methods). Show the gap explicitly so the dashboard never implies
  // "Executed == funds earning yield" without an independent check.
  const positionsLive =
    (positions.data?.positions.length ?? 0) > 0 && totalAllocatedNum > 0;
  const executedWithoutPositions = executed > 0 && !positionsLive;


  // Allocation progress against the policy cap.
  const allocatedRaw = positions.data?.totalAllocated ?? "0";
  const maxAllocRaw = policy.data?.max_total_allocated ?? null;
  const allocatedNum = Number(BigInt(allocatedRaw)) / 10 ** stableDecimals;
  const maxAllocNum = maxAllocRaw
    ? Number(BigInt(maxAllocRaw)) / 10 ** stableDecimals
    : null;
  const pct =
    maxAllocNum && maxAllocNum > 0
      ? Math.min(100, (allocatedNum / maxAllocNum) * 100)
      : null;

  if (!TREASURY_CONTRACT_ID) {
    return (
      <div className="space-y-6">
        <p className="eyebrow mb-2">Overview</p>
        <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">
          Dashboard
        </h1>
        <EmptyState
          title="Treasury contract not configured"
          description="Set NEXT_PUBLIC_TREASURY_CONTRACT_ID in web/.env.local to see treasury stats."
        />
      </div>
    );
  }

  const loading = proposals.isPending || config.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">Overview</p>
          <h1 className="text-[1.75rem] font-semibold leading-tight text-ink-900">
            Dashboard
          </h1>
          <p className="mt-1.5 text-sm font-medium text-ink-600">
            {TREASURY_CONTRACT_ID}
            {paused.data === true && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                allocations paused
              </span>
            )}
          </p>
        </div>
        <Link href="/treasury" className="btn-primary text-sm">
          Review proposals →
        </Link>
      </div>

      {(proposals.isError || config.isError) && (
        <ErrorState
          error={proposals.error ?? config.error}
          onRetry={() => {
            proposals.refetch();
            config.refetch();
          }}
          retrying={proposals.isRefetching || config.isRefetching}
        />
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-primary-100" />
          ))}
        </div>
      )}

      {!loading && (
        <>
          {/* ---- headline stats ---- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon="coins"
              label="Treasury NEAR"
              value={
                balance.data ? `${formatAmount(balance.data, 24, 3)} Ⓝ` : "—"
              }
              sub="Liquid balance, storage staking included"
              delay={80}
            />
            <StatCard
              icon="wallet"
              label={stableSymbol}
              value={stable.data ? formatAmount(stable.data, stableDecimals, 2) : "—"}
              sub={
                stableToken
                  ? `Held at ${stableToken}`
                  : "Set NEXT_PUBLIC_STABLE_TOKEN"
              }
              delay={170}
            />
            <StatCard
              icon="clock"
              label="Pending"
              value={String(pending)}
              sub={`${executed} executed · ${failed} failed · ${list.length} total`}
              delay={260}
            />
            {executedWithoutPositions && (
              <StatCard
                icon="alert"
                label="On-chain note"
                value="Executed ≠ moved"
                sub="Review proposal status vs venue positions below"
                delay={300}
              />
            )}
            <StatCard
              icon="users"
              label="Signers"
              value={
                config.data
                  ? `${config.data.threshold} of ${config.data.signers.length}`
                  : "—"
              }
              sub={`Proposer: ${config.data?.proposer ?? "—"}`}
              delay={350}
            />
          </div>

          {/* ---- yield layer ---- */}
          <SectionCard
            title="Yield"
            hint={
              policy.data
                ? `reserve floor ${formatAmount(policy.data.reserve_floor, stableDecimals, 2)} ${stableSymbol}`
                : "policy not configured"
            }
            delay={420}
          >
            {!policy.data ? (
              <p className="text-sm font-medium text-ink-600">
                No policy yet — the yield layer activates after a{" "}
                <span className="font-semibold text-primary-800">SetPolicy</span>{" "}
                proposal passes. Create one from the{" "}
                <Link href="/treasury" className="font-semibold text-primary-700 underline">
                  treasury page
                </Link>
                .
              </p>
            ) : (
              <div className="space-y-5">
                {/* Allocation cap progress */}
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between text-sm">
                    <span className="font-semibold text-ink-600">
                      Allocated
                    </span>
                    <span className="font-bold text-primary-950">
                      {allocatedNum.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      {maxAllocNum !== null && (
                        <span className="font-medium text-ink-400">
                          {" "}
                          / {maxAllocNum.toLocaleString("en-US", { maximumFractionDigits: 2 })}{" "}
                          {stableSymbol}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-primary-100">
                    <div
                      className="h-full rounded-full bg-primary-700 transition-all duration-700"
                      style={{ width: `${pct ?? 0}%` }}
                    />
                  </div>
                  {executedWithoutPositions && (
                    <p className="mt-1 text-xs font-medium text-amber-700">
                      {executed} proposal{executed !== 1 ? "s" : ""} show as Executed, but the
                      treasury’s recorded allocated principal is {formatAmount(
                        positionsTotal,
                        stableDecimals,
                        2
                      )} {stableSymbol}. Execution status is not proof of funds
                      moving — verify venue balances below.
                    </p>
                  )}
                  {!executedWithoutPositions && (
                    <p className="mt-1 text-xs font-medium text-emerald-700">
                      Recorded allocated principal {formatAmount(
                        positionsTotal,
                        stableDecimals,
                        2
                      )} {stableSymbol} across {(positions.data?.positions.length ?? 0)} venue
                      positions.
                    </p>
                  )}
                  {pct === null && (
                    <p className="mt-1 text-xs font-medium text-ink-400">
                      No max_total_allocated set in the policy.
                    </p>
                  )}
                </div>

                {/* Per-venue positions */}
                {(positions.data?.positions.length ?? 0) === 0 ? (
                  <p className="text-sm font-medium text-ink-600">
                    No venue holds principal yet — propose an{" "}
                    <span className="font-semibold text-primary-800">Allocate</span>{" "}
                    to start earning yield.
                  </p>
                ) : (
                  <ul className="divide-y divide-primary-100">
                    {positions.data?.positions.map(([venue, principal], i) => {
                      const live = venueBalances.data?.[venue];
                      return (
                        <li
                          key={venue}
                          className="flex flex-wrap items-center justify-between gap-2 py-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono text-sm font-semibold text-primary-900">
                              {venue}
                            </p>
                            <p className="text-xs font-medium text-ink-400">
                              principal {formatAmount(principal, stableDecimals, 2)}{" "}
                              {stableSymbol}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-primary-950">
                              {live !== null && live !== undefined
                                ? `${formatAmount(live, stableDecimals, 2)} ${stableSymbol}`
                                : executedWithoutPositions
                                  ? "— (check on-chain)"
                                  : "—"}
                            </p>
                            <p className="text-xs font-medium text-ink-400">
                              {live !== null && live !== undefined
                                ? `live venue balance`
                                : live === null
                                  ? `venue doesn't expose balance_of`
                                  : `venue balance unavailable`}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </SectionCard>

          {/* ---- beneficiaries ---- */}
          <SectionCard
            title="Beneficiaries"
            hint={`${recipients.length} paid · executed payouts only`}
            delay={500}
          >
            {recipients.length === 0 ? (
              <p className="text-sm font-medium text-ink-600">
                No executed payouts yet. Recipients appear here once a{" "}
                <span className="font-semibold text-primary-800">Payout</span>{" "}
                proposal executes.
              </p>
            ) : (
              <ul className="divide-y divide-primary-100">
                {recipients.slice(0, 8).map((r) => (
                  <li
                    key={r.to}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm font-semibold text-primary-900">
                        {r.to}
                      </p>
                      <p className="text-xs font-medium text-ink-400">
                        {r.payouts} payout{r.payouts === 1 ? "" : "s"} · last{" "}
                        {new Date(r.lastMs).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right text-sm font-bold text-primary-950">
                      {r.byToken.map((b) => (
                        <p key={b.token ?? "near"}>
                          {formatAmount(
                            b.total,
                            tokenDecimals(b.token),
                            2
                          )}{" "}
                          <span className="font-medium text-ink-400">
                            {b.token ?? "NEAR"}
                          </span>
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* ---- on-chain honesty footer ---- */}
          {executedWithoutPositions && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              {executed} proposal{executed !== 1 ? "s" : ""} are marked Executed on the
              treasury, but the contract’s recorded allocated principal is still
              {formatAmount(positionsTotal, stableDecimals, 2)} {stableSymbol}.
              <br />
              This usually means the async execution committed without the venue
              actually taking the funds (venue doesn’t expose the right query
              methods, the venue isn’t a real NEP-141-compatible contract, or the
              transfer failed/rolled back). Treat Executed as “proposal state”,
              not “money is earning yield”, until venue balances/positions confirm
              otherwise.
            </section>
          )}
          {/* ---- signers ---- */}
          <SectionCard
            title="Signers"
            hint="approval participation across all proposals"
            delay={580}
          >
            <ul className="divide-y divide-primary-100">
              {activity.map((s) => {
                const isMe = myAccountId === s.account;
                return (
                  <li
                    key={s.account}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm font-semibold text-primary-900">
                        {s.account}
                      </span>
                      {isMe && (
                        <span className="shrink-0 rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-700">
                          you
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 text-xs font-semibold text-ink-600">
                      <span title="Approvals cast across all proposals">
                        {s.approvals} approved
                      </span>
                      <span title="Approvals on proposals still pending">
                        {s.pendingApprovals} pending
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {config.data?.proposer && (
              <p className="mt-4 border-t border-primary-100 pt-3 text-xs font-medium text-ink-400">
                AI proposer <span className="font-mono">{config.data.proposer}</span>{" "}
                — can create proposals, never approve them.
              </p>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
