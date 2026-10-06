/** The header search, for every role: pages, strategies, customers, decisions and
 *  messages, each only when the role may open it. "/" or Ctrl+K focuses it. */
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { NAV } from "./nav";
import { useOutside } from "./useOutside";

interface Results {
  strategies: { campaign_id: string; name: string; status: string; version: number }[];
  customers: { customer_id: number; name: string; ref: string; cohort_id: string; days_past_due: number }[];
  decisions: { decision_id: string; campaign_id: string; customer: string; group: string }[];
  messages: { nudge_id: string; channel: string; status: string; customer: string }[];
}
interface Hit { group: string; key: string; title: string; detail: string; to: string }

const EMPTY: Results = { strategies: [], customers: [], decisions: [], messages: [] };

export function GlobalSearch() {
  const { me, can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);   // small screens: the box opens over the header
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => { setOpen(false); setExpanded(false); setActive(-1); }, []);
  const ref = useOutside(open || expanded, close);

  const canCustomers = can("view_customer_list");
  const placeholder = canCustomers ? "Search customers, strategies, decisions, pages"
    : can("view_kpi_dashboard") ? "Search strategies and pages" : "Search pages";

  // "/" or Ctrl+K from anywhere that is not already a text field
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setExpanded(true);
        setOpen(true);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(EMPTY); return; }
    let stale = false;
    setBusy(true);
    const t = setTimeout(() => {
      api.get<Results>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (!stale) setRes(r); })
        .catch(() => { if (!stale) setRes(EMPTY); })
        .finally(() => { if (!stale) setBusy(false); });
    }, 200);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  const hits = useMemo<Hit[]>(() => {
    if (!me) return [];
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const seen = new Set<string>();
    const pages: Hit[] = [];
    for (const s of NAV[me.user.role]) {
      for (const i of s.items) {
        if ((i.perm && !can(i.perm)) || seen.has(i.to) || !i.label.toLowerCase().includes(term)) continue;
        seen.add(i.to);
        pages.push({ group: "Pages", key: `p${i.to}`, title: i.label, detail: s.section ?? "", to: i.to });
      }
    }
    return [
      ...pages.slice(0, 4),
      ...res.customers.map((c) => ({ group: "Customers", key: `c${c.customer_id}`, title: c.name,
        detail: `${c.ref} · ${c.cohort_id} · ${c.days_past_due} DPD`, to: `/journeys/${c.customer_id}` })),
      ...res.strategies.map((s) => ({ group: "Strategies", key: `s${s.campaign_id}`, title: s.name,
        detail: `${s.campaign_id} · v${s.version} · ${s.status}`, to: `/strategies/${s.campaign_id}` })),
      ...res.decisions.map((d) => ({ group: "Decisions", key: `d${d.decision_id}`, title: d.decision_id,
        detail: `${d.customer} · ${d.campaign_id} · ${d.group}`, to: `/decisions/${d.decision_id}` })),
      ...res.messages.map((n) => ({ group: "Messages", key: `n${n.nudge_id}`, title: n.nudge_id,
        detail: `${n.customer} · ${n.channel} · ${n.status}`, to: `/nudges/${n.nudge_id}` })),
    ];
  }, [me, can, q, res]);

  useEffect(() => setActive(-1), [hits.length]);

  if (!me) return null;

  const go = (to: string) => { navigate(to); setQ(""); close(); input.current?.blur(); };
  const submit = () => {
    if (active >= 0 && hits[active]) return go(hits[active].to);
    const term = q.trim();
    if (!term) return;
    if (canCustomers) return go(`/customers?q=${encodeURIComponent(term)}`);
    if (hits[0]) go(hits[0].to);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
  };

  const term = q.trim();
  const showPanel = open && term.length > 0;
  const searched = ["pages", can("view_kpi_dashboard") && "strategies", canCustomers && "customers",
    can("view_ai_decisions") && "decisions and messages"].filter(Boolean).join(", ");

  return (
    <div ref={ref} className={clsx("min-w-0", expanded ? "absolute inset-x-3 top-2.5 z-40" : "relative ml-4 max-w-[440px] flex-1")}>
      {!expanded && (
        <button onClick={() => { setExpanded(true); setOpen(true); requestAnimationFrame(() => input.current?.focus()); }}
          aria-label="Search" className="flex h-9 w-9 items-center justify-center rounded-md text-primary-100 hover:bg-white/10 hover:text-white lg:hidden">
          <Search className="h-[18px] w-[18px]" />
        </button>
      )}
      <form role="search" className={clsx("relative", expanded ? "block" : "hidden lg:block")}
        onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-200" />
        <input ref={input} value={q} placeholder={placeholder} aria-label="Search" aria-expanded={showPanel} aria-controls="global-search-results"
          aria-activedescendant={active >= 0 ? `gs-${active}` : undefined} role="combobox" autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          className="h-9 w-full rounded-md border border-white/10 bg-ink-800 pl-9 pr-16 text-[13px] text-white placeholder:text-primary-200 focus:border-primary-200/60 focus:outline-none lg:bg-white/[0.08] lg:focus:bg-white/[0.12]" />
        {q ? (
          <button type="button" aria-label="Clear search" onClick={() => { setQ(""); input.current?.focus(); }}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-primary-200 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-white/15 px-1.5 text-2xs text-primary-200 lg:block">/</kbd>
        )}
      </form>
      {showPanel && (
        <div id="global-search-results" role="listbox"
          className="absolute inset-x-0 top-11 z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface py-1 text-fg shadow-pop">
          {hits.map((h, i) => (
            <div key={h.key}>
              {(i === 0 || hits[i - 1].group !== h.group) && (
                <p className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">{h.group}</p>
              )}
              <button id={`gs-${i}`} role="option" aria-selected={i === active} type="button"
                onMouseEnter={() => setActive(i)} onClick={() => go(h.to)}
                className={clsx("flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left", i === active && "bg-surface-hover")}>
                <span className="truncate text-[13px]">{h.title}</span>
                <span className="shrink-0 truncate font-mono text-2xs text-fg-3">{h.detail}</span>
              </button>
            </div>
          ))}
          {!hits.length && (
            <p className="px-3 py-2.5 text-xs text-fg-3">
              {term.length < 2 || busy ? "Searching…" : `No matches for “${term}”.`}
            </p>
          )}
          <p className="mt-1 border-t border-line px-3 pb-1 pt-2 text-2xs text-fg-3">
            Searches {searched}.{canCustomers && " Press Enter for all matching customers."}
          </p>
        </div>
      )}
    </div>
  );
}
