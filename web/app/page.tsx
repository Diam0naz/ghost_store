import Link from "next/link";
import Logo, { GhostMark } from "@/components/Logo";

const links = [
  {
    href: "/checkout/demo",
    title: "Checkout",
    desc: "Pay with any token via NEAR Intents. Settles to treasury as stablecoin.",
  },
  {
    href: "/treasury",
    title: "Treasury",
    desc: "Review and approve AI-drafted proposals. M-of-N signer flow.",
  },
  {
    href: "/flows",
    title: "Flows",
    desc: "Track where payments came in and where funds currently sit.",
  },
];

export default function Home() {
  return (
    <div className="space-y-10">
      {/* Hero */}
      <div className="card relative overflow-hidden p-8 md:p-10">
        <GhostMark className="pointer-events-none absolute -right-6 -top-8 h-52 w-52 text-primary-100" />
        <div className="relative">
          <div
            className="mb-5 inline-flex items-center gap-2 rounded-full bg-primary-100 px-3 py-1 text-xs font-bold text-primary-700 animate-card-in"
            style={{ animationDelay: "0ms" }}
          >
            <Logo size={18} />
            Powered by NEAR Intents
          </div>
          <h1
            className="mb-3 bg-gradient-to-r from-primary-800 via-primary-600 to-primary-400 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent animate-card-in md:text-5xl"
            style={{ animationDelay: "120ms" }}
          >
            Ghost Store
          </h1>
          <p
            className="max-w-xl text-lg font-medium text-ink-600 animate-card-in"
            style={{ animationDelay: "260ms" }}
          >
            Confidential AI-powered merchant treasury on NEAR. Pay vendors in
            any token, settle stablecoins, and let the AI draft M-of-N spending
            proposals in a TEE.
          </p>
        </div>
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {links.map((l, i) => (
          <Link
            key={l.href}
            href={l.href}
            className="card group p-6 transition-all hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-lg"
            style={{ animationDelay: `${90 + i * 90}ms` }}
          >
            <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary-100 text-primary-600 transition-colors group-hover:bg-primary-600 group-hover:text-white">
              <GhostMark className="h-7 w-7" />
            </div>
            <div className="mb-1 text-lg font-bold text-primary-950">{l.title}</div>
            <p className="text-sm font-medium text-ink-600">{l.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
