import { useNavigate } from "react-router-dom";

import { money, num, pct, pp, SEGMENT_LABEL, SEGMENTS } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList, SERIES } from "../../ui/charts";
import { Card, ErrorState, Kpi, Page, PageHeader, Spinner, StatusChip, Table, Td, Th, Tr } from "../../ui/ui";

interface Cohort { cohort_id: string; name: string; dpd_bucket: string; risk_band: string; customers: number; in_strategy: number; arrears: number;
  segments: Record<string, number>; states: Record<string, number>; recovery_rate: number | null; control_rate: number | null; uplift: number | null; recovered: number }
interface Data { cohorts: Cohort[]; pipeline: Record<string, number>; not_in_strategy: number; customers: number }

const ORDER = ["Resolved", "Accepted", "Engaged", "Responding", "In window", "Pending review", "Unresponsive", "Escalated", "Suppressed", "Holdout"];

export default function PortfolioHealth() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/portfolio-health");
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const inStrategy = data.customers - data.not_in_strategy;
  const resolved = (data.pipeline.Resolved ?? 0) + (data.pipeline.Accepted ?? 0);
  return (
    <>
      <PageHeader title="Portfolio Health" subtitle="Where every handed-over account stands" role={me?.user.role_label} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Accounts handed over" value={num(data.customers)} sub={`${data.cohorts.length} cohorts`} />
          <Kpi label="In a strategy" value={num(inStrategy)} sub={`${pct(inStrategy / data.customers, 0)} of the book`} progress={inStrategy / data.customers} />
          <Kpi label="Resolved or on a plan" value={num(resolved)} tone="good" sub={`${pct(resolved / Math.max(1, inStrategy), 0)} of those in a strategy`} />
          <Kpi label="Needing attention" value={num((data.pipeline.Unresponsive ?? 0) + (data.pipeline.Escalated ?? 0))} tone="warn" sub="unresponsive or escalated" />
        </div>
        <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
          <Card title="Pipeline status" subtitle="Latest state of every customer a strategy has decided">
            <BarList rows={ORDER.filter((s) => data.pipeline[s]).map((s, i) => ({ label: s, value: data.pipeline[s], color: SERIES[i % 5] }))}
              format={(v) => num(v ?? 0)} />
          </Card>
          <Card title="Cohorts" flush>
            <Table>
              <thead><tr><Th>Cohort</Th><Th align="right">Accounts</Th><Th align="right">In strategy</Th><Th align="right">Arrears</Th><Th align="right">Treated rate</Th><Th align="right">Control</Th><Th align="right">Uplift</Th><Th align="right">Recovered</Th></tr></thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <Tr key={c.cohort_id} onClick={() => navigate("/customers")}>
                    <Td><span className="font-medium">{c.name}</span><span className="block text-2xs text-fg-3">{c.dpd_bucket} · {c.risk_band} risk</span></Td>
                    <Td align="right">{num(c.customers)}</Td><Td align="right">{num(c.in_strategy)}</Td><Td align="right">{money(c.arrears, true)}</Td>
                    <Td align="right">{pct(c.recovery_rate, 0)}</Td><Td align="right">{pct(c.control_rate, 0)}</Td><Td align="right" className="font-medium">{pp(c.uplift)}</Td>
                    <Td align="right">{money(c.recovered, true)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {data.cohorts.map((c) => (
            <Card key={c.cohort_id} title={c.name} subtitle="Intervention-fit mix and pipeline">
              <BarList rows={SEGMENTS.filter((g) => c.segments[g]).map((g, i) => ({ label: SEGMENT_LABEL[g], value: c.segments[g], color: ["var(--series-1)", "var(--series-3)", "var(--series-4)", "var(--control)"][i] }))}
                format={(v) => num(v ?? 0)} max={c.customers} />
              <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-2.5">
                {Object.entries(c.states).sort((a, b) => b[1] - a[1]).map(([s, n]) => <StatusChip key={s} status={s} label={`${s} ${n}`} />)}
              </div>
            </Card>
          ))}
        </div>
      </Page>
    </>
  );
}
