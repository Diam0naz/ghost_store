import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
import Logo from "@/components/Logo";
import WalletButton from "@/components/WalletButton";
import SiteNav from "@/components/SiteNav";
import { NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Ghost Store — Confidential AI treasury on NEAR",
  description:
    "An AI treasurer for merchants. Private inference in a TEE, proposals verified on chain, spending bounded by the contract.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <head>
        {/* Geist + Geist Mono, loaded at runtime so builds stay offline-safe. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300..800&family=Geist+Mono:wght@400..600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-screen flex-col font-sans antialiased">
        <header className="sticky top-0 z-40 border-b border-line/80 bg-white/75 backdrop-blur-md supports-[backdrop-filter]:bg-white/65">
          <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex items-center gap-8">
              <Link href="/" className="flex items-center gap-2.5" aria-label="Ghost Store home">
                <Logo size={30} />
                <span className="text-[15px] font-semibold tracking-tight text-ink-900">
                  Ghost Store
                </span>
              </Link>
              <SiteNav />
            </div>
            <WalletButton />
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
          <QueryProvider>{children}</QueryProvider>
        </main>

        <footer className="border-t border-line bg-white/60">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-2.5">
              <Logo size={22} />
              <span className="font-medium text-ink-900">Ghost Store</span>
              <span className="text-ink-400">· Built on NEAR · Testnet</span>
            </div>
            <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-ink-900">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
