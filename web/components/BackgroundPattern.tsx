"use client";
// Sparse decorative background: hand-authored ghosts, coins, diamonds and
// sparkles scattered behind every route. Deterministic — positions live in a
// fixed array (no Math.random), so SSR and client render identically.
//
// Density: the landing page gets the full pattern; data pages (dashboard,
// treasury, flows, checkout) get a sparse edge-only subset at capped opacity
// so nothing fights the text people came to read.

import { usePathname } from "next/navigation";
import { GhostMark } from "@/components/Logo";

type PatternItem = {
  type: "ghost" | "coin" | "diamond" | "sparkle";
  /** Left offset as % of the page. */
  x: string;
  /** Top offset as % of the whole page height. */
  y: string;
  /** Literal Tailwind classes: mobile size, then md: desktop size. */
  size: string;
  /** Literal text-* color class (ghosts/sparkles use currentColor). */
  color: string;
  /** Static rotation in degrees (-15..15 for ghosts). */
  rotate: number;
  /** 0.10 – 0.35 so it reads as background. */
  opacity: number;
  delay: string;
  duration: string;
  /** Float amplitude in px (6..12), applied via --pattern-amp. */
  amp: number;
  /** Hidden below the md breakpoint (landing shows only 9 on mobile). */
  desktopOnly?: boolean;
  mirror?: boolean;
  /** Coins seen edge-on. */
  edgeOn?: boolean;
  /** Diamonds with a slow spin. */
  spin?: boolean;
};

// ---- original SVG artwork ---------------------------------------------------

/** Coin: body, inner ring, highlight arc and a NEAR-style N mark. */
function Coin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="currentColor" />
      <circle
        cx="16"
        cy="16"
        r="11.5"
        fill="none"
        stroke="white"
        strokeOpacity="0.5"
        strokeWidth="1.5"
      />
      <path
        d="M6.5 13.5A11 11 0 0 1 11.5 6.8"
        fill="none"
        stroke="white"
        strokeOpacity="0.35"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M11 21.5V10.5l10 11v-11"
        fill="none"
        stroke="white"
        strokeOpacity="0.9"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Diamond: kite silhouette split into four facets, light from upper-left. */
function Diamond({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 28" className={className} aria-hidden="true">
      <path d="M16 1 L2 11 L16 11 Z" fill="var(--color-primary-200)" />
      <path d="M16 1 L30 11 L16 11 Z" fill="var(--color-primary-300)" />
      <path d="M2 11 L16 27 L16 11 Z" fill="var(--color-primary-400)" />
      <path d="M30 11 L16 27 L16 11 Z" fill="var(--color-primary-500)" />
    </svg>
  );
}

// ---- sizes ------------------------------------------------------------------

const GHOST = {
  tiny: "h-4 w-4 md:h-5 md:w-5", // 20px desktop
  sm: "h-6 w-6 md:h-9 md:w-9", // 36px
  md: "h-8 w-8 md:h-12 md:w-12", // 48px
  lg: "h-10 w-10 md:h-16 md:w-16", // 64px
  xl: "h-16 w-16 md:h-30 md:w-30", // 120px
};
const COIN = {
  sm: "h-3 w-3 md:h-4 md:w-4", // 16px
  md: "h-5 w-5 md:h-8 md:w-8", // 32px
  lg: "h-6 w-6 md:h-12 md:w-12", // 48px
};
const GEM = {
  xs: "h-2 w-2 md:h-2.5 md:w-2.5", // 10px
  sm: "h-3 w-3 md:h-4 md:w-4", // 16px
  md: "h-4 w-4 md:h-6 md:w-6", // 24px
  lg: "h-6 w-6 md:h-9 md:w-9", // 36px
};
const SPARK = {
  sm: "text-xs md:text-sm",
  md: "text-sm md:text-base",
};

// ---- the pattern ------------------------------------------------------------
// Laid out in side columns (x <= 9% / x >= 90%) plus the bands above the hero,
// between the hero and cards, and below the cards. Neighbours are kept roughly
// 120px+ apart at desktop width and types alternate so no two touch.

