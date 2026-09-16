import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader } from "../App";
import { Card, ErrorBox, Loading, Stat, tooltipStyle } from "../components/ui";
import { api, exactMoney, money, SEGMENT_BLURB, SEGMENT_COLOR, type Segment } from "../lib/api";
import { useAsync } from "../lib/hooks";

export default function Dashboard() {
  const { data, error, loading } = useAsync(() => api.dashboard(), []);
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <Loading what="portfolio" />;

  const maxFunnel = data.funnel[0].value;

  return (
    <>
      <PageHeader
        eyebrow="Step 01 · Portfolio view"
        title="Executive Dashboard"
        blurb="Traditional collections identifies risky customers. ARI goes further: it separates the risky customers whose behaviour can actually be changed from those where spend is wasted."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Total customers" value={data.total_customers.toLocaleString()} hint="Delinquent-risk book" accent="sky" />
        <Stat label="High risk" value={data.high_risk.toLocaleString()} hint="Risk score ≥ 50" accent="rose" />
        <Stat label="Persuadables" value={data.persuadables.toLocaleString()} hint="Treatment changes the outcome" accent="brand" />
        <Stat label="Expected recovery" value={money(data.expected_recovery)} hint="Uplift-weighted balance" accent="emerald" />
        <Stat
          label="Projected savings"
          value={money(data.annual_savings)}
          hint={`${data.contacts_avoided} contacts avoided / cycle · ${data.contact_reduction_pct}% less outreach`}
          accent="amber"
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Targeting funnel"
          subtitle="From the whole book down to the accounts where an intervention actually pays for itself."
        >
          <div className="space-y-3">
            {data.funnel.map((f, i) => {
              const pct = (f.value / maxFunnel) * 100;
              const colors = ["#38bdf8", "#f43f5e", "#6366f1", "#8b5cf6", "#10b981"];
              return (
                <div key={f.stage}>
                  <div className="mb-1.5 flex items-baseline justify-between text-xs">
                    <span className="font-medium text-slate-300">{f.stage}</span>
                    <span className="font-mono text-slate-400">
                      {f.value.toLocaleString()}{" "}
                      <span className="text-slate-600">({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  <div className="h-8 w-full overflow-hidden rounded-lg bg-white/[0.04]">
                    <div
                      className="flex h-full items-center rounded-lg pl-3 text-[11px] font-semibold text-white/90 transition-all duration-700"
                      style={{
                        width: `${Math.max(pct, 6)}%`,
                        background: `linear-gradient(90deg, ${colors[i]}dd, ${colors[i]}77)`,
                      }}
                    >
                      {f.value.toLocaleString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-slate-400">
            Only <span className="font-semibold text-brand-400">{data.persuadables}</span> of{" "}
            <span className="font-semibold text-slate-200">{data.high_risk}</span> high-risk accounts
            are worth an intensive treatment. The rest either self-cure or need the hardship team —
            contacting them all costs money and goodwill without moving recovery.
          </p>
        </Card>

        <Card title="Uplift segmentation" subtitle="Nudge propensity × self-cure likelihood.">
          <ResponsiveContainer width="100%" height={190}>
            <PieChart>
              <Pie
                data={data.segments}
                dataKey="count"
                nameKey="segment"
                innerRadius={52}
                outerRadius={82}
                paddingAngle={3}
                stroke="none"
              >
                {data.segments.map((s) => (
                  <Cell key={s.segment} fill={SEGMENT_COLOR[s.segment]} />
                ))}
              </Pie>
              <Tooltip
                {...tooltipStyle}
                formatter={(v, n) => [`${v} customers`, String(n)]}
              />
            </PieChart>
          </ResponsiveContainer>
          <ul className="mt-2 space-y-2.5">
            {data.segments.map((s) => (
              <li key={s.segment} className="flex gap-2.5">
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: SEGMENT_COLOR[s.segment] }}
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-200">
                    {s.segment}{" "}
                    <span className="font-mono font-normal text-slate-500">
                      {s.count} · {money(s.balance)}
                    </span>
                  </p>
                  <p className="text-[11px] leading-snug text-slate-500">
                    {SEGMENT_BLURB[s.segment as Segment]}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Risk score distribution" subtitle="Where the book sits on delinquency risk.">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.risk_distribution} margin={{ left: -18, right: 8, top: 8 }}>
              <XAxis dataKey="band" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {data.risk_distribution.map((_, i) => (
                  <Cell key={i} fill={["#22d3ee", "#38bdf8", "#818cf8", "#fb923c", "#f43f5e"][i]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Outcome mix" subtitle="How the book resolved under ARI-selected treatments.">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.outcomes} layout="vertical" margin={{ left: 34, right: 16 }}>
              <XAxis type="number" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="outcome"
                stroke="#94a3b8"
                fontSize={11}
                width={104}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
              <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                {data.outcomes.map((o, i) => (
                  <Cell
                    key={i}
                    fill={
                      o.outcome === "Recovered"
                        ? "#6366f1"
                        : o.outcome === "Self Recovered"
                          ? "#10b981"
                          : o.outcome === "Assisted Route"
                            ? "#f59e0b"
                            : "#64748b"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card className="mt-5" title="Executive summary">
        <p className="text-sm leading-relaxed text-slate-300">
          Adaptive Recovery Intelligence combines a delinquency <strong className="text-white">Risk Model</strong>, a{" "}
          <strong className="text-white">Nudge Propensity Model</strong> and{" "}
          <strong className="text-white">Contextual Thompson Sampling</strong> to identify accounts
          heading for delinquency, determine which of them will actually respond to intervention, and
          dynamically select the best recovery strategy for each one. On this book that means{" "}
          <span className="font-semibold text-emerald-400">{exactMoney(data.expected_recovery)}</span>{" "}
          of uplift-weighted recovery while cutting outreach by{" "}
          <span className="font-semibold text-amber-400">{data.contact_reduction_pct}%</span> —{" "}
          {exactMoney(data.annual_savings)} of avoided contact cost a year, with a materially better
          customer experience.
        </p>
      </Card>
    </>
  );
}
