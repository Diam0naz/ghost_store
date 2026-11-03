// Shared empty-state illustration: the Ghost Store mascot floating gently and
// blinking, surrounded by twinkles. Used whenever a list has nothing to show.

import { GHOST_BODY, GHOST_EYES } from "@/components/Logo";

const TWINKLES = [
  { className: "left-[10%] top-[14%] text-lg text-primary-300", delay: "0.4s" },
  { className: "right-[12%] top-[22%] text-sm text-primary-200", delay: "1.3s" },
  { className: "bottom-[16%] left-[18%] text-sm text-primary-200", delay: "2.1s" },
  { className: "bottom-[24%] right-[24%] text-base text-primary-300", delay: "0.9s" },
];

export default function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="card relative overflow-hidden px-8 py-14 text-center">
      {/* Twinkle sparkles around the mascot */}
      {TWINKLES.map((t, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`animate-twinkle pointer-events-none absolute select-none font-bold ${t.className}`}
          style={{ animationDelay: t.delay }}
        >
          ✦
        </span>
      ))}

      {/* Floating, blinking mascot */}
      <svg
        viewBox="0 0 64 64"
        className="animate-ghost-float mx-auto h-24 w-24 drop-shadow-[0_12px_20px_rgb(122_47_240_/_0.28)]"
        aria-hidden="true"
      >
        <path
          d={GHOST_BODY}
          fill="var(--color-primary-200)"
        />
        <ellipse className="ghost-eye" cx="26.5" cy="20" rx="3" ry="4" fill="var(--color-primary-950)" />
        <ellipse className="ghost-eye" cx="37.5" cy="20" rx="3" ry="4" fill="var(--color-primary-950)" />
      </svg>

      <h3 className="mt-5 text-lg font-bold text-primary-950">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm font-medium text-ink-600">
        {description}
      </p>
    </div>
  );
}
