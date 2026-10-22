/** The executive dashboard, every role's first screen: accounts handed over,
 *  where they went, what came back, where results differ from plan, and what
 *  needs attention now. */
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { dateOnly, money, num, pct, pp } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { CLIENT_BANK } from "../../ui/brand";
import { BarList, ExperimentBars, SERIES, fmtMoney } from "../../ui/charts";
import {
  Card, Chip, ErrorState, Kpi, MetricInfo, Page, PageHeader, Spinner, StatusChip, Table, Tabs, Td, Th, Tr,
} from "../../ui/ui";

type State = "on_track" | "watch" | "off_track" | null;
interface Group { accounts: number; paying: number; payment_rate: number | null; cure_rate: number | null;
  liquidation_rate: number | null; recovered: number; arrears: number }
interface Data {
  intake: { accounts: number; balance: number; arrears: number; handoffs: number; last_handoff: { at: string; total: number } | null;
    by_product: { product: string; accounts: number; balance: number }[];
    by_bucket: { cohort_id: string; bucket: string; name: string; accounts: number }[] };
  routing: { route: string; label: string; accounts: number; share: number }[];
  pipeline: { in_strategies: number; live_strategies: number; awaiting_review: number; placements_awaiting_approval: number; with_agencies: number };
  recovery: { comparison: { experiment: Group; control: Group; lift: { value: number | null; ci: [number, number] | null; significant: boolean };
      incremental_recoveries: number | null };
    timeline: { period: string; experiment_value: number; control_value: number }[];
    ari_recovered: number; agency_recovered: number; agency_net_recovered: number };
  deviations: {
    strategies: { campaign_id: string; name: string; status: string; target: number; actual: number | null; deviation: number | null; accounts: number; state: State }[];
    buckets: { cohort_id: string; bucket: string; risk_band: string; expected: string; actual_days: number | null; payment_rate: number | null; accounts: number; state: State }[];
    treatments: { code: string; name: string; expected: number | null; actual: number | null; deviation: number | null; accounts: number; state: State }[];
    notes: Record<"strategies" | "buckets" | "treatments", string>;
  };
  exceptions: { kind: string; severity: string; count: number; title: string; detail: string; link: string }[];
}

/** Colour only where something needs attention: on track is plain text. */
function StateCell({ state }: { state: State }) {
  if (state === "watch") return <Chip tone="warn">Watch</Chip>;
  if (state === "off_track") return <Chip tone="bad">Off track</Chip>;
  if (state === "on_track") return <span className="text-xs text-fg-2">On track</span>;
  return <span className="text-xs text-fg-3">No target</span>;
}

const ROUTE_COLOR: Record<string, string> = { strategy: SERIES[0], bau: SERIES[1], hardship: SERIES[2], suppress: SERIES[3] };

