/** Report visuals drawn with D3: sparkline, time series with a shared hover week,
 *  Sankey account flow and a heatmap. D3 does the maths (scales, ticks, layout);
 *  React renders the SVG, so the markup stays declarative and themeable.
 *  Motion is Anime.js and is skipped when the viewer asks for reduced motion. */
import * as d3 from "d3";
import { sankey, sankeyLeft, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { animate, createScope, stagger, svg, type Scope } from "animejs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { weekLabel } from "../lib/format";

export const INK = { axis: "#6b778a", grid: "#e8ecf2", label: "#46546a", strong: "#16202e", track: "#eef2f7", surface: "#ffffff" };
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------ utilities */

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    setW(Math.round(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Tiles fade and rise once, in reading order, the first time the report appears. */
export function useEntrance(root: RefObject<HTMLElement | null>, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || !root.current || reduced()) return;
    done.current = true;
    const scope: Scope = createScope({ root: root as RefObject<HTMLElement> }).add(() => {
      animate("[data-tile]", { opacity: [0, 1], y: [10, 0], duration: 460, ease: "out(3)", delay: stagger(45) });
    });
    return () => { scope.revert(); };
  }, [ready, root]);
}

/** A number that counts from its previous value to the new one. */
export function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const el = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (reduced()) { node.textContent = format(value); prev.current = value; return; }
    const o = { v: prev.current };
    const a = animate(o, { v: value, duration: 700, ease: "out(4)", onUpdate: () => { node.textContent = format(o.v); } });
    prev.current = value;
    return () => { a.cancel(); node.textContent = format(value); };
  }, [value, format]);
  return <span ref={el}>{format(value)}</span>;
}

function useDrawIn(ref: RefObject<SVGPathElement | null>, key: string) {
  useEffect(() => {
    if (!ref.current || reduced()) return;
    const a = animate(svg.createDrawable(ref.current), { draw: ["0 0", "0 1"], duration: 900, ease: "inOut(2)" });
    return () => { a.revert(); };
  }, [ref, key]);
}

/** A tooltip box positioned inside a chart container. */
function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 4), Math.max(4, width - 196));
  return (
    <div className="pointer-events-none absolute z-10 w-[184px] rounded-md border border-[#dfe4ec] bg-white/95 px-2.5 py-2 text-[11px] shadow-[0_6px_16px_rgba(16,24,40,0.12)]"
      style={{ left, top: Math.max(0, y) }}>{children}</div>
  );
}

const Row = ({ color, name, value, dash }: { color: string; name: string; value: string; dash?: boolean }) => (
  <div className="flex items-center justify-between gap-3 py-0.5">
    <span className="flex items-center gap-1.5 text-[#46546a]">
      <span className="inline-block h-[3px] w-3 rounded-full" style={{ background: dash ? "transparent" : color, borderTop: dash ? `2px dashed ${color}` : undefined }} />{name}</span>
    <span className="num font-semibold text-[#16202e]">{value}</span>
  </div>
);

/* ------------------------------------------------------------ sparkline */

export function Sparkline({ data, color, format, height = 40 }: { data: (number | null)[]; color: string; format: (v: number) => string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const path = useRef<SVGPathElement>(null);
  const pts = data.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null);
  const ok = pts.length >= 2 && pts.some((p) => p.v !== 0);
  const m = { t: 5, r: 5, b: 5, l: 3 };
  const x = d3.scaleLinear().domain([0, data.length - 1]).range([m.l, Math.max(m.l + 1, width - m.r)]);
  const [lo, hi] = d3.extent(pts, (p) => p.v) as [number, number];
  const y = d3.scaleLinear().domain([Math.min(0, lo ?? 0), (hi ?? 1) || 1]).nice().range([height - m.b, m.t]);
  const line = d3.line<{ i: number; v: number }>().x((p) => x(p.i)).y((p) => y(p.v)).curve(d3.curveMonotoneX);
  const area = d3.area<{ i: number; v: number }>().x((p) => x(p.i)).y0(height - m.b).y1((p) => y(p.v)).curve(d3.curveMonotoneX);
  useDrawIn(path, `${width > 0}-${data.join(",")}`);
  const last = pts[pts.length - 1];
  const max = pts.reduce((a, p) => (p.v > a.v ? p : a), pts[0] ?? { i: 0, v: 0 });
  const gid = useMemo(() => `spark-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div ref={ref} className="relative" style={{ height }}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        if (!ok) return;
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const i = Math.round(x.invert(e.clientX - r.left));
        const near = pts.reduce((a, p) => (Math.abs(p.i - i) < Math.abs(a.i - i) ? p : a), pts[0]);
        setHover(near.i);
      }}>
      {ok && width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Trend over ${data.length} weeks, latest ${format(last.v)}`}>
          <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.18} /><stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient></defs>
          <path d={area(pts) ?? ""} fill={`url(#${gid})`} />
          <path ref={path} d={line(pts) ?? ""} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {max && max !== last && <circle cx={x(max.i)} cy={y(max.v)} r={2} fill={INK.surface} stroke={color} strokeWidth={1.25} />}
          <circle cx={x(last.i)} cy={y(last.v)} r={3} fill={color} stroke={INK.surface} strokeWidth={1.5} />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t - 2} y2={height - m.b} stroke={INK.axis} strokeDasharray="2 2" />}
        </svg>
      )}
      {ok && hover !== null && (() => {
        const p = pts.find((q) => q.i === hover)!;
        return <div className="pointer-events-none absolute -top-7 rounded bg-[#16202e] px-1.5 py-0.5 text-[10px] font-medium text-white"
          style={{ left: Math.min(Math.max(x(p.i) - 30, 0), width - 64) }}>{format(p.v)}</div>;
      })()}
    </div>
  );
}

