import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, CircleDashed, Dices, Sparkles, X } from "lucide-react";
import clsx from "clsx";
import { FlowBar, ScopeToggle } from "../components/flow";
import { Button, Card, ErrorBox, Loading, OpenItem, PageHeader, SegmentBadge } from "../components/ui";
import { api, SEGMENT_PLAIN, STRATEGY_COLOR } from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

export default function CustomerAssignment() {
  const id = Number(useParams().id);
  const [params] = useSearchParams();
  const { flow } = useFlow();
  const strategies = (params.get("s") ?? flow.strategies?.join(",") ?? "").split(",").filter(Boolean);
  const [nonce, setNonce] = useState(0);

  const { data: c } = useAsync(() => api.customer(id), [id]);
  const { data: pv, error, loading } = useAsync(() => api.assignmentPreview(id, strategies), [id, strategies.join(","), nonce]);
  const { data: live } = useAsync(
    () => (flow.experimentId ? api.experimentCustomer(flow.experimentId, id).catch(() => null) : Promise.resolve(null)),
    [flow.experimentId, id],
  );
  const { data: cohort } = useAsync(() => (c ? api.cohort(c.cohort_id) : Promise.resolve(null)), [c?.cohort_id]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !pv || !c) return <Loading what="assignment" />;

  const first = c.name.split(" ")[0];
  const selected = pv.selected;
  const maxScore = Math.max(0.01, ...pv.ranking.map((r) => r.score));
  const liveState = live?.state;
  // A customer already processed in the live experiment has a real result; show that,
  // and treat the draw on this page as an illustration of how assignment works.
  const settled = liveState === "treated" || (liveState === "control" && !!live?.outcome);

  const assignedStep =
    liveState === "treated"
      ? { title: `Assigned: ${live?.strategy_name}`, body: `Wave ${live?.wave} of the current experiment`, done: true }
      : liveState === "control"
        ? { title: "Held back as control", body: "No new intervention - part of the baseline", done: true }
        : selected
          ? { title: `Would be assigned: ${selected.name}`, body: "Top of the draw below, unless held back as control", done: false }
          : { title: "No test strategy assigned", body: "Follows the fixed route for this group", done: false };

  const timeline = [
    { day: "Day 0", title: "Handoff from client", body: `${c.days_past_due} DPD, ${c.client_risk_band.toLowerCase()} risk - flagged by the client's system`, done: true },
    {
      day: "Day 0",
      title: pv.in_test_population ? "Enters the experiment" : "Routed outside the experiment",
      body: pv.in_test_population ? "Can be helped by an intervention" : pv.gate_reason ?? "",
      done: true,
    },
    { day: "Day 1", ...assignedStep },
    {
      day: cohort ? `Day 1 → ${cohort.expected_payment}` : "Payment window",
      title: "Waiting for the outcome",
      body: "Payment, if it comes, lands days later. How this wait is handled is still being designed.",
      done: false,
      open: true,
    },
    {
      day: "Outcome",
      title: settled ? `Recorded: ${live?.outcome}` : "Paid / not paid recorded",
      body: "Compared against control, then fed back into the strategy's success rate",
      done: settled,
    },
  ];

  return (
    <>
      <FlowBar current={3} />
      <PageHeader
        eyebrow="Step 03 · Experiment · customer view"
        title={`How ${first} is assigned`}
        blurb="The group view shows the experiment across the cohort. This is the same logic applied to one customer."
        right={
          <ScopeToggle
            scope="customer"
            cohortHref={flow.experimentId ? `/experiment/${flow.experimentId}` : `/experiment/new/${c.cohort_id}`}
            customerHref={`/customer/${id}/assignment?s=${strategies.join(",")}`}
          />
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
        <Link to={`/customer/${id}`} className="text-sm font-semibold text-white hover:text-brand-400">
          {c.name}
        </Link>
        <SegmentBadge segment={c.segment} />
        <span className="text-xs text-slate-400">{SEGMENT_PLAIN[c.segment]}</span>
        {liveState && (
          <span className="ml-auto rounded-md border border-brand-500/40 bg-brand-500/10 px-2.5 py-1 text-[11px] text-brand-200">
            In current experiment:{" "}
            <strong className="text-white">
              {liveState === "treated"
                ? `${live?.strategy_name} · wave ${live?.wave} · ${live?.outcome}`
                : liveState === "control"
                  ? `control group${live?.outcome ? ` · ${live.outcome}` : ""}`
                  : liveState === "queued"
                    ? "treatment group, not yet assigned"
                    : "excluded"}
            </strong>
          </span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="1 · Eligible?">
            <div className={clsx("rounded-xl border p-3.5 text-sm", pv.in_test_population ? "border-emerald-500/30 bg-emerald-500/[0.06]" : "border-amber-500/30 bg-amber-500/[0.06]")}>
              <p className={pv.in_test_population ? "font-semibold text-emerald-300" : "font-semibold text-amber-300"}>
                {pv.in_test_population ? `Yes - ${first} can be helped, so enters the experiment` : `No - ${pv.gate_reason}`}
              </p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {pv.eligibility.map((e) => (
                <div key={e.code} className="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-xs">
                  {e.eligible ? <Check className="mt-0.5 h-3.5 w-3.5 text-emerald-400" /> : <X className="mt-0.5 h-3.5 w-3.5 text-rose-400" />}
                  <div>
                    <p className="font-semibold text-slate-200">{e.name}</p>
                    <p className="text-[10px] text-slate-500">{e.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="2 · Group">
            <p className="text-xs leading-relaxed text-slate-300">
              {pv.in_test_population
                ? `Before any strategy is chosen, ${first} has a random chance of being held back as control and receiving no new intervention. Otherwise ${first} is in the treatment group.`
                : `${first} is not part of the experiment, so there's no control/treatment split.`}
            </p>
          </Card>

          <Card
            title="3 · Strategy assignment"
            subtitle="One draw per eligible strategy: past success rate with a little randomness, adjusted for how well it fits this customer. Highest wins."
            action={
              pv.ranking.length > 0 && (
                <Button variant="ghost" onClick={() => setNonce((n) => n + 1)}>
                  <span className="flex items-center gap-1.5">
                    <Dices className="h-3.5 w-3.5" /> Draw again
                  </span>
                </Button>
              )
            }
          >
            {liveState === "treated" && (
              <p className="mb-3 rounded-lg border border-brand-500/30 bg-brand-500/[0.07] p-2.5 text-xs text-slate-300">
                In the current experiment {first} was assigned{" "}
                <strong className="text-white">{live?.strategy_name}</strong> in wave {live?.wave}. The draw below is a
                fresh one, to show how the choice is made. Draw again and the winner can change.
              </p>
            )}
            {pv.ranking.length === 0 ? (
              <p className="text-xs text-slate-500">No eligible strategies among the ones selected.</p>
            ) : (
              <div className="space-y-2.5">
                {pv.ranking.map((r, i) => (
                  <div
                    key={r.code}
                    className={clsx(
                      "rounded-xl border p-3",
                      i === 0 && pv.in_test_population ? "border-brand-500/50 bg-brand-500/[0.08]" : "border-white/10 bg-white/[0.02]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: STRATEGY_COLOR[r.code] }} />
                        {r.name}
                        {i === 0 && pv.in_test_population && (
                          <span className="flex items-center gap-1 rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] text-brand-200">
                            <Sparkles className="h-3 w-3" /> {liveState === "treated" ? "wins this draw" : "assigned"}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-base font-bold" style={{ color: i === 0 ? STRATEGY_COLOR[r.code] : "#94a3b8" }}>
                        {r.score.toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(r.score / maxScore) * 100}%`, background: STRATEGY_COLOR[r.code] }} />
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-500">
                      Past success {(r.belief * 100).toFixed(0)}% · this draw {r.base_sample.toFixed(2)} · fit ×{r.fit.toFixed(2)}
                      {r.fit_reasons.length > 0 && ` - ${r.fit_reasons.join(", ").toLowerCase()}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="4 · Outcome tracking">
            <ol className="relative ml-2 border-l border-white/10 pl-6">
              {timeline.map((t, i) => (
                <li key={i} className="relative pb-5 last:pb-0">
                  <span
                    className={clsx(
                      "absolute -left-[33px] grid h-5 w-5 place-items-center rounded-full border-2",
                      t.open ? "border-dashed border-amber-400 bg-ink-900" : t.done ? "border-brand-500 bg-brand-500/20" : "border-white/20 bg-ink-900",
                    )}
                  >
                    {t.done ? <Check className="h-2.5 w-2.5 text-brand-300" /> : <CircleDashed className="h-2.5 w-2.5 text-slate-500" />}
                  </span>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{t.day}</p>
                  <p className={clsx("text-xs font-semibold", t.open ? "text-amber-300" : "text-slate-100")}>{t.title}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t.body}</p>
                </li>
              ))}
            </ol>
          </Card>
          <OpenItem title="Delayed outcomes">
            The gap between intervention and payment is still an open design question. The prototype doesn't settle it.
          </OpenItem>
          <Link to={`/strategies/customer/${id}`} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-brand-400">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to {first}'s strategy sheet
          </Link>
        </div>
      </div>
    </>
  );
}
