import { RefreshCw } from "lucide-react";

import { dateTime, num, pct } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Banner, Button, Card, ErrorState, Kpi, Page, PageHeader, Spinner, StatusChip } from "../../ui/ui";
import { fmtUptime, type Health } from "./AdminDashboard";

export default function SystemHealth() {
  const { data, error, loading, reload } = useApi<Health>("/admin/health");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const m = data.metrics;
  return (
    <>
      <PageHeader title="System Health" subtitle={`Measured from live requests since ${dateTime(data.started_at)}`}
        actions={<Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reload}>Refresh</Button>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Availability" value={pct(m.availability, 2)} tone={m.availability < 0.999 ? "warn" : "good"} sub={`uptime ${fmtUptime(m.uptime_seconds)}`} />
          <Kpi label="API latency p95" value={`${m.latency_p95_ms} ms`} sub={`p50 ${m.latency_p50_ms} · p99 ${m.latency_p99_ms} ms`} tone={m.latency_p95_ms > 800 ? "warn" : "neutral"} />
          <Kpi label="Requests" value={num(m.requests_total)} sub={`${num(m.requests_last_hour)} in the last hour · ${pct(m.error_rate, 2)} errors`} />
          <Kpi label="Decisions, 24h" value={num(data.decisions_24h)} sub={`${data.decision_latency_ms} ms per decision · ${data.model_version}`} />
        </div>
        <Card title="Components" flush>
          {data.components.map((c) => (
            <div key={c.name} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1"><p className="text-[13px] font-semibold">{c.name}</p><p className="text-xs text-fg-3">{c.detail}</p></div>
              <StatusChip status={c.status} />
            </div>
          ))}
        </Card>
        <Banner tone="neutral">Latency and availability are measured by middleware on every API request in this process. They reset when the service restarts.</Banner>
      </Page>
    </>
  );
}
