/**
 * Charts. Method: one y-axis per chart (never dual), categorical hues in fixed
 * order, sequential = one hue, thin marks, recessive grid, direct labels, and
 * a hover tooltip on every plotted form.
 */
import clsx from "clsx";
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

import type { Learning } from "../lib/api";
import { money, num, pct, pp, weekLabel } from "../lib/format";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];
const AXIS = { fontSize: 11, fill: "var(--chart-axis)" };

function Tip({ label, rows }: { label: string; rows: { name: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="font-semibold text-fg">{label}</p>
      {rows.map((r) => (
        <p key={r.name} className="mt-1 flex items-center gap-2 text-fg-2">
          {r.color && <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />}
          <span>{r.name}</span><span className="num ml-auto pl-3 font-medium text-fg">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

type Fmt = (v: number | null | undefined) => string;

/** Treated vs control rate over weeks: the comparison every strategy is judged on. */
export function RateVsControl({ data, height = 220, target }: {
  data: { week: string; recovery_rate: number | null; control_rate: number | null }[];
  height?: number; target?: number;
}) {
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="week" tickFormatter={weekLabel} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0, "auto"]} width={44} />
        <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
          <Tip label={`Week of ${weekLabel(String(label))}`} rows={[
            { name: "Treated", value: pct(payload[0].payload.recovery_rate), color: SERIES[0] },
            { name: "Control", value: pct(payload[0].payload.control_rate), color: "var(--control)" },
            { name: "Uplift", value: pp((payload[0].payload.recovery_rate ?? 0) - (payload[0].payload.control_rate ?? 0)) },
          ]} />) : null} />
        <Line type="monotone" dataKey="recovery_rate" name="Treated" stroke={SERIES[0]} strokeWidth={2}
          dot={{ r: 3.5, strokeWidth: 0, fill: SERIES[0] }} connectNulls />
        <Line type="monotone" dataKey="control_rate" name="Control" stroke="var(--control)" strokeWidth={2}
          strokeDasharray="4 3" dot={{ r: 3.5, strokeWidth: 0, fill: "var(--control)" }} connectNulls />
        {target !== undefined && (
          <Line type="monotone" dataKey={() => target} name="Target" stroke="var(--chart-axis)" strokeWidth={1}
            strokeDasharray="2 4" dot={false} isAnimationActive={false} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** One metric over weeks. */
export function MetricTrend({ data, dataKey, format, height = 180, color = SERIES[0], name }: {
  data: Record<string, unknown>[]; dataKey: string; format: Fmt; height?: number; color?: string; name: string;
}) {
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 18, right: 8, left: -6, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="week" tickFormatter={weekLabel} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => format(v)} width={52} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={({ active, payload, label }) => active && payload?.length ? (
          <Tip label={`Week of ${weekLabel(String(label))}`} rows={[{ name, value: format(payload[0].value as number), color }]} />) : null} />
        <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} maxBarSize={34}
          label={{ position: "top", fontSize: 10, fill: "var(--chart-axis)", formatter: (v: unknown) => format(v as number) }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Up to five strategies' treated rate over weeks. */
export function CompareTrend({ series, height = 230 }: {
  series: { id: string; name: string; weekly: { week: string; recovery_rate: number | null }[] }[]; height?: number;
}) {
  const weeks = Array.from(new Set(series.flatMap((s) => s.weekly.map((w) => w.week)))).sort();
  const data = weeks.map((w) => ({ week: w, ...Object.fromEntries(series.map((s) => [s.id, s.weekly.find((x) => x.week === w)?.recovery_rate ?? null])) }));
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="week" tickFormatter={weekLabel} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={44} />
        <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
          <Tip label={`Week of ${weekLabel(String(label))}`} rows={series.map((s, i) => ({
            name: s.id, value: pct(payload[0].payload[s.id]), color: SERIES[i] }))} />) : null} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} formatter={(v: string) => <span style={{ color: "var(--chart-axis)" }}>{v}</span>} />
        {series.map((s, i) => (
          <Line key={s.id} type="monotone" dataKey={s.id} name={`${s.id} ${s.name}`} stroke={SERIES[i]} strokeWidth={2}
            dot={{ r: 3, strokeWidth: 0, fill: SERIES[i] }} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Stacked weekly counts by category (compliance violations by area). */
export function StackedWeekly({ data: raw, keys: allKeys, height = 220 }: { data: Record<string, unknown>[]; keys: string[]; height?: number }) {
  // Five validated hues. More categories fold into "Other" (neutral) rather than
  // cycling colours, which would give two categories the same identity.
  const totals = allKeys.map((k) => [k, raw.reduce((s, r) => s + (Number(r[k]) || 0), 0)] as const).sort((a, b) => b[1] - a[1]);
  const keys = allKeys.length > 5 ? [...totals.slice(0, 4).map(([k]) => k), "Other"] : allKeys;
  const data = allKeys.length > 5 ? raw.map((r) => ({ ...r, Other: totals.slice(4).reduce((s, [k]) => s + (Number(r[k]) || 0), 0) })) : raw;
  const colour = (k: string, i: number) => (k === "Other" ? "var(--control)" : SERIES[i]);
  if (!data.length) return <EmptyChart height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="week" tickFormatter={weekLabel} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={({ active, payload, label }) => active && payload?.length ? (
          <Tip label={`Week of ${weekLabel(String(label))}`} rows={keys.filter((k) => payload[0].payload[k]).map((k) => ({
            name: k, value: String(payload[0].payload[k]), color: colour(k, keys.indexOf(k)) }))} />) : null} />
        <Legend iconType="square" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} formatter={(v: string) => <span style={{ color: "var(--chart-axis)" }}>{v}</span>} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="a" fill={colour(k, i)} stroke="var(--chart-surface)" strokeWidth={1}
            radius={i === keys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} maxBarSize={36} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars with direct labels: ranked categories. */
export function BarList({ rows, format = (v) => String(v), color = SERIES[0], max }: {
  rows: { label: string; value: number; sub?: string; color?: string }[]; format?: Fmt; color?: string; max?: number;
}) {
  const m = max ?? Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 font-medium leading-4 text-fg">{r.label}</span>
            <span className="num shrink-0 font-semibold text-fg">{format(r.value)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (r.value / m) * 100)}%`, background: r.color ?? color }} />
          </div>
          {r.sub && <p className="mt-0.5 text-2xs text-fg-3">{r.sub}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Uplift over control with a 95% interval, against a zero line. */
export function UpliftRow({ uplift, ci, mde, compact }: { uplift: number | null; ci: [number, number] | null; mde?: number | null; compact?: boolean }) {
  if (uplift === null || !ci) return <span className="text-xs text-fg-3">Not enough data</span>;
  const span = Math.max(0.3, Math.abs(ci[0]), Math.abs(ci[1])) * 1.1;
  const x = (v: number) => `${50 + (v / span) * 50}%`;
  const sig = ci[0] > 0 || ci[1] < 0;
  return (
    <div className={clsx(compact ? "w-40" : "w-full")}>
      <div className="relative h-4">
        <div className="absolute inset-y-0 left-1/2 w-px bg-fg-3/50" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary-200"
          style={{ left: x(ci[0]), width: `calc(${x(ci[1])} - ${x(ci[0])})` }} />
        <div className={clsx("absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm ring-2 ring-surface",
          sig ? (uplift > 0 ? "bg-good" : "bg-bad") : "bg-primary-500")} style={{ left: x(uplift) }} />
      </div>
      {!compact && (
        <p className="mt-1 text-2xs text-fg-3">
          {pp(uplift)} (95% interval {pp(ci[0])} to {pp(ci[1])}){mde ? ` · detectable at this size: ${pp(mde)}` : ""}
        </p>
      )}
    </div>
  );
}

/** Posterior belief per arm, with its uncertainty range. */
export function BeliefBars({ rows }: { rows: { name: string; mean: number; low: number; high: number; sub?: string; highlight?: boolean }[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => (
        <li key={r.name}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i % 5] }} />
              <span className={clsx("text-fg", r.highlight && "font-semibold")}>{r.name}</span>
            </span>
            <span className="num text-fg-2"><span className="font-semibold text-fg">{pct(r.mean, 0)}</span>
              <span className="text-fg-3"> ({pct(r.low, 0)}–{pct(r.high, 0)})</span></span>
          </div>
          <div className="relative mt-1 h-3 rounded-full bg-surface-sunken">
            <div className="absolute inset-y-0 rounded-full opacity-25" style={{ left: `${r.low * 100}%`, width: `${Math.max(1, (r.high - r.low) * 100)}%`, background: SERIES[i % 5] }} />
            <div className="absolute inset-y-0 w-1.5 -translate-x-1/2 rounded-sm" style={{ left: `${r.mean * 100}%`, background: SERIES[i % 5] }} />
          </div>
          {r.sub && <p className="mt-0.5 text-2xs text-fg-3">{r.sub}</p>}
        </li>
      ))}
    </ul>
  );
}

const waveTick = (l: string) => (l === "Prior" ? "Prior" : l.replace("Wave ", "W"));
const legendText = (v: string) => <span style={{ color: "var(--chart-axis)" }}>{v}</span>;

/** How the engine's belief in each treatment moved, wave by wave: posterior mean
 *  (line) and its 95% interval (band). A band that narrows is the engine learning. */
export function BeliefTrajectory({ learning, height = 260 }: { learning: Learning; height?: number }) {
  const { arms, waves } = learning;
  if (waves.length < 2) return <EmptyChart height={height} />;
  const data = waves.map((w) => ({
    label: w.label,
    ...Object.fromEntries(arms.flatMap((a) => {
      const p = w.posterior[a.code];
      return [[`${a.code}_m`, p?.mean ?? null], [`${a.code}_r`, p ? [p.low, p.high] : null]];
    })),
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="label" tickFormatter={waveTick} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0, "auto"]} width={44} />
        <Tooltip content={({ active, label }) => {
          const w = active ? waves.find((x) => x.label === label) : undefined;
          return w ? (
            <Tip label={w.wave ? `${w.label} · ${num(w.learned)} outcomes learned` : "Starting belief"} rows={arms.map((a, i) => {
              const p = w.posterior[a.code];
              return { name: a.name, color: SERIES[i % 5],
                value: `${pct(p.mean, 0)} (${pct(p.low, 0)}–${pct(p.high, 0)}) · best ${pct(p.p_best, 0)}` };
            })} />) : null;
        }} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} formatter={legendText}
          itemSorter={(item) => arms.findIndex((a) => a.name === item.value)} />
        {arms.map((a, i) => (
          <Area key={`${a.code}_r`} dataKey={`${a.code}_r`} stroke="none" fill={SERIES[i % 5]} fillOpacity={0.1}
            legendType="none" activeDot={false} isAnimationActive={false} />
        ))}
        {arms.map((a, i) => (
          <Line key={a.code} dataKey={`${a.code}_m`} name={a.name} stroke={SERIES[i % 5]} strokeWidth={2}
            dot={{ r: 3, strokeWidth: 0, fill: SERIES[i % 5] }} isAnimationActive={false} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Share of each wave's treated customers that went to each treatment: what
 *  Thompson sampling did with its beliefs. Colours match BeliefTrajectory. */
export function AllocationChart({ learning, height = 220 }: { learning: Learning; height?: number }) {
  const { arms, waves } = learning;
  const rows = waves.filter((w) => w.wave > 0);
  if (!rows.length) return <EmptyChart height={height} />;
  const data = rows.map((w) => ({ label: w.label, ...Object.fromEntries(arms.map((a) => [a.code, w.allocation[a.code] ?? 0])) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 10, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey="label" tickFormatter={waveTick} tick={AXIS} tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${Math.round(v * 100)}%`}
          domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} width={44} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={({ active, label }) => {
          const w = active ? rows.find((x) => x.label === label) : undefined;
          return w ? (
            <Tip label={`${w.label} · ${num(w.treated)} treated`} rows={arms.map((a, i) => ({
              name: a.name, color: SERIES[i % 5], value: `${pct(w.allocation[a.code], 0)} · ${num(w.counts[a.code])}` }))} />) : null;
        }} />
        <Legend iconType="square" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} formatter={legendText}
          itemSorter={(item) => arms.findIndex((a) => a.name === item.value)} />
        {arms.map((a, i) => (
          <Bar key={a.code} dataKey={a.code} name={a.name} stackId="s" fill={SERIES[i % 5]} stroke="var(--chart-surface)"
            strokeWidth={1} maxBarSize={36} isAnimationActive={false}
            radius={i === arms.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function EmptyChart({ height }: { height: number }) {
  return <div className="flex items-center justify-center rounded-lg bg-surface-sunken text-xs text-fg-3" style={{ height }}>No data yet</div>;
}

export const fmtMoney: Fmt = (v) => money(v ?? 0, true);
export const fmtPct: Fmt = (v) => pct(v, 0);
