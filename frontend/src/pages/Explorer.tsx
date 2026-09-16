import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { PageHeader } from "../App";
import { Bar, Card, ErrorBox, Loading, SegmentBadge, tooltipStyle } from "../components/ui";
import { api, exactMoney, SEGMENT_COLOR, type Segment } from "../lib/api";
import { useAsync } from "../lib/hooks";

const SEGMENTS = ["All", "Persuadable", "Sure Thing", "Lost Cause", "Sleeping Dog"] as const;

export default function Explorer() {
  const [segment, setSegment] = useState<string>("All");
  const [search, setSearch] = useState("");
  const { data, error, loading } = useAsync(
    () => api.customers({ segment, search, limit: 400 }),
    [segment, search],
  );

  const scatter = useMemo(
    () =>
      (data ?? []).map((c) => ({
        x: c.self_cure_score,
        y: c.nudge_score,
        z: c.balance,
        name: c.name,
        segment: c.segment,
        id: c.customer_id,
      })),
    [data],
  );

  if (error) return <ErrorBox message={error} />;

  return (
    <>
      <PageHeader
        eyebrow="Step 02 · Population"
        title="Customer Explorer"
        blurb="Every delinquent account scored on two axes: will they fix it themselves, and can we change their behaviour if they won't?"
      />

      <Card
        title="Uplift quadrants"
        subtitle="Self-cure likelihood (x) against nudge propensity (y). The top band is where intervention earns its cost."
        className="mb-5"
      >
        <ResponsiveContainer width="100%" height={330}>
          <ScatterChart margin={{ top: 10, right: 16, bottom: 18, left: -12 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" />
            <ReferenceArea y1={70} y2={100} fill="#6366f1" fillOpacity={0.07} />
            <ReferenceArea x1={55} x2={100} y1={0} y2={70} fill="#10b981" fillOpacity={0.06} />
            <XAxis
              type="number"
              dataKey="x"
              name="Self-cure"
              domain={[0, 100]}
              stroke="#475569"
              fontSize={11}
              tickLine={false}
              label={{ value: "Self-cure likelihood", position: "insideBottom", offset: -10, fill: "#64748b", fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Nudge"
              domain={[0, 100]}
              stroke="#475569"
              fontSize={11}
              tickLine={false}
              label={{ value: "Nudge propensity", angle: -90, position: "insideLeft", offset: 22, fill: "#64748b", fontSize: 11 }}
            />
            <ZAxis type="number" dataKey="z" range={[18, 150]} />
            <Tooltip
              {...tooltipStyle}
              cursor={{ strokeDasharray: "3 3", stroke: "#475569" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload;
                if (!p) return null;
                return (
                  <div className="rounded-xl border border-white/15 bg-ink-900 px-3 py-2 text-xs shadow-xl">
                    <p className="font-semibold text-white">{p.name}</p>
                    <p className="mt-0.5 text-slate-400">
                      Nudge {p.y} · Self-cure {p.x}
                    </p>
                    <p className="text-slate-400">{exactMoney(p.z)} balance</p>
                    <p className="mt-1" style={{ color: SEGMENT_COLOR[p.segment as Segment] }}>
                      {p.segment}
                    </p>
                  </div>
                );
              }}
            />
            <Scatter data={scatter} fillOpacity={0.75}>
              {scatter.map((p) => (
                <Cell key={p.id} fill={SEGMENT_COLOR[p.segment as Segment]} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </Card>

      <Card
        title="Accounts"
        subtitle={loading ? "Loading…" : `${data?.length ?? 0} accounts shown, highest risk first.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name…"
              className="w-40 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-brand-500/50"
            />
            {SEGMENTS.map((s) => (
              <button
                key={s}
                onClick={() => setSegment(s)}
                className={
                  "rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors " +
                  (segment === s
                    ? "border-brand-500/60 bg-brand-500/15 text-white"
                    : "border-white/10 bg-white/5 text-slate-400 hover:text-slate-200")
                }
              >
                {s}
              </button>
            ))}
          </div>
        }
      >
        {loading ? (
          <Loading what="accounts" />
        ) : (
          <div className="max-h-[520px] overflow-auto rounded-xl border border-white/5">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-ink-850/95 backdrop-blur">
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-semibold">Customer</th>
                  <th className="px-4 py-3 font-semibold">Balance</th>
                  <th className="w-40 px-4 py-3 font-semibold">Risk</th>
                  <th className="w-40 px-4 py-3 font-semibold">Nudge</th>
                  <th className="px-4 py-3 font-semibold">Segment</th>
                  <th className="px-4 py-3 font-semibold">Treatment</th>
                  <th className="px-4 py-3 font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((c) => (
                  <tr
                    key={c.customer_id}
                    className="border-t border-white/5 transition-colors hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        to={`/customer/${c.customer_id}`}
                        className="font-medium text-slate-100 hover:text-brand-400"
                      >
                        {c.name}
                      </Link>
                      {c.is_persona && (
                        <span className="ml-2 rounded bg-brand-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-brand-400">
                          persona
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">{exactMoney(c.balance)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-8 font-mono text-slate-300">{c.risk_score.toFixed(0)}</span>
                        <Bar value={c.risk_score} color="#f43f5e" />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-8 font-mono text-slate-300">{c.nudge_score.toFixed(0)}</span>
                        <Bar value={c.nudge_score} color="#6366f1" />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <SegmentBadge segment={c.segment} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{c.treatment}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          c.outcome === "Recovered"
                            ? "text-brand-400"
                            : c.outcome === "Self Recovered"
                              ? "text-emerald-400"
                              : c.outcome === "Assisted Route"
                                ? "text-amber-400"
                                : "text-slate-500"
                        }
                      >
                        {c.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
