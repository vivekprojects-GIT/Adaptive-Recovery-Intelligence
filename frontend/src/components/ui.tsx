import clsx from "clsx";
import type { ReactNode } from "react";
import { SEGMENT_COLOR, type Segment } from "../lib/api";

export function Card({
  children,
  className,
  title,
  subtitle,
  action,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={clsx("card p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[180px] flex-1">
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-slate-400">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  accent = "brand",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: "brand" | "emerald" | "amber" | "rose" | "sky";
}) {
  const bar = {
    brand: "from-brand-500 to-brand-400",
    emerald: "from-emerald-500 to-emerald-400",
    amber: "from-amber-500 to-amber-400",
    rose: "from-rose-500 to-rose-400",
    sky: "from-sky-500 to-sky-400",
  }[accent];
  return (
    <div className="card relative overflow-hidden p-5">
      <div className={clsx("absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r", bar)} />
      <p className="label">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-white">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function SegmentBadge({ segment, className }: { segment: Segment; className?: string }) {
  const c = SEGMENT_COLOR[segment];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        className,
      )}
      style={{ background: `${c}1f`, color: c, border: `1px solid ${c}40` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {segment}
    </span>
  );
}

export function Pill({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "emerald" | "amber" | "rose" | "brand";
}) {
  const tones = {
    slate: "bg-white/5 text-slate-300 border-white/10",
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    rose: "bg-rose-500/10 text-rose-300 border-rose-500/30",
    brand: "bg-brand-500/10 text-brand-400 border-brand-500/30",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
}) {
  const v = {
    primary: "bg-brand-600 hover:bg-brand-500 text-white border-brand-500/50",
    ghost: "bg-white/5 hover:bg-white/10 text-slate-200 border-white/10",
    danger: "bg-rose-600/80 hover:bg-rose-600 text-white border-rose-500/50",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        v,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Semi-circular score gauge. */
export function Gauge({
  value,
  label,
  color,
  caption,
}: {
  value: number;
  label: string;
  color: string;
  caption?: string;
}) {
  const r = 70;
  const circ = Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 180 104" className="w-full max-w-[220px]">
        <path
          d={`M 20 92 A ${r} ${r} 0 0 1 160 92`}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d={`M 20 92 A ${r} ${r} 0 0 1 160 92`}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`}
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(.4,0,.2,1)" }}
        />
        <text
          x="90"
          y="82"
          textAnchor="middle"
          className="fill-white"
          style={{ fontSize: 30, fontWeight: 700 }}
        >
          {value.toFixed(0)}
        </text>
      </svg>
      <p className="-mt-1 text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      {caption && <p className="mt-1 text-[11px] text-slate-500">{caption}</p>}
    </div>
  );
}

export function Bar({ value, color, max = 100 }: { value: number; color: string; max?: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }}
      />
    </div>
  );
}

export function Loading({ what = "data" }: { what?: string }) {
  return (
    <div className="flex h-56 items-center justify-center text-sm text-slate-500">
      <span className="mr-2 h-3 w-3 animate-ping rounded-full bg-brand-500" /> Loading {what}…
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="card border-rose-500/30 bg-rose-500/5 p-5 text-sm text-rose-200">
      <p className="font-semibold">Could not reach the ARI API.</p>
      <p className="mt-1 text-xs text-rose-300/80">{message}</p>
      <p className="mt-2 text-xs text-slate-400">
        Start the backend with <code className="font-mono text-slate-300">uvicorn app.main:app --reload --port 8000</code>
      </p>
    </div>
  );
}

export const tooltipStyle = {
  contentStyle: {
    background: "#0b1120",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    fontSize: 12,
    color: "#e2e8f0",
  },
  labelStyle: { color: "#94a3b8", fontSize: 11 },
  itemStyle: { color: "#e2e8f0" },
};
