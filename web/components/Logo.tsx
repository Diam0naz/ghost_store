// Ghost Store logo. A Snapchat-style ghost mark as pure inline SVG so it can
// be themed with Tailwind color tokens — no asset pipeline needed.

// Plump ghost silhouette: rounded dome, up-flared shoulder tabs and a wavy hem.
const GHOST_BODY =
  "M32 4 C25.5 4 15 10.5 15 20 L15 26.8 " +
  "C12.9 26.4 10.6 25 9.2 23.3 " +
  "C8.2 22.1 6.4 22.2 5.7 23.5 " +
  "C5.05 24.7 5.4 26.1 6.5 27.1 " +
  "C8.4 28.9 10.9 30.2 14 30.9 " +
  "C13.8 33.3 12.9 35.5 11.2 37.3 " +
  "C9.2 39.4 6.5 40.6 4.2 41.8 " +
  "C3.55 43.5 4.45 44.75 6 44.95 " +
  "C11.1 45.6 16.4 44.4 21.2 46.6 " +
  "C24.6 48.2 27.9 50.9 32 50.9 " +
  "C36.1 50.9 39.4 48.2 42.8 46.6 " +
  "C47.6 44.4 52.9 45.6 58 44.95 " +
  "C59.55 44.75 60.45 43.5 59.8 41.8 " +
  "C57.5 40.6 54.8 39.4 52.8 37.3 " +
  "C51.1 35.5 50.2 33.3 50 30.9 " +
  "C53.1 30.2 55.6 28.9 57.5 27.1 " +
  "C58.6 26.1 58.95 24.7 58.3 23.5 " +
  "C57.6 22.2 55.8 22.1 54.8 23.3 " +
  "C53.4 25 51.1 26.4 49 26.8 " +
  "L49 20 C49 10.5 38.5 4 32 4 Z";

// Two oval eye cutouts. Rendered with fill-rule="evenodd" they punch through
// whatever is behind the ghost (the gradient badge, card background, ...).
const GHOST_EYES =
  "M23.5 20 a3 4 0 1 0 6 0 a3 4 0 1 0 -6 0 Z " +
  "M34.5 20 a3 4 0 1 0 6 0 a3 4 0 1 0 -6 0 Z";

const GHOST_PATH = GHOST_BODY + " " + GHOST_EYES;

/** Bare ghost silhouette with eye cutouts, inherits color from `currentColor`. */
export function GhostMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden="true"
    >
      <path d={GHOST_PATH} />
    </svg>
  );
}

export { GHOST_BODY, GHOST_EYES };

/** Ghost mark on the purple rounded badge (the app logo). */
export default function Logo({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[30%] bg-gradient-to-br from-primary-400 via-primary-500 to-primary-700 shadow-soft ${className}`}
      style={{ width: size, height: size }}
    >
      <GhostMark className="h-[68%] w-[68%] text-white" />
    </span>
  );
}
