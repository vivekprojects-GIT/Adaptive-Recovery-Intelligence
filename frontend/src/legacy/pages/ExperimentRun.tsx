import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, FastForward, Play } from "lucide-react";
import { Bar as RBar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CohortChip, FlowBar } from "../components/flow";
import { Button, Card, ErrorBox, Loading, OpenItem, PageHeader, Pill, SegmentBadge, tooltipStyle } from "../components/ui";
import { api, pct, STRATEGY_COLOR, type Experiment } from "../lib/api";
import { useFlow } from "../lib/flow";

function StepTitle({ n, title, sub }: { n: number; title: string; sub?: string }) {
  return (
    <div className="mb-3 mt-8 flex items-baseline gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-600 font-mono text-xs font-bold text-white">
        {n}
      </span>
      <div>
        <h2 className="text-base font-bold text-white">{title}</h2>
        {sub && <p className="text-xs text-slate-400">{sub}</p>}
      </div>
    </div>
  );
}

export function ExpiredExperiment({ cohortId }: { cohortId: string }) {
  return (
    <div className="card p-6 text-sm">
      <p className="font-semibold text-white">This experiment is no longer available.</p>
      <p className="mt-1 text-slate-400">
        Experiments live in memory, so they reset when the server restarts or goes to sleep. Set it up again - it only
        takes a click.
      </p>
      <Link
        to={`/experiment/new/${cohortId}`}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white"
      >
        Set up a new experiment <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

export function useExperiment(expId: string) {
  const [exp, setExp] = useState<Experiment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { flow, update } = useFlow();
  useEffect(() => {
    let alive = true;
    setExp(null);
    setError(null);
    api
      .experiment(expId)
      .then((e) => alive && setExp(e))
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        // Expired (server restarted) - stop the nav from pointing at it.
        if (e.message.includes("not found") && flow.experimentId === expId) update({ experimentId: null });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expId]);
  return { exp, setExp, error };
}

export default function ExperimentRun() {
  const expId = useParams().expId!;
  const { flow, update } = useFlow();
  const { exp, setExp, error } = useExperiment(expId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (exp) update({ experimentId: exp.id, cohortId: exp.cohort.cohort_id, strategies: exp.strategies.map((s) => s.code) });
  }, [exp, update]);

  if (error) return error.includes("not found") ? <ExpiredExperiment cohortId={flow.cohortId} /> : <ErrorBox message={error} />;
  if (!exp) return <Loading what="experiment" />;

  const run = async (count: number) => {
    setBusy(true);
    try {
      setExp(await api.runWaves(exp.id, count));
    } finally {
      setBusy(false);
    }
  };

  const p = exp.population;
  const codes = exp.strategies.map((s) => s.code);
  const nameOf = Object.fromEntries(exp.strategies.map((s) => [s.code, s.name]));
  const waveData = exp.waves.map((w) => ({ wave: `W${w.wave}`, ...Object.fromEntries(codes.map((c) => [nameOf[c], w.allocation[c] ?? 0])) }));
  const excludedTotal = p.exclusions.reduce((a, e) => a + e.count, 0);
  const sParam = codes.join(",");

  return (
    <>
      <FlowBar current={3} />
      <PageHeader
        eyebrow={`Step 03 · Experiment ${exp.id}`}
        title="Experiment: eligible population → groups → assignment"
        blurb={`${exp.strategies.map((s) => s.name).join(", ")} tested against a ${pct(exp.settings.control_pct)} control group, ${
          exp.settings.mode === "adaptive" ? "with adaptive assignment" : "with a fixed equal split"
        }.`}
        right={
          <Link
            to={`/experiment/new/${exp.cohort.cohort_id}`}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"
          >
            New experiment
          </Link>
        }
      />
      <CohortChip dpd={exp.cohort.dpd_bucket} band={exp.cohort.client_risk_band} expected={exp.cohort.expected_payment} customers={p.total} />

      {/* ---------------------------------------------------------------- 1 */}
      <StepTitle n={1} title="Eligible population" sub="Who from the cohort takes part, and where everyone else goes." />
      <Card>
        <div className="grid items-center gap-4 lg:grid-cols-[1fr_auto_1.6fr_auto_1fr]">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
            <p className="label">Cohort</p>
            <p className="mt-1 font-mono text-3xl font-bold text-white">{p.total}</p>
            <p className="text-[11px] text-slate-500">handed off by client</p>
          </div>
          <ArrowRight className="mx-auto hidden h-5 w-5 text-slate-600 lg:block" />
          <div className="space-y-2">
            <p className="label">Routed outside the experiment · {excludedTotal}</p>
            {p.exclusions.map((e) => (
              <div key={e.reason} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs">
                <span className="text-slate-300">{e.reason}</span>
                <span className="font-mono text-slate-400">{e.count}</span>
              </div>
            ))}
          </div>
          <ArrowRight className="mx-auto hidden h-5 w-5 text-slate-600 lg:block" />
          <div className="rounded-xl border border-brand-500/40 bg-brand-500/10 p-4 text-center">
            <p className="label text-brand-300">Eligible</p>
            <p className="mt-1 font-mono text-3xl font-bold text-white">{p.eligible}</p>
            <p className="text-[11px] text-slate-400">enter the experiment</p>
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- 2 */}
      <StepTitle n={2} title="Sampling & groups" sub="A random slice is held back as control. Nobody chooses who goes where." />
      <Card>
        <div className="flex h-12 w-full overflow-hidden rounded-xl text-xs font-semibold">
          <div
            className="flex items-center justify-center bg-slate-600/60 text-white"
            style={{ width: `${(p.control / Math.max(p.eligible, 1)) * 100}%` }}
          >
            Control {p.control}
          </div>
          <div className="flex flex-1 items-center justify-center bg-brand-600/80 text-white">Treatment {p.treatment}</div>
        </div>
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
          <p className="text-slate-400">
            <strong className="text-slate-200">Control ({p.control})</strong> - no new intervention. Their payment rate is
            the baseline: what would have happened anyway.
          </p>
          <p className="text-slate-400">
            <strong className="text-slate-200">Treatment ({p.treatment})</strong> - each gets one of the selected strategies,
            assigned in {exp.progress.total_waves} waves of up to {exp.settings.wave_size}.
          </p>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- 3 */}
      <StepTitle n={3} title="Strategy assignment" sub="Run the experiment wave by wave. Each wave's results feed into the next wave's assignments." />
      <div className="grid gap-5 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Customers assigned per wave"
          subtitle={
            exp.settings.mode === "adaptive"
              ? "Watch the mix shift toward the strategy that's working."
              : "Fixed split - every strategy keeps its share."
          }
          action={
            <div className="flex gap-2">
              <Button onClick={() => run(1)} disabled={busy || exp.progress.done}>
                <span className="flex items-center gap-1.5">
                  <Play className="h-3.5 w-3.5" /> Run next wave
                </span>
              </Button>
              <Button variant="ghost" onClick={() => run(100)} disabled={busy || exp.progress.done}>
                <span className="flex items-center gap-1.5">
                  <FastForward className="h-3.5 w-3.5" /> Run all
                </span>
              </Button>
            </div>
          }
        >
          <p className="mb-2 font-mono text-[11px] text-slate-500">
            Wave {exp.progress.waves_run} of {exp.progress.total_waves}
            {exp.progress.done && " · complete"}
          </p>
          {exp.waves.length === 0 ? (
            <div className="grid h-[240px] place-items-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
              Press "Run next wave" to assign the first {exp.settings.wave_size} customers.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={waveData} margin={{ left: -20, right: 8, top: 6 }}>
                <XAxis dataKey="wave" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {codes.map((c, i) => (
                  <RBar
                    key={c}
                    dataKey={nameOf[c]}
                    stackId="a"
                    fill={STRATEGY_COLOR[c]}
                    radius={i === codes.length - 1 ? [5, 5, 0, 0] : 0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Assignment so far">
          <div className="space-y-3">
            {exp.arms.map((a) => (
              <div key={a.code}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="flex items-center gap-2 text-slate-200">
                    <span className="h-2 w-2 rounded-full" style={{ background: STRATEGY_COLOR[a.code] }} />
                    {a.name}
                  </span>
                  <span className="font-mono text-slate-400">
                    {a.assigned} <span className="text-slate-600">({pct(a.share)})</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${a.share * 100}%`, background: STRATEGY_COLOR[a.code] }} />
                </div>
                <p className="mt-0.5 text-[10px] text-slate-500">{a.eligible} eligible for this strategy</p>
              </div>
            ))}
          </div>
          <Link
            to={`/experiment/${exp.id}/outcomes`}
            className="mt-5 flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-brand-500"
          >
            Outcome tracking <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>

      <Card className="mt-5" title="Latest assignments" subtitle="Click a customer for the customer-level view of their assignment.">
        {exp.recent_assignments.length === 0 ? (
          <p className="text-xs text-slate-500">No customers assigned yet.</p>
        ) : (
          <div className="max-h-[380px] overflow-auto rounded-xl border border-white/5">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="sticky top-0 bg-ink-850/95 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Wave</th>
                  <th className="px-3 py-2.5 font-semibold">Customer</th>
                  <th className="px-3 py-2.5 font-semibold">Group</th>
                  <th className="px-3 py-2.5 font-semibold">Strategy</th>
                  <th className="px-3 py-2.5 font-semibold">Why</th>
                  <th className="px-3 py-2.5 font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {exp.recent_assignments.map((a) => (
                  <tr key={`${a.customer_id}-${a.wave}`} className="border-t border-white/5">
                    <td className="px-3 py-2 font-mono text-slate-500">W{a.wave}</td>
                    <td className="px-3 py-2">
                      <Link to={`/customer/${a.customer_id}/assignment?s=${sParam}`} className="font-medium text-slate-100 hover:text-brand-400">
                        {a.name}
                      </Link>{" "}
                      <SegmentBadge segment={a.segment} className="ml-1 scale-90" />
                    </td>
                    <td className="px-3 py-2">
                      <Pill tone={a.group === "Control" ? "slate" : "brand"}>{a.group}</Pill>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-slate-200">
                        {a.strategy && <span className="h-2 w-2 rounded-full" style={{ background: STRATEGY_COLOR[a.strategy] }} />}
                        {a.strategy_name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-500">{a.why}</td>
                    <td className="px-3 py-2">
                      <span className={a.outcome === "Paid" ? "font-semibold text-emerald-400" : "text-slate-500"}>{a.outcome}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-5">
        <OpenItem title="When the outcome arrives days later">
          This cohort is expected to pay in {exp.cohort.expected_payment}, so in practice the result of an intervention isn't known
          straight away. For the demo, each wave's outcomes are recorded as soon as the wave runs. How to handle delayed
          outcomes (how long to wait, how to treat results still pending, and when the learning updates) is still being
          designed and isn't final here.
        </OpenItem>
      </div>
    </>
  );
}
