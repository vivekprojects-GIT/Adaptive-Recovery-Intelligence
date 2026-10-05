import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, MessageSquare, Smartphone, TriangleAlert } from "lucide-react";
import { FlowBar, ScopeToggle } from "../components/flow";
import { Card, ErrorBox, Gauge, Loading, PageHeader, Pill, SegmentBadge } from "../components/ui";
import { api, exactMoney, SEGMENT_BLURB, SEGMENT_COLOR, SEGMENT_PLAIN } from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

export default function CustomerView() {
  const id = Number(useParams().id);
  const { update } = useFlow();
  const { data: c, error, loading } = useAsync(() => api.customer(id), [id]);
  const { data: fit } = useAsync(() => api.fit(id), [id]);

  useEffect(() => {
    if (c) update({ cohortId: c.cohort_id, customerId: c.customer_id });
  }, [c, update]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !c) return <Loading what="customer" />;

  const color = SEGMENT_COLOR[c.segment];
  const clientFacts = [
    ["Days past due", `${c.days_past_due}`],
    ["Client risk band", c.client_risk_band],
    ["Client risk score", c.client_risk_score.toFixed(0)],
    ["Cohort", c.cohort_id],
  ];
  const accountFacts = [
    ["Balance", exactMoney(c.balance)],
    ["Credit limit", exactMoney(c.credit_limit)],
    ["Utilisation", `${(c.utilization * 100).toFixed(0)}%`],
    ["Tenure", `${c.tenure_years} years`],
    ["Missed payments (12m)", `${c.missed_payments}`],
    ["On-time history", `${(c.payment_history * 100).toFixed(0)}%`],
  ];

  return (
    <>
      <FlowBar current={1} />
      <PageHeader
        eyebrow="Step 01 · Customer view"
        title={c.name}
        blurb="The client tells us this customer is in arrears and how risky they are. ARI asks the intervention question: can an intervention change what they do?"
        right={<ScopeToggle scope="customer" cohortHref={`/cohort/${c.cohort_id}`} customerHref={`/customer/${c.customer_id}`} />}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold text-white">{c.name}</p>
                <p className="font-mono text-[11px] text-slate-500">Account #{String(c.customer_id).padStart(6, "0")}</p>
              </div>
              <SegmentBadge segment={c.segment} />
            </div>
            {c.persona_note && (
              <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm leading-relaxed text-slate-300">
                {c.persona_note}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Pill tone={c.sms_responsive ? "emerald" : "slate"}>
                <MessageSquare className="h-3 w-3" /> {c.sms_responsive ? "Responds to SMS" : "Ignores SMS"}
              </Pill>
              <Pill tone={c.app_user ? "emerald" : "slate"}>
                <Smartphone className="h-3 w-3" /> {c.app_user ? "Uses the app" : "No app usage"}
              </Pill>
              <Pill tone={c.hardship_flag ? "amber" : "slate"}>
                <TriangleAlert className="h-3 w-3" />
                {c.hardship_flag ? (c.missed_payments >= 2 ? "Severe hardship" : "Temporary hardship") : "No hardship flag"}
              </Pill>
            </div>
          </Card>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="card border-dashed border-slate-600/70 bg-transparent p-5">
              <p className="label">From the client's systems</p>
              <dl className="mt-3 space-y-2">
                {clientFacts.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="font-mono text-slate-300">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[10px] text-slate-600">Used as provided. ARI does not re-score risk.</p>
            </div>
            <Card>
              <p className="label">Account & behaviour</p>
              <dl className="mt-3 space-y-2">
                {accountFacts.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <dt className="text-slate-400">{k}</dt>
                    <dd className="font-mono text-slate-200">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>

          {fit && (
            <Card
              title={`Why ${fit.nudge_score.toFixed(0)} on influenceability?`}
              subtitle="How much an intervention can change this customer's behaviour, factor by factor."
            >
              <div className="space-y-3">
                {fit.contributions.map((f) => (
                  <div key={f.factor}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-slate-200">{f.factor}</span>
                      <span className="font-mono">
                        <span className={f.points > 0 ? "text-emerald-400" : "text-slate-600"}>
                          +{f.points.toFixed(0)}
                        </span>
                        <span className="text-slate-600"> / {f.max_points}</span>
                      </span>
                    </div>
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/[0.04]">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-white/[0.06]" style={{ width: `${f.max_points}%` }} />
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-600 to-brand-400"
                        style={{ width: `${f.points}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {fit.severity_penalty !== 0 && (
                <p className="mt-3 flex justify-between border-t border-white/10 pt-3 text-xs text-amber-400">
                  <span>Severity discount - {c.missed_payments} missed payments; a nudge can't fix the underlying problem</span>
                  <span className="font-mono">{fit.severity_penalty.toFixed(0)}</span>
                </p>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Intervention fit">
            {fit ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Gauge value={fit.nudge_score} label="Influence" color="#6366f1" caption="can we change it?" />
                  <Gauge value={fit.self_cure_score} label="Self-cure" color="#10b981" caption="pays without help?" />
                </div>
                <div className="mt-3 rounded-xl p-3.5" style={{ background: `${color}12`, border: `1px solid ${color}33` }}>
                  <p className="text-sm font-semibold" style={{ color }}>
                    {SEGMENT_PLAIN[c.segment]}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{SEGMENT_BLURB[c.segment]}</p>
                </div>
              </>
            ) : (
              <Loading what="fit" />
            )}
          </Card>
          <Link
            to={`/strategies/customer/${c.customer_id}`}
            className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-500"
          >
            Strategy sheet for {c.name.split(" ")[0]} <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to={`/cohort/${c.cohort_id}`}
            className="block text-center text-xs text-slate-400 hover:text-brand-400"
          >
            ← Back to the cohort
          </Link>
        </div>
      </div>
    </>
  );
}