const PATTERN: PatternItem[] = [
  // Left column
  { type: "ghost", x: "3%", y: "11%", size: GHOST.lg, color: "text-primary-300", rotate: -8, opacity: 0.16, delay: "0s", duration: "9s", amp: -8, desktopOnly: true },
  { type: "coin", x: "8%", y: "28%", size: COIN.md, color: "text-primary-400", rotate: 14, opacity: 0.22, delay: "1.4s", duration: "7.5s", amp: -7, desktopOnly: true, edgeOn: true },
  { type: "diamond", x: "4%", y: "45%", size: GEM.lg, color: "", rotate: -10, opacity: 0.18, delay: "0.8s", duration: "10s", amp: -9, spin: true },
  { type: "ghost", x: "9%", y: "62%", size: GHOST.xl, color: "text-primary-400", rotate: 6, opacity: 0.12, delay: "2s", duration: "12s", amp: -11, desktopOnly: true, mirror: true },
  { type: "coin", x: "4%", y: "79%", size: COIN.lg, color: "text-primary-500", rotate: -16, opacity: 0.2, delay: "3s", duration: "8s", amp: -8, desktopOnly: true },
  { type: "diamond", x: "8%", y: "96%", size: GEM.md, color: "", rotate: 12, opacity: 0.2, delay: "1.2s", duration: "9.5s", amp: -7, desktopOnly: true },
  // Right column
  { type: "coin", x: "95%", y: "17%", size: COIN.md, color: "text-primary-400", rotate: -12, opacity: 0.2, delay: "0.5s", duration: "8.5s", amp: -7, desktopOnly: true },
  { type: "ghost", x: "90%", y: "34%", size: GHOST.sm, color: "text-primary-300", rotate: 8, opacity: 0.26, delay: "2.4s", duration: "7s", amp: -6, desktopOnly: true, mirror: true },
  { type: "diamond", x: "96%", y: "51%", size: GEM.md, color: "", rotate: -6, opacity: 0.16, delay: "1.7s", duration: "11s", amp: -10, desktopOnly: true },
  { type: "coin", x: "91%", y: "68%", size: COIN.sm, color: "text-primary-500", rotate: 18, opacity: 0.26, delay: "0.3s", duration: "6.5s", amp: -6, desktopOnly: true, edgeOn: true },
  { type: "ghost", x: "95%", y: "83%", size: GHOST.lg, color: "text-primary-400", rotate: -12, opacity: 0.14, delay: "3.5s", duration: "11.5s", amp: -10, desktopOnly: true },
  { type: "coin", x: "90%", y: "98%", size: COIN.md, color: "text-primary-400", rotate: 8, opacity: 0.22, delay: "1.1s", duration: "9s", amp: -8 },
  // Band above the hero (between header and hero card)
  { type: "diamond", x: "28%", y: "12%", size: GEM.xs, color: "", rotate: 10, opacity: 0.2, delay: "0.7s", duration: "8s", amp: -7, desktopOnly: true },
  { type: "sparkle", x: "47%", y: "13.5%", size: SPARK.sm, color: "text-primary-300", rotate: 0, opacity: 0.3, delay: "1.9s", duration: "7s", amp: -6, desktopOnly: true },
  { type: "ghost", x: "68%", y: "12%", size: GHOST.md, color: "text-primary-300", rotate: -5, opacity: 0.24, delay: "2.8s", duration: "9.5s", amp: -8, desktopOnly: true, mirror: true },
  // Gap between hero and cards
  { type: "coin", x: "33%", y: "57%", size: COIN.sm, color: "text-primary-400", rotate: -14, opacity: 0.24, delay: "0.4s", duration: "7.5s", amp: -6, desktopOnly: true },
  { type: "diamond", x: "52%", y: "58.5%", size: GEM.sm, color: "", rotate: 7, opacity: 0.22, delay: "2.1s", duration: "10.5s", amp: -9, desktopOnly: true, spin: true },
  { type: "sparkle", x: "71%", y: "57%", size: SPARK.md, color: "text-primary-400", rotate: 0, opacity: 0.26, delay: "1.3s", duration: "8s", amp: -7, desktopOnly: true },
  // Below the cards
  { type: "ghost", x: "24%", y: "98%", size: GHOST.sm, color: "text-primary-300", rotate: 9, opacity: 0.22, delay: "0.9s", duration: "9s", amp: -8 },
  { type: "coin", x: "52%", y: "97.5%", size: COIN.md, color: "text-primary-400", rotate: -8, opacity: 0.2, delay: "2.6s", duration: "7s", amp: -6 },
  { type: "diamond", x: "80%", y: "98%", size: GEM.md, color: "", rotate: -12, opacity: 0.18, delay: "1.5s", duration: "10s", amp: -9, spin: true },
  // Mobile-visible extras: card gaps on small screens, margins on desktop
  { type: "ghost", x: "62%", y: "45.5%", size: GHOST.tiny, color: "text-primary-400", rotate: -14, opacity: 0.3, delay: "0.2s", duration: "6.5s", amp: -6, mirror: true },
  { type: "ghost", x: "44%", y: "64.5%", size: GHOST.sm, color: "text-primary-300", rotate: 11, opacity: 0.2, delay: "3.2s", duration: "8.5s", amp: -7 },
  { type: "diamond", x: "35%", y: "82%", size: GEM.sm, color: "", rotate: -9, opacity: 0.22, delay: "1.6s", duration: "9.5s", amp: -8 },
  { type: "sparkle", x: "86%", y: "82%", size: SPARK.sm, color: "text-primary-300", rotate: 0, opacity: 0.28, delay: "2.3s", duration: "7.5s", amp: -6 },
];

// Sparse subset for data pages: edge-only items (side margins on wide
// screens), types still mixed.
const SPARSE_IDX = [0, 2, 4, 5, 7, 9, 10, 11];
const SPARSE = SPARSE_IDX.map((i) => PATTERN[i]);

function ItemArt({ item }: { item: PatternItem }) {
  if (item.type === "ghost") {
    return <GhostMark className={`${item.size} ${item.color}`} />;
  }
  if (item.type === "coin") {
    return <Coin className={`${item.size} ${item.color}`} />;
  }
  if (item.type === "diamond") {
    const gem = <Diamond className={item.size} />;
    // Spin lives on its own layer so it composes with the float above it.
    return item.spin ? (
      <div className="animate-pattern-spin">{gem}</div>
    ) : (
      gem
    );
  }
  return (
    <span className={`font-bold leading-none ${item.size} ${item.color}`}>
      ✦
    </span>
  );
}

export default function BackgroundPattern() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const items = isHome ? PATTERN : SPARSE;

  return (
    <div
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={`absolute ${
            isHome && item.desktopOnly ? "hidden md:block" : ""
          }`}
          style={{
            left: item.x,
            top: item.y,
            opacity: isHome ? item.opacity : Math.min(item.opacity, 0.16),
            transform: `rotate(${item.rotate}deg)${
              item.edgeOn ? " scaleY(0.35)" : ""
            }${item.mirror ? " scaleX(-1)" : ""}`,
          }}
        >
          <div
            className="animate-pattern-float"
            style={
              {
                animationDuration: item.duration,
                animationDelay: item.delay,
                "--pattern-amp": `${item.amp}px`,
              } as React.CSSProperties
            }
          >
            <ItemArt item={item} />
          </div>
        </div>
      ))}
    </div>
  );
}
