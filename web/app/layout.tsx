import type { Metadata } from "next";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";

export const metadata: Metadata = {
  title: "Ghost Store",
  description: "Confidential AI treasury for merchants on NEAR",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 font-sans antialiased">
        <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <span className="font-semibold tracking-tight text-white">👻 Ghost Store</span>
          <nav className="flex gap-4 text-sm text-gray-400">
            <a href="/treasury" className="hover:text-white transition-colors">Treasury</a>
            <a href="/flows" className="hover:text-white transition-colors">Flows</a>
          </nav>
        </header>
        <main className="max-w-5xl mx-auto px-6 py-10">
          <QueryProvider>{children}</QueryProvider>
        </main>
      </body>
    </html>
  );
}
