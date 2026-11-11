// Minimal line-icon set (24px grid, 1.75 stroke, currentColor). Inline SVG so it themes with
// Tailwind text colors and needs no icon dependency.

const PATHS = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowUpRight: "M7 17L17 7M8 7h9v9",
  payout: "M12 3v12m0 0l-4-4m4 4l4-4M5 21h14",
  allocate: "M4 17l5-5 4 4 7-7M14 9h6v6",
  withdraw: "M4 7l5 5 4-4 7 7M14 15h6V9",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  pause: "M9 5v14M15 5v14",
  user: "M20 21a8 8 0 10-16 0M12 11a4 4 0 100-8 4 4 0 000 8z",
  users: "M17 21a5 5 0 00-10 0M12 11a4 4 0 100-8 4 4 0 000 8zM21 21a4 4 0 00-3-3.9M17 3.1a4 4 0 010 7.8",
  hash: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  bot: "M12 8V4M8 4h8M5 8h14v11H5zM9 13h.01M15 13h.01M9 17h6",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8zM7.5 7.5h.01",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 118 0v4",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  plus: "M12 5v14M5 12h14",
  wallet: "M3 7h15a3 3 0 013 3v7a3 3 0 01-3 3H6a3 3 0 01-3-3V7zm0 0V6a2 2 0 012-2h11M16 14h.01",
  coins: "M9 14a6 6 0 100-12 6 6 0 000 12zM15.5 9.6A6 6 0 1114.4 21M7 8h3M8.5 6.5v3",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  eyeOff: "M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9 9 0 0121 12a13 13 0 01-2.2 3M6.2 6.2A13 13 0 003 12s3.5 7 9 7a9 9 0 004.3-1.1",
  key: "M15 7a4 4 0 11-3.9 4.9L4 19v2h3l1-1v-2h2v-2h2l.6-.6A4 4 0 0115 7zM16 8h.01",
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6l2-8z",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  external: "M14 4h6v6M10 14L20 4M19 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h6",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h3",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  store: "M3 9l2-5h14l2 5M3 9h18v11H3V9zm6 11v-6h6v6",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({
  name,
  className = "h-4 w-4",
  strokeWidth = 1.75,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
