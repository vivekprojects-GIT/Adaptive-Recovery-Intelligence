import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Info, Lock, MoreHorizontal, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import { initials } from "../lib/format";

/* ================================================================ layout */

export function PageHeader({
  title, subtitle, role, actions, crumbs, meta,
}: {
  title: ReactNode; subtitle?: ReactNode; role?: string; actions?: ReactNode;
  crumbs?: { label: string; to?: string }[]; meta?: ReactNode;
}) {
  return (
    <div className="border-b border-line bg-surface px-6 pb-4 pt-4">
      {crumbs && (
        <nav className="mb-1.5 flex items-center gap-1 text-xs text-fg-3">
          {crumbs.map((c, i) => (
            <span key={c.label} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              {c.to ? <Link to={c.to} className="hover:text-primary-500 hover:underline">{c.label}</Link>
                : <span className="text-fg-2">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-medium leading-7 tracking-tight text-fg">{title}</h1>
            {role && <Chip tone="primary">{role}</Chip>}
          </div>
          {subtitle && <p className="mt-0.5 max-w-3xl text-sm text-fg-2">{subtitle}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export const Page = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={clsx("space-y-4 p-6", className)}>{children}</div>
);

export function Card({
  title, subtitle, actions, children, className, flush, footer,
}: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
  className?: string; flush?: boolean; footer?: ReactNode;
}) {
  return (
    <section className={clsx("rounded-lg border border-line bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs leading-4 text-fg-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
      {footer && <footer className="border-t border-line px-4 py-2.5">{footer}</footer>}
    </section>
  );
}

/* ================================================================= chips */

export type Tone = "neutral" | "good" | "warn" | "serious" | "bad" | "info" | "primary" | "ai";

const TONES: Record<Tone, string> = {
  neutral: "bg-mute-bg text-mute",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
  serious: "bg-serious-bg text-serious",
  bad: "bg-bad-bg text-bad",
  info: "bg-info-bg text-info",
  primary: "bg-primary-50 text-primary-600",
  ai: "bg-ai-50 text-ai-600",
};

export function Chip({ children, tone = "neutral", icon, className, title }: {
  children: ReactNode; tone?: Tone; icon?: ReactNode; className?: string; title?: string;
}) {
  return (
    <span title={title} className={clsx(
      "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs font-semibold",
      TONES[tone], className)}>
      {icon}{children}
    </span>
  );
}

export const Dot = ({ tone = "neutral" }: { tone?: Tone }) => (
  <span className={clsx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", {
    neutral: "bg-fg-3", good: "bg-good", warn: "bg-warn", serious: "bg-serious", bad: "bg-bad",
    info: "bg-info", primary: "bg-primary-500", ai: "bg-ai-500",
  }[tone])} />
);

const STATUS_TONE: Record<string, Tone> = {
  Live: "good", Active: "good", Approved: "info", "In review": "warn", Draft: "neutral",
  Paused: "warn", Archived: "neutral", Inactive: "neutral", Pending: "warn",
  Resolved: "good", Accepted: "good", Engaged: "primary", Responding: "info", Unresponsive: "bad",
  Escalated: "serious", Holdout: "neutral", "Pending review": "warn", "In window": "info",
  Suppressed: "neutral", "Held by override": "neutral", "Not in a strategy": "neutral",
  Delivered: "good", Opened: "info", Clicked: "primary", Failed: "bad", Held: "warn", Scheduled: "neutral",
  Open: "bad", Investigating: "warn", Critical: "bad", High: "serious", Medium: "warn", Low: "neutral",
  New: "primary", Applied: "good", Declined: "neutral", Treatment: "primary", Control: "neutral",
  Paid: "good", "Not paid": "neutral", pending: "warn", approved: "good", rejected: "bad", cancelled: "neutral", Cancelled: "neutral",
  Connected: "good", Simulated: "info", Operational: "good", Degraded: "warn",
};

export const StatusChip = ({ status, label }: { status: string | null | undefined; label?: string }) =>
  status ? (
    <Chip tone={STATUS_TONE[status] ?? "neutral"}><Dot tone={STATUS_TONE[status] ?? "neutral"} />{label ?? status}</Chip>
  ) : <span className="text-fg-3">—</span>;

/* =============================================================== buttons */

export function Button({
  children, onClick, variant = "secondary", size = "md", disabled, icon, type = "button", title, loading,
}: {
  children?: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost" | "danger" | "ai";
  size?: "sm" | "md"; disabled?: boolean; icon?: ReactNode; type?: "button" | "submit"; title?: string;
  loading?: boolean;
}) {
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition",
        "focus:outline-none focus-visible:shadow-ring disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        {
          primary: "bg-primary-500 text-white shadow-sm hover:bg-primary-600",
          secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-hover",
          ghost: "text-fg-2 hover:bg-surface-hover hover:text-fg",
          danger: "border border-bad/25 bg-surface text-bad hover:bg-bad-bg",
          ai: "bg-ai-500 text-white shadow-sm hover:bg-ai-600",
        }[variant])}>
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : icon}
      {children}
    </button>
  );
}

export interface MenuItem {
  label: string; icon?: ReactNode; onClick?: () => void; danger?: boolean; hidden?: boolean;
  /** Disabled items stay visible and say why, so a refused action is never a mystery. */
  disabled?: boolean; reason?: string;
}

/** Overflow ("More") menu. Fixed-positioned so a table's or card's overflow never clips it. */
export function Menu({ items, label = "More actions", size = "md" }: { items: MenuItem[]; label?: string; size?: "sm" | "md" }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!pos) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setPos(null);
    };
    const close = () => setPos(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);
  if (!visible.length) return null;
  const toggle = () => {
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    const h = visible.reduce((n, i) => n + (i.disabled && i.reason ? 50 : 36), 10);
    setPos({ top: r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
      right: Math.max(8, window.innerWidth - r.right) });
  };
  return (
    <>
      <button ref={btn} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!pos}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        className={clsx("inline-flex shrink-0 items-center justify-center rounded-md text-fg-2 transition hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:shadow-ring",
          size === "sm" ? "h-7 w-7" : "h-8 w-8", pos && "bg-surface-hover text-fg")}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {pos && createPortal(
        <div ref={menu} role="menu" style={{ top: pos.top, right: pos.right }} onClick={(e) => e.stopPropagation()}
          className="fixed z-[55] w-64 overflow-hidden rounded-lg border border-line bg-surface py-1 text-left font-normal shadow-pop">
          {visible.map((i) => (
            <button key={i.label} type="button" role="menuitem" disabled={i.disabled}
              onClick={() => { setPos(null); i.onClick?.(); }}
              className={clsx("flex w-full items-start gap-2.5 px-3 py-2 text-left text-[13px] disabled:cursor-not-allowed",
                i.disabled ? "text-fg-3" : i.danger ? "text-bad hover:bg-bad-bg" : "text-fg hover:bg-surface-hover")}>
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{i.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{i.label}</span>
                {i.disabled && i.reason && <span className="mt-0.5 block text-2xs leading-4 text-fg-3">{i.reason}</span>}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** A button the current role may not use: shown disabled with the reason. */
export function Gated({ allowed, reason, children }: { allowed: boolean; reason: string; children: ReactNode }) {
  if (allowed) return <>{children}</>;
  return (
    <span title={reason} className="inline-flex cursor-not-allowed items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 py-1 text-xs text-fg-3">
      <Lock className="h-3 w-3" />{reason}
    </span>
  );
}

/* ================================================================ tables */

export function Table({ children, maxHeight }: { children: ReactNode; maxHeight?: string }) {
  return (
    <div className={clsx("overflow-x-auto", maxHeight && "overflow-y-auto")} style={maxHeight ? { maxHeight } : undefined}>
      <table className={clsx("w-full border-collapse text-[13px]", maxHeight && "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10")}>
        {children}
      </table>
    </div>
  );
}

export const Th = ({ children, align = "left", w }: { children?: ReactNode; align?: "left" | "right" | "center"; w?: string }) => (
  <th style={w ? { width: w } : undefined} className={clsx(
    "border-b border-line bg-surface-sunken px-3 py-2 text-2xs font-semibold uppercase tracking-[0.05em] text-fg-3",
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left")}>{children}</th>
);

export const Td = ({ children, align = "left", className, mono }: {
  children?: ReactNode; align?: "left" | "right" | "center"; className?: string; mono?: boolean;
}) => (
  <td className={clsx("border-b border-line px-3 py-2.5 align-middle text-fg",
    align === "right" && "num text-right", align === "center" && "text-center",
    mono && "font-mono text-xs", className)}>{children}</td>
);

export const Tr = ({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) => (
  <tr onClick={onClick} className={clsx(onClick && "cursor-pointer hover:bg-primary-50/40", className)}>{children}</tr>
);

export const Empty = ({ cols, children }: { cols: number; children: ReactNode }) => (
  <tr><td colSpan={cols} className="px-3 py-12 text-center text-sm text-fg-3">{children}</td></tr>
);

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
      <span className="text-xs text-fg-3">
        Showing <span className="num font-medium text-fg">{total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)}</span> of <span className="num font-medium text-fg">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft className="h-3.5 w-3.5" />} />
        {Array.from({ length: Math.min(last, 5) }, (_, i) => {
          const p = last <= 5 ? i + 1 : Math.min(Math.max(page - 2, 1), last - 4) + i;
          return (
            <button key={p} onClick={() => onPage(p)} className={clsx("num h-7 min-w-7 rounded-md px-2 text-xs font-medium",
              p === page ? "bg-primary-500 text-white" : "text-fg-2 hover:bg-surface-hover")}>{p}</button>
          );
        })}
        <Button size="sm" variant="ghost" disabled={page >= last} onClick={() => onPage(page + 1)} icon={<ChevronRight className="h-3.5 w-3.5" />} />
      </div>
    </div>
  );
}

/* ================================================================== KPIs */

export function Kpi({
  label, value, sub, delta, deltaGood, target, progress, tone = "neutral", icon,
}: {
  label: string; value: ReactNode; sub?: ReactNode; delta?: string | null; deltaGood?: boolean | null;
  target?: string; progress?: number | null; tone?: "neutral" | "good" | "warn" | "bad" | "primary"; icon?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-fg-2">{label}</p>
        {delta && (
          <Chip tone={deltaGood === null || deltaGood === undefined ? "neutral" : deltaGood ? "good" : "bad"}>
            {delta}
          </Chip>
        )}
        {!delta && icon}
      </div>
      <p className={clsx("num mt-1.5 text-[26px] font-semibold leading-8 tracking-tight", {
        neutral: "text-fg", good: "text-good", warn: "text-warn", bad: "text-bad", primary: "text-primary-500",
      }[tone])}>{value}</p>
      {progress !== undefined && progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          <div className={clsx("h-full rounded-full", tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-azure")}
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
        </div>
      )}
      {(sub || target) && (
        <p className="mt-1.5 text-xs text-fg-3">{sub}{sub && target ? " · " : ""}{target && <span>Target {target}</span>}</p>
      )}
    </div>
  );
}

export function Progress({ value, tone = "primary", className }: { value: number; tone?: Tone; className?: string }) {
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken", className)}>
      <div className={clsx("h-full rounded-full", {
        neutral: "bg-fg-3", good: "bg-good", warn: "bg-warn", serious: "bg-serious", bad: "bg-bad",
        info: "bg-info", primary: "bg-azure", ai: "bg-ai-500",
      }[tone])} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

/* ================================================================ banners */

export function Banner({ tone = "info", title, children, action }: {
  tone?: "info" | "warn" | "good" | "bad" | "neutral" | "ai"; title?: ReactNode; children?: ReactNode; action?: ReactNode;
}) {
  const Icon = tone === "warn" || tone === "bad" ? AlertTriangle : tone === "good" ? CheckCircle2 : Info;
  return (
    <div className={clsx("flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px]", {
      info: "border-info/15 bg-info-bg text-info", warn: "border-warn/20 bg-warn-bg text-warn",
      good: "border-good/20 bg-good-bg text-good", bad: "border-bad/20 bg-bad-bg text-bad",
      neutral: "border-line bg-surface-sunken text-fg-2", ai: "border-ai-500/15 bg-ai-50 text-ai-600",
    }[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 leading-5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

/* ================================================================ overlays */

export function Drawer({ open, onClose, title, subtitle, children, footer, width = "max-w-xl" }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode;
  footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end text-left font-normal" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-fg/25 backdrop-blur-[1px]" onClick={onClose} />
      <aside className={clsx("relative flex h-full w-full flex-col bg-surface shadow-pop", width)}>
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-fg-3">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-surface-hover hover:text-fg"><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 text-left font-normal" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-fg/25" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-lg bg-surface shadow-pop">
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-surface-hover"><X className="h-4 w-4" /></button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ================================================================== tabs */

export function Tabs<T extends string>({ tabs, active, onChange, className }: {
  tabs: { id: T; label: string; count?: number; icon?: ReactNode }[]; active: T; onChange: (t: T) => void; className?: string;
}) {
  return (
    <div className={clsx("flex gap-1 overflow-x-auto border-b border-line", className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
          className={clsx("-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition",
            active === t.id ? "border-azure text-primary-500" : "border-transparent text-fg-2 hover:text-fg")}>
          {t.icon}{t.label}
          {t.count !== undefined && <span className="num rounded bg-surface-sunken px-1.5 text-2xs text-fg-3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pills<T extends string>({ options, value, onChange }: {
  options: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={clsx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition",
          value === o.id ? "border-primary-500 bg-primary-50 text-primary-600" : "border-line-strong bg-surface text-fg-2 hover:bg-surface-hover")}>
          {o.label}{o.count !== undefined && <span className="num text-fg-3">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ================================================================= forms */

export const inputCls =
  "h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-3 focus:border-primary-500 focus:outline-none focus:shadow-ring disabled:bg-surface-sunken disabled:text-fg-3";

export function Field({ label, hint, children, required }: { label: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-fg-2">{label}{required && <span className="text-bad"> *</span>}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-2xs leading-4 text-fg-3">{hint}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, className, disabled }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; disabled?: boolean;
}) {
  return (
    <div className={clsx("relative", className)}>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={clsx(inputCls, "appearance-none pr-7")}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-good" : "bg-line-strong")}>
      <span className={clsx("inline-block h-4 w-4 rounded-full bg-white shadow transition", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function CheckCard({ checked, onChange, title, sub, right }: {
  checked: boolean; onChange: (v: boolean) => void; title: ReactNode; sub?: ReactNode; right?: ReactNode;
}) {
  return (
    <label className={clsx("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition",
      checked ? "border-primary-500 bg-primary-50/50" : "border-line hover:bg-surface-hover")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/30" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg">{title}</span>
        {sub && <span className="mt-0.5 block text-2xs leading-4 text-fg-3">{sub}</span>}
      </span>
      {right}
    </label>
  );
}

/* ================================================================= misc */

export function Avatar({ name, size = "md", tone = 0 }: { name: string; size?: "sm" | "md"; tone?: number }) {
  const palettes = ["bg-primary-100 text-primary-700", "bg-good-bg text-good", "bg-ai-100 text-ai-600", "bg-warn-bg text-warn", "bg-info-bg text-info", "bg-serious-bg text-serious"];
  const idx = tone || [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return (
    <span className={clsx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
      size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs", palettes[idx % palettes.length])}>{initials(name)}</span>
  );
}

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-20 text-sm text-fg-3">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-primary-500" />{label}
  </div>
);

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="p-6">
    <Banner tone="bad" title="Could not load this view" action={onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}>{message}</Banner>
  </div>
);

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="min-w-0">
    <p className="label">{label}</p>
    <p className="num mt-0.5 text-[15px] font-semibold text-fg">{value}</p>
    {sub && <p className="text-2xs text-fg-3">{sub}</p>}
  </div>
);

export const KV = ({ items }: { items: { label: string; value: ReactNode }[] }) => (
  <dl className="divide-y divide-line">
    {items.map((i) => (
      <div key={i.label} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
        <dt className="text-fg-3">{i.label}</dt>
        <dd className="min-w-0 truncate text-right font-medium text-fg">{i.value}</dd>
      </div>
    ))}
  </dl>
);

/* ================================================================= toast */

type ToastT = { id: number; tone: "good" | "bad" | "info"; text: string };
const ToastCtx = createContext<(tone: ToastT["tone"], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((tone: ToastT["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, tone, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "bad" ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={clsx("pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface px-3.5 py-3 text-[13px] shadow-pop",
            t.tone === "bad" ? "border-bad/30" : t.tone === "good" ? "border-good/30" : "border-line")}>
            {t.tone === "bad" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : t.tone === "good"
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />}
            <span className="leading-5 text-fg">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run an API action with a toast on success, and the API's own reason on failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, ok?: string | ((r: T) => string)) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast("good", typeof ok === "function" ? ok(r) : ok);
      return r;
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { run, busy };
}
