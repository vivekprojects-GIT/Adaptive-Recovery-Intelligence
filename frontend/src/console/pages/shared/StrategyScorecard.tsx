/** A strategy's scorecard: what it caused against its own control group, what
 *  each extra recovery cost, and where each treatment's score stands now. */
import type { StrategyScorecard } from "../../lib/api";
import { money, num, pct } from "../../lib/format";
import { Card, Stat, Table, Td, Th, Tr } from "../../ui/ui";

const one = (v: number | null) => (v === null ? "—" : v.toFixed(1));

export function StrategyScorecardCard({ sc }: { sc: StrategyScorecard }) {
  const hasControl = sc.control > 0 && sc.treated > 0;
  return (
    <Card title="Scorecard" subtitle="What this strategy caused, measured against its own control group">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Extra recoveries" value={hasControl ? one(sc.incremental_recoveries) : "—"}
          sub={sc.incremental_range ? `95% range ${one(sc.incremental_range[0])} to ${one(sc.incremental_range[1])}, from ${num(sc.treated)} treated`
            : "Needs treated and control results"} />
        <Stat label="Extra dollars recovered" value={sc.incremental_dollars !== null ? money(sc.incremental_dollars) : "—"}
          sub={sc.incremental_dollars_range
            ? `95% range ${money(sc.incremental_dollars_range[0])} to ${money(sc.incremental_dollars_range[1])}`
            : undefined} />
        <Stat label="Cost per extra recovery" value={sc.cost_per_incremental_recovery !== null ? money(sc.cost_per_incremental_recovery) : "—"}
          sub={sc.cost_per_incremental_recovery === null ? (hasControl ? "No extra recoveries yet to divide by" : undefined)
            : sc.significant ? `Contact cost ${money(sc.contact_cost)}` : "Not proven yet: the range of extra recoveries includes zero"} />
        <Stat label="Return per $1 of contact" value={sc.return_on_contact !== null ? `$${sc.return_on_contact.toFixed(2)}` : "—"}
          sub={sc.return_on_contact === null ? undefined : sc.dollars_proven ? "Extra dollars recovered for each dollar spent on contact"
            : "Not proven yet: the range of extra dollars includes zero"} />
      </div>
      {sc.treatments.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-1.5">Treatment scores now</p>
          <Table>
            <thead><tr><Th>Treatment</Th><Th align="right">Estimated payment rate</Th><Th align="right">Chance it is best</Th><Th align="right">Results learned</Th></tr></thead>
            <tbody>
              {sc.treatments.map((t) => (
                <Tr key={t.code}><Td>{t.name}</Td><Td align="right">{pct(t.mean)}</Td><Td align="right">{pct(t.p_best, 0)}</Td><Td align="right">{num(t.learned)}</Td></Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <p className="mt-3 text-2xs leading-4 text-fg-3">
        Extra means caused by the strategy: treated customers' results minus what the control group shows would have
        happened anyway.{sc.validation_decisions > 0 && ` ${num(sc.validation_decisions)} decisions from the Propensity Router's validation share are left out: they score the router, not this strategy.`}
      </p>
    </Card>
  );
}
