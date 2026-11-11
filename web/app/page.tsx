import Link from "next/link";
import Icon, { type IconName } from "@/components/Icon";

const PILLARS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "eyeOff",
    title: "Private by construction",
    body: "Sales, customers and bills go only to a model running inside NEAR AI Cloud's TEE. Only a hash reaches the chain.",
  },
  {
    icon: "shield",
    title: "Verified on chain",
    body: "The treasury contract recovers the TEE's signature and parses proposals from the signed output. No badge to trust.",
  },
  {
    icon: "lock",
    title: "Bounded by policy",
    body: "Allowlisted vendors, per-payout and daily caps, a veto window and a reserve floor. Everything else needs M-of-N.",
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Private inference",
    body: "The agent sends the books and on-chain state to an attested model. A schema limits payees to known vendors.",
  },
  {
    title: "Signed output",
    body: "The TEE signs the model name and the request and response hashes with a key bound to its Intel TDX quote.",
  },
  {
    title: "On-chain verification",
    body: "propose_attested recomputes the hash, runs ecrecover, rejects replays and stale or tampered responses.",
  },
  {
    title: "Bounded execution",
    body: "Small payouts to trusted vendors run after a veto window. Larger or new ones wait for signers.",
  },
];

const PRODUCT: { href: string; icon: IconName; title: string; body: string }[] = [
  { href: "/dashboard", icon: "layers", title: "Dashboard", body: "Balances, positions, signer activity and proposal health." },
  { href: "/treasury", icon: "shield", title: "Treasury", body: "Review AI proposals, veto, approve and track the autonomy budget." },
  { href: "/invoices", icon: "receipt", title: "Invoices", body: "Vendor agents submit invoices as NFTs. Sell them early or get paid by the AI." },
  { href: "/checkout/demo", icon: "wallet", title: "Checkout", body: "Accept any token via NEAR Intents, settle to the treasury as stablecoin." },
  { href: "/flows", icon: "allocate", title: "Flows", body: "Follow funds from payment to payout and yield venue." },
];

/** Static product illustration. Not live data. */
function PreviewCard() {
  return (
    <div className="relative" aria-label="Product illustration">
      <div className="absolute -inset-6 -z-10 rounded-3xl bg-gradient-to-br from-primary-200/60 via-white to-transparent blur-2xl" />
      <div className="card overflow-hidden p-0 shadow-lift">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="eyebrow">Proposal #12</span>
          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200/70">
            Pending
          </span>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
              <Icon name="payout" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-ink-900">Payout 40 USDT</p>
              <p className="truncate font-mono text-xs text-ink-600">→ packaging.treasury-dev.testnet</p>
              <p className="mt-1.5 text-sm text-ink-600">Bill PKG-2291 due Nov 12, within the 14-day window.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200/70">
              <Icon name="shield" className="h-3.5 w-3.5" /> TEE-signed · checked on chain
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-primary-50 px-2 py-1 text-[11px] font-medium text-ink-600 ring-1 ring-line">
              <Icon name="bot" className="h-3.5 w-3.5" /> Qwen3.6 · NEAR AI TEE
            </span>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-ink-900">
                <Icon name="clock" className="h-3.5 w-3.5 text-amber-600" /> Autonomy lane
              </span>
              <span className="font-mono text-ink-600">executes in 4 min</span>
            </div>
            <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-primary-100">
              <div className="w-[25%] bg-ink-900" />
              <div className="w-[40%] bg-amber-400" />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-400">
              <span>65 / 100 USDT today</span>
              <span>1 veto stops it</span>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex flex-1 items-center justify-center rounded-lg border border-line bg-white py-2 text-xs font-medium text-red-600">
              Veto
            </span>
            <span className="inline-flex flex-1 items-center justify-center rounded-lg bg-ink-900 py-2 text-xs font-medium text-white">
              Approve
            </span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-ink-400">Illustration of the treasury view</p>
    </div>
  );
}