/* ------------------------------------------------------------ time series */

export interface Series { key: string; name: string; color: string; values: (number | null)[]; kind: "bar" | "line" | "dash" }

/** Weekly series on one axis. The hover week is shared across every chart that
 *  receives the same `hover` and `onHover`, so collections and recovery line up. */
export function TimeSeries({ weeks, series, format, height = 228, hover, onHover, reference, band, emptyText }: {
  weeks: string[]; series: Series[]; format: (v: number) => string; height?: number;
  hover: number | null; onHover: (i: number | null) => void;
  reference?: { label: string; value: number }; band?: [string, string]; emptyText?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const firstLine = useRef<SVGPathElement>(null);
  const m = { t: 16, r: 14, b: 26, l: 48 };
  const inner = { w: Math.max(10, width - m.l - m.r), h: height - m.t - m.b };
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const has = all.some((v) => v !== 0);
  const bars = series.filter((s) => s.kind === "bar");
  const x = d3.scaleBand<number>().domain(weeks.map((_, i) => i)).range([0, inner.w]).paddingInner(0.38).paddingOuter(0.2);
  const y = d3.scaleLinear().domain([0, (d3.max(all) ?? 1) * 1.08 || 1]).nice(4).range([inner.h, 0]);
  const cx = (i: number) => (x(i) ?? 0) + x.bandwidth() / 2;
  const lineGen = d3.line<number | null>().defined((v) => v !== null).x((_, i) => cx(i)).y((v) => y(v as number)).curve(d3.curveMonotoneX);
  const bw = bars.length ? x.bandwidth() / bars.length : 0;
  const ticks = y.ticks(4);
  const lastIdx = (() => { const s = series[0]; if (!s) return -1; for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null && s.values[i] !== 0) return i; return -1; })();
  useDrawIn(firstLine, `${width > 0}-${series.map((s) => s.values.join(",")).join("|")}`);

  const bandArea = band && (() => {
    const a = series.find((s) => s.key === band[0]), b = series.find((s) => s.key === band[1]);
    if (!a || !b) return null;
    const rows = weeks.map((_, i) => ({ i, a: a.values[i], b: b.values[i] }));
    return d3.area<{ i: number; a: number | null; b: number | null }>().defined((r) => r.a !== null && r.b !== null)
      .x((r) => cx(r.i)).y0((r) => y(r.b as number)).y1((r) => y(r.a as number)).curve(d3.curveMonotoneX)(rows);
  })();

  if (!has) return <div className="flex items-center justify-center rounded border border-dashed border-[#e2e7ee] text-xs text-[#6b778a]" style={{ height }}>{emptyText ?? "No data in these weeks"}</div>;
  return (
    <div ref={ref} className="relative" style={{ height }}
      onMouseLeave={() => onHover(null)}
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const px = e.clientX - r.left - m.l;
        const step = inner.w / Math.max(1, weeks.length);
        onHover(Math.max(0, Math.min(weeks.length - 1, Math.floor(px / step))));
      }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(" and ") + " by week"}>
          <g transform={`translate(${m.l},${m.t})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x2={inner.w} stroke={INK.grid} strokeDasharray={t === 0 ? undefined : "3 3"} />
                <text x={-8} dy="0.32em" textAnchor="end" fontSize={10.5} fill={INK.axis} className="num">{format(t)}</text>
              </g>
            ))}
            {weeks.map((w, i) => i % 2 === 0 && (
              <text key={w} x={cx(i)} y={inner.h + 17} textAnchor="middle" fontSize={10.5} fill={INK.axis}>{weekLabel(w)}</text>
            ))}
            {hover !== null && <rect x={(x(hover) ?? 0) - x.step() * x.paddingInner() / 2} width={x.step()} y={0} height={inner.h} fill="#eef3f9" />}
            {bandArea && <path d={bandArea} fill={series[0].color} opacity={0.1} />}
            {bars.map((s, si) => s.values.map((v, i) => v !== null && v > 0 && (
              <rect key={`${s.key}-${i}`} x={(x(i) ?? 0) + si * bw} y={y(v)} width={Math.max(1, bw - (bars.length > 1 ? 2 : 0))} height={inner.h - y(v)}
                rx={2} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
            )))}
            {series.filter((s) => s.kind !== "bar").map((s, si) => (
              <path key={s.key} ref={si === 0 ? firstLine : undefined} d={lineGen(s.values) ?? ""} fill="none" stroke={s.color}
                strokeWidth={2} strokeDasharray={s.kind === "dash" ? "5 4" : undefined} strokeLinecap="round" />
            ))}
            {series.filter((s) => s.kind === "line").map((s) => s.values.map((v, i) => v !== null && (
              <circle key={`${s.key}-p${i}`} cx={cx(i)} cy={y(v)} r={hover === i ? 4 : 2.5} fill={s.color} stroke={INK.surface} strokeWidth={1.5} />
            )))}
            {reference && reference.value > 0 && (
              <g transform={`translate(0,${y(reference.value)})`}>
                <line x2={inner.w} stroke={INK.strong} strokeOpacity={0.55} strokeDasharray="2 3" />
                <text x={4} dy={-5} textAnchor="start" fontSize={10} fill={INK.label} stroke="#ffffff" strokeWidth={3} paintOrder="stroke"
                  strokeLinejoin="round">{reference.label} <tspan className="num" fontWeight={600}>{format(reference.value)}</tspan></text>
              </g>
            )}
            {lastIdx >= 0 && hover === null && series[0].values[lastIdx] !== null && (
              <g transform={`translate(${cx(lastIdx)},${y(series[0].values[lastIdx] as number)})`}>
                <text y={-7} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={INK.strong} className="num" stroke="#ffffff" strokeWidth={3}
                  paintOrder="stroke" strokeLinejoin="round">{format(series[0].values[lastIdx] as number)}</text>
              </g>
            )}
          </g>
        </svg>
      )}
      {hover !== null && width > 0 && (
        <Tooltip x={m.l + cx(hover)} y={m.t} width={width}>
          <p className="mb-1 font-semibold text-[#16202e]">Week of {weekLabel(weeks[hover])}</p>
          {series.map((s) => <Row key={s.key} color={s.color} name={s.name} dash={s.kind === "dash"}
            value={s.values[hover] === null ? "—" : format(s.values[hover] as number)} />)}
        </Tooltip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ sankey */

export interface FlowNode { id: string; label: string; process: string }
export interface FlowLink { source: string; target: string; value: number }
type SNode = SankeyNode<FlowNode, FlowLink>;
type SLink = SankeyLink<FlowNode, FlowLink>;

export function Sankey({ nodes, links, colorOf, height = 340, format }: {
  nodes: FlowNode[]; links: FlowLink[]; colorOf: (n: FlowNode) => string; height?: number; format: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ link?: SLink; node?: SNode; x: number; y: number } | null>(null);
  const graph = useMemo(() => {
    if (width < 200 || !links.length) return null;
    const layout = sankey<FlowNode, FlowLink>().nodeId((d) => d.id).nodeAlign(sankeyLeft).nodeWidth(12).nodePadding(14)
      .nodeSort(() => null).extent([[1, 6], [width - 1, height - 6]]);
    return layout({ nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
  }, [nodes, links, width, height]);
  if (!links.length) return <div className="flex items-center justify-center rounded border border-dashed border-[#e2e7ee] text-xs text-[#6b778a]" style={{ height }}>No accounts</div>;
  const active = (l: SLink) => !hover || hover.link === l || hover.node === l.source || hover.node === l.target;
  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {graph && (
        <svg width={width} height={height} role="img" aria-label="Account flow from each book to its route, status and outcome">
          <g fill="none">
            {graph.links.map((l, i) => (
              <path key={i} d={sankeyLinkHorizontal()(l) ?? ""} stroke={colorOf(l.source as SNode)} strokeWidth={Math.max(1, l.width ?? 1)}
                strokeOpacity={active(l) ? 0.32 : 0.08} style={{ transition: "stroke-opacity 150ms" }}
                onMouseMove={(e) => { const r = ref.current!.getBoundingClientRect(); setHover({ link: l, x: e.clientX - r.left, y: e.clientY - r.top }); }} />
            ))}
          </g>
          {graph.nodes.map((n) => {
            const right = (n.x1 ?? 0) > width - 40;
            const h = (n.y1 ?? 0) - (n.y0 ?? 0);
            return (
              <g key={n.id} onMouseMove={(e) => { const r = ref.current!.getBoundingClientRect(); setHover({ node: n, x: e.clientX - r.left, y: e.clientY - r.top }); }}>
                <rect x={n.x0} y={n.y0} width={(n.x1 ?? 0) - (n.x0 ?? 0)} height={Math.max(1, h)} rx={2} fill={colorOf(n)} />
                <text x={right ? (n.x0 ?? 0) - 6 : (n.x1 ?? 0) + 6} y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2} dy="0.35em" textAnchor={right ? "end" : "start"}
                  fontSize={11} fill={INK.label}>
                  <tspan fontWeight={600} fill={INK.strong}>{n.label}</tspan><tspan className="num" dx={5}>{format(n.value ?? 0)}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && graph && (
        <Tooltip x={hover.x} y={hover.y - 10} width={width}>
          {hover.link ? <>
            <p className="font-semibold text-[#16202e]">{(hover.link.source as SNode).label} → {(hover.link.target as SNode).label}</p>
            <p className="num mt-0.5 text-[#46546a]">{format(hover.link.value)} accounts · {Math.round((hover.link.value / ((hover.link.source as SNode).value || 1)) * 100)}% of {(hover.link.source as SNode).label.toLowerCase()}</p>
          </> : hover.node && <>
            <p className="font-semibold text-[#16202e]">{hover.node.label}</p>
            <p className="num mt-0.5 text-[#46546a]">{format(hover.node.value ?? 0)} accounts</p>
          </>}
        </Tooltip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ heatmap */

export function Heatmap({ rows, weeks, color, format }: {
  rows: { label: string; values: number[] }[]; weeks: string[]; color: string; format: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const labelW = 150, totalW = 64, cellH = 30, headH = 18, gap = 2;
  const cols = weeks.length;
  const cellW = Math.max(14, (width - labelW - totalW - gap * cols) / Math.max(1, cols));
  const max = d3.max(rows.flatMap((r) => r.values)) ?? 0;
  const scale = d3.scaleSequential(d3.interpolateRgb("#f3f6fa", color)).domain([0, max || 1]);
  const height = headH + rows.length * (cellH + gap) + 26;
  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Weekly amounts by card business">
          {weeks.map((w, c) => (c % 2 === 0 || c === cols - 1) && (
            <text key={w} x={labelW + c * (cellW + gap) + cellW / 2} y={12} textAnchor="middle" fontSize={10} fill={INK.axis}>{weekLabel(w)}</text>
          ))}
          <text x={width - 2} y={12} textAnchor="end" fontSize={10} fontWeight={600} fill={INK.axis}>12 weeks</text>
          {rows.map((row, r) => {
            const yy = headH + r * (cellH + gap);
            const total = row.values.reduce((a, b) => a + b, 0);
            return (
              <g key={row.label}>
                <text x={0} y={yy + cellH / 2} dy="0.35em" fontSize={11.5} fontWeight={500} fill={INK.strong}>{row.label}</text>
                {row.values.map((v, c) => (
                  <rect key={c} x={labelW + c * (cellW + gap)} y={yy} width={cellW} height={cellH} rx={2}
                    fill={v > 0 ? scale(v) : "#f6f8fb"} stroke={hover?.r === r && hover?.c === c ? INK.strong : "none"} strokeWidth={1.5}
                    onMouseEnter={() => setHover({ r, c })} />
                ))}
                <text x={width - 2} y={yy + cellH / 2} dy="0.35em" textAnchor="end" fontSize={11.5} fontWeight={600} fill={INK.strong} className="num">{format(total)}</text>
              </g>
            );
          })}
          <g transform={`translate(${labelW},${height - 12})`}>
            <text x={0} dy="0.35em" fontSize={10} fill={INK.axis}>Less</text>
            {d3.range(6).map((k) => <rect key={k} x={30 + k * 18} y={-5} width={16} height={10} rx={2} fill={scale((max * k) / 5)} />)}
            <text x={30 + 6 * 18 + 4} dy="0.35em" fontSize={10} fill={INK.axis}>More</text>
          </g>
        </svg>
      )}
      {hover && width > 0 && (
        <Tooltip x={labelW + hover.c * (cellW + gap)} y={headH + hover.r * (cellH + gap) + cellH + 4} width={width}>
          <p className="font-semibold text-[#16202e]">{rows[hover.r].label}</p>
          <p className="text-[#46546a]">Week of {weekLabel(weeks[hover.c])}: <span className="num font-semibold text-[#16202e]">{format(rows[hover.r].values[hover.c])}</span></p>
        </Tooltip>
      )}
    </div>
  );
}
