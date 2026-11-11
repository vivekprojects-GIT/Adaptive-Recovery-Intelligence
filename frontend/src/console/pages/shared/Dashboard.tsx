/** The dashboard: one report page for collections and recovery, sliced by card business,
 *  process, period and owner. Visuals are drawn with D3 (ui/d3charts), motion is
 *  Anime.js, controls are shadcn/ui. Every tile can be read as a table or exported. */
import clsx from "clsx";
import { ArrowRight, BarChart3, Download, MoreHorizontal, RotateCcw, Sheet } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { api, type InsightRow } from "../../lib/api";
import { money, num, pct, pp, timeOnly, weekLabel } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { CLIENT_BANK } from "../../ui/brand";
import { SERIES } from "../../ui/charts";
import { CountUp, Heatmap, Sankey, TimeSeries, useEntrance, type FlowNode } from "../../ui/d3charts";
import { Button, ErrorState, MetricInfo, Select, useAction } from "../../ui/ui";
import { InsightCard } from "../strategist/MyDashboard";

type Process = "all" | "collections" | "recovery";
interface Kpi { value: number | null; delta?: number | null; trend: (number | null)[]; sub?: number; control?: number | null; lift?: number | null; treated?: number }
interface Business { business: string; collections_accounts: number; collections_balance: number; past_due: number; collected: number;
  charged_off_accounts: number; recovered: number; remaining: number }
interface Strat { campaign_id: string; name: string; status: string; treated: number; payment_rate: number | null; control_rate: number | null;
  lift: number | null; target: number; deviation: number | null; collected: number; state: string | null }
interface Data {
  filters: { businesses: string[] };
  weeks: string[];
  kpis: Record<"collections_accounts" | "collected" | "payment_rate" | "charged_off" | "recovered" | "remaining", Kpi | null>;
  cash_by_week: { week: string; collections: number | null; recovery: number | null }[];
  rate_by_week: { week: string; treated: number | null; control: number | null }[];
  flow: { nodes: FlowNode[]; links: { source: string; target: string; value: number }[] };
  heatmap: { business: string; collected: number[]; recovered: number[] }[];
  businesses: Business[];
  strategies: Strat[];
  exceptions: { kind: string; severity: string; count: number; title: string; detail: string; link: string }[];
  insights: InsightRow[];
}
type Cell = string | number;
interface TableData { columns: string[]; rows: Cell[][] }

const COLL = SERIES[0];   // collections: always the first hue
const REC = SERIES[1];    // recovery: always the second
const OUT: Record<string, string> = { out_paid: "#2f7d4f", out_unpaid: "#a3adbb", out_waiting: "#c3cbd6", out_undecided: "#dce1e8" };
const fmtK = (v: number) => money(v, true);
const fmtNum = (v: number) => num(Math.round(v));
const fmtPct = (v: number) => pct(v, 0);
const fmtPct1 = (v: number) => pct(v);

/* ============================================================ export */

function downloadCsv(name: string, t: TableData) {
  const esc = (v: Cell) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [t.columns, ...t.rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================ tiles */

/** A report visual: title row, headline figure, and a menu to read it as a table or export it. */
function Tile({ title, metric, subtitle, figure, children, className, table, actions }: {
  title: string; metric?: string; subtitle?: string; figure?: ReactNode; children: ReactNode; className?: string;
  table?: TableData; actions?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section data-tile className={clsx("flex min-w-0 flex-col rounded-md border border-line bg-white shadow-card", className)}>
      <header className="flex items-start justify-between gap-3 px-4 pb-1 pt-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1 text-[13px] font-semibold leading-5 text-fg">{title}{metric && <MetricInfo metric={metric} />}</h2>
          {subtitle && <p className="text-[11px] leading-4 text-fg-3">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {figure && <div className="text-right">{figure}</div>}
          {actions}
          {table && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`More options for ${title}`}
                className="-mr-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded text-fg-3 outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-surface-hover">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setAsTable((v) => !v)}>
                  {asTable ? <BarChart3 /> : <Sheet />}{asTable ? "Show as chart" : "Show as table"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadCsv(title, table)}><Download />Export data (CSV)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      <div className="min-w-0 flex-1 px-4 pb-3 pt-2">{asTable && table ? <DataTable t={table} /> : children}</div>
    </section>
  );
}

function DataTable({ t }: { t: TableData }) {
  return (
    <div className="max-h-[340px] overflow-auto rounded border border-line">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-surface-sunken"><tr>{t.columns.map((c, i) => (
          <th key={`${c}-${i}`} scope="col" className={clsx("whitespace-nowrap border-b border-line-strong px-2.5 py-1.5 font-semibold text-fg-2", i ? "text-right" : "text-left")}>{c}</th>))}</tr></thead>
        <tbody>{t.rows.map((r, ri) => (
          <tr key={ri} className="hover:bg-surface-hover">{r.map((v, i) => (
            <td key={i} className={clsx("whitespace-nowrap border-b border-line px-2.5 py-1.5", i ? "num text-right" : "text-fg")}>{v}</td>))}</tr>))}</tbody>
      </table>
    </div>
  );
}

