/** Collections performance in industry terms: Control against Experiment,
 *  recoveries over time (volume and value), and treatment effectiveness.
 *  Every figure carries the formula that produced it. */
import { useState } from "react";

import { money, num, pct, pp } from "../../lib/format";
import { useApi } from "../../lib/session";
import { ExperimentBars } from "../../ui/charts";
import { Card, Chip, ErrorState, MetricInfo, Pills, Spinner, Table, Td, Th, Tr } from "../../ui/ui";

interface Group {
  accounts: number; paying: number; cured: number; payment_rate: number | null; cure_rate: number | null;
  arrears: number; recovered: number; liquidation_rate: number | null; avg_days_to_pay: number | null;
  contact_cost: number | null; cost_per_recovery: number | null; cost_to_collect: number | null;
}
interface Lift { value: number | null; ci: [number, number] | null; significant: boolean }
interface Report {
  comparison: { experiment: Group; control: Group; lift: Lift; incremental_recoveries: number | null };
  timeline: { period: string; experiment_volume: number; experiment_value: number; control_volume: number; control_value: number }[];
  treatments: (Group & { code: string; name: string; channel: string; control_payment_rate: number | null; lift: Lift; strategies: string[] })[];
}

const range = (ci: [number, number] | null) => (ci ? `${pp(ci[0], 0)} to ${pp(ci[1], 0)}` : "");

