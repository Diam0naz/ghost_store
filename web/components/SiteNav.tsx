"use client";
// Primary navigation with active-route state and a compact mobile menu.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NAV } from "@/lib/nav";

function isActive(pathname: string, item: (typeof NAV)[number]) {
  const base = item.match ?? item.href;
  return pathname === base || pathname.startsWith(base + "/");
}

export default function SiteNav() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <nav className="hidden items-center gap-1 text-sm md:flex" aria-label="Primary">
        {NAV.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                active
                  ? "bg-primary-100 text-ink-900"
                  : "text-ink-600 hover:bg-primary-50 hover:text-ink-900"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label="Menu"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-ink-900 md:hidden"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
        </svg>
      </button>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="absolute inset-x-4 top-full mt-2 rounded-xl border border-line bg-white p-2 shadow-lift animate-fade-in md:hidden"
        >
          {NAV.map((item) => {
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium ${
                  active ? "bg-primary-100 text-ink-900" : "text-ink-600 hover:bg-primary-50"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
