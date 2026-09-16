import { Link } from "react-router-dom";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { PageHeader } from "../App";
import { Bar, Card, ErrorBox, Loading, SegmentBadge, tooltipStyle } from "../components/ui";
import { api, exactMoney, SEGMENT_BLURB, SEGMENT_COLOR, type Customer } from "../lib/api";
import { useAsync } from "../lib/hooks";

export default function Compare() {
  const { data, error, loading } = useAsync(() => api.personas(), []);
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <Loading what="personas" />;

  const radar = [
    { metric: "Risk", ...Object.fromEntries(data.map((c) => [c.name, c.risk_score])) },
    { metric: "Nudge", ...Object.fromEntries(data.map((c) => [c.name, c.nudge_score])) },
    { metric: "Self-cure", ...Object.fromEntries(data.map((c) => [c.name, c.self_cure_score])) },
    {
      metric: "Utilisation",
      ...Object.fromEntries(data.map((c) => [c.name, c.utilization * 100])),
    },
    {
      metric: "Payment history",
      ...Object.fromEntries(data.map((c) => [c.name, c.payment_history * 100])),
    },
  ];

  const rows: [string, (c: Customer) => React.ReactNode][] = [
    ["Balance", (c) => <span className="font-mono">{exactMoney(c.balance)}</span>],
    ["Tenure", (c) => `${c.tenure_years} years`],
    ["Missed payments", (c) => `${c.missed_payments}`],
    ["Days past due", (c) => `${c.days_past_due}`],
    [
      "Risk score",
      (c) => (
        <div className="flex items-center gap-2">
          <span className="w-8 font-mono text-slate-200">{c.risk_score.toFixed(0)}</span>
          <Bar value={c.risk_score} color="#f43f5e" />
        </div>
      ),
    ],
    [
      "Nudge propensity",
      (c) => (
        <div className="flex items-center gap-2">
          <span className="w-8 font-mono text-slate-200">{c.nudge_score.toFixed(0)}</span>
          <Bar value={c.nudge_score} color="#6366f1" />
        </div>
      ),
    ],
    [
      "Self-cure",
      (c) => (
        <div className="flex items-center gap-2">
          <span className="w-8 font-mono text-slate-200">{c.self_cure_score.toFixed(0)}</span>
          <Bar value={c.self_cure_score} color="#10b981" />
        </div>
      ),
    ],
    ["Segment", (c) => <SegmentBadge segment={c.segment} />],
    ["Treatment", (c) => <span className="font-semibold text-slate-100">{c.treatment}</span>],
    [
      "Outcome",
      (c) => (
        <span
          style={{ color: SEGMENT_COLOR[c.segment] }}
          className="font-semibold"
        >
          {c.outcome}
        </span>
      ),
    ],
  ];

  return (
    <>
      <PageHeader
        eyebrow="Step 07 · The argument"
        title="Persona Comparison"
        blurb="Three customers with comparable risk scores and completely different right answers. This is the case for ARI in one table."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {data.map((c) => (
          <Card key={c.customer_id} className="relative overflow-hidden">
            <div
              className="absolute inset-x-0 top-0 h-[3px]"
              style={{ background: SEGMENT_COLOR[c.segment] }}
            />
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-white">{c.name}</h3>
                <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                  Risk {c.risk_score.toFixed(0)} · Nudge {c.nudge_score.toFixed(0)}
                </p>
              </div>
              <SegmentBadge segment={c.segment} />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">{c.persona_note}</p>
            <p
              className="mt-3 rounded-lg p-2.5 text-xs font-medium"
              style={{
                background: `${SEGMENT_COLOR[c.segment]}12`,
                color: SEGMENT_COLOR[c.segment],
              }}
            >
              {SEGMENT_BLURB[c.segment]}
            </p>
            <Link
              to={`/customer/${c.customer_id}`}
              className="mt-3 block text-center text-[11px] font-semibold text-slate-400 hover:text-brand-400"
            >
              Open Customer 360 →
            </Link>
          </Card>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Side by side">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2.5 font-semibold">Attribute</th>
                  {data.map((c) => (
                    <th key={c.customer_id} className="px-3 py-2.5 font-semibold text-slate-300">
                      {c.name.split(" ")[0]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, render]) => (
                  <tr key={label} className="border-t border-white/5">
                    <td className="px-3 py-2.5 text-slate-400">{label}</td>
                    {data.map((c) => (
                      <td key={c.customer_id} className="px-3 py-2.5 text-slate-200">
                        {render(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="lg:col-span-2" title="Profile shape" subtitle="Same risk band, different shape.">
          <ResponsiveContainer width="100%" height={330}>
            <RadarChart data={radar} outerRadius="72%">
              <PolarGrid stroke="rgba(255,255,255,0.08)" />
              <PolarAngleAxis dataKey="metric" tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <PolarRadiusAxis domain={[0, 100]} tick={{ fill: "#475569", fontSize: 9 }} axisLine={false} />
              <Tooltip {...tooltipStyle} />
              {data.map((c) => (
                <Radar
                  key={c.customer_id}
                  name={c.name.split(" ")[0]}
                  dataKey={c.name}
                  stroke={SEGMENT_COLOR[c.segment]}
                  fill={SEGMENT_COLOR[c.segment]}
                  fillOpacity={0.14}
                  strokeWidth={2}
                />
              ))}
            </RadarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap justify-center gap-3">
            {data.map((c) => (
              <span key={c.customer_id} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: SEGMENT_COLOR[c.segment] }}
                />
                {c.name.split(" ")[0]}
              </span>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-5" title="Why this matters">
        <p className="text-sm leading-relaxed text-slate-300">
          A conventional collections engine sees three high-risk accounts and sends all three the
          same escalating sequence of reminders and calls. ARI sends Priya a{" "}
          <span className="font-semibold text-brand-400">split payment plan</span> because she is
          influenceable and in temporary difficulty, leaves John to a{" "}
          <span className="font-semibold text-emerald-400">single reminder</span> because he
          self-cures, and routes Mike straight to the{" "}
          <span className="font-semibold text-amber-400">hardship team</span> because no nudge
          replaces lost income. Same risk model, three different right answers — that difference is
          the whole product.
        </p>
      </Card>
    </>
  );
}
