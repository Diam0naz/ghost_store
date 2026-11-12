// Site footer: brand, product links, proof links (docs + live contracts), and the builder's
// GitHub profile. Server component: no client JS.
import Link from "next/link";
import Logo from "@/components/Logo";
import { NAV } from "@/lib/nav";

const GITHUB_USER = "Diam0naz";
const REPO = `https://github.com/${GITHUB_USER}/ghost_store`;
const VAULT = process.env.NEXT_PUBLIC_TREASURY_CONTRACT_ID || "vault2.treasury-dev.testnet";

const PROOF = [
  { href: `${REPO}#proven-on-mainnet-checkout-via-near-intents`, label: "Mainnet payment proof" },
  { href: `${REPO}#what-is-proven-on-testnet-v2`, label: "Testnet results" },
  { href: `${REPO}/blob/main/docs/ATTESTATION.md`, label: "TEE attestation" },
  { href: `${REPO}/blob/main/docs/CONTRACT.md`, label: "Contract design" },
  { href: `https://testnet.nearblocks.io/address/${VAULT}`, label: "Treasury on explorer" },
];

function GitHubMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function ExternalArrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3 opacity-50" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17L17 7M8 7h9v9" />
    </svg>
  );
}

export default function SiteFooter() {
  return (
    <footer className="border-t border-line bg-white/70">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-x-6 gap-y-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1.2fr]">
        {/* Brand */}
        <div className="col-span-2 md:col-span-1">
          <Link href="/" className="inline-flex items-center gap-2.5" aria-label="Ghost Store home">
            <Logo size={28} />
            <span className="text-[15px] font-semibold tracking-tight text-ink-900">Ghost Store</span>
          </Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-600">
            An AI treasurer for merchants. Private inference in a TEE, proposals verified on chain,
            spending bounded by the contract.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-medium">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-ink-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              Treasury: NEAR testnet
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-ink-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Checkout: mainnet
            </span>
          </div>
        </div>

        {/* Product */}
        <nav aria-label="Product">
          <p className="eyebrow mb-3">Product</p>
          <ul className="space-y-2 text-sm">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="text-ink-600 transition-colors hover:text-ink-900">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Proof */}
        <nav aria-label="Proof and docs">
          <p className="eyebrow mb-3">Proof</p>
          <ul className="space-y-2 text-sm">
            {PROOF.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-ink-600 transition-colors hover:text-ink-900"
                >
                  {l.label}
                  <ExternalArrow />
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Builder */}
        <div className="col-span-2 md:col-span-1">
          <p className="eyebrow mb-3">Built by</p>
          <a
            href={`https://github.com/${GITHUB_USER}`}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-3 rounded-xl border border-line bg-white p-3 shadow-soft transition-all hover:border-primary-300 hover:shadow-lift"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://github.com/${GITHUB_USER}.png?size=96`}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-full bg-primary-50"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900">{GITHUB_USER}</span>
              <span className="flex items-center gap-1 text-xs text-ink-400">
                <GitHubMark className="h-3.5 w-3.5" />
                github.com/{GITHUB_USER}
              </span>
            </span>
            <span className="text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-600">→</span>
          </a>
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm text-ink-600 transition-colors hover:text-ink-900"
          >
            <GitHubMark className="h-4 w-4" />
            Source code
            <ExternalArrow />
          </a>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© 2026 Ghost Store. Built at NEAR HACKATHON.</p>
          <p>Testnet funds only in the treasury. Not financial advice.</p>
        </div>
      </div>
    </footer>
  );
}