const Figure = ({ value, label }: { value: ReactNode; label: string }) => (
  <p className="leading-4"><span className="num block text-[15px] font-semibold text-fg">{value}</span>
    <span className="text-[11px] text-fg-3">{label}</span></p>
);

function DeltaPill({ d, goodWhenUp }: { d: number | null | undefined; goodWhenUp: boolean | null }) {
  if (d === null || d === undefined) return <span className="text-[11px] text-fg-3">No full prior period yet</span>;
  const up = d >= 0;
  const good = goodWhenUp === null ? null : up === goodWhenUp;
  return (
    <span className="flex items-center gap-1.5 text-2xs">
      <span className={clsx("num font-medium", good === true ? "text-good" : good === false ? "text-bad" : "text-fg-2")}>
        {up ? "▲" : "▼"} {Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%
      </span>
      <span className="text-fg-3">vs prior period</span>
    </span>
  );
}

/** One figure in a ledger: a label, the figure, and what it compares against. */
function KpiCell({ label, metric, value, format, foot }: {
  label: string; metric?: string; value: number; format: (v: number) => string; foot: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col px-5 py-4">
      <p className="flex items-center gap-1 text-xs leading-4 text-fg-3">{label}{metric && <MetricInfo metric={metric} />}</p>
      <p className="num mt-1.5 text-2xl font-medium leading-8 text-fg"><CountUp value={value} format={format} /></p>
      <div className="mt-1 flex min-h-5 items-center">{foot}</div>
    </div>
  );
}

/** A book's figures side by side on hairline rules: the dashboard's ledger. */
function Ledger({ title, color, children }: { title: string; color: string; children: ReactNode }) {
  return (
    <section data-tile className="min-w-0 rounded-md border border-line bg-surface shadow-card">
      <p className="flex items-center gap-2 border-b border-line px-5 py-2 text-xs font-medium text-fg-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />{title}
      </p>
      <div className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">{children}</div>
    </section>
  );
}

/* ============================================================ bars and bullets */

function Bar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 min-w-[28px] flex-1 overflow-hidden rounded-sm bg-surface-hover">
        <div className="h-full rounded-sm" style={{ width: `${max > 0 ? Math.max(1.5, (value / max) * 100) : 0}%`, background: color }} />
      </div>
      <span className="num w-[66px] shrink-0 text-right">{label}</span>
    </div>
  );
}

/** Actual against target over off track / watch / on track bands, with a target marker. */
function Bullet({ value, target, max }: { value: number | null; target: number; max: number }) {
  if (value === null) return <span className="text-fg-3">No outcomes yet</span>;
  const x = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const watch = Math.max(0, target - 0.05);
  return (
    <div className="flex items-center gap-3" aria-label={`${pct(value)} against a ${pct(target, 0)} target`}>
      <div className="relative h-3.5 min-w-[80px] flex-1 overflow-hidden rounded-sm">
        <div className="absolute inset-y-0 left-0 bg-[#f8e3e6]" style={{ width: x(watch) }} />
        <div className="absolute inset-y-0 bg-[#fbf0d9]" style={{ left: x(watch), width: `calc(${x(target)} - ${x(watch)})` }} />
        <div className="absolute inset-y-0 right-0 bg-[#e4f1e8]" style={{ left: x(target) }} />
        <div className="absolute inset-y-[4px] left-0 rounded-r-sm" style={{ width: x(value), background: "#1d365a" }} />
        <div className="absolute inset-y-0 w-[2.5px] bg-fg" style={{ left: `calc(${x(target)} - 1px)` }} />
      </div>
      <span className="num w-[88px] shrink-0 text-right text-xs"><span className="font-semibold text-fg">{pct(value)}</span>
        <span className="text-fg-3"> · {Math.round((value / target) * 100)}%</span></span>
    </div>
  );
}

