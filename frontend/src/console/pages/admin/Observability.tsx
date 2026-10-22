/** Observability: the OpenTelemetry traces, metrics, events and logs (MELT) the
 *  decision engine records. A trace opens as a waterfall of its spans. */
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { dateTime, num } from "../../lib/format";
import { useApi } from "../../lib/session";
import {
  Card, Chip, ErrorState, Kpi, Page, PageHeader, Spinner, Table, Tabs, Td, Th, Tr, inputCls,
} from "../../ui/ui";

type Tab = "traces" | "metrics" | "events" | "logs";
interface Summary { traces: number; spans: number; errors: number; decisions_traced: number; decision_p95_ms: number | null; logs: number; exporting_to: string | null; service: Record<string, string> }
interface TraceRow { trace_id: string; name: string; root_span: string; start: string; duration_ms: number | null; spans: number; error: boolean; decision_id: string | null; operations: string[]; status_code: number | null }
interface SpanRow { depth: number; span_id: string; parent_id: string | null; name: string; kind: string; offset_ms: number; duration_ms: number | null; status: string; attributes: Record<string, string | number | boolean>; events: { name: string; time: string; attributes: Record<string, string | number | boolean> }[] }
interface TraceDetail { trace_id: string; name: string; start: string; duration_ms: number | null; spans: SpanRow[] }
interface Metric { name: string; description: string; unit: string; type: string; points: { attributes: Record<string, string | number | boolean>; value?: number; count?: number; avg?: number | null; max?: number | null }[] }

const kv = (a: Record<string, string | number | boolean>) => Object.entries(a).map(([k, v]) => `${k.replace(/^ari\./, "")}=${v}`).join(" · ");
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v < 1 ? `${v.toFixed(2)} ms` : `${v.toFixed(1)} ms`);

