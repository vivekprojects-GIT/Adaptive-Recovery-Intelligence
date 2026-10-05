import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { CohortChip, FlowBar, ScopeToggle } from "../components/flow";
import { Bar, Card, ErrorBox, Loading, PageHeader, SegmentBadge, Stat } from "../components/ui";
import { api, exactMoney, money, pct, SEGMENT_COLOR, SEGMENT_PLAIN, type Segment } from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

const FILTERS = ["All", "Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"] as const;

export default function CohortView() {
  const cohortId = useParams().cohortId ?? "C2";
  const { flow, update } = useFlow();
  const [filter, setFilter] = useState<string>("All");
  const { data: co, error, loading } = useAsync(() => api.cohort(cohortId), [cohortId]);
  const { data: members } = useAsync(
    () => api.customers({ cohort_id: cohortId, segment: filter, limit: 600 }),
    [cohortId, filter],
  );

  useEffect(() => {
    if (flow.cohortId !== cohortId) update({ cohortId, strategies: null, experimentId: null });
  }, [cohortId, flow.cohortId, update]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !co) return <Loading what="cohort" />;

  const customerHref =
    flow.customerId && members?.some((m) => m.customer_id === flow.customerId)
      ? `/customer/${flow.customerId}`
      : co.personas[0]
        ? `/customer/${co.personas[0].customer_id}`
        : members?.[0]
          ? `/customer/${members[0].customer_id}`
          : null;

  return (
    <>
      <FlowBar current={1} />
      <PageHeader
        eyebrow="Step 01 · Handoff received"
        title={`Cohort: ${co.name}`}
        blurb="The client's systems say these customers are alike. ARI looks one level deeper: who can actually be helped by an intervention, and who can't."
        right={<ScopeToggle scope="cohort" cohortHref={`/cohort/${cohortId}`} customerHref={customerHref} />}
      />
      <div className="mb-5">
        <CohortChip dpd={co.dpd_bucket} band={co.client_risk_band} expected={co.expected_payment} customers={co.customers} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Customers" value={co.customers.toLocaleString()} hint={`${money(co.balance)} total balance`} accent="sky" />
        <Stat label="Avg balance" value={exactMoney(co.profile.avg_balance)} hint={`${co.profile.avg_tenure} yrs average tenure`} accent="brand" />
        <Stat
          label="Reachable digitally"
          value={pct(co.profile.sms_responsive_pct)}
          hint={`respond to SMS · ${pct(co.profile.app_user_pct)} use the app`}
          accent="emerald"
        />
        <Stat label="Hardship flag" value={pct(co.profile.hardship_pct)} hint="on file with the client" accent="amber" />
      </div>

      <Card
        className="mt-5"
        title="Same risk band, different needs"
        subtitle="ARI's intervention-fit scoring splits the cohort by whether an intervention can change the outcome."
      >
        <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full">
          {co.segments.map((s) => (
            <div
              key={s.segment}
              style={{ width: `${(s.count / co.customers) * 100}%`, background: SEGMENT_COLOR[s.segment] }}
              title={`${s.segment}: ${s.count}`}
            />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {co.segments.map((s) => (
            <div
              key={s.segment}
              className="rounded-xl border p-3.5"
              style={{ borderColor: `${SEGMENT_COLOR[s.segment]}40`, background: `${SEGMENT_COLOR[s.segment]}0d` }}
            >
              <div className="flex items-baseline justify-between">
                <p className="text-xs font-semibold" style={{ color: SEGMENT_COLOR[s.segment] }}>
                  {SEGMENT_PLAIN[s.segment]}
                </p>
                <p className="font-mono text-lg font-bold text-white">{s.count}</p>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-slate-500">{s.segment}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{s.action}</p>
            </div>
          ))}
        </div>
      </Card>

      {co.personas.length > 0 && (
        <Card
          className="mt-5"
          title="Three customers from this cohort"
          subtitle="Same DPD bucket, same client risk band. Three different right answers."
        >
          <div className="grid gap-3 lg:grid-cols-3">
            {co.personas.map((p) => (
              <Link
                key={p.customer_id}
                to={`/customer/${p.customer_id}`}
                onClick={() => update({ customerId: p.customer_id })}
                className="group rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-brand-500/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">{p.name}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                      {p.days_past_due} DPD · {p.client_risk_band} risk (client)
                    </p>
                  </div>
                  <SegmentBadge segment={p.segment} />
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-slate-400">{p.persona_note}</p>
                <p className="mt-3 text-[11px] font-semibold text-brand-400 group-hover:text-brand-300">
                  Open customer view →
                </p>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card
        className="mt-5"
        title="Customers in this cohort"
        subtitle={members ? `${members.length} shown` : "Loading…"}
        action={
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={
                  "rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold " +
                  (filter === f
                    ? "border-brand-500/60 bg-brand-500/15 text-white"
                    : "border-white/10 bg-white/5 text-slate-400 hover:text-slate-200")
                }
              >
                {f === "All" ? "All" : SEGMENT_PLAIN[f as Segment]}
              </button>
            ))}
          </div>
        }
      >
        <div className="max-h-[420px] overflow-auto rounded-xl border border-white/5">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="sticky top-0 bg-ink-850/95 text-[10px] uppercase tracking-wider text-slate-500 backdrop-blur">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Customer</th>
                <th className="px-4 py-2.5 font-semibold">Balance</th>
                <th className="px-4 py-2.5 font-semibold">DPD</th>
                <th className="px-4 py-2.5 font-semibold">Client risk</th>
                <th className="w-40 px-4 py-2.5 font-semibold">Influenceability</th>
                <th className="px-4 py-2.5 font-semibold">Intervention fit</th>
              </tr>
            </thead>
            <tbody>
              {members?.map((m) => (
                <tr key={m.customer_id} className="border-t border-white/5 hover:bg-white/[0.03]">
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/customer/${m.customer_id}`}
                      onClick={() => update({ customerId: m.customer_id })}
                      className="font-medium text-slate-100 hover:text-brand-400"
                    >
                      {m.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-400">{exactMoney(m.balance)}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-400">{m.days_past_due}</td>
                  <td className="px-4 py-2.5 text-slate-400">{m.client_risk_band}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-7 font-mono text-slate-300">{m.nudge_score.toFixed(0)}</span>
                      <Bar value={m.nudge_score} color="#6366f1" />
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <SegmentBadge segment={m.segment} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6 flex justify-end">
        <Link
          to={`/strategies/cohort/${cohortId}`}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-500"
        >
          Open the strategy sheet for this cohort <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </>
  );
}