function StateText({ s }: { s: string | null }) {
  if (!s) return <span className="text-fg-3">—</span>;
  const label = { on_track: "On track", watch: "Watch", off_track: "Off track" }[s] ?? s;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", s === "on_track" ? "text-fg-2" : s === "watch" ? "font-medium text-warn" : "font-medium text-bad")}>
      <span className={clsx("h-2 w-2 rounded-full", s === "on_track" ? "bg-good" : s === "watch" ? "bg-warn" : "bg-bad")} />{label}
    </span>
  );
}

const TH = "whitespace-nowrap border-b border-line-strong bg-surface-sunken px-2.5 py-2 text-[11px] font-semibold text-fg-2";
const TD = "border-b border-line px-2.5 py-2 text-[13px]";
const TOT = "border-t border-line-strong bg-surface-sunken px-2.5 py-2 text-[13px] font-semibold";
const ROW = "cursor-pointer transition-colors duration-150 hover:bg-surface-hover";

/* ============================================================ narrative */

/** The period in a few sentences, written from the numbers on the page. */
function Narrative({ d, showC, showR, periodLabel }: { d: Data; showC: boolean; showR: boolean; periodLabel: string }) {
  const lines: ReactNode[] = [];
  const pr = d.kpis.payment_rate;
  if (showC && pr && pr.value !== null) {
    const best = [...d.strategies].filter((s) => s.lift !== null && s.treated >= 10).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))[0];
    lines.push(<>Treated accounts paid at <b>{pct(pr.value)}</b> against <b>{pct(pr.control)}</b> for customers held back with no contact: <b>{pp(pr.lift)} over no contact</b>, about {Math.round((pr.lift ?? 0) * 100)} more payers in every 100 contacted
      {best ? <>; <b>{best.name}</b> leads at {pp(best.lift)}</> : null}.</>);
  }
  if (showC && d.kpis.collected) {
    const off = d.strategies.filter((s) => s.state === "off_track");
    lines.push(<><b>{fmtK(d.kpis.collected.value ?? 0)}</b> collected in the {periodLabel}
      {off.length ? <>; {off.length === 1 ? <><b>{off[0].name}</b> is</> : <><b>{off.length} strategies</b> are</>} below target</> : <>; every strategy is at or near target</>}.</>);
  }
  if (showR && d.kpis.recovered && d.kpis.remaining) {
    const dl = d.kpis.recovered.delta;
    lines.push(<><b>{fmtK(d.kpis.recovered.value ?? 0)}</b> recovered on recovery accounts
      {dl !== null && dl !== undefined ? <> ({dl >= 0 ? "up" : "down"} {pct(Math.abs(dl), 0)} on the prior period)</> : null}; <b>{fmtK(d.kpis.remaining.value ?? 0)}</b> remains to recover.</>);
  }
  if (!lines.length) return null;
  return (
    <section data-tile className="rounded-md border border-line bg-white px-4 py-3 shadow-card">
      <p className="mb-1.5 text-[11px] font-semibold text-fg-3">Summary for the {periodLabel}</p>
      <ul className="grid gap-x-8 gap-y-1.5 text-[13px] leading-5 text-fg-2 lg:grid-cols-3 [&_b]:font-semibold [&_b]:text-fg">
        {lines.map((l, i) => <li key={i} className="flex gap-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" /><span>{l}</span></li>)}
      </ul>
    </section>
  );
}

/* ============================================================ skeleton */

function Skeleton() {
  const block = "animate-pulse rounded-md bg-line motion-reduce:animate-none";
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading dashboard">
      <div className={clsx(block, "h-[76px]")} />
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className={clsx(block, "h-[140px]")} />)}</div>
      <div className="grid gap-3 xl:grid-cols-3"><div className={clsx(block, "h-[400px] xl:col-span-2")} /><div className={clsx(block, "h-[400px]")} /></div>
    </div>
  );
}

/* ============================================================ page */

