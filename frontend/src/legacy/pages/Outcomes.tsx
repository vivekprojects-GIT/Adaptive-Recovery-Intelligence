import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FastForward, Play } from "lucide-react";
import { Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CohortChip, FlowBar } from "../components/flow";
import { Button, Card, ErrorBox, Loading, OpenItem, PageHeader, Stat, tooltipStyle } from "../components/ui";
import { api, pct, STRATEGY_COLOR } from "../lib/api";
import { useFlow } from "../lib/flow";
import { ExpiredExperiment, useExperiment } from "./ExperimentRun";

export default function Outcomes() {
  const expId = useParams().expId!;
  const { flow, update } = useFlow();
  const { exp, setExp, error } = useExperiment(expId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (exp) update({ experimentId: exp.id, cohortId: exp.cohort.cohort_id });
  }, [exp, update]);

  if (error) return error.includes("not found") ? <ExpiredExperiment cohortId={flow.cohortId} /> : <ErrorBox message={error} />;
  if (!exp) return <Loading what="outcomes" />;

  const run = async (count: number) => {
    setBusy(true);
    try {
      setExp(await api.runWaves(exp.id, count));
    } finally {
      setBusy(false);
    }
  };

  const r = exp.results;
  const codes = exp.strategies.map((s) => s.code);
  const nameOf = Object.fromEntries(exp.strategies.map((s) => [s.code, s.name]));
  const rateData = exp.waves.map((w) => ({
    wave: `W${w.wave}`,
    Treatment: w.cum_treatment_rate,
    Control: w.cum_control_rate,
  }));
  const beliefData = [
    { wave: "Start", ...Object.fromEntries(exp.arms.map((a) => [a.name, a.prior_mean])) },
    ...exp.waves.map((w) => ({ wave: `W${w.wave}`, ...Object.fromEntries(codes.map((c) => [nameOf[c], w.beliefs[c]])) })),
  ];
  const sParam = codes.join(",");
  const best = [...exp.arms].filter((a) => a.assigned >= 10).sort((a, b) => (b.pay_rate ?? 0) - (a.pay_rate ?? 0))[0];

  const controls = (
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
  );

  return (
    <>
      <FlowBar current={4} />
      <PageHeader
        eyebrow={`Step 04 · Outcome tracking · experiment ${exp.id}`}
        title="Did it work, and what did the system learn?"
        blurb="Every outcome is compared against the control group, so the difference is the effect of the intervention - not customers who'd have paid anyway."
        right={controls}
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <CohortChip dpd={exp.cohort.dpd_bucket} band={exp.cohort.client_risk_band} expected={exp.cohort.expected_payment} />
        <Link to={`/experiment/${exp.id}`} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to assignment
        </Link>
      </div>

      {exp.progress.waves_run === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <p className="text-sm text-slate-300">No outcomes yet.</p>
            <p className="mt-1 text-xs text-slate-500">Run a wave to start collecting results.</p>
            <div className="mt-4 flex justify-center">{controls}</div>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Treatment pay rate" value={pct(r.treatment_rate)} hint={`${r.treated_paid} of ${exp.progress.treated} paid`} accent="brand" />
            <Stat label="Control pay rate" value={pct(r.control_rate)} hint={`${r.control_paid} of ${exp.progress.control_observed} paid - the baseline`} accent="sky" />
            <Stat
              label="Uplift from intervention"
              value={r.uplift === null ? "—" : `${r.uplift >= 0 ? "+" : ""}${(r.uplift * 100).toFixed(0)} pts`}
              hint="treatment minus control"
              accent="emerald"
            />
            <Stat
              label="Leading strategy"
              value={<span className="text-2xl">{best?.name ?? "—"}</span>}
              hint={best ? `${pct(best.pay_rate)} paid across ${best.assigned} customers` : "needs more data"}
              accent="amber"
            />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card title="Payment rate: treatment vs control" subtitle="Running total after each wave.">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={rateData} margin={{ left: -14, right: 10, top: 6 }}>
                  <XAxis dataKey="wave" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} domain={[0, 1]} tickFormatter={(v: number) => `${v * 100}%`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => pct(Number(v), 1)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="Treatment" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="Control" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card
              title="What the system believes each strategy's success rate is"
              subtitle="Starts from the client's historical record, then moves with every outcome."
            >
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={beliefData} margin={{ left: -14, right: 10, top: 6 }}>
                  <XAxis dataKey="wave" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} domain={[0, 1]} tickFormatter={(v: number) => `${v * 100}%`} />
                  <Tooltip {...tooltipStyle} formatter={(v) => pct(Number(v), 1)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {codes.map((c) => (
                    <Line key={c} type="monotone" dataKey={nameOf[c]} stroke={STRATEGY_COLOR[c]} strokeWidth={2} dot={{ r: 2.5 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card className="mt-5" title="Results by strategy">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Strategy</th>
                    <th className="px-3 py-2.5 font-semibold">Customers</th>
                    <th className="px-3 py-2.5 font-semibold">Paid</th>
                    <th className="px-3 py-2.5 font-semibold">Pay rate</th>
                    <th className="px-3 py-2.5 font-semibold">vs control</th>
                    <th className="px-3 py-2.5 font-semibold">Cost per payment</th>
                    <th className="px-3 py-2.5 font-semibold">Believed success rate</th>
                  </tr>
                </thead>
                <tbody>
                  {exp.arms.map((a) => (
                    <tr key={a.code} className="border-t border-white/5">
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2 font-semibold text-slate-100">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: STRATEGY_COLOR[a.code] }} />
                          {a.name}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-300">{a.assigned}</td>
                      <td className="px-3 py-2.5 font-mono text-slate-300">{a.paid}</td>
                      <td className="px-3 py-2.5 font-mono text-slate-100">{pct(a.pay_rate)}</td>
                      <td className="px-3 py-2.5 font-mono">
                        {a.uplift_vs_control === null ? (
                          <span className="text-slate-600">—</span>
                        ) : (
                          <span className={a.uplift_vs_control >= 0 ? "text-emerald-400" : "text-rose-400"}>
                            {a.uplift_vs_control >= 0 ? "+" : ""}
                            {(a.uplift_vs_control * 100).toFixed(0)} pts
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-400">
                        {a.cost_per_payment === null ? "—" : `$${a.cost_per_payment.toFixed(2)}`}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-400">
                        {pct(a.belief)} <span className="text-slate-600">({pct(a.belief_low)}–{pct(a.belief_high)})</span>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-white/10 bg-white/[0.02]">
                    <td className="px-3 py-2.5 font-semibold text-slate-400">Control (no new intervention)</td>
                    <td className="px-3 py-2.5 font-mono text-slate-400">{exp.progress.control_observed}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-400">{r.control_paid}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-300">{pct(r.control_rate)}</td>
                    <td className="px-3 py-2.5 text-slate-600">baseline</td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5" />
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              With a control group this size, small differences can be noise. Treat early results as a direction, not a verdict.
            </p>
          </Card>

          <Card className="mt-5" title="Customer outcomes" subtitle="Latest 40. Click a customer to see their assignment in detail.">
            <div className="max-h-[320px] overflow-auto rounded-xl border border-white/5">
              <table className="w-full min-w-[560px] text-left text-xs">
                <tbody>
                  {exp.recent_assignments.map((a) => (
                    <tr key={`${a.customer_id}-${a.wave}`} className="border-t border-white/5 first:border-0">
                      <td className="px-3 py-2 font-mono text-slate-500">W{a.wave}</td>
                      <td className="px-3 py-2">
                        <Link to={`/customer/${a.customer_id}/assignment?s=${sParam}`} className="text-slate-100 hover:text-brand-400">
                          {a.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-slate-400">{a.group === "Control" ? "Control" : a.strategy_name}</td>
                      <td className="px-3 py-2">
                        <span className={a.outcome === "Paid" ? "font-semibold text-emerald-400" : "text-slate-500"}>{a.outcome}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <div className="mt-5">
        <OpenItem title="Delayed outcomes - how to credit a payment that arrives days later">
          <p>
            This cohort is expected to pay in <strong className="text-white">{exp.cohort.expected_payment}</strong>. A real
            experiment has to decide how long to wait before calling a result, what to do with customers whose outcome is
            still pending, and when that feeds back into the learning.
          </p>
          <p className="mt-2 text-slate-400">
            The prototype records each wave's outcome immediately so the flow can be demonstrated. That's a
            placeholder, not the proposed design. The approach is still to be agreed.
          </p>
        </OpenItem>
      </div>
    </>
  );
}