export default function Home() {
  return (
    <div className="space-y-24 pb-8">
      {/* Hero */}
      <section className="grid items-center gap-12 pt-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div className="animate-card-in">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-ink-600 shadow-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-primary-500" aria-hidden="true" />
            Confidential AI treasury on NEAR
          </span>
          <h1 className="mt-6 text-4xl font-semibold leading-[1.08] text-ink-900 sm:text-5xl lg:text-[3.4rem]">
            An AI treasurer your
            <br className="hidden sm:block" /> contract keeps in check.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-600">
            Ghost Store reads a merchant&apos;s books privately inside a TEE and drafts vendor
            payouts and yield moves. The treasury contract verifies every draft&apos;s TEE
            signature, and only small, policy-bound payouts run without a human.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/treasury" className="btn-primary h-11 px-5">
              Open treasury <Icon name="arrowRight" />
            </Link>
            <Link href="/checkout/demo" className="btn-ghost h-11 px-5">
              Try checkout
            </Link>
          </div>
          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
            {[
              ["M-of-N", "signer approvals"],
              ["1 veto", "stops autonomy"],
              ["0 bytes", "of books on chain"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-lg font-semibold text-ink-900">{k}</dt>
                <dd className="text-xs text-ink-600">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="animate-card-in" style={{ animationDelay: "120ms" }}>
          <PreviewCard />
        </div>
      </section>

      {/* Pillars */}
      <section className="grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
        {PILLARS.map((p) => (
          <div key={p.title} className="bg-white p-6">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
              <Icon name={p.icon} />
            </span>
            <h3 className="mt-4 font-semibold text-ink-900">{p.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{p.body}</p>
          </div>
        ))}
      </section>

      {/* How it works */}
      <section>
        <div className="max-w-2xl">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">
            Trust moves from the interface into the contract.
          </h2>
          <p className="mt-3 text-ink-600">
            A TEE signature proves which model wrote a proposal, not that it is a good idea. So it
            buys the AI a small, capped amount of autonomy, nothing more.
          </p>
        </div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card p-5" style={{ animationDelay: `${i * 70}ms` }}>
              <span className="font-mono text-xs text-ink-400">0{i + 1}</span>
              <h3 className="mt-3 font-semibold text-ink-900">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Two lanes */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-7">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700">
            <Icon name="clock" /> Autonomy lane
          </div>
          <h3 className="mt-3 text-xl font-semibold text-ink-900">Routine bills pay themselves</h3>
          <ul className="mt-5 space-y-3 text-sm text-ink-600">
            {[
              "TEE-signed payout to an allowlisted vendor",
              "Within the per-payout limit and today's cap",
              "Executes after the veto window, by anyone",
              "Reserve floor checked against the live balance",
            ].map((t) => (
              <li key={t} className="flex gap-2.5">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-7">
          <div className="flex items-center gap-2 text-sm font-medium text-primary-700">
            <Icon name="users" /> Signer lane
          </div>
          <h3 className="mt-3 text-xl font-semibold text-ink-900">Everything else needs people</h3>
          <ul className="mt-5 space-y-3 text-sm text-ink-600">
            {[
              "New payees and amounts above the limits",
              "Yield allocations and withdrawals",
              "Governance: signers, policy, trusted model keys",
              "Any one signer can pause autonomy instantly",
            ].map((t) => (
              <li key={t} className="flex gap-2.5">
                <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Invoices: agent-to-agent payments + factoring */}
      <section className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Agent-to-agent invoices</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">
            Vendor agents bill. Your AI checks. The contract pays.
          </h2>
          <p className="mt-3 text-ink-600">
            Any vendor, or its agent, submits an invoice on chain. Inside the TEE the AI matches it
            against the private books and proposes payment by invoice id, never by payee, so a
            manipulated prompt can&apos;t redirect funds. Fake and duplicate invoices are simply never paid.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-ink-600">
            {[
              ["receipt", "Every invoice is an NFT (NEP-171). Whoever holds it gets paid."],
              ["store", "Vendors sell unpaid invoices for early cash, atomically on chain."],
              ["shield", "Autonomous payment only for allowlisted issuers, within the caps."],
            ].map(([icon, t]) => (
              <li key={t} className="flex gap-2.5">
                <Icon name={icon as IconName} className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
                {t}
              </li>
            ))}
          </ul>
          <Link href="/invoices" className="btn-ghost mt-7 h-10">
            Browse invoices <Icon name="arrowRight" />
          </Link>
        </div>
        <figure>
        <div className="card overflow-hidden p-0" aria-label="Invoice lifecycle illustration">
          {[
            ["packaging.testnet submits PKG-2291", "40 USDT · NFT #3 minted to the vendor", "receipt", "text-ink-600"],
            ["Vendor lists it for 39.20 USDT", "A buyer pays now; 0.5% sale fee to the operator", "store", "text-amber-700"],
            ["AI matches it to the books", "PayInvoice #3, TEE-signed, checked on chain", "bot", "text-primary-700"],
            ["Veto window passes", "Treasury pays 40 USDT to the current holder", "check", "text-emerald-700"],
          ].map(([t, b, icon, tone], i) => (
            <div key={t} className={`flex gap-3 px-5 py-4 ${i ? "border-t border-line" : ""}`}>
              <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface ring-1 ring-line ${tone}`}>
                <Icon name={icon as IconName} className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-medium text-ink-900">{t}</p>
                <p className="text-xs text-ink-600">{b}</p>
              </div>
            </div>
          ))}
        </div>
        <figcaption className="mt-3 text-center text-[11px] text-ink-400">Illustration of an invoice&apos;s lifecycle</figcaption>
        </figure>
      </section>

      {/* For agent builders */}
      <section className="grid items-start gap-10 rounded-2xl border border-line bg-white p-7 shadow-soft sm:p-10 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="eyebrow">For agent builders</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">A wallet your agent can&apos;t empty.</h2>
          <p className="mt-3 text-ink-600">
            Any agent that pays for APIs, compute or suppliers needs spending power without a blank
            cheque. Point it at a Ghost Store treasury: decisions are verified on chain, spending is
            capped, and humans keep a veto.
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            {[
              ["Provenance", "TEE signature checked by the contract"],
              ["Limits", "Per-payout, daily cap, allowlist"],
              ["Oversight", "Veto window, one-signer pause"],
              ["Accountability", "Invoice-backed, replay-proof"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="font-medium text-ink-900">{k}</dt>
                <dd className="text-ink-600">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <pre className="overflow-x-auto rounded-xl bg-ink-900 p-5 font-mono text-[12.5px] leading-relaxed text-white/85">
          <code>{`// 1. Private inference inside NEAR AI's TEE
const res = await fetch(\`\${NEAR_AI}/chat/completions\`, { body });
const sig = await getSignature(res.id);   // TEE-held ECDSA key

// 2. The contract verifies and parses the signed output
await treasury.propose_attested({
  model, request_hash,                    // books stay off chain
  response: base64(responseBytes),
  signature: sig.signature,
});

// 3. Within limits: executes after the veto window
await treasury.execute_auto({ id });`}</code>
        </pre>
      </section>

      {/* How it earns */}
      <section>
        <p className="eyebrow">How it earns</p>
        <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {[
            ["Invoice sale fee", "A governance-set fee (up to 10%) on every invoice sold early, enforced by the contract.", "Live in contract"],
            ["Checkout settlement", "A small fee on payments settled to the treasury through NEAR Intents.", "Planned"],
            ["Agent treasuries", "Hosted treasuries for agent builders: policy templates, keeper and monitoring.", "Planned"],
          ].map(([t, b, tag]) => (
            <div key={t} className="bg-white p-6">
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${
                  tag === "Planned" ? "bg-surface text-ink-600 ring-line" : "bg-emerald-50 text-emerald-700 ring-emerald-200/70"
                }`}
              >
                {tag}
              </span>
              <h3 className="mt-3 font-semibold text-ink-900">{t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Product */}
      <section>
        <p className="eyebrow">Product</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {PRODUCT.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className="card group flex flex-col p-5 transition-[box-shadow,border-color] hover:border-primary-300 hover:shadow-lift"
            >
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary-100 text-primary-700 transition-colors group-hover:bg-ink-900 group-hover:text-white">
                <Icon name={p.icon} />
              </span>
              <span className="mt-4 flex items-center justify-between font-semibold text-ink-900">
                {p.title}
                <Icon
                  name="arrowUpRight"
                  className="h-4 w-4 text-ink-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ink-900"
                />
              </span>
              <span className="mt-1.5 text-sm leading-relaxed text-ink-600">{p.body}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden rounded-2xl bg-ink-900 px-8 py-12 text-white sm:px-12">
        <div className="bg-grid absolute inset-0 opacity-[0.15] invert" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <h2 className="text-2xl font-semibold sm:text-3xl">See the proposals the AI drafted today.</h2>
            <p className="mt-2 text-white/70">
              Live on NEAR testnet. Connect a signer wallet to approve or veto.
            </p>
          </div>
          <Link
            href="/treasury"
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-5 text-sm font-medium text-ink-900 transition-colors hover:bg-primary-100"
          >
            Open treasury <Icon name="arrowRight" />
          </Link>
        </div>
      </section>
    </div>
  );
}