export function PerformancePanel({ campaignId }: { campaignId?: string }) {
  const [period, setPeriod] = useState<"week" | "month">("week");
  const { data, error, loading, reload } = useApi<Report>(
    `/performance?period=${period}${campaignId ? `&campaign_id=${campaignId}` : ""}`, [period, campaignId]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Loading performance" />;
  if (!data) return null;
  const { experiment: e, control: c, lift } = data.comparison;
  const rows: [string, string, string, string, string?][] = [
    ["Accounts", num(c.accounts), num(e.accounts), ""],
    ["Payment rate", pct(c.payment_rate), pct(e.payment_rate),
      lift.value !== null ? `${pp(lift.value)}${lift.ci ? ` (${range(lift.ci)})` : ""}` : "—", "payment_rate"],
    ["Cure rate", pct(c.cure_rate), pct(e.cure_rate),
      c.cure_rate !== null && e.cure_rate !== null ? pp(e.cure_rate - c.cure_rate) : "—", "cure_rate"],
    ["Dollars in arrears", money(c.arrears), money(e.arrears), "", "arrears"],
    ["Dollars recovered", money(c.recovered), money(e.recovered), "", "recovered"],
    ["Liquidation rate", pct(c.liquidation_rate), pct(e.liquidation_rate),
      c.liquidation_rate !== null && e.liquidation_rate !== null ? pp(e.liquidation_rate - c.liquidation_rate) : "—", "liquidation_rate"],
    ["Average days to pay", c.avg_days_to_pay?.toFixed(1) ?? "—", e.avg_days_to_pay?.toFixed(1) ?? "—", "", "avg_days_to_pay"],
    ["Contact cost", "Business as usual", money(e.contact_cost), ""],
    ["Cost per recovery", "—", e.cost_per_recovery !== null ? money(e.cost_per_recovery) : "—", "", "cost_per_recovery"],
    ["Cost to collect", "—", e.cost_to_collect !== null ? `$${e.cost_to_collect.toFixed(3)} per $1` : "—", "", "cost_to_collect"],
  ];
  return (
    <div className="space-y-4">
      <Card title="Control vs Experiment" flush
        subtitle="All decisions to date. Control: customers randomly kept on business as usual. Experiment: customers the strategy treated.">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2.5 text-[13px]">
          <span className="inline-flex items-center gap-1">Lift in payment rate <MetricInfo metric="lift" /> <span className="num font-semibold">{lift.value !== null ? pp(lift.value) : "—"}</span></span>
          {lift.value !== null && (lift.significant
            ? <span className="text-xs text-fg-2">Proven: the 95% range {range(lift.ci)} is above zero</span>
            : <Chip tone="neutral">Not proven yet</Chip>)}
          {data.comparison.incremental_recoveries !== null &&
            <span className="text-xs text-fg-2">≈ <span className="num font-medium text-fg">{data.comparison.incremental_recoveries.toFixed(0)}</span> extra paying accounts</span>}
        </div>
        <Table>
          <thead><tr><Th>Measure</Th><Th align="right">Control</Th><Th align="right">Experiment</Th><Th align="right">Difference</Th></tr></thead>
          <tbody>
            {rows.map(([k, a, b, d, m]) => (
              <Tr key={k}><Td><span className="flex items-center gap-1">{k}{m && <MetricInfo metric={m} />}</span></Td><Td align="right" className="num">{a}</Td><Td align="right" className="num font-medium">{b}</Td><Td align="right" className="num text-fg-2">{d}</Td></Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title="Recoveries over time" subtitle="Payments received in each period, by when they arrived"
        actions={<Pills value={period} onChange={(v) => setPeriod(v)} options={[{ id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }]} />}>
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <p className="label mb-1">Volume: payments received</p>
            <ExperimentBars data={data.timeline} experimentKey="experiment_volume" controlKey="control_volume" format={(v) => num(v ?? 0)} />
          </div>
          <div>
            <p className="label mb-1">Value: dollars recovered</p>
            <ExperimentBars data={data.timeline} experimentKey="experiment_value" controlKey="control_value" format={(v) => money(v ?? 0, true)} />
          </div>
        </div>
        <p className="mt-2 text-2xs leading-4 text-fg-3">The control group is about a fifth of the size of the experiment, so compare rates in the table above, not bar heights.</p>
      </Card>

      <Card title="Treatment effectiveness" flush subtitle="What each treatment's accounts did, what it cost, and its lift over the control groups of the strategies that used it">
        <Table>
          <thead><tr><Th>Treatment</Th><Th align="right">Accounts</Th><Th align="right"><span className="inline-flex items-center gap-1">Payment rate <MetricInfo metric="payment_rate" /></span></Th><Th align="right"><span className="inline-flex items-center gap-1">Cure rate <MetricInfo metric="cure_rate" /></span></Th><Th align="right"><span className="inline-flex items-center gap-1">Recovered <MetricInfo metric="recovered" /></span></Th><Th align="right"><span className="inline-flex items-center gap-1">Cost per recovery <MetricInfo metric="cost_per_recovery" /></span></Th><Th align="right"><span className="inline-flex items-center gap-1">Lift vs control <MetricInfo metric="lift" /></span></Th></tr></thead>
          <tbody>
            {data.treatments.map((t) => (
              <Tr key={t.code}>
                <Td><span className="block font-medium">{t.name}</span><span className="block text-2xs text-fg-3">{t.channel}</span></Td>
                <Td align="right">{num(t.accounts)}</Td>
                <Td align="right">{pct(t.payment_rate)}</Td>
                <Td align="right">{pct(t.cure_rate)}</Td>
                <Td align="right">{money(t.recovered)}</Td>
                <Td align="right">{t.cost_per_recovery !== null ? money(t.cost_per_recovery) : "—"}</Td>
                <Td align="right"><span className="num block">{t.lift.value !== null ? pp(t.lift.value) : "—"}</span>
                  <span className="block text-2xs text-fg-3">{t.lift.value === null ? "" : t.lift.significant ? "proven" : "not proven yet"}</span></Td>
              </Tr>
            ))}
            {!data.treatments.length && <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-fg-3">No treated accounts with results yet.</td></tr>}
          </tbody>
        </Table>
        <div className="px-4 pb-3">
          <p className="mt-2 text-2xs leading-4 text-fg-3">Each treatment reaches the customers it suits best, so its lift is a guide, not a controlled comparison between treatments.</p>
        </div>
      </Card>
    </div>
  );
}