function RoutingBar({ rows }: { rows: Data["routing"] }) {
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-sunken">
        {rows.filter((r) => r.share > 0).map((r) => (
          <div key={r.route} title={`${r.label}: ${num(r.accounts)}`} className="h-full border-r-2 border-surface last:border-r-0"
            style={{ width: `${r.share * 100}%`, background: ROUTE_COLOR[r.route] }} />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map((r) => (
          <li key={r.route} className="flex items-start gap-2 text-xs">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: ROUTE_COLOR[r.route] }} />
            <span className="min-w-0"><span className="block text-fg">{r.label}</span>
              <span className="num text-fg-3">{num(r.accounts)} · {pct(r.share, 0)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PipelineStep({ label, value, to, sub }: { label: string; value: number; to?: string; sub?: string }) {
  const body = (
    <>
      <p className="text-xs text-fg-2">{label}</p>
      <p className="num mt-0.5 text-xl font-semibold text-fg">{num(value)}</p>
      {sub && <p className="text-2xs text-fg-3">{sub}</p>}
    </>
  );
  return to
    ? <Link to={to} className="block rounded-md border border-line p-3 transition hover:border-line-strong hover:bg-surface-hover">{body}</Link>
    : <div className="rounded-md border border-line p-3">{body}</div>;
}

type DevTab = "strategies" | "buckets" | "treatments";

export default function Executive() {
  const { me, can } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/executive");
  const [tab, setTab] = useState<DevTab>("strategies");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading the executive dashboard" />;
  const { intake, pipeline: p, recovery: r, deviations: dv } = data;
  const { experiment: e, control: c, lift } = r.comparison;
  const off = dv.strategies.filter((s) => s.state === "off_track").length;
  const watch = dv.strategies.filter((s) => s.state === "watch").length;

  return (
    <>
      <PageHeader title="Executive dashboard"
        subtitle={`${CLIENT_BANK} collections, from the accounts handed over to what has been recovered`}
        meta={intake.last_handoff && <span className="text-xs text-fg-3">
          Last handoff {dateOnly(intake.last_handoff.at)}: {num(intake.last_handoff.total)} accounts · signed in as {me?.user.name}</span>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <Kpi label="Accounts imported" metric="accounts_imported" value={num(intake.accounts)} sub={`${intake.handoffs} handoffs`} />
          <Kpi label="Arrears under management" metric="arrears" value={money(intake.arrears, true)} sub={`${money(intake.balance, true)} total balance`} />
          <Kpi label="Recovered by ARI" metric="recovered" value={money(r.ari_recovered, true)} sub="experiment and control" />
          <Kpi label="Payment rate" metric="payment_rate" value={pct(e.payment_rate)} sub={`control ${pct(c.payment_rate)}`} />
          <Kpi label="Lift over control" metric="lift" value={pp(lift.value)}
            sub={lift.ci ? `${lift.significant ? "Proven" : "Not proven yet"}: ${pp(lift.ci[0], 0)} to ${pp(lift.ci[1], 0)}` : undefined} />
          <Kpi label="Agency net recovered" metric="net_liquidation" value={money(r.agency_net_recovered, true)}
            sub={`${money(r.agency_recovered, true)} before fees`} />
        </div>

        <Card title="Where the accounts are" subtitle="From handoff, through the Propensity Router, to a strategy, a reviewer or an agency">
          <div className="grid gap-6 lg:grid-cols-3">
            <div>
              <p className="label mb-2 flex items-center gap-1">By product</p>
              <BarList rows={intake.by_product.map((x) => ({ label: x.product, value: x.accounts, sub: `${money(x.balance, true)} balance` }))}
                format={(v) => num(v)} />
            </div>
            <div>
              <p className="label mb-2">By delinquency bucket</p>
              <BarList rows={intake.by_bucket.map((x) => ({ label: `${x.bucket} · ${x.name.replace(/^\d+\+? DPD - /, "")}`, value: x.accounts }))}
                format={(v) => num(v)} color={SERIES[1]} />
            </div>
            <div>
              <p className="label mb-2 flex items-center gap-1">Propensity Router <MetricInfo metric="routing_share" /></p>
              <RoutingBar rows={data.routing} />
            </div>
          </div>
          <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 xl:grid-cols-4">
            <PipelineStep label="In ARI strategies" value={p.in_strategies} sub={`${p.live_strategies} live strategies`}
              to={can("view_customer_list") ? "/customers" : undefined} />
            <PipelineStep label="Decisions waiting for review" value={p.awaiting_review} sub="nothing sent until a person decides"
              to={can("override_decisions") ? "/review" : undefined} />
            <PipelineStep label="Agency placements to approve" value={p.placements_awaiting_approval} sub="proposed by ARI" to="/agencies" />
            <PipelineStep label="With collection agencies" value={p.with_agencies} sub="ARI does not contact these" to="/agencies" />
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <Card title="Dollars recovered by week" subtitle="Payments received, experiment against control">
            <ExperimentBars data={r.timeline} experimentKey="experiment_value" controlKey="control_value" format={fmtMoney} />
          </Card>
          <Card title="Experiment against control" subtitle="All strategies, all decisions to date" flush>
            <Table>
              <thead><tr><Th>Measure</Th><Th align="right">Control</Th><Th align="right">Experiment</Th></tr></thead>
              <tbody>
                {([["Accounts", num(c.accounts), num(e.accounts), null],
                  ["Payment rate", pct(c.payment_rate), pct(e.payment_rate), "payment_rate"],
                  ["Cure rate", pct(c.cure_rate), pct(e.cure_rate), "cure_rate"],
                  ["Liquidation rate", pct(c.liquidation_rate), pct(e.liquidation_rate), "liquidation_rate"],
                  ["Dollars recovered", money(c.recovered), money(e.recovered), "recovered"]] as const).map(([l, cv, ev, m]) => (
                  <Tr key={l}>
                    <Td><span className="flex items-center gap-1">{l}{m && <MetricInfo metric={m} />}</span></Td>
                    <Td align="right" className="num">{cv}</Td><Td align="right" className="num font-medium">{ev}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {r.comparison.incremental_recoveries !== null && (
              <p className="border-t border-line px-4 py-2.5 text-xs text-fg-2">
                About <span className="num font-medium text-fg">{num(Math.round(r.comparison.incremental_recoveries))}</span> paying accounts
                would not have paid without the strategies.</p>
            )}
          </Card>
        </div>

        <Card title="Deviation summary" subtitle={dv.notes[tab]} flush
          actions={(off || watch) ? <span className="text-xs text-fg-2">{off} off track · {watch} to watch</span> : undefined}>
          <div className="px-4 pt-1">
            <Tabs<DevTab> active={tab} onChange={setTab} tabs={[
              { id: "strategies", label: "Strategies", count: dv.strategies.length },
              { id: "buckets", label: "Delinquency buckets", count: dv.buckets.length },
              { id: "treatments", label: "Treatments", count: dv.treatments.length },
            ]} />
          </div>
          {tab === "strategies" && (
            <Table>
              <thead><tr><Th>Strategy</Th><Th>Status</Th><Th align="right">Accounts</Th><Th align="right">Target payment rate</Th>
                <Th align="right">Actual</Th><Th align="right">Deviation</Th><Th>State</Th></tr></thead>
              <tbody>{dv.strategies.map((s) => (
                <Tr key={s.campaign_id}>
                  <Td><Link to={`/strategies/${s.campaign_id}`} className="font-medium hover:underline">{s.name}</Link>
                    <span className="block font-mono text-2xs text-fg-3">{s.campaign_id}</span></Td>
                  <Td><StatusChip status={s.status} /></Td>
                  <Td align="right" className="num">{num(s.accounts)}</Td>
                  <Td align="right" className="num">{pct(s.target, 0)}</Td>
                  <Td align="right" className="num">{pct(s.actual)}</Td>
                  <Td align="right" className="num">{pp(s.deviation)}</Td>
                  <Td><StateCell state={s.state} /></Td>
                </Tr>))}</tbody>
            </Table>
          )}
          {tab === "buckets" && (
            <Table>
              <thead><tr><Th>Bucket</Th><Th>Bank risk band</Th><Th align="right">Accounts decided</Th><Th align="right">Payment rate</Th>
                <Th>Expected time to pay</Th><Th align="right">Actual average</Th><Th>State</Th></tr></thead>
              <tbody>{dv.buckets.map((b) => (
                <Tr key={b.cohort_id}>
                  <Td className="font-medium">{b.bucket}</Td><Td className="text-fg-2">{b.risk_band}</Td>
                  <Td align="right" className="num">{num(b.accounts)}</Td>
                  <Td align="right" className="num">{pct(b.payment_rate)}</Td>
                  <Td className="text-fg-2">{b.expected}</Td>
                  <Td align="right" className="num">{b.actual_days !== null ? `${b.actual_days} days` : "—"}</Td>
                  <Td><StateCell state={b.state} /></Td>
                </Tr>))}</tbody>
            </Table>
          )}
          {tab === "treatments" && (
            <Table>
              <thead><tr><Th>Treatment</Th><Th align="right">Accounts</Th><Th align="right">Track record before ARI</Th>
                <Th align="right">Under ARI</Th><Th align="right">Deviation</Th><Th>State</Th></tr></thead>
              <tbody>{dv.treatments.map((t) => (
                <Tr key={t.code}>
                  <Td className="font-medium">{t.name}<span className="ml-1.5 font-mono text-2xs text-fg-3">{t.code}</span></Td>
                  <Td align="right" className="num">{num(t.accounts)}</Td>
                  <Td align="right" className="num">{pct(t.expected)}</Td>
                  <Td align="right" className="num">{pct(t.actual)}</Td>
                  <Td align="right" className="num">{pp(t.deviation)}</Td>
                  <Td><StateCell state={t.state} /></Td>
                </Tr>))}</tbody>
            </Table>
          )}
        </Card>

        <Card title="Exceptions" subtitle="What needs attention now, most serious first" flush>
          {data.exceptions.length ? (
            <ul className="divide-y divide-line">
              {data.exceptions.map((x, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-20 shrink-0 pt-0.5"><StatusChip status={x.severity} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg">{x.title}{x.count > 1 && <span className="num ml-1.5 text-fg-2">({num(x.count)})</span>}</p>
                    <p className="mt-0.5 text-xs leading-5 text-fg-2">{x.detail}</p>
                  </div>
                  <Link to={x.link} className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs font-medium text-primary-500 hover:underline">
                    Open <ArrowRight className="h-3 w-3" /></Link>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-6 text-sm text-fg-3">Nothing needs attention.</p>}
        </Card>
      </Page>
    </>
  );
}