function Slicer({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center gap-2"><span className="whitespace-nowrap text-[11px] font-medium text-fg-3">{label}</span>{children}</div>;
}
const ITEM = "h-8 cursor-pointer px-3";

export default function Dashboard() {
  const { me, can } = useSession();
  const navigate = useNavigate();
  const [product, setProduct] = useState("");
  const [process, setProcess] = useState<Process>("all");
  const [period, setPeriod] = useState("30");
  const [mine, setMine] = useState(false);
  const [hoverWeek, setHoverWeek] = useState<number | null>(null);
  const [heatMetric, setHeatMetric] = useState<"collected" | "recovered">("collected");
  const { run, busy } = useAction();
  const qs = useMemo(() => new URLSearchParams({ product, process, period, mine: String(mine) }).toString(), [product, process, period, mine]);
  const { data, error, loading, reload } = useApi<Data>(`/overview?${qs}`, [qs]);
  const [asOf] = useState(() => new Date().toISOString());
  const page = useRef<HTMLDivElement>(null);
  useEntrance(page, !!data);
  const onHover = useCallback((i: number | null) => setHoverWeek(i), []);
  const strategist = me?.user.role === "strategist";
  const showC = process !== "recovery";
  const showR = process !== "collections";
  const filtered = product || process !== "all" || period !== "30" || mine;
  const periodLabel = `last ${period} days`;
  const metric = showC && showR ? heatMetric : showC ? "collected" : "recovered";
  const colorOf = useCallback((n: FlowNode) => OUT[n.id] ?? (n.process === "recovery" ? REC : COLL), []);

  const totals = useMemo(() => {
    const b = data?.businesses ?? [];
    const sum = (k: keyof Business) => b.reduce((t, x) => t + Number(x[k]), 0);
    return { collections_accounts: sum("collections_accounts"), collections_balance: sum("collections_balance"), past_due: sum("past_due"),
      collected: sum("collected"), charged_off_accounts: sum("charged_off_accounts"), recovered: sum("recovered"), remaining: sum("remaining") };
  }, [data]);

  const weekly = (key: "collections" | "recovery") => {
    const vals = (data?.cash_by_week ?? []).map((w) => w[key]);
    const live = vals.filter((v): v is number => v !== null && v > 0);
    const total = live.reduce((a, b) => a + b, 0);
    return { vals, total, avg: live.length ? total / live.length : 0 };
  };

  return (
    <div className="min-h-full bg-app">
      {/* Report header and filters */}
      <div className="sticky top-0 z-20 border-b border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-2.5 pt-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-fg">Collections and recovery</h1>
            <p className="text-xs text-fg-3">{CLIENT_BANK} · data as of {timeOnly(asOf)} today{loading && data ? " · updating" : ""}</p>
          </div>
          {can("export_reports") && <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === "x"}
            onClick={() => run("x", () => api.download("/reports/portfolio.csv", "portfolio.csv"), "Portfolio report downloaded.")}>Export report</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line px-6 py-2.5" role="group" aria-label="Filters">
          <Slicer label="Card business">
            <Select className="w-52 [&_select]:h-8 [&_select]:cursor-pointer" value={product} onChange={setProduct}
              options={[{ value: "", label: "All card businesses" }, ...(data?.filters.businesses ?? []).map((b) => ({ value: b, label: b }))]} />
          </Slicer>
          <Slicer label="Process">
            <ToggleGroup type="single" value={process} onValueChange={(v) => v && setProcess(v as Process)} aria-label="Process">
              <ToggleGroupItem value="all" className={ITEM}>All</ToggleGroupItem>
              <ToggleGroupItem value="collections" className={ITEM}>Collections</ToggleGroupItem>
              <ToggleGroupItem value="recovery" className={ITEM}>Recovery</ToggleGroupItem>
            </ToggleGroup>
          </Slicer>
          <Slicer label="Period">
            <ToggleGroup type="single" value={period} onValueChange={(v) => v && setPeriod(v)} aria-label="Period">
              <ToggleGroupItem value="30" className={ITEM}>30 days</ToggleGroupItem>
              <ToggleGroupItem value="90" className={ITEM}>90 days</ToggleGroupItem>
              <ToggleGroupItem value="180" className={ITEM}>180 days</ToggleGroupItem>
            </ToggleGroup>
          </Slicer>
          {strategist && (
            <Slicer label="Strategies">
              <ToggleGroup type="single" value={mine ? "mine" : "all"} onValueChange={(v) => v && setMine(v === "mine")} aria-label="Strategies">
                <ToggleGroupItem value="all" className={ITEM}>All</ToggleGroupItem>
                <ToggleGroupItem value="mine" className={ITEM}>Mine</ToggleGroupItem>
              </ToggleGroup>
            </Slicer>
          )}
          {filtered && (
            <button type="button" onClick={() => { setProduct(""); setProcess("all"); setPeriod("30"); setMine(false); }}
              className="inline-flex cursor-pointer items-center gap-1 rounded text-xs font-medium text-primary-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <RotateCcw className="h-3 w-3" />Clear filters</button>
          )}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-fg-3" aria-hidden>
            {showC && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLL }} />Collections</span>}
            {showR && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: REC }} />Recovery</span>}
          </span>
        </div>
      </div>

      {error ? <div className="p-6"><ErrorState message={error} onRetry={reload} /></div> : !data ? <Skeleton /> : (
        <div ref={page} className={clsx("space-y-3 p-5 transition-opacity duration-200", loading && "opacity-60")}>
          {/* The ledger: each book's figures on hairline rules */}
          <div className={clsx("grid gap-3", showC && showR && "xl:grid-cols-2")}>
            {showC && (
              <Ledger title="Collections" color={COLL}>
                {data.kpis.collections_accounts && (
                  <KpiCell label="Accounts in collections" metric="accounts_imported" value={data.kpis.collections_accounts.value ?? 0} format={fmtNum}
                    foot={<span className="text-2xs text-fg-3"><span className="num font-medium text-fg-2">{num(data.kpis.collections_accounts.sub ?? 0)}</span> in a strategy</span>} />
                )}
                {data.kpis.collected && (
                  <KpiCell label={`Collected, ${periodLabel}`} metric="recovered" value={data.kpis.collected.value ?? 0} format={fmtK}
                    foot={<DeltaPill d={data.kpis.collected.delta} goodWhenUp />} />
                )}
                {data.kpis.payment_rate && (
                  <KpiCell label="Payment rate, treated" metric="payment_rate" value={data.kpis.payment_rate.value ?? 0} format={fmtPct1}
                    foot={<span className="text-2xs text-fg-3">no contact {pct(data.kpis.payment_rate.control)} ·{" "}
                      <span className={clsx("num font-medium", (data.kpis.payment_rate.lift ?? 0) >= 0 ? "text-good" : "text-bad")}>{pp(data.kpis.payment_rate.lift)}</span> over no contact</span>} />
                )}
              </Ledger>
            )}
            {showR && (
              <Ledger title="Recovery" color={REC}>
                {data.kpis.charged_off && (
                  <KpiCell label="Recovery accounts" value={data.kpis.charged_off.value ?? 0} format={fmtNum}
                    foot={<DeltaPill d={data.kpis.charged_off.delta} goodWhenUp={null} />} />
                )}
                {data.kpis.recovered && (
                  <KpiCell label={`Recovered, ${periodLabel}`} metric="recovered" value={data.kpis.recovered.value ?? 0} format={fmtK}
                    foot={<DeltaPill d={data.kpis.recovered.delta} goodWhenUp />} />
                )}
                {data.kpis.remaining && (
                  <KpiCell label="Remaining recovery balance" value={data.kpis.remaining.value ?? 0} format={fmtK}
                    foot={<DeltaPill d={data.kpis.remaining.delta} goodWhenUp={false} />} />
                )}
              </Ledger>
            )}
          </div>

          {/* Flow and attention */}
          <div className="grid gap-3 xl:grid-cols-3">
            <Tile title="Account flow" metric="routing_share" className="xl:col-span-2"
              subtitle="Each book, where its accounts went, and what happened to the accounts in a strategy. Every number is a count of accounts."
              figure={<Figure value={num(data.flow.links.filter((l) => l.source === "c_book" || l.source === "r_book").reduce((t, l) => t + l.value, 0))} label="accounts" />}
              table={{ columns: ["From", "To", "Accounts"], rows: data.flow.links.map((l) => [
                data.flow.nodes.find((n) => n.id === l.source)?.label ?? l.source, data.flow.nodes.find((n) => n.id === l.target)?.label ?? l.target, l.value]) }}>
              <Sankey nodes={data.flow.nodes} links={data.flow.links} colorOf={colorOf} format={fmtNum} height={Math.max(300, data.flow.nodes.length * 22)} />
            </Tile>
            <Tile title="Needs attention" subtitle="Most serious first" figure={<Figure value={num(data.exceptions.length)} label="items" />}
              table={{ columns: ["Severity", "Item", "Count"], rows: data.exceptions.map((x) => [x.severity, x.title, x.count]) }}>
              <ul className="space-y-1.5">
                {data.exceptions.slice(0, 7).map((x, i) => (
                  <li key={i}>
                    <Link to={x.link} className="flex items-start gap-2.5 rounded-md border border-line px-2.5 py-2 transition-colors duration-150 hover:border-line hover:bg-surface-hover">
                      <span className={clsx("mt-[5px] h-2 w-2 shrink-0 rounded-full",
                        x.severity === "Critical" ? "bg-bad" : x.severity === "High" ? "bg-serious" : x.severity === "Medium" ? "bg-warn" : "bg-line-strong")} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-medium text-fg">{x.title}</span>
                          {x.count > 1 && <span className="num shrink-0 text-xs font-semibold text-fg-2">{num(x.count)}</span>}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-fg-3"><span className="font-medium text-fg-2">{x.severity}</span> · {x.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
                {!data.exceptions.length && <li className="py-4 text-sm text-fg-3">Nothing needs attention.</li>}
              </ul>
            </Tile>
          </div>

          <Narrative d={data} showC={showC} showR={showR} periodLabel={periodLabel} />

          {/* Trends, sharing one hover week */}
          <div className={clsx("grid gap-3 lg:grid-cols-2", showC && showR ? "xl:grid-cols-3" : "")}>
            {showC && (() => {
              const w = weekly("collections");
              return (
                <Tile title="Collected by week" subtitle="Payments on accounts in a strategy" figure={<Figure value={fmtK(w.total)} label="12 weeks" />}
                  table={{ columns: ["Week of", "Collected"], rows: data.cash_by_week.map((x) => [weekLabel(x.week), money(x.collections ?? 0)]) }}>
                  <TimeSeries weeks={data.weeks} format={fmtK} hover={hoverWeek} onHover={onHover} emptyText="No payments in these 12 weeks"
                    reference={w.avg ? { label: "Weekly average", value: w.avg } : undefined}
                    series={[{ key: "c", name: "Collected", color: COLL, values: w.vals, kind: "bar" }]} />
                </Tile>
              );
            })()}
            {showR && (() => {
              const w = weekly("recovery");
              return (
                <Tile title="Recovered by week" subtitle="Payments on recovery accounts" figure={<Figure value={fmtK(w.total)} label="12 weeks" />}
                  table={{ columns: ["Week of", "Recovered"], rows: data.cash_by_week.map((x) => [weekLabel(x.week), money(x.recovery ?? 0)]) }}>
                  <TimeSeries weeks={data.weeks} format={fmtK} hover={hoverWeek} onHover={onHover} emptyText="No payments in these 12 weeks"
                    reference={w.avg ? { label: "Weekly average", value: w.avg } : undefined}
                    series={[{ key: "r", name: "Recovered", color: REC, values: w.vals, kind: "bar" }]} />
                </Tile>
              );
            })()}
            {showC && (
              <Tile title="Payment rate, treated against control" metric="lift" subtitle="Shaded gap is the lift. Weeks under 10 treated accounts omitted"
                figure={data.kpis.payment_rate && <Figure value={pp(data.kpis.payment_rate.lift)} label="over no contact" />}
                table={{ columns: ["Decision week", "Treated", "Control"], rows: data.rate_by_week.map((x) => [weekLabel(x.week), x.treated === null ? "—" : pct(x.treated), x.control === null ? "—" : pct(x.control)]) }}>
                <TimeSeries weeks={data.weeks} format={fmtPct} hover={hoverWeek} onHover={onHover} band={["t", "k"]} emptyText="Not enough treated accounts per week yet"
                  series={[{ key: "t", name: "Treated", color: COLL, values: data.rate_by_week.map((x) => x.treated), kind: "line" },
                    { key: "k", name: "Control", color: "#6e7480", values: data.rate_by_week.map((x) => x.control), kind: "dash" }]} />
              </Tile>
            )}
          </div>

          {/* Heatmap and balances */}
          <div className="grid gap-3 xl:grid-cols-3">
            <Tile title={metric === "collected" ? "Weekly collections by card business" : "Weekly recoveries by card business"} className="xl:col-span-2"
              subtitle="Darker cells are bigger weeks; the right-hand column is the 12-week total"
              table={{ columns: ["Card business", ...data.weeks.map(weekLabel), "Total"], rows: data.heatmap.map((h) => [h.business, ...h[metric].map((v) => Math.round(v)), Math.round(h[metric].reduce((a, b) => a + b, 0))]) }}
              actions={showC && showR ? (
                <ToggleGroup type="single" value={heatMetric} onValueChange={(v) => v && setHeatMetric(v as "collected" | "recovered")} aria-label="Heatmap measure">
                  <ToggleGroupItem value="collected" className="h-7 cursor-pointer px-2.5 text-[11px]">Collected</ToggleGroupItem>
                  <ToggleGroupItem value="recovered" className="h-7 cursor-pointer px-2.5 text-[11px]">Recovered</ToggleGroupItem>
                </ToggleGroup>) : undefined}>
              <Heatmap weeks={data.weeks} color={metric === "collected" ? "#0058ab" : "#d9731f"} format={fmtK}
                rows={data.heatmap.map((h) => ({ label: h.business, values: h[metric] }))} />
            </Tile>
            <Tile title="Balance by card business" subtitle="Collections balance and what remains to recover"
              table={{ columns: ["Card business", "Collections balance", "Recovery remaining"], rows: data.businesses.map((b) => [b.business, money(b.collections_balance), money(b.remaining)]) }}>
              <ul className="space-y-3.5 pt-1">
                {data.businesses.map((b) => {
                  const max = Math.max(...data.businesses.flatMap((x) => [showC ? x.collections_balance : 0, showR ? x.remaining : 0]), 1);
                  return (
                    <li key={b.business}>
                      <p className="mb-1 text-xs font-medium text-fg">{b.business}</p>
                      {showC && <Bar value={b.collections_balance} max={max} color={COLL} label={fmtK(b.collections_balance)} />}
                      {showR && <div className="mt-1"><Bar value={b.remaining} max={max} color={REC} label={fmtK(b.remaining)} /></div>}
                    </li>
                  );
                })}
              </ul>
            </Tile>
          </div>

          {/* Matrices */}
          <Tile title="Card business summary" subtitle={`Flows for the ${periodLabel}; balances as they stand today. Select a row to filter the page`}
            table={{ columns: ["Card business", "Collections accounts", "Balance", "Delinquent amount", "Collected", "Recovery accounts", "Recovered", "Remaining"],
              rows: data.businesses.map((b) => [b.business, b.collections_accounts, Math.round(b.collections_balance), Math.round(b.past_due), Math.round(b.collected),
                b.charged_off_accounts, Math.round(b.recovered), Math.round(b.remaining)]) }}>
            <div className="-mx-4 -mb-3 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <thead><tr>
                  <th scope="col" className={clsx(TH, "text-left")}>Card business</th>
                  {showC && <><th scope="col" className={clsx(TH, "text-right")}>Collections accounts</th><th scope="col" className={clsx(TH, "text-right")}>Balance</th>
                    <th scope="col" className={clsx(TH, "text-right")}>Delinquent amount</th><th scope="col" className={clsx(TH, "text-right")}>Collected</th></>}
                  {showR && <><th scope="col" className={clsx(TH, "text-right")}>Recovery accounts</th><th scope="col" className={clsx(TH, "text-right")}>Recovered</th>
                    <th scope="col" className={clsx(TH, "text-right")}>Remaining</th></>}
                </tr></thead>
                <tbody>
                  {data.businesses.map((b) => {
                    const max = (k: keyof Business) => Math.max(...data.businesses.map((x) => Number(x[k])));
                    return (
                      <tr key={b.business} className={clsx(ROW, product === b.business && "bg-surface-hover")} onClick={() => setProduct(product === b.business ? "" : b.business)}>
                        <td className={clsx(TD, "whitespace-nowrap font-medium")}>{b.business}</td>
                        {showC && <>
                          <td className={TD}><Bar value={b.collections_accounts} max={max("collections_accounts")} color={COLL} label={num(b.collections_accounts)} /></td>
                          <td className={TD}><Bar value={b.collections_balance} max={max("collections_balance")} color={COLL} label={fmtK(b.collections_balance)} /></td>
                          <td className={TD}><Bar value={b.past_due} max={max("past_due")} color={COLL} label={fmtK(b.past_due)} /></td>
                          <td className={TD}><Bar value={b.collected} max={max("collected")} color={COLL} label={fmtK(b.collected)} /></td>
                        </>}
                        {showR && <>
                          <td className={TD}><Bar value={b.charged_off_accounts} max={max("charged_off_accounts")} color={REC} label={num(b.charged_off_accounts)} /></td>
                          <td className={TD}><Bar value={b.recovered} max={max("recovered")} color={REC} label={fmtK(b.recovered)} /></td>
                          <td className={TD}><Bar value={b.remaining} max={max("remaining")} color={REC} label={fmtK(b.remaining)} /></td>
                        </>}
                      </tr>
                    );
                  })}
                </tbody>
                {data.businesses.length > 1 && (
                  <tfoot><tr>
                    <td className={TOT}>Total</td>
                    {showC && <>
                      <td className={clsx(TOT, "num text-right")}>{num(totals.collections_accounts)}</td>
                      <td className={clsx(TOT, "num text-right")}>{fmtK(totals.collections_balance)}</td>
                      <td className={clsx(TOT, "num text-right")}>{fmtK(totals.past_due)}</td>
                      <td className={clsx(TOT, "num text-right")}>{fmtK(totals.collected)}</td>
                    </>}
                    {showR && <>
                      <td className={clsx(TOT, "num text-right")}>{num(totals.charged_off_accounts)}</td>
                      <td className={clsx(TOT, "num text-right")}>{fmtK(totals.recovered)}</td>
                      <td className={clsx(TOT, "num text-right")}>{fmtK(totals.remaining)}</td>
                    </>}
                  </tr></tfoot>
                )}
              </table>
            </div>
          </Tile>

          {showC && (
            <Tile title="Strategy performance" metric="lift" subtitle="Payment rate against target: bands show off track, watch (within 5 points) and on track; the tick is the target"
              actions={<Link to="/analytics" className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary-500 hover:underline">Details <ArrowRight className="h-3 w-3" /></Link>}
              table={{ columns: ["Strategy", "Status", "Treated", "Payment rate", "Target", "No contact", "Lift over no contact", "State"], rows: data.strategies.map((s) => [
                s.name, s.status, s.treated, s.payment_rate === null ? "—" : pct(s.payment_rate), pct(s.target, 0), s.control_rate === null ? "—" : pct(s.control_rate),
                s.lift === null ? "—" : pp(s.lift), s.state ?? "—"]) }}>
              <div className="-mx-4 -mb-3 overflow-x-auto">
                <table className="w-full min-w-[700px] border-collapse">
                  <thead><tr>
                    <th scope="col" className={clsx(TH, "text-left")}>Strategy</th><th scope="col" className={clsx(TH, "text-right")}>Treated</th>
                    <th scope="col" className={clsx(TH, "text-left")}>Payment rate · % of target</th>
                    <th scope="col" className={clsx(TH, "text-right")}>Target</th><th scope="col" className={clsx(TH, "text-right")}>Control</th>
                    <th scope="col" className={clsx(TH, "text-right")}>Lift over no contact</th><th scope="col" className={clsx(TH, "text-left")}>State</th>
                  </tr></thead>
                  <tbody>
                    {data.strategies.map((s) => {
                      const max = Math.max(...data.strategies.flatMap((x) => [x.payment_rate ?? 0, x.target]), 0.05) * 1.15;
                      return (
                        <tr key={s.campaign_id} className={ROW} onClick={() => navigate(`/strategies/${s.campaign_id}`)}>
                          <td className={clsx(TD, "min-w-[190px]")}><span className="whitespace-nowrap font-medium">{s.name}</span>
                            <span className="block text-[11px] text-fg-3">{s.campaign_id} · {s.status}</span></td>
                          <td className={clsx(TD, "num text-right")}>{num(s.treated)}</td>
                          <td className={clsx(TD, "w-[38%] min-w-[220px]")}><Bullet value={s.payment_rate} target={s.target} max={max} /></td>
                          <td className={clsx(TD, "num text-right text-fg-2")}>{pct(s.target, 0)}</td>
                          <td className={clsx(TD, "num text-right text-fg-2")}>{pct(s.control_rate)}</td>
                          <td className={clsx(TD, "num whitespace-nowrap text-right font-semibold", s.lift === null ? "text-fg-3" : s.lift >= 0 ? "text-good" : "text-bad")}>
                            {s.lift === null ? "—" : `${s.lift >= 0 ? "▲" : "▼"} ${pp(Math.abs(s.lift))}`}</td>
                          <td className={TD}><StateText s={s.state} /></td>
                        </tr>
                      );
                    })}
                    {!data.strategies.length && <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-fg-3">No strategies match these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Tile>
          )}

          {strategist && data.insights.length > 0 && (
            <Tile title="Insights from your executive" subtitle="Proposed changes to your strategies">
              <div className="grid gap-3 xl:grid-cols-2">{data.insights.map((i) => <InsightCard key={i.insight_id} i={i} onDone={reload} compact />)}</div>
            </Tile>
          )}
        </div>
      )}
    </div>
  );
}
