"use client";
// Celebration for a completed payment: a one-shot confetti burst (canvas, no deps),
// a self-drawing check badge and a count-up of what the merchant received.
// Respects prefers-reduced-motion: no particles, no count-up, just the final state.

import { useEffect, useRef, useState } from "react";

const COLORS = ["#4f46e5", "#818cf8", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#ffffff"];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type Piece = {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; rot: number; vr: number;
  color: string; shape: "rect" | "circle" | "ribbon"; wobble: number; life: number;
};

/** Full-screen confetti that fires once when mounted, then removes itself. */
export function Confetti({ onDone }: { onDone?: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      onDone?.();
      return;
    }
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    const pieces: Piece[] = [];
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const shapes: Piece["shape"][] = ["rect", "rect", "circle", "ribbon"];

    // Two side cannons aimed up and inward, plus a soft shower from the top a beat later.
    const cannon = (fromLeft: boolean, n: number) => {
      for (let i = 0; i < n; i++) {
        const angle = (fromLeft ? rand(-75, -45) : rand(-135, -105)) * (Math.PI / 180);
        const speed = rand(9, 17);
        pieces.push({
          x: fromLeft ? -10 : W() + 10, y: H() * rand(0.7, 0.9),
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          w: rand(6, 11), h: rand(8, 16), rot: rand(0, Math.PI * 2), vr: rand(-0.25, 0.25),
          color: COLORS[(Math.random() * COLORS.length) | 0], shape: shapes[(Math.random() * shapes.length) | 0],
          wobble: rand(0, Math.PI * 2), life: 1,
        });
      }
    };
    const shower = (n: number) => {
      for (let i = 0; i < n; i++) {
        pieces.push({
          x: rand(0, W()), y: rand(-H() * 0.3, -10),
          vx: rand(-1.5, 1.5), vy: rand(1, 4),
          w: rand(5, 9), h: rand(7, 13), rot: rand(0, Math.PI * 2), vr: rand(-0.2, 0.2),
          color: COLORS[(Math.random() * COLORS.length) | 0], shape: shapes[(Math.random() * shapes.length) | 0],
          wobble: rand(0, Math.PI * 2), life: 1,
        });
      }
    };
    const narrow = W() < 640;
    cannon(true, narrow ? 60 : 110);
    cannon(false, narrow ? 60 : 110);
    const showerTimer = window.setTimeout(() => shower(narrow ? 50 : 90), 350);

    let raf = 0;
    const start = performance.now();
    const DURATION = 4200;
    const tick = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, W(), H());
      for (const p of pieces) {
        p.vy += 0.28; // gravity
        p.vx *= 0.985; p.vy *= 0.985; // air drag
        p.wobble += 0.12;
        p.x += p.vx + Math.sin(p.wobble) * 0.6;
        p.y += p.vy;
        p.rot += p.vr;
        if (t > DURATION - 1200) p.life = Math.max(0, p.life - 0.02);
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.color === "#ffffff") { ctx.strokeStyle = "#c7d2fe"; ctx.lineWidth = 1; }
        if (p.shape === "circle") {
          ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill();
        } else if (p.shape === "ribbon") {
          // A strip whose apparent width flips as it tumbles.
          const sx = Math.cos(p.wobble * 1.5);
          ctx.fillRect((-p.w / 2) * sx, -p.h / 2, p.w * sx * 0.6, p.h * 1.4);
        } else {
          const sy = Math.cos(p.wobble); // 3D flip
          ctx.fillRect(-p.w / 2, (-p.h / 2) * sy, p.w, p.h * sy);
          if (p.color === "#ffffff") ctx.strokeRect(-p.w / 2, (-p.h / 2) * sy, p.w, p.h * sy);
        }
        ctx.restore();
      }
      if (t < DURATION) raf = requestAnimationFrame(tick);
      else onDone?.();
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(showerTimer);
      window.removeEventListener("resize", resize);
    };
  }, [onDone]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[70] h-full w-full"
    />
  );
}

/** Animated success check with a pulse ring. */
export function SuccessBadge() {
  return (
    <div className="relative mx-auto mb-4 flex h-20 w-20 items-center justify-center" aria-hidden="true">
      <span className="absolute inset-0 rounded-full bg-emerald-400/30 animate-celebrate-ring" />
      <span className="absolute inset-0 rounded-full bg-emerald-400/20 animate-celebrate-ring [animation-delay:400ms]" />
      <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/30 animate-celebrate-pop">
        <svg viewBox="0 0 52 52" className="h-11 w-11">
          <path
            d="M14 27 l8 8 l16 -18"
            fill="none"
            stroke="white"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="animate-celebrate-check"
            style={{ strokeDasharray: 48, strokeDashoffset: 48 }}
          />
        </svg>
      </span>
    </div>
  );
}

/** Counts a label like "0.999898 USDC" up from zero; shows it as-is if it has no number. */
export function CountUp({ label, durationMs = 1400 }: { label: string; durationMs?: number }) {
  const match = label.match(/^([^0-9]*?)([0-9]+(?:\.[0-9]+)?)(.*)$/);
  const prefix = match?.[1] ?? "";
  const target = match ? Number(match[2]) : NaN;
  const decimals = match?.[2].split(".")[1]?.length ?? 0;
  const suffix = match?.[3] ?? "";
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));

  useEffect(() => {
    if (!Number.isFinite(target) || prefersReducedMotion()) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - k, 3);
      setValue(target * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  if (!Number.isFinite(target)) return <>{label}</>;
  return (
    <span className="tabular-nums">
      {prefix}
      {value.toFixed(Math.min(decimals, 6))}
      {suffix}
    </span>
  );
}
