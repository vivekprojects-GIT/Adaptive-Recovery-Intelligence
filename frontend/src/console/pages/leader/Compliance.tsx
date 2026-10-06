import clsx from "clsx";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../lib/api";
import { customerRef, dateTime, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList, StackedWeekly } from "../../ui/charts";
import {
  Banner, Button, Card, Drawer, Empty, ErrorState, Field, Kpi, Page, PageHeader, Pills, Progress, Spinner, StatusChip, Table, Td, Th, Tr, inputCls, useAction,
} from "../../ui/ui";

interface V { violation_id: string; policy_area: string; rule: string; severity: string; campaign_id: string | null; customer_id: number | null;
  nudge_id: string | null; description: string; detected_at: string; status: string; resolved_by: string | null; resolved_at: string | null; resolution_note: string | null }
interface Data {
  kpis: { open: number; open_critical: number; open_high: number; month_total: number; score: number; weakest: string; avg_resolution_days: number | null };
  areas: { area: string; description: string; violations: number; checked: number; score: number }[];
  weekly: Record<string, number | string>[]; by_strategy: { campaign_id: string; count: number }[]; violations: V[];
}

export default function Compliance() {
  const { can, refresh } = useSession();
  const [filter, setFilter] = useState("all");
  const { data, error, loading, reload } = useApi<Data>("/compliance");
  const [sel, setSel] = useState<V | null>(null);
  const [note, setNote] = useState("");
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const k = data.kpis;
  const rows = data.violations.filter((v) => filter === "all" || v.severity === filter || v.status === filter);
  const areaKeys = data.areas.map((a) => a.area).filter((a) => data.weekly.some((w) => w[a]));
  const update = (status: string) => run("u", () => api.post(`/compliance/${sel!.violation_id}`, { status, note }), `${sel!.violation_id} → ${status}.`)
    .then((r) => { if (r) { setSel(null); setNote(""); reload(); refresh(); } });

  return (
    <>
      <PageHeader title="Compliance & Governance" subtitle="Policy breaches across everything the customer experienced: ARI's messages and the bank's own systems"
        actions={<>
          {can("resolve_violations") && <Button icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === "scan"}
            onClick={() => run("scan", () => api.post<{ new_violations: number }>("/compliance/scan"), (r) => `Scan complete: ${r.new_violations} new.`).then(reload)}>Scan now</Button>}
          {can("export_reports") && <Button icon={<Download className="h-3.5 w-3.5" />} onClick={() => run("x", () => api.download("/reports/compliance.csv", "ari-compliance.csv"), "Downloaded.")}>Export Report</Button>}
          <Button variant="danger" onClick={() => setFilter("Open")}>{k.open} open issues</Button>
        </>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Open violations" value={k.open} tone={k.open_critical ? "bad" : "warn"} sub={`${k.open_critical} critical · ${k.open_high} high`} />
          <Kpi label="Violations, last 30 days" value={k.month_total} />
          <Kpi label="Compliance score" value={pct(k.score, 0)} tone={k.score < 0.9 ? "warn" : "good"} sub={`weakest: ${k.weakest}`} progress={k.score} />
          <Kpi label="Avg resolution time" value={k.avg_resolution_days !== null ? `${k.avg_resolution_days}d` : "—"} target="< 2 days" />
        </div>

        <Banner tone="info">
          ARI's contact guard stops its own messages breaching caps, hours and opt-outs before they are sent. Most breaches here come from the bank's BAU dialler and letters running alongside, or from manual messages. They are pinned to the ARI strategy contacting the same customer that week, because that strategy's contact plan is what can change.
        </Banner>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Card title="Violation trend" subtitle="Weekly, by policy area"><StackedWeekly data={data.weekly} keys={areaKeys} /></Card>
          <Card title="Violations by strategy">
            <BarList rows={data.by_strategy.map((b) => ({ label: b.campaign_id, value: b.count }))} format={(v) => String(v ?? 0)} color="var(--series-2)" />
          </Card>
        </div>

        <Card title="Policy area compliance" subtitle="Share of checked events with no breach, last 30 days">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.areas.map((a) => (
              <button key={a.area} onClick={() => setFilter("all")} className={clsx("rounded-lg border p-3 text-left",
                a.score < 0.8 ? "border-bad/25" : a.score < 0.95 ? "border-warn/30" : "border-line")}>
                <div className="flex items-baseline justify-between"><p className="text-[13px] font-semibold">{a.area}</p>
                  <span className={clsx("num text-sm font-semibold", a.score < 0.8 ? "text-bad" : a.score < 0.95 ? "text-warn" : "text-good")}>{pct(a.score, 0)}</span></div>
                <Progress value={a.score * 100} tone={a.score < 0.8 ? "bad" : a.score < 0.95 ? "warn" : "good"} className="mt-1.5" />
                <p className="mt-1.5 text-2xs text-fg-3">{a.violations} violations · {a.checked} checked · {a.description}</p>
              </button>
            ))}
          </div>
        </Card>

        <Card title="Violation log" flush actions={<Pills value={filter} onChange={setFilter} options={[
          { id: "all", label: "All" }, { id: "Critical", label: "Critical" }, { id: "High", label: "High" }, { id: "Open", label: "Open" }, { id: "Resolved", label: "Resolved" }]} />}>
          <Table maxHeight="520px">
            <thead><tr><Th>ID</Th><Th>Severity</Th><Th>Policy area</Th><Th>What happened</Th><Th>Strategy</Th><Th>Customer</Th><Th>Detected</Th><Th>Status</Th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <Tr key={v.violation_id} onClick={() => setSel(v)}>
                  <Td mono className="font-medium">{v.violation_id}</Td><Td><StatusChip status={v.severity} /></Td>
                  <Td className="text-xs">{v.policy_area}<span className="block text-2xs text-fg-3">{v.rule}</span></Td>
                  <Td className="max-w-md text-xs text-fg-2">{v.description}</Td>
                  <Td className="text-xs">{v.campaign_id ?? <span className="text-fg-3">BAU only</span>}</Td>
                  <Td>{v.customer_id ? <Link onClick={(e) => e.stopPropagation()} to={`/journeys/${v.customer_id}`} className="text-xs text-primary-500 hover:underline">{customerRef(v.customer_id)}</Link> : "—"}</Td>
                  <Td className="text-xs text-fg-3">{dateTime(v.detected_at)}</Td><Td><StatusChip status={v.status} /></Td>
                </Tr>
              ))}
              {!rows.length && <Empty cols={8}>No violations match.</Empty>}
            </tbody>
          </Table>
        </Card>
      </Page>
      <Drawer open={!!sel} onClose={() => { setSel(null); setNote(""); }} title={sel?.violation_id ?? ""} subtitle={`${sel?.policy_area} · ${sel?.rule}`}
        footer={can("resolve_violations") && sel?.status !== "Resolved" ? <>
          <Button variant="ghost" onClick={() => setSel(null)}>Close</Button>
          {sel?.status === "Open" && <Button loading={busy === "u"} onClick={() => update("Investigating")}>Mark investigating</Button>}
          <Button variant="primary" disabled={!note.trim()} loading={busy === "u"} onClick={() => update("Resolved")}>Resolve</Button>
        </> : undefined}>
        {sel && (
          <div className="space-y-4">
            <div className="flex gap-1.5"><StatusChip status={sel.severity} /><StatusChip status={sel.status} /></div>
            <p className="text-[13px] leading-5">{sel.description}</p>
            <div className="flex flex-wrap gap-3 text-xs">
              {sel.campaign_id && <Link className="text-primary-500 hover:underline" to={`/strategies/${sel.campaign_id}`}>Strategy {sel.campaign_id}</Link>}
              {sel.customer_id && <Link className="text-primary-500 hover:underline" to={`/journeys/${sel.customer_id}`}>Customer journey</Link>}
              {sel.nudge_id && <Link className="text-primary-500 hover:underline" to={`/nudges/${sel.nudge_id}`}>Message {sel.nudge_id}</Link>}
            </div>
            {sel.status === "Resolved" ? (
              <Banner tone="good" title={`Resolved by ${sel.resolved_by}`}>{sel.resolution_note}</Banner>
            ) : can("resolve_violations") ? (
              <Field label="Resolution note" required hint="What was done and how recurrence is prevented. Required to resolve.">
                <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} h-auto py-2`} />
              </Field>
            ) : null}
          </div>
        )}
      </Drawer>
    </>
  );
}
