import { AlertTriangle, Download } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { api, type Alert, type WeekPoint } from "../../lib/api";
import { money, num, pct, pp } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { fmtMoney, MetricTrend, RateVsControl, UpliftRow } from "../../ui/charts";
import { ResultCell } from "../../ui/domain";
import { Banner, Button, Card, Chip, ErrorState, Kpi, Page, PageHeader, Progress, Spinner, StatusChip, Table, Td, Th, Tr, useAction } from "../../ui/ui";

interface K { value: number | null; delta?: number | null; target?: number }
interface Data {
  kpis: { recovery_rate: K; recovered: K; cost_per_recovery: K; escalation_rate: K; active_strategies: K; avg_resolution_days: K;
    uplift: { value: number | null; ci: [number, number] | null; mde: number | null; control_rate: number | null; significant: boolean; underpowered: boolean };
    decisions_30d: number; pending_review: number };
  weekly: WeekPoint[];
  segments: { band: string; accounts: number; recovery_rate: number | null; control_rate: number | null; uplift: number | null }[];
  leaderboard: { campaign_id: string; name: string; owner: string; status: string; accounts: number; recovery_rate: number | null; uplift: number | null;
    significant: boolean; underpowered: boolean; last_week_rate: number | null; cost_per_recovery: number | null; target: number }[];
  alerts: Alert[];
}

const d = (v: number | null | undefined, f: (x: number) => string) => (v === null || v === undefined ? null : (v >= 0 ? "▲ " : "▼ ") + f(Math.abs(v)));

