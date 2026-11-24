"use client";
// Which treasury the visitor is looking at (the demo or a merchant's shop), with a switcher
// for shops the connected account created or signs for, and a link to create one.
// Rendered after mount only: the selected shop lives in the browser, not on the server.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEFAULT_TREASURY_ID,
  FACTORY_CONTRACT_ID,
  TREASURY_CONTRACT_ID,
  switchShop,
  useAccountId,
} from "@/lib/near";
import { useMyShops, useShop } from "@/lib/factory";

export default function ShopBanner() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const accountId = useAccountId();
  const shops = useMyShops(accountId);
  const isDemo = TREASURY_CONTRACT_ID === DEFAULT_TREASURY_ID;
  const current = useShop(isDemo ? null : TREASURY_CONTRACT_ID);

  if (!mounted || !FACTORY_CONTRACT_ID) return null;
  const mine = (shops.data ?? []).filter((s) => s.status === "Active");
  const name = isDemo ? "Demo shop" : current.data?.display_name ?? TREASURY_CONTRACT_ID;

  return (
    <div className="mb-4 flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-ink-600">
        Viewing <span className="font-semibold text-ink-900">{name}</span>{" "}
        <span className="font-mono text-xs text-ink-400">{TREASURY_CONTRACT_ID}</span>
      </p>
      <div className="flex items-center gap-2">
        {(mine.length > 0 || !isDemo) && (
          <label className="flex items-center gap-2">
            <span className="sr-only">Switch shop</span>
            <select
              className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm text-ink-900"
              value={TREASURY_CONTRACT_ID}
              onChange={(e) => {
                const v = e.target.value;
                const path = window.location.pathname;
                switchShop(v === DEFAULT_TREASURY_ID ? null : v, path);
              }}
            >
              <option value={DEFAULT_TREASURY_ID}>Demo shop</option>
              {mine.map((s) => (
                <option key={s.treasury} value={s.treasury}>
                  {s.display_name}
                </option>
              ))}
              {!isDemo && !mine.some((s) => s.treasury === TREASURY_CONTRACT_ID) && (
                <option value={TREASURY_CONTRACT_ID}>{name}</option>
              )}
            </select>
          </label>
        )}
        <Link href="/onboard" className="btn-ghost text-sm">
          {mine.length > 0 ? "New shop" : "Create your shop"}
        </Link>
      </div>
    </div>
  );
}
