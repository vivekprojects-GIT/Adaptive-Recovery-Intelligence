import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Dices, RotateCcw, Sparkles, Zap } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "../App";
import { CustomerPicker } from "../components/CustomerPicker";
import { Button, Card, ErrorBox, Loading, Pill, tooltipStyle } from "../components/ui";
import { api, JOURNEY_COLOR, type SimResult } from "../lib/api";
import { useAsync } from "../lib/hooks";

export default function BanditDecision() {
  const id = Number(useParams().id ?? 1);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sims, setSims] = useState<(SimResult & { label: string })[]>([]);

  const { data: c } = useAsync(() => api.customer(id), [id]);
  const { data: rec, error, loading } = useAsync(() => api.recommend(id), [id, nonce]);
  const { data: stats } = useAsync(() => api.journeys(), [nonce]);
  const { data: post } = useAsync(() => api.posterior(), [nonce]);

  async function run(rounds: number) {
    setBusy(true);
    try {
      const r = await api.simulate(rounds);
      setSims((s) => [...s, { ...r, label: `+${rounds}` }]);
      setNonce((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function reset(flat: boolean) {
    setBusy(true);
    try {
      await api.resetBandit(flat);
      setSims([]);
      setNonce((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (loading || !rec || !c) return <Loading what="bandit" />;

  const best = rec.ranking[0];
  const maxScore = Math.max(...rec.ranking.map((r) => r.score));

  return (
    <>
      <PageHeader
        eyebrow="Step 05 · Treatment selection"
        title="Contextual Thompson Sampling"
        blurb="For influenceable customers, ARI draws one sample from each journey's Beta posterior, tilts it by the customer's context, and plays the arm that wins. Exploration and exploitation in a single draw."
        right={<CustomerPicker current={c} basePath="/decision" />}
      />

      {!rec.eligible_for_bandit && (
        <div className="card mb-5 border-amber-500/30 bg-amber-500/[0.06] p-4">
          <p className="text-sm font-semibold text-amber-300">
            {c.name} is a {rec.segment} — the bandit is not the right tool here.
          </p>
          <p className="mt-1 text-xs text-slate-300">{rec.gate_reason}</p>
          <p className="mt-1.5 text-xs text-slate-500">
            The ranking below is shown for transparency, but ARI would not spend an intensive
            treatment on this account.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Journey ranking — this draw"
          subtitle="Beta sample × context multiplier. Re-sample to see the stochastic policy at work."
          action={
            <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
              <span className="flex items-center gap-1.5">
                <Dices className="h-3.5 w-3.5" /> Re-sample
              </span>
            </Button>
          }
        >
          <div className="space-y-3">
            {rec.ranking.map((j, i) => {
              const win = i === 0;
              const color = JOURNEY_COLOR[j.journey_code];
              return (
                <div
                  key={j.journey_id}
                  className={
                    "rounded-xl border p-3 transition-colors " +
                    (win ? "border-brand-500/50 bg-brand-500/[0.08]" : "border-white/8 bg-white/[0.02]")
                  }
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-slate-500">{j.journey_code}</span>
                      <span className="text-sm font-semibold text-slate-100">{j.journey_name}</span>
                      {win && (
                        <Pill tone="brand">
                          <Sparkles className="h-3 w-3" /> selected
                        </Pill>
                      )}
                      {j.context_multiplier !== 1 && (
                        <Pill tone={j.context_multiplier > 1 ? "emerald" : "rose"}>
                          ×{j.context_multiplier.toFixed(2)} context
                        </Pill>
                      )}
                    </div>
                    <span
                      className="font-mono text-lg font-bold"
                      style={{ color: win ? color : "#94a3b8" }}
                    >
                      {j.score.toFixed(3)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.04]">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${(j.score / maxScore) * 100}%`, background: color }}
                    />
                  </div>
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-slate-500">
                    <span>
                      Beta({j.successes + 1}, {j.failures + 1}) → {j.base_sample.toFixed(3)}
                    </span>
                    <span>posterior mean {(j.posterior_mean * 100).toFixed(1)}%</span>
                    <span className="text-slate-600">{j.description}</span>
                  </p>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="space-y-5">
          <div className="card relative overflow-hidden p-6">
            <div className="absolute inset-0 bg-gradient-to-br from-brand-600/20 via-transparent to-emerald-500/10" />
            <div className="relative">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-brand-400" />
                <p className="label text-brand-400">ARI decision</p>
              </div>
              <p className="mt-3 text-3xl font-bold leading-tight tracking-tight text-white">
                {best.journey_name}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Sampled score{" "}
                <span className="font-mono text-slate-200">{best.score.toFixed(3)}</span> · beat{" "}
                {rec.ranking.length - 1} alternatives
              </p>
              <p className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-slate-300">
                {best.description}
              </p>
              <Link
                to={`/journey/${id}`}
                className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
              >
                Run the journey <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          <Card title="Context multipliers" subtitle="How this customer's profile tilts each arm.">
            <ul className="space-y-1.5">
              {Object.entries(rec.context_multipliers).map(([code, m]) => (
                <li key={code} className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">
                    <span className="font-mono text-slate-500">{code}</span>{" "}
                    {rec.ranking.find((r) => r.journey_code === code)?.journey_name}
                  </span>
                  <span
                    className={
                      "font-mono " +
                      (m > 1 ? "text-emerald-400" : m < 1 ? "text-rose-400" : "text-slate-500")
                    }
                  >
                    ×{m.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card
          title="Belief distributions"
          subtitle="Beta posterior over each journey's success rate. Narrow and right means confident and good."
        >
          {post ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={post.data} margin={{ left: -20, right: 10, top: 6 }}>
                <XAxis
                  dataKey="x"
                  stroke="#475569"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip
                  {...tooltipStyle}
                  labelFormatter={(v) => `Success rate ${(Number(v) * 100).toFixed(0)}%`}
                />
                {post.series.map((name, i) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={name}
                    dot={false}
                    strokeWidth={2}
                    stroke={Object.values(JOURNEY_COLOR)[i]}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Loading what="posteriors" />
          )}
          <div className="mt-2 flex flex-wrap gap-3">
            {post?.series.map((name, i) => (
              <span key={name} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: Object.values(JOURNEY_COLOR)[i] }}
                />
                {name}
              </span>
            ))}
          </div>
        </Card>

        <Card
          title="Continuous learning"
          subtitle="Push live outcomes through the feedback loop and watch the beliefs sharpen."
          action={
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => reset(true)} disabled={busy}>
                <span className="flex items-center gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" /> Cold start
                </span>
              </Button>
              <Button variant="ghost" onClick={() => reset(false)} disabled={busy}>
                Restore priors
              </Button>
              <Button onClick={() => run(50)} disabled={busy}>
                Run 50 rounds
              </Button>
            </div>
          }
        >
          <div className="overflow-hidden rounded-xl border border-white/5">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Journey</th>
                  <th className="px-3 py-2.5 font-semibold">Wins</th>
                  <th className="px-3 py-2.5 font-semibold">Losses</th>
                  <th className="px-3 py-2.5 font-semibold">Success rate</th>
                  <th className="px-3 py-2.5 font-semibold">95% interval</th>
                </tr>
              </thead>
              <tbody>
                {stats?.map((s) => (
                  <tr key={s.journey_id} className="border-t border-white/5">
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: JOURNEY_COLOR[s.journey_code] }}
                        />
                        <span className="text-slate-200">{s.journey_name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-emerald-400">{s.successes}</td>
                    <td className="px-3 py-2.5 font-mono text-rose-400">{s.failures}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-200">
                      {(s.posterior_mean * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-500">
                      {(s.ci_low * 100).toFixed(0)}–{(s.ci_high * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sims.length > 0 && (
            <div className="mt-4">
              <p className="label mb-2">Conversion by simulated batch</p>
              <div className="flex flex-wrap gap-2">
                {sims.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"
                  >
                    <p className="font-mono text-slate-500">
                      batch {i + 1} · {s.rounds} accounts
                    </p>
                    <p className="mt-0.5 font-mono text-sm font-bold text-emerald-400">
                      {(s.conversion_rate * 100).toFixed(1)}%
                    </p>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {Object.entries(s.allocation)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => `${k.split(" ")[0]} ${v}`)
                        .join(" · ")}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                From a cold start the bandit spreads traffic across all five journeys, then
                concentrates on Split Payment Plan as evidence accumulates — conversion climbs batch
                over batch without anyone rewriting a rule.
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
