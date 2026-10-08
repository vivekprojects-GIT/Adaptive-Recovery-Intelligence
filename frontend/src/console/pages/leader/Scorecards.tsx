/** Scorecards: is the Propensity Router right about each group, and is Thompson
 *  sampling picking well? Each strategy's own scorecard is on its page. */
import { Link } from "react-router-dom";

import { num, pct, pp } from "../../lib/format";
import { useApi } from "../../lib/session";
import { BarList } from "../../ui/charts";
import { Card, Chip, ErrorState, Page, PageHeader, Spinner, Stat, Table, Td, Th, Tr, type Tone } from "../../ui/ui";

interface Arm { n: number; paid: number; rate: number | null }
interface Group {
  fit_group: string; label: string; route: string; route_label: string; expected: string; customers: number;
  routed: Record<string, number>; treated: Arm; untreated: Arm;
  difference: { value: number | null; ci: [number, number] | null; significant: boolean };
  state: string; verdict: string; treated_from: string | null; untreated_from: string;
}
interface Summary { decisions: number; picked_best: number | null; regret: number | null }
interface Data {
  router: {
    policy: string; validation_share: number; customers: number; groups: Group[];
    calibration: {
      self_cure: { band: string; n: number; paid: number; rate: number | null }[];
    };
    outcomes: { total: number; reported_by_nova: number };
  };
  engine: { available: boolean; overall: Summary; note: string;
    strategies: ({ campaign_id: string; name: string; waves: number; early: Summary; recent: Summary } & Summary)[] };
}

const STATE_TONE: Record<string, Tone> = { Contradicted: "bad", "Not proven yet": "neutral", "Too few results": "neutral" };
/** Payment rate given up: a cost, so no sign. */
const missed = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} pp`);
const range = (ci: [number, number] | null) => (ci ? `${pp(ci[0], 0)} to ${pp(ci[1], 0)}` : "");

export default function Scorecards() {
  const { data, error, loading, reload } = useApi<Data>("/scorecards");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Scoring" />;
  const r = data.router, e = data.engine;
  return (
    <>
      <PageHeader title="Scorecards"
        subtitle="Whether the Propensity Router puts customers in the right groups, and whether Thompson sampling picks the right treatment. Each strategy's own scorecard is on its page." />
      <Page>
        <Card title="Propensity Router" flush
          subtitle={`Does each group behave as the router claims? Treated customers against untreated ones in the same group. Validation share ${pct(r.validation_share, 0)}: that share of Likely self-cure and Needs support customers is treated anyway, so those groups can be checked.`}>
          <Table>
            <thead><tr><Th>Group and route</Th><Th>The router assumes</Th><Th align="right">Treated</Th><Th align="right">Untreated</Th><Th align="right">Difference</Th><Th>Verdict</Th></tr></thead>
            <tbody>
              {r.groups.map((g) => (
                <Tr key={g.fit_group}>
                  <Td><span className="block font-medium">{g.label}</span>
                    <span className="block text-2xs text-fg-3">→ {g.route_label} · {num(g.customers)} customers{g.routed.validation ? ` · ${num(g.routed.validation)} in the validation share` : ""}</span></Td>
                  <Td className="text-xs text-fg-2">{g.expected}</Td>
                  <Td align="right"><span className="num block">{g.treated.n ? pct(g.treated.rate, 0) : "—"}</span>
                    <span className="block text-2xs text-fg-3">{g.treated.n ? `${num(g.treated.n)} from ${g.treated_from}` : "never treated"}</span></Td>
                  <Td align="right"><span className="num block">{g.untreated.n ? pct(g.untreated.rate, 0) : "—"}</span>
                    <span className="block text-2xs text-fg-3">{num(g.untreated.n)} from {g.untreated_from}</span></Td>
                  <Td align="right"><span className="num block">{g.difference.value !== null ? pp(g.difference.value) : "—"}</span>
                    <span className="block text-2xs text-fg-3">{range(g.difference.ci)}</span></Td>
                  <Td><Chip tone={STATE_TONE[g.state] ?? "neutral"}>{g.state}</Chip>
                    <span className="mt-0.5 block max-w-xs text-2xs leading-4 text-fg-3">{g.verdict}</span></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Self-cure score against paying without help"
            subtitle="Untreated customers by self-cure score. If the score works, the payment rate rises from band to band.">
            <BarList rows={r.calibration.self_cure.filter((b) => b.n).map((b) => ({ label: `Score ${b.band}`, value: b.rate ?? 0, sub: `${num(b.n)} customers` }))}
              format={(v) => pct(v ?? 0, 0)} max={1} />
        </Card>

        <Card title="Thompson sampling · offline evaluation" flush subtitle={e.note}>
          {e.available ? (
            <>
              <div className="grid gap-4 border-b border-line px-4 py-3 sm:grid-cols-3">
                <Stat label="Picked the best treatment" value={pct(e.overall.picked_best, 0)} sub={`of ${num(e.overall.decisions)} decisions with a choice`} />
                <Stat label="Average cost of a miss" value={missed(e.overall.regret)}
                  sub="Expected payment rate given up against the best treatment for that customer" />
                <Stat label="Strategies scored" value={num(e.strategies.length)} />
              </div>
              <Table>
                <thead><tr><Th>Strategy</Th><Th align="right">Decisions</Th><Th align="right">Picked best</Th><Th align="right">First 2 waves</Th><Th align="right">Last 2 waves</Th><Th align="right">Average miss</Th></tr></thead>
                <tbody>
                  {e.strategies.map((s) => (
                    <Tr key={s.campaign_id}>
                      <Td><Link to={`/strategies/${s.campaign_id}`} className="font-mono text-2xs text-primary-500 hover:underline">{s.campaign_id}</Link>
                        <span className="block">{s.name}</span></Td>
                      <Td align="right">{num(s.decisions)}</Td>
                      <Td align="right">{pct(s.picked_best, 0)}</Td>
                      <Td align="right">{pct(s.early.picked_best, 0)}</Td>
                      <Td align="right">{s.recent.decisions ? pct(s.recent.picked_best, 0) : <span className="text-fg-3">too few waves</span>}</Td>
                      <Td align="right">{missed(s.regret)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : <p className="px-4 py-6 text-sm text-fg-3">No decisions with more than one allowed treatment yet.</p>}
        </Card>
      </Page>
    </>
  );
}