function TraceView({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useApi<TraceDetail>(`/observability/traces/${id}`, [id]);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorState message={error} />;
  if (!data) return <Spinner label="Loading trace" />;
  const total = Math.max(data.duration_ms ?? 1, 0.001);
  return (
    <Card title={data.name} subtitle={`Trace ${data.trace_id} · ${dateTime(data.start)} · ${ms(data.duration_ms)} · ${data.spans.length} spans`}
      actions={<button onClick={onClose} aria-label="Close trace" className="rounded-md p-1 text-fg-3 hover:bg-surface-hover hover:text-fg"><X className="h-4 w-4" /></button>} flush>
      <div className="overflow-x-auto">
        <ul className="min-w-[640px] divide-y divide-line">
          {data.spans.map((s) => (
            <li key={s.span_id}>
              <button onClick={() => setOpen(open === s.span_id ? null : s.span_id)}
                className="grid w-full grid-cols-[minmax(220px,38%)_minmax(0,1fr)_80px] items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-hover">
                <span className="truncate text-xs" style={{ paddingLeft: `${Math.min(s.depth, 8) * 14}px` }}>
                  <span className={clsx("font-mono", s.status === "error" ? "text-bad" : "text-fg")}>{s.name}</span>
                  {s.events.length > 0 && <span className="ml-1.5 text-2xs text-fg-3">{s.events.length} event{s.events.length === 1 ? "" : "s"}</span>}
                </span>
                <span className="relative h-3 rounded-sm bg-surface-sunken">
                  <span className={clsx("absolute inset-y-0 rounded-sm", s.status === "error" ? "bg-bad" : s.name.startsWith("ari.") || s.name.startsWith("mcp.") ? "bg-primary-500" : "bg-fg-3")}
                    style={{ left: `${(s.offset_ms / total) * 100}%`, width: `${Math.max(0.6, ((s.duration_ms ?? 0) / total) * 100)}%` }} />
                </span>
                <span className="num text-right text-2xs text-fg-2">{ms(s.duration_ms)}</span>
              </button>
              {open === s.span_id && (
                <div className="bg-surface-sunken px-4 py-2.5 text-2xs leading-5 text-fg-2">
                  <p><span className="font-medium text-fg">Attributes</span> · {kv(s.attributes) || "none"}</p>
                  {s.events.map((e, i) => <p key={i}><span className="font-medium text-fg">Event {e.name}</span> · {kv(e.attributes)}</p>)}
                  <p className="text-fg-3">Span {s.span_id}{s.parent_id ? ` · parent ${s.parent_id}` : " · root"} · {s.kind}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default function Observability() {
  const [tab, setTab] = useState<Tab>("traces");
  const [q, setQ] = useState("ari.decide");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const summary = useApi<Summary>("/observability/summary");
  const traces = useApi<{ traces: TraceRow[]; total: number }>(tab === "traces" ? `/observability/traces?q=${encodeURIComponent(q)}&errors=${errorsOnly}` : null, [tab, q, errorsOnly]);
  const metrics = useApi<{ metrics: Metric[] }>(tab === "metrics" ? "/observability/metrics" : null, [tab]);
  const events = useApi<{ events: { time: string; name: string; attributes: Record<string, string | number | boolean>; span: string; trace_id: string }[]; total: number }>(tab === "events" ? "/observability/events" : null, [tab]);
  const logs = useApi<{ logs: { time: string; severity: string; body: string; trace_id: string | null }[]; total: number }>(tab === "logs" ? "/observability/logs" : null, [tab]);
  const s = summary.data;
  const openTrace = (id: string) => { setTrace(id); setTab("traces"); };

  return (
    <>
      <PageHeader title="Observability" subtitle="OpenTelemetry traces, metrics, events and logs from the decision engine" />
      <Page>
        {s && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Traces held" value={num(s.traces)} sub={`${num(s.spans)} spans`} />
            <Kpi label="Decisions traced" value={num(s.decisions_traced)} sub="one trace each, with every stage" />
            <Kpi label="Decision time (p95)" value={ms(s.decision_p95_ms)} sub="router, rules, scoring and review" />
            <Kpi label="Errors" value={num(s.errors)} tone={s.errors ? "bad" : "neutral"} sub="spans with an error status" />
            <Kpi label="Export" value={s.exporting_to ? "OTLP" : "In-app"} sub={s.exporting_to ?? `${s.service["service.name"]} ${s.service["service.version"]}`} />
          </div>
        )}
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[
          { id: "traces", label: "Traces" }, { id: "metrics", label: "Metrics" }, { id: "events", label: "Events" }, { id: "logs", label: "Logs" },
        ]} />

        {tab === "traces" && (
          <>
            {trace && <TraceView id={trace} onClose={() => setTrace(null)} />}
            <Card flush title="Traces" subtitle="Newest first. A decision trace shows the Propensity Router, the rules, Thompson sampling, the review gate and the send."
              actions={<div className="flex items-center gap-2">
                <div className="relative w-64">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                  <input id="trace-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Operation, route or decision ID" className={`${inputCls} h-8 pl-8 text-xs`} />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-fg-2"><input id="errors-only" type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />Errors only</label>
              </div>}>
              <Table>
                <thead><tr><Th>Started</Th><Th>Trace</Th><Th align="right">Duration</Th><Th align="right">Spans</Th><Th>Decision</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {traces.data?.traces.map((t) => (
                    <Tr key={t.trace_id} onClick={() => setTrace(t.trace_id)} className={trace === t.trace_id ? "bg-primary-50/40" : undefined}>
                      <Td className="whitespace-nowrap text-xs text-fg-3">{dateTime(t.start)}</Td>
                      <Td><span className="block font-mono text-xs">{t.name}</span><span className="block truncate text-2xs text-fg-3">{t.operations.join(" · ")}</span></Td>
                      <Td align="right" className="num">{ms(t.duration_ms)}</Td>
                      <Td align="right">{t.spans}</Td>
                      <Td>{t.decision_id ? <Link onClick={(e) => e.stopPropagation()} to={`/decisions/${t.decision_id}`} className="font-mono text-xs text-primary-500 hover:underline">{t.decision_id}</Link> : <span className="text-fg-3">—</span>}</Td>
                      <Td>{t.error ? <Chip tone="bad">Error</Chip> : <span className="text-xs text-fg-2">{t.status_code ?? "OK"}</span>}</Td>
                    </Tr>
                  ))}
                  {traces.data && !traces.data.traces.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-fg-3">No traces match.</td></tr>}
                </tbody>
              </Table>
            </Card>
          </>
        )}

        {tab === "metrics" && (
          <Card flush title="Metrics" subtitle="Counters and histograms since the service started, by attribute set">
            <Table>
              <thead><tr><Th>Metric</Th><Th>Attributes</Th><Th align="right">Value</Th></tr></thead>
              <tbody>
                {metrics.data?.metrics.flatMap((m) => m.points.map((p, i) => (
                  <Tr key={`${m.name}-${i}`}>
                    <Td>{i === 0 ? <><span className="block font-mono text-xs">{m.name}</span><span className="block text-2xs text-fg-3">{m.description}{m.unit ? ` (${m.unit})` : ""}</span></> : null}</Td>
                    <Td className="text-xs text-fg-2">{kv(p.attributes) || "—"}</Td>
                    <Td align="right" className="num">{p.value !== undefined ? num(p.value) : `${num(p.count ?? 0)} · avg ${p.avg?.toFixed(1) ?? "—"} · max ${p.max?.toFixed(1) ?? "—"}`}</Td>
                  </Tr>
                )))}
              </tbody>
            </Table>
          </Card>
        )}

        {tab === "events" && (
          <Card flush title="Events" subtitle={`Span events, newest first: rules that blocked a treatment, decisions sent to review, held contacts. ${num(events.data?.total)} held.`}>
            <Table>
              <thead><tr><Th>Time</Th><Th>Event</Th><Th>Details</Th><Th>In span</Th><Th>Trace</Th></tr></thead>
              <tbody>
                {events.data?.events.map((e, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap text-xs text-fg-3">{dateTime(e.time)}</Td>
                    <Td className="font-mono text-xs">{e.name}</Td>
                    <Td className="text-xs text-fg-2">{kv(e.attributes)}</Td>
                    <Td className="font-mono text-2xs text-fg-3">{e.span}</Td>
                    <Td><button onClick={() => openTrace(e.trace_id)} className="font-mono text-2xs text-primary-500 hover:underline">{e.trace_id.slice(0, 12)}…</button></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        {tab === "logs" && (
          <Card flush title="Logs" subtitle={`Log records, newest first, each linked to the trace it was written in. ${num(logs.data?.total)} held.`}>
            <Table>
              <thead><tr><Th>Time</Th><Th>Level</Th><Th>Message</Th><Th>Trace</Th></tr></thead>
              <tbody>
                {logs.data?.logs.map((l, i) => (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap text-xs text-fg-3">{dateTime(l.time)}</Td>
                    <Td>{l.severity === "INFO" ? <span className="text-xs text-fg-2">Info</span> : <Chip tone={l.severity === "ERROR" ? "bad" : "warn"}>{l.severity.charAt(0) + l.severity.slice(1).toLowerCase()}</Chip>}</Td>
                    <Td className="text-xs">{l.body}</Td>
                    <Td>{l.trace_id ? <button onClick={() => openTrace(l.trace_id!)} className="font-mono text-2xs text-primary-500 hover:underline">{l.trace_id.slice(0, 12)}…</button> : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </Page>
    </>
  );
}
