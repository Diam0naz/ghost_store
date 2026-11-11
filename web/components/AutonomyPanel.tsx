"use client";
// The AI's spending limits as the contract enforces them: today's autonomy budget,
// per-payout limit, veto window, vendor allowlist and the TEE keys the treasury trusts.

import {
  formatAmount,
  useAutonomy,
  useModelSigners,
  useVendors,
} from "@/lib/proposals";

function Bar({ spent, committed, cap }: { spent: bigint; committed: bigint; cap: bigint }) {
  const pct = (v: bigint) => (cap === 0n ? 0 : Number((v * 10_000n) / cap) / 100);
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-primary-100"
      role="img"
      aria-label={`Spent ${pct(spent)}%, waiting in veto window ${pct(committed)}%`}
    >
      <div className="bg-ink-900" style={{ width: `${pct(spent)}%` }} />
      <div className="bg-amber-400" style={{ width: `${pct(committed)}%` }} />
    </div>
  );
}

export default function AutonomyPanel() {
  const autonomy = useAutonomy();
  const vendors = useVendors();
  const signers = useModelSigners();

  if (autonomy.isError || vendors.isError || signers.isError) {
    return (
      <div className="card p-6 text-sm font-medium text-ink-600">
        <h2 className="mb-1 text-base font-semibold text-primary-950">AI autonomy</h2>
        This treasury contract does not expose the autonomy views yet. Deploy the v2 contract
        (see docs/CONTRACT.md) to enable on-chain verified AI proposals.
      </div>
    );
  }

  const a = autonomy.data;
  const policy = a?.policy ?? null;
  const fmt = (raw: string) => `${formatAmount(raw, 6, 2)} USDT`;

  return (
    <div className="card space-y-4 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-primary-950">AI autonomy</h2>
        <span className="text-xs font-medium text-ink-400">Limits enforced by the contract</span>
      </div>

      {!a ? (
        <div className="h-16 animate-pulse rounded-xl bg-primary-100" />
      ) : !policy ? (
        <p className="text-sm font-medium text-ink-600">
          Off. Every AI proposal waits for the signer threshold. Turn it on with a SetAutonomy
          proposal.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold text-ink-600">
              <span>
                Today: <span className="text-primary-950">{fmt(a.spent)}</span> paid ·{" "}
                <span className="text-amber-700">{fmt(a.committed)}</span> in veto window
              </span>
              <span>
                <span className="text-primary-950">{fmt(a.remaining)}</span> left of{" "}
                {fmt(policy.daily_cap)}
              </span>
            </div>
            <Bar
              spent={BigInt(a.spent)}
              committed={BigInt(a.committed)}
              cap={BigInt(policy.daily_cap)}
            />
          </div>
          <ul className="grid grid-cols-2 gap-2 text-xs font-medium text-ink-600 sm:grid-cols-4">
            <li className="rounded-xl bg-primary-50 px-3 py-2">
              Max per payout
              <span className="block font-mono text-sm font-bold text-primary-950">
                {fmt(policy.max_per_payout)}
              </span>
            </li>
            <li className="rounded-xl bg-primary-50 px-3 py-2">
              Veto window
              <span className="block font-mono text-sm font-bold text-primary-950">
                {Math.round(policy.veto_window_ms / 60_000)} min
              </span>
            </li>
            <li className="rounded-xl bg-primary-50 px-3 py-2">
              Pays
              <span className="block font-mono text-sm font-bold text-primary-950">
                {policy.invoices_only ? "Invoices only" : "Invoices + payouts"}
              </span>
            </li>
            <li className="rounded-xl bg-primary-50 px-3 py-2">
              Veto needs
              <span className="block font-mono text-sm font-bold text-primary-950">1 signer</span>
            </li>
          </ul>
        </>
      )}

      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <h3 className="mb-1 font-bold text-ink-600">Vendor allowlist</h3>
          {vendors.data?.length ? (
            <ul className="space-y-1">
              {vendors.data.map((v) => (
                <li key={v} className="break-all font-mono text-primary-950">
                  {v}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-400">None. No payout can run without signers.</p>
          )}
        </div>
        <div>
          <h3 className="mb-1 font-bold text-ink-600">Trusted TEE model keys</h3>
          {signers.data?.length ? (
            <ul className="space-y-1">
              {signers.data.map(([addr, model]) => (
                <li key={addr} className="min-w-0">
                  <span className="block break-all font-mono text-primary-950">{addr}</span>
                  <span className="text-ink-400">{model}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-400">
              None registered. Attested proposals are refused until signers approve a
              SetModelSigner proposal.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
