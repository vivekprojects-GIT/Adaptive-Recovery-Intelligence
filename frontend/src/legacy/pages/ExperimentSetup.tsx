import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, FlaskConical, Filter, Shuffle, Target, TrendingUp } from "lucide-react";
import clsx from "clsx";
import { CohortChip, FlowBar } from "../components/flow";
import { Card, ErrorBox, Loading, PageHeader } from "../components/ui";
import { api, STRATEGY_COLOR } from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

export const EXPERIMENT_STEPS = [
  { icon: Filter, title: "Eligible population", body: "Who from the cohort can take part, and who is routed elsewhere" },
  { icon: Shuffle, title: "Sampling & groups", body: "Random control group held back; everyone else is in treatment" },
  { icon: Target, title: "Strategy assignment", body: "Each treatment customer gets one strategy, in waves" },
  { icon: TrendingUp, title: "Outcome tracking", body: "Paid or not, against control - and the system learns" },
];

function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-xl border p-3 text-left transition-colors",
            value === o.value ? "border-brand-500/60 bg-brand-500/10" : "border-white/10 bg-white/[0.02] hover:bg-white/5",
          )}
        >
          <p className="text-xs font-semibold text-slate-100">{o.label}</p>
          {o.hint && <p className="mt-1 text-[11px] leading-snug text-slate-400">{o.hint}</p>}
        </button>
      ))}
    </div>
  );
}

export default function ExperimentSetup() {
  const cohortId = useParams().cohortId ?? "C2";
  const nav = useNavigate();
  const { flow, update } = useFlow();
  const { data: sheet, error, loading } = useAsync(() => api.cohortSheet(cohortId), [cohortId]);
  const [controlPct, setControlPct] = useState(0.2);
  const [mode, setMode] = useState<"adaptive" | "fixed">("adaptive");
  const [includeSure, setIncludeSure] = useState(false);
  const [waveSize, setWaveSize] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (error) return <ErrorBox message={error} />;
  if (loading || !sheet) return <Loading what="setup" />;

  const codes =
    flow.cohortId === cohortId && flow.strategies?.length
      ? flow.strategies
      : sheet.rows.filter((r) => r.status === "Recommended").map((r) => r.code);
  const chosen = sheet.rows.filter((r) => codes.includes(r.code));

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const exp = await api.createExperiment({
        cohort_id: cohortId,
        strategies: codes,
        control_pct: controlPct,
        mode,
        include_segments: includeSure ? ["Persuadable", "Sure Thing"] : ["Persuadable"],
        wave_size: waveSize,
      });
      update({ cohortId, strategies: codes, experimentId: exp.id });
      nav(`/experiment/${exp.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FlowBar current={3} />
      <PageHeader
        eyebrow="Step 03 · Experiment setup"
        title="Turn the selected strategies into an experiment"
        blurb="Instead of rolling one strategy out to everyone, ARI tests the shortlisted strategies against each other and against a control group, and shifts customers toward what works as results come in."
      />
      <div className="mb-5">
        <CohortChip dpd={sheet.dpd_bucket} band={sheet.client_risk_band} expected={sheet.expected_payment} customers={sheet.customers} />
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {EXPERIMENT_STEPS.map(({ icon: Icon, title, body }, i) => (
          <div key={title} className="card p-4">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-brand-500/15 font-mono text-[11px] font-bold text-brand-300">
                {i + 1}
              </span>
              <Icon className="h-4 w-4 text-brand-400" />
              <p className="text-xs font-semibold text-white">{title}</p>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{body}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card
            title="Strategies under test"
            subtitle="From the strategy sheet."
            action={
              <Link to={`/strategies/cohort/${cohortId}`} className="text-xs font-semibold text-brand-400 hover:text-brand-300">
                Change selection
              </Link>
            }
          >
            <div className="flex flex-wrap gap-2">
              {chosen.map((r) => (
                <div key={r.code} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STRATEGY_COLOR[r.code] }} />
                  <span className="text-xs font-semibold text-slate-100">{r.name}</span>
                  <span className="font-mono text-[10px] text-slate-500">{r.eligible_in_target} eligible</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Control group" subtitle="Customers held back at random and given no new intervention. Comparing against them is what proves a strategy caused the payment.">
            <Choice
              value={controlPct}
              onChange={setControlPct}
              options={[
                { value: 0.1, label: "10% held back", hint: "More customers treated, noisier comparison" },
                { value: 0.2, label: "20% held back", hint: "Recommended balance for a cohort this size" },
              ]}
            />
          </Card>

          <Card title="How strategies are assigned">
            <Choice
              value={mode}
              onChange={setMode}
              options={[
                {
                  value: "adaptive",
                  label: "Adaptive (learns as it goes)",
                  hint: "Starts spread out, then sends more customers to whatever is working. Fewer customers get a weak strategy.",
                },
                {
                  value: "fixed",
                  label: "Fixed equal split (classic A/B)",
                  hint: "Every eligible strategy gets the same share until the end. Useful as a benchmark.",
                },
              ]}
            />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Who takes part">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <input
                type="checkbox"
                checked={includeSure}
                onChange={(e) => setIncludeSure(e.target.checked)}
                className="mt-0.5 accent-indigo-500"
              />
              <span>
                <span className="block text-xs font-semibold text-slate-100">Also include "will pay anyway"</span>
                <span className="mt-1 block text-[11px] leading-snug text-slate-400">
                  Off by default. Turn on to show that treating them adds little over control.
                </span>
              </span>
            </label>
          </Card>

          <Card title="Wave size" subtitle="Customers assigned per wave before results feed back.">
            <div className="flex gap-2">
              {[20, 30, 50].map((n) => (
                <button
                  key={n}
                  onClick={() => setWaveSize(n)}
                  className={clsx(
                    "flex-1 rounded-lg border py-2 text-xs font-semibold",
                    waveSize === n ? "border-brand-500/60 bg-brand-500/15 text-white" : "border-white/10 bg-white/5 text-slate-400",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </Card>

          <button
            onClick={create}
            disabled={busy || codes.length === 0}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3.5 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
          >
            <FlaskConical className="h-4 w-4" />
            {busy ? "Creating…" : "Create experiment"}
            <ArrowRight className="h-4 w-4" />
          </button>
          {err && <p className="text-xs text-rose-400">{err}</p>}
        </div>
      </div>
    </>
  );
}