export default function KpiDashboard() {
  const { me, can } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/kpis");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading portfolio" />;
  const k = data.kpis;
  const rr = k.recovery_rate.value ?? 0;
  return (
    <>
      <PageHeader title="KPI Dashboard" subtitle={`Portfolio overview · last 30 days · ${me?.user.name}`}
        actions={<>
          {can("export_reports") && <Button variant="primary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === "x"}
            onClick={() => run("x", () => api.download("/reports/portfolio.csv", "ari-portfolio.csv"), "Portfolio report downloaded.")}>Export Report</Button>}
        </>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Kpi label="Portfolio recovery rate (treated)" value={pct(k.recovery_rate.value)} progress={rr / (k.recovery_rate.target || 1)}
            tone={rr < (k.recovery_rate.target ?? 0) ? "warn" : "neutral"} target={pct(k.recovery_rate.target, 0)}
            delta={d(k.recovery_rate.delta, (x) => pp(x).replace(/^[+−]/, ""))} deltaGood={k.recovery_rate.delta === null ? null : (k.recovery_rate.delta ?? 0) >= 0}
            sub="vs prior 14 days" />
          <Kpi label="Total recovered" value={money(k.recovered.value, true)} sub={`${num(k.decisions_30d)} decisions`}
            delta={d(k.recovered.delta, (x) => money(x, true))} deltaGood={k.recovered.delta === null ? null : (k.recovered.delta ?? 0) >= 0} />
          <Kpi label="Contact cost per recovery" value={money(k.cost_per_recovery.value)} target={money(k.cost_per_recovery.target)}
            tone={(k.cost_per_recovery.value ?? 0) > (k.cost_per_recovery.target ?? 99) ? "warn" : "neutral"}
            delta={d(k.cost_per_recovery.delta, (x) => money(x))} deltaGood={k.cost_per_recovery.delta === null ? null : (k.cost_per_recovery.delta ?? 0) <= 0} />
          <Kpi label="Escalation rate" value={pct(k.escalation_rate.value)} target={`< ${pct(k.escalation_rate.target, 0)}`}
            tone={(k.escalation_rate.value ?? 0) > (k.escalation_rate.target ?? 1) ? "bad" : "neutral"}
            delta={d(k.escalation_rate.delta, (x) => pp(x).replace(/^[+−]/, ""))} deltaGood={k.escalation_rate.delta === null ? null : (k.escalation_rate.delta ?? 0) <= 0} />
          <Kpi label="Active strategies" value={k.active_strategies.value} tone="primary"
            delta={k.active_strategies.delta ? `${k.active_strategies.delta > 0 ? "▲" : "▼"} ${Math.abs(k.active_strategies.delta)}` : null}
            deltaGood={null} sub={`${k.pending_review} offers awaiting review`} />
          <Kpi label="Avg days to pay" value={k.avg_resolution_days.value ? `${k.avg_resolution_days.value} days` : "—"} sub="among payers"
            delta={d(k.avg_resolution_days.delta, (x) => `${x.toFixed(1)}d`)} deltaGood={k.avg_resolution_days.delta === null ? null : (k.avg_resolution_days.delta ?? 0) <= 0} />
        </div>

        <Card title="What ARI caused: treated vs control, portfolio-wide" subtitle="Recovery rates include customers who would have paid anyway. The uplift is the part the strategies earned.">
          <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
            <RateVsControl data={data.weekly} target={k.recovery_rate.target} />
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-surface-sunken p-3"><p className="label">Treated</p><p className="num text-xl font-semibold">{pct(k.recovery_rate.value)}</p></div>
                <div className="rounded-lg bg-surface-sunken p-3"><p className="label">Control</p><p className="num text-xl font-semibold">{pct(k.uplift.control_rate)}</p></div>
              </div>
              <div><p className="label mb-1">Uplift over control (95% interval)</p><UpliftRow uplift={k.uplift.value} ci={k.uplift.ci} mde={k.uplift.mde} /></div>
              {k.uplift.underpowered && (k.uplift.significant
                ? <Banner tone="info">Significant, on a modest sample: the interval excludes zero, but effects this small are often overstated at this size. It firms up as cohorts accumulate.</Banner>
                : <Banner tone="warn">Directional only: the lift is smaller than this sample can prove. It firms up as cohorts accumulate.</Banner>)}
            </div>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1fr_1fr_340px]">
          <Card title="Recovered per week"><MetricTrend data={data.weekly as unknown as Record<string, unknown>[]} dataKey="recovered" format={fmtMoney} name="Recovered" /></Card>
          <Card title="Segment performance" subtitle="By the client's risk band">
            <ul className="space-y-3">
              {data.segments.map((s) => (
                <li key={s.band}>
                  <div className="flex items-baseline justify-between text-xs"><span className="font-medium">{s.band} risk</span><span className="num text-fg-2"><span className="font-semibold text-fg">{pct(s.recovery_rate, 0)}</span> · {pp(s.uplift)} vs control</span></div>
                  <Progress value={(s.recovery_rate ?? 0) * 100} tone={s.band === "Low" ? "good" : s.band === "Medium" ? "warn" : "bad"} className="mt-1" />
                  <p className="mt-0.5 text-2xs text-fg-3">{num(s.accounts)} accounts</p>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={<span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-bad" />Alerts</span>}
            actions={<Chip tone={data.alerts.some((a) => a.severity === "Critical") ? "bad" : "warn"}>{data.alerts.length} firing</Chip>}>
            <ul className="space-y-2">
              {data.alerts.slice(0, 6).map((a, i) => (
                <li key={i} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-1.5"><StatusChip status={a.severity} /><span className="truncate text-xs font-medium">{a.name}</span></div>
                  <p className="mt-1 text-2xs leading-4 text-fg-2">{a.message}</p>
                </li>
              ))}
              {!data.alerts.length && <p className="text-xs text-fg-3">No alerts firing.</p>}
            </ul>
          </Card>
        </div>

        <Card title="Strategy leaderboard" subtitle="Ranked by uplift over each strategy's own control group, not by raw recovery rate" flush
          actions={<Link to="/compare" className="text-xs font-medium text-primary-500 hover:underline">Full comparison</Link>}>
          <Table>
            <thead><tr><Th w="40px">#</Th><Th>Strategy</Th><Th>Owner</Th><Th>Status</Th><Th align="right">Accounts</Th><Th>Recovery vs control</Th>
              <Th align="right">Last 7 days</Th><Th align="right">Target</Th><Th align="right">Cost / recovery</Th></tr></thead>
            <tbody>
              {data.leaderboard.map((s, i) => (
                <Tr key={s.campaign_id} onClick={() => navigate(`/strategies/${s.campaign_id}`)}>
                  <Td className="num text-fg-3">{i + 1}</Td>
                  <Td><span className="font-medium">{s.name}</span><span className="block font-mono text-2xs text-fg-3">{s.campaign_id}</span></Td>
                  <Td className="text-fg-2">{s.owner}</Td><Td><StatusChip status={s.status} /></Td><Td align="right">{num(s.accounts)}</Td>
                  <Td><ResultCell rate={s.recovery_rate} uplift={s.uplift} significant={s.significant} underpowered={s.underpowered} /></Td>
                  <Td align="right">{pct(s.last_week_rate, 0)}</Td>
                  <Td align="right" className={s.recovery_rate !== null && s.recovery_rate < s.target ? "text-bad" : ""}>{pct(s.target, 0)}</Td>
                  <Td align="right">{money(s.cost_per_recovery)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </Page>
    </>
  );
}
