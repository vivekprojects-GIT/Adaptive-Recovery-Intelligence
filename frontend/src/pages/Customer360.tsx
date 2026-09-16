import { Link, useParams } from "react-router-dom";
import { ArrowRight, CreditCard, MessageSquare, Smartphone, TriangleAlert } from "lucide-react";
import { PageHeader } from "../App";
import { CustomerPicker } from "../components/CustomerPicker";
import { Bar, Card, ErrorBox, Gauge, Loading, Pill, SegmentBadge } from "../components/ui";
import { api, exactMoney, SEGMENT_BLURB, SEGMENT_COLOR } from "../lib/api";
import { useAsync } from "../lib/hooks";

export default function Customer360() {
  const id = Number(useParams().id ?? 1);
  const { data: c, error, loading } = useAsync(() => api.customer(id), [id]);
  const { data: risk } = useAsync(() => api.risk(id), [id]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !c) return <Loading what="customer" />;

  const facts = [
    { icon: CreditCard, label: "Balance", value: exactMoney(c.balance) },
    { icon: CreditCard, label: "Credit limit", value: exactMoney(c.credit_limit) },
    { icon: CreditCard, label: "Utilisation", value: `${(c.utilization * 100).toFixed(0)}%` },
    { icon: CreditCard, label: "Tenure", value: `${c.tenure_years} years` },
    { icon: TriangleAlert, label: "Days past due", value: `${c.days_past_due}` },
    { icon: TriangleAlert, label: "Missed payments", value: `${c.missed_payments}` },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Step 03 · Single account"
        title="Customer 360"
        blurb="Everything the two models see, and what they conclude."
        right={<CustomerPicker current={c} basePath="/customer" />}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div
                className="grid h-14 w-14 place-items-center rounded-2xl text-lg font-bold text-white"
                style={{ background: `${SEGMENT_COLOR[c.segment]}33`, border: `1px solid ${SEGMENT_COLOR[c.segment]}55` }}
              >
                {c.name.split(" ").map((n) => n[0]).join("")}
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">{c.name}</h2>
                <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                  Account #{String(c.customer_id).padStart(6, "0")}
                </p>
              </div>
            </div>
            <SegmentBadge segment={c.segment} />
          </div>

          {c.persona_note && (
            <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3.5 text-sm leading-relaxed text-slate-300">
              {c.persona_note}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Pill tone={c.sms_responsive ? "emerald" : "slate"}>
              <MessageSquare className="h-3 w-3" /> {c.sms_responsive ? "SMS responsive" : "Ignores SMS"}
            </Pill>
            <Pill tone={c.app_user ? "emerald" : "slate"}>
              <Smartphone className="h-3 w-3" /> {c.app_user ? "Mobile app user" : "No app usage"}
            </Pill>
            <Pill tone={c.hardship_flag ? "amber" : "slate"}>
              <TriangleAlert className="h-3 w-3" />{" "}
              {c.hardship_flag
                ? c.missed_payments >= 2
                  ? "Severe hardship"
                  : "Temporary hardship"
                : "No hardship flag"}
            </Pill>
            <Pill tone={c.payment_history >= 0.8 ? "emerald" : "rose"}>
              {(c.payment_history * 100).toFixed(0)}% on-time history
            </Pill>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {facts.map((f) => (
              <div key={f.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="label">{f.label}</p>
                <p className="mt-1 font-mono text-base font-semibold text-slate-100">{f.value}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Model output">
          <div className="grid grid-cols-2 gap-2">
            <Gauge value={c.risk_score} label="Risk" color="#f43f5e" caption="of rolling forward" />
            <Gauge value={c.nudge_score} label="Nudge" color="#6366f1" caption="influenceability" />
          </div>
          <div className="mt-3">
            <div className="mb-1.5 flex justify-between text-[11px]">
              <span className="text-slate-400">Self-cure likelihood</span>
              <span className="font-mono text-slate-300">{c.self_cure_score.toFixed(0)}</span>
            </div>
            <Bar value={c.self_cure_score} color="#10b981" />
          </div>
          <div
            className="mt-4 rounded-xl p-3.5"
            style={{
              background: `${SEGMENT_COLOR[c.segment]}12`,
              border: `1px solid ${SEGMENT_COLOR[c.segment]}33`,
            }}
          >
            <p className="label" style={{ color: SEGMENT_COLOR[c.segment] }}>
              Verdict
            </p>
            <p className="mt-1.5 text-sm font-semibold text-white">{c.segment}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">{SEGMENT_BLURB[c.segment]}</p>
          </div>
          <Link
            to={`/nudge/${c.customer_id}`}
            className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-2.5 text-xs font-semibold text-brand-300 transition-colors hover:bg-brand-500/20"
          >
            Why this nudge score? <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>

      {risk && (
        <Card
          className="mt-5"
          title="Risk model drivers"
          subtitle={`Logistic scorecard contributions to a ${risk.risk_score}% probability of rolling forward (${risk.band} band).`}
        >
          <div className="space-y-2.5">
            {risk.drivers.map((d) => {
              const width = Math.min(Math.abs(d.contribution) / 3, 1) * 100;
              const up = d.contribution >= 0;
              return (
                <div key={d.feature} className="flex items-center gap-3 text-xs">
                  <span className="w-40 shrink-0 text-slate-300">{d.feature}</span>
                  <div className="flex h-5 flex-1 items-center">
                    <div className="flex w-1/2 justify-end">
                      {!up && (
                        <div
                          className="h-4 rounded-l bg-emerald-500/70"
                          style={{ width: `${width}%` }}
                        />
                      )}
                    </div>
                    <div className="h-4 w-px bg-white/20" />
                    <div className="w-1/2">
                      {up && (
                        <div className="h-4 rounded-r bg-rose-500/70" style={{ width: `${width}%` }} />
                      )}
                    </div>
                  </div>
                  <span
                    className={
                      "w-16 text-right font-mono " + (up ? "text-rose-400" : "text-emerald-400")
                    }
                  >
                    {up ? "+" : ""}
                    {d.contribution.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Values are log-odds contributions. Green reduces delinquency risk, red increases it.
          </p>
        </Card>
      )}
    </>
  );
}
