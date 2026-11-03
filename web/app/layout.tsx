import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
import Logo from "@/components/Logo";
import PrivyProviderWrapper from "@/components/PrivyProvider";
import WalletButton from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "Ghost Store",
  description: "Confidential AI treasury for merchants on NEAR",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <head>
        {/* Baloo 2 — rounded display font (loaded at runtime, keeps builds offline-safe) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400..800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-20 px-4 pt-4">
          <div className="mx-auto flex max-w-5xl items-center justify-between rounded-2xl border border-primary-100 bg-white/80 px-5 py-3 shadow-soft backdrop-blur">
            <Link href="/" className="flex items-center gap-3">
              <Logo size={38} />
              <span className="text-xl font-bold tracking-tight text-primary-950">
                Ghost Store
              </span>
            </Link>
            <div className="flex items-center gap-2">
              <nav className="flex gap-1 text-sm font-semibold">
                <Link
                  href="/treasury"
                  className="rounded-full px-4 py-1.5 text-ink-600 transition-colors hover:bg-primary-100 hover:text-primary-800"
                >
                  Treasury
                </Link>
                <Link
                  href="/flows"
                  className="rounded-full px-4 py-1.5 text-ink-600 transition-colors hover:bg-primary-100 hover:text-primary-800"
                >
                  Flows
                </Link>
              </nav>
              {/* Connect button / connected wallet name — visible on every page */}
              <div className="border-l border-primary-100 pl-2">
                <WalletButton />
              </div>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">
          <QueryProvider>
            <PrivyProviderWrapper>{children}</PrivyProviderWrapper>
          </QueryProvider>
        </main>
      </body>
    </html>
  );
}
