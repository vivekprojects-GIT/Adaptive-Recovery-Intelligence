import { Link, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "../App";
import { CustomerPicker } from "../components/CustomerPicker";
import { Card, ErrorBox, Gauge, Loading } from "../components/ui";
import { api, SEGMENT_BLURB, SEGMENT_COLOR } from "../lib/api";
import { useAsync } from "../lib/hooks";

const QUADRANTS = [
  { seg: "Persuadable", rule: "Nudge ≥ 70", note: "Treatment changes the outcome" },
  { seg: "Sure Thing", rule: "Nudge < 70 and self-cure ≥ 55", note: "Would pay anyway" },
  { seg: "Lost Cause", rule: "Low self-cure + hardship + 2 or more misses", note: "Cannot pay" },
  { seg: "Sleeping Dog", rule: "Low on both, disengaged", note: "Contact backfires" },
] as const;

export default function NudgeExplain() {
  const id = Number(useParams().id ?? 1);
  const { data: c } = useAsync(() => api.customer(id), [id]);
  const { data: n, error, loading } = useAsync(() => api.nudge(id), [id]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !n || !c) return <Loading what="nudge model" />;

  const subtotal = n.contributions.reduce((a, b) => a + b.points, 0);

  return (
    <>
      <PageHeader
        eyebrow="Step 04 · Explainability"
        title="Nudge Propensity Explanation"
        blurb="Risk tells you who is in trouble. Nudge propensity tells you whose behaviour an intervention can actually change — and every point of it is attributable."
        right={<CustomerPicker current={c} basePath="/nudge" />}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={`Why ${n.nudge_score} for ${n.name}?`}
          subtitle="Weighted feature contributions, each capped at its maximum achievable points."
        >
          <div className="space-y-3.5">
            {n.contributions.map((f) => (
              <div key={f.factor}>
                <div className="mb-1.5 flex items-baseline justify-between text-xs">
                  <span className="font-medium text-slate-200">{f.factor}</span>
                  <span className="font-mono">
                    <span className={f.points > 0 ? "text-emerald-400" : "text-slate-600"}>
                      {f.points > 0 ? "+" : ""}
                      {f.points.toFixed(1)}
                    </span>
                    <span className="text-slate-600"> / {f.max_points}</span>
                  </span>
                </div>
                <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-white/[0.06]"
                    style={{ width: `${f.max_points}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-600 to-brand-400 transition-all duration-700"
                    style={{ width: `${f.points}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 space-y-2 border-t border-white/10 pt-4 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Weighted subtotal</span>
              <span className="font-mono">{subtotal.toFixed(1)}</span>
            </div>
            {n.severity_penalty !== 0 && (
              <div className="flex justify-between text-amber-400">
                <span>
                  Severity discount — {c.missed_payments} missed payments means a nudge cannot fix
                  the underlying problem
                </span>
                <span className="font-mono">{n.severity_penalty.toFixed(1)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-white/10 pt-2 text-sm font-bold text-white">
              <span>Nudge propensity</span>
              <span className="font-mono">{n.nudge_score.toFixed(1)}</span>
            </div>
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <div className="grid grid-cols-2 gap-2">
              <Gauge value={n.nudge_score} label="Nudge" color="#6366f1" />
              <Gauge value={n.self_cure_score} label="Self-cure" color="#10b981" />
            </div>
            <div
              className="mt-2 rounded-xl p-3.5"
              style={{
                background: `${SEGMENT_COLOR[n.segment]}12`,
                border: `1px solid ${SEGMENT_COLOR[n.segment]}33`,
              }}
            >
              <p className="label" style={{ color: SEGMENT_COLOR[n.segment] }}>
                Segment
              </p>
              <p className="mt-1.5 text-sm font-semibold text-white">{n.segment}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {SEGMENT_BLURB[n.segment]}
              </p>
              <p className="mt-2.5 border-t border-white/10 pt-2.5 text-xs text-slate-300">
                <span className="label block mb-1">Next action</span>
                {n.recommended_action}
              </p>
            </div>
            {n.segment === "Persuadable" && (
              <Link
                to={`/decision/${id}`}
                className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-2.5 text-xs font-semibold text-brand-300 transition-colors hover:bg-brand-500/20"
              >
                Select a treatment <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </Card>

          <Card title="Segmentation rule">
            <ul className="space-y-2.5">
              {QUADRANTS.map((q) => (
                <li
                  key={q.seg}
                  className={
                    "rounded-lg border p-2.5 " +
                    (q.seg === n.segment
                      ? "border-brand-500/40 bg-brand-500/10"
                      : "border-white/10 bg-white/[0.02]")
                  }
                >
                  <p className="flex items-center justify-between text-xs font-semibold text-slate-200">
                    {q.seg}
                    <span className="font-mono text-[10px] font-normal text-slate-500">{q.note}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-slate-500">{q.rule}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
