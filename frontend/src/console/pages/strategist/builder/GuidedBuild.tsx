/** Guided build in three steps: who the strategy is for, what it may send, and
 *  a review with the settings most strategists leave at the platform defaults. */
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, type Cohort, type Population, type Strategy, type Treatment } from "../../../lib/api";
import { money, num, pct } from "../../../lib/format";
import { useApi, useSession } from "../../../lib/session";
import {
  Banner,
  Button,
  Card,
  CheckCard,
  Chip,
  Field,
  Kpi,
  Select,
  Spinner,
  StatusChip,
  inputCls,
  useAction,
} from "../../../ui/ui";
import { DONE_AT, STEPS, stepsDone } from "./steps";

type Form = Omit<Strategy, "campaign_id" | "status" | "version" | "source" | "created_at" | "updated_at" | "submitted_at" |
  "approved_at" | "launched_at" | "waves_run" | "owner_id" | "owner" | "created_by" | "approved_by" | "approver" | "channels" | "treatments" |
  "parent_id" | "has_history" | "editable" | "revisable" | "deletable" | "open_revision" | "pool_remaining" | "created">;

interface Defaults { control_pct: number; wave_size: number; evaluation_days: number; contact_hour_start: number; contact_hour_end: number }

const BLANK: Form = {
  name: "", description: "", steps_completed: 0, target_cohorts: [], risk_bands: [],
  min_balance: null, max_balance: null, min_dpd: null, max_dpd: null, treatment_codes: [], cadence_days: 3,
  max_touches: 3, tone: "Supportive", send_window_start: 9, send_window_end: 19, escalate_after_days: 14,
  escalate_to: null, control_pct: 0.2, wave_size: 40, evaluation_days: 7, recovery_target: 0.45,
};

const TONE_PREVIEW: Record<string, string> = {
  Supportive: "Hi Priya, a quick reminder that $146 is past due on your account. You can pay in seconds here: ari.bank/p/3fa1c2. Reply STOP to opt out.",
  Neutral: "Priya, your account has $146 past due. Pay now: ari.bank/p/3fa1c2. Reply STOP to opt out.",
  Direct: "Priya, $146 on your account is now 30 days overdue. Please pay today: ari.bank/p/3fa1c2. Reply STOP to opt out.",
};

const SUBTITLE = [
  "Who this strategy is for. The Propensity Router decides which of these customers a strategy may contact.",
  "What the strategy may send. Thompson sampling learns which of these works for which customer.",
  "Check the audience and the experiment, then submit it for approval.",
];

function numOrNull(v: string) { return v === "" ? null : Number(v); }

/** A section that stays closed until it is needed, with a one-line summary of what is inside. */
function Optional({ title, summary, open: initial, children }: { title: string; summary: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!initial);
  return (
    <div className="rounded-lg border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-hover">
        <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <span className="text-[13px] font-medium text-fg">{title}</span>
        {!open && <span className="ml-auto truncate pl-3 text-2xs text-fg-3">{summary}</span>}
      </button>
      {open && <div className="space-y-4 border-t border-line px-3 py-3">{children}</div>}
    </div>
  );
}

export default function GuidedBuild({ id }: { id?: string }) {
  const navigate = useNavigate();
  const { can } = useSession();
  const { run, busy } = useAction();
  const cohorts = useApi<Cohort[]>("/cohorts").data;
  const treatments = useApi<Treatment[]>("/treatments").data;
  const defaults = useApi<Defaults>("/strategies/defaults").data;
  const [form, setForm] = useState<Form>(BLANK);
  const [meta, setMeta] = useState<Strategy | null>(null);
  const [step, setStep] = useState(0);
  const [est, setEst] = useState<Population | null>(null);
  const [recs, setRecs] = useState<{ recommendations: { kind: string; title: string; body: string; campaign_id?: string }[];
    library: { campaign_id: string; name: string; rate: number | null }[] } | null>(null);

  useEffect(() => {
    if (!id) { setForm(BLANK); setMeta(null); setStep(0); return; }
    api.get<Strategy>(`/strategies/${id}`).then((s) => {
      const f = { ...BLANK } as Record<string, unknown>;
      Object.keys(BLANK).forEach((k) => { f[k] = (s as unknown as Record<string, unknown>)[k]; });
      setForm(f as unknown as Form);
      setMeta(s);
      setStep(Math.min(stepsDone(s.steps_completed), STEPS.length - 1));
    });
  }, [id]);

  // A new strategy starts from the platform's defaults, not from numbers written into the page.
  useEffect(() => {
    if (id || !defaults) return;
    setForm((f) => f.steps_completed ? f : {
      ...f, control_pct: defaults.control_pct, wave_size: defaults.wave_size, evaluation_days: defaults.evaluation_days,
      send_window_start: Math.max(f.send_window_start, defaults.contact_hour_start),
      send_window_end: Math.min(f.send_window_end, defaults.contact_hour_end),
    });
  }, [id, defaults]);

  const estimateQuery = useMemo(() => {
    const p = new URLSearchParams({
      cohorts: form.target_cohorts.join(","), risk_bands: form.risk_bands.join(","),
      treatments: form.treatment_codes.join(","),
    });
    (["min_balance", "max_balance", "min_dpd", "max_dpd"] as const).forEach((k) => form[k] !== null && p.set(k, String(form[k])));
    return p.toString();
  }, [form]);

  useEffect(() => {
    if (!form.target_cohorts.length) { setEst(null); return; }
    const t = setTimeout(() => api.get<Population>(`/strategies/estimate?${estimateQuery}`).then(setEst).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [estimateQuery, form.target_cohorts.length]);

  // Recommendations follow the cohorts on the form, saved or not.
  const recsQuery = useMemo(() => new URLSearchParams({ cohorts: form.target_cohorts.join(","), editing: id ?? "" }).toString(),
    [form.target_cohorts, id]);
  useEffect(() => {
    if (!form.target_cohorts.length) { setRecs(null); return; }
    let stale = false;
    const t = setTimeout(() => api.get<NonNullable<typeof recs>>(`/strategies/recommendations?${recsQuery}`)
      .then((r) => { if (!stale) setRecs(r); }).catch(() => { if (!stale) setRecs(null); }), 250);
    return () => { stale = true; clearTimeout(t); };
  }, [recsQuery, form.target_cohorts.length]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: "target_cohorts" | "risk_bands" | "treatment_codes", v: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  const save = useCallback(async (stored: number) => {
    const body = { ...form, steps_completed: Math.max(form.steps_completed, stored) };
    const r = await run("save", () => meta ? api.put<Strategy>(`/strategies/${meta.campaign_id}`, body) : api.post<Strategy>("/strategies", body),
      (s) => s.reapproval_required ? `Saved ${s.campaign_id}. A material change sent it back to Draft (v${s.version}) for re-approval.` : `Saved ${s.campaign_id}.`);
    if (r) {
      setMeta(r);
      setForm((f) => ({ ...f, steps_completed: r.steps_completed }));
      if (!meta) navigate(`/builder/${r.campaign_id}`, { replace: true });
      return r;
    }
  }, [form, meta, navigate, run]);

  if (!cohorts || !treatments) return <Spinner />;
  const editable = !meta || meta.editable;
  const offered = treatments.filter((t) => t.status === "Active" || form.treatment_codes.includes(t.code));
  const revise = () => meta && run("revise", () => api.post<Strategy>(`/strategies/${meta.campaign_id}/revise`),
    (r) => r.created ? `Opened ${r.campaign_id} as v${r.version} of ${meta.campaign_id}.` : `Continuing ${r.campaign_id}.`)
    .then((r) => r && navigate(`/builder/${r.campaign_id}`));
  const mde = est && est.control > 0 ? (2.8 * Math.sqrt(2 * 0.3 * 0.7 / Math.max(1, Math.min(est.control, est.treatment)))) : null;
  const done = stepsDone(form.steps_completed);
  const name = (code: string) => treatments.find((t) => t.code === code)?.name ?? code;

  const limits = [
    form.min_balance !== null || form.max_balance !== null
      ? `balance ${form.min_balance !== null ? money(form.min_balance) : "any"}–${form.max_balance !== null ? money(form.max_balance) : "any"}` : null,
    form.min_dpd !== null || form.max_dpd !== null ? `${form.min_dpd ?? 0}–${form.max_dpd ?? "any"} days past due` : null,
    form.risk_bands.length ? `${form.risk_bands.join(", ")} risk` : null,
  ].filter(Boolean).join(" · ");
  const rhythm = `Every ${form.cadence_days} days, up to ${form.max_touches} touches, ${form.tone.toLowerCase()} tone, ${form.send_window_start}:00–${form.send_window_end}:00`;
  const experiment = `${pct(form.control_pct, 0)} control, waves of ${form.wave_size}, ${form.evaluation_days}-day window, target ${pct(form.recovery_target, 0)}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)_280px]">
      {/* step rail */}
      <div className="space-y-1">
        <p className="label px-2 pb-1">Steps</p>
        {STEPS.map((s, i) => (
          <button key={s} onClick={() => setStep(i)} className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]",
            step === i ? "bg-primary-50 font-medium text-primary-600" : "text-fg-2 hover:bg-surface-hover")}>
            <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold",
              i < done ? "bg-good text-white" : step === i ? "bg-primary-500 text-white" : "bg-surface-sunken text-fg-3 ring-1 ring-line")}>
              {i < done ? <Check className="h-3 w-3" /> : i + 1}
            </span>{s}
          </button>
        ))}
        {meta && <div className="mt-3 space-y-1 px-1"><StatusChip status={meta.status} /><p className="font-mono text-2xs text-fg-3">{meta.campaign_id} · v{meta.version}</p></div>}
      </div>

      {/* step body */}
      <Card title={STEPS[step]} subtitle={SUBTITLE[step]}
        footer={<div className="flex items-center justify-between">
          <Button variant="ghost" disabled={step === 0} icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => setStep((s) => s - 1)}>Back</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={!editable || !form.name.trim()} loading={busy === "save"}
              onClick={async () => { if (await save(DONE_AT[step])) setStep((s) => s + 1); }}>Save & continue <ArrowRight className="h-3.5 w-3.5" /></Button>
          ) : (
            <div className="flex gap-2">
              <Button disabled={!editable || !form.name.trim()} loading={busy === "save"} onClick={() => save(DONE_AT[1])}>Save draft</Button>
              <Button variant="primary" disabled={!editable || !form.name.trim() || (meta !== null && meta.status !== "Draft")} loading={busy === "submit"}
                onClick={async () => {
                  const s = await save(DONE_AT[2]);
                  if (s && (await run("submit", () => api.post(`/strategies/${s.campaign_id}/submit`), `${s.campaign_id} submitted. A strategy leader approves it before launch.`)))
                    navigate(`/strategies/${s.campaign_id}`);
                }}>Submit for approval</Button>
            </div>
          )}
        </div>}>
        {meta && !editable && (
          <div className="mb-3">
            {meta.revisable ? (
              <Banner tone="info" title={`${meta.campaign_id} is ${meta.status.toLowerCase()} and has already decided customers`}
                action={<Button size="sm" variant="primary" loading={busy === "revise"} onClick={revise}>
                  {meta.open_revision ? `Open v${meta.version + 1} draft` : `Edit as v${meta.version + 1}`}</Button>}>
                It is not changed in place. Your changes go into a new version, and this one keeps running as approved until the new version is launched.
              </Banner>
            ) : (
              <Banner tone="warn">This strategy is {meta.status.toLowerCase()}. {meta.status === "Archived" ? "Clone it to reuse its settings."
                : meta.status === "Live" ? "Pause it to make changes; changes to its audience, treatments or experiment go back for approval."
                : "It cannot be changed."}</Banner>
            )}
          </div>
        )}
        {meta && editable && meta.parent_id && (
          <div className="mb-3">
            <Banner tone="info" title={`Version ${meta.version} of ${meta.parent_id}`}>
              When this version is approved and launched it replaces {meta.parent_id}, which is then archived. Customers already in {meta.parent_id} stay with it; this version gets its own control group.
            </Banner>
          </div>
        )}
        {meta && editable && ["Approved", "In review", "Paused"].includes(meta.status) ? (
          <div className="mb-3"><Banner tone="info">Changing the audience, treatments, control share or escalation sends this strategy back to Draft for re-approval.</Banner></div>
        ) : null}

        {step === 0 && (
          <div className="space-y-4">
            <Field label="Strategy name" required><input id="strategy-name" className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Medium-Risk Payment Plan Flow" /></Field>
            <Field label="Description"><textarea id="strategy-description" rows={2} className={`${inputCls} h-auto py-2`} value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="Target cohorts" hint="Handed over by the client's collections system. ARI does not re-segment them.">
              <div className="grid gap-2 sm:grid-cols-2">
                {cohorts.map((c) => (
                  <CheckCard key={c.cohort_id} checked={form.target_cohorts.includes(c.cohort_id)} onChange={() => toggle("target_cohorts", c.cohort_id)}
                    title={c.name} sub={`${c.dpd_bucket} · ${c.risk_band} risk · ${num(c.customers)} customers`} />
                ))}
              </div>
            </Field>
            <Optional title="Narrow the audience (optional)" summary={limits || "All balances, days past due and risk bands"} open={!!limits}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Minimum balance ($)"><input id="min-balance" type="number" className={inputCls} value={form.min_balance ?? ""} onChange={(e) => set("min_balance", numOrNull(e.target.value))} placeholder="No floor" /></Field>
                <Field label="Maximum balance ($)"><input id="max-balance" type="number" className={inputCls} value={form.max_balance ?? ""} onChange={(e) => set("max_balance", numOrNull(e.target.value))} placeholder="No ceiling" /></Field>
                <Field label="Minimum days past due"><input id="min-dpd" type="number" className={inputCls} value={form.min_dpd ?? ""} onChange={(e) => set("min_dpd", numOrNull(e.target.value))} placeholder="Any" /></Field>
                <Field label="Maximum days past due"><input id="max-dpd" type="number" className={inputCls} value={form.max_dpd ?? ""} onChange={(e) => set("max_dpd", numOrNull(e.target.value))} placeholder="Any" /></Field>
              </div>
              <Field label="Client risk bands" hint="From the client's risk model. Leave empty to accept every band in the cohorts.">
                <div className="flex flex-wrap gap-2">
                  {["Low", "Medium", "High", "Very high"].map((b) => (
                    <button key={b} type="button" onClick={() => toggle("risk_bands", b)} className={clsx("h-8 rounded-lg border px-3 text-[13px]",
                      form.risk_bands.includes(b) ? "border-primary-500 bg-primary-50 font-medium text-primary-600" : "border-line-strong text-fg-2 hover:bg-surface-hover")}>{b}</button>
                  ))}
                </div>
              </Field>
            </Optional>
            <p className="text-2xs leading-4 text-fg-3">
              Consent, opt-outs, contact caps and vulnerability are platform rules, checked before any treatment is chosen and again before every send.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              {offered.map((t) => (
                <CheckCard key={t.code} checked={form.treatment_codes.includes(t.code)} onChange={() => toggle("treatment_codes", t.code)}
                  title={<span className="flex flex-wrap items-center gap-1.5">{t.name}<Chip tone="info">{t.channel}</Chip>
                    {t.human_review && <Chip tone="warn">human approval</Chip>}
                    {t.historical_n === 0 && <Chip tone="info">new</Chip>}
                    {t.status === "Retired" && <Chip tone="bad">retired: remove before submitting</Chip>}</span>}
                  sub={<>{t.offer} · Eligible when: {t.eligibility_rule} · {money(t.cost)} per contact · {t.historical_n
                    ? <>historical raw rate {pct(t.historical_rate, 0)} (includes self-cure)</>
                    : <>no track record yet, so the bandit explores it from a flat prior</>}</>}
                  right={est ? <span className="num whitespace-nowrap text-2xs text-fg-3">{num(est.arm_eligibility[t.code] ?? 0)} eligible</span> : undefined} />
              ))}
            </div>
            {can("manage_treatments") && (
              <Link to="/treatments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-500 hover:underline">
                Add or edit treatments in the playbook <ArrowRight className="h-3 w-3" /></Link>
            )}
            <Optional title="If nothing works (optional)" open={!!form.escalate_to}
              summary={form.escalate_to ? `${name(form.escalate_to)} after ${form.escalate_after_days} days with no payment` : "No escalation"}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Escalate to">
                  <Select value={form.escalate_to ?? ""} onChange={(v) => set("escalate_to", v || null)}
                    options={[{ value: "", label: "No escalation" }, ...treatments.filter((t) => t.status === "Active" || t.code === form.escalate_to)
                      .map((t) => ({ value: t.code, label: `${t.name} (${t.channel})${t.status === "Retired" ? " - retired" : ""}` }))]} />
                </Field>
                <Field label="After (days with no payment)"><input id="escalate-after" type="number" min={1} disabled={!form.escalate_to} className={inputCls} value={form.escalate_after_days} onChange={(e) => set("escalate_after_days", Number(e.target.value))} /></Field>
              </div>
              <p className="text-2xs leading-4 text-fg-3">Escalations count toward contact limits and cost. Many digital payers settle in the second week, so escalating early often pays for calls that were not needed.</p>
            </Optional>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="rounded-lg border border-line">
              <dl className="divide-y divide-line text-[13px]">
                {[
                  ["Audience", `${form.target_cohorts.map((c) => cohorts.find((x) => x.cohort_id === c)?.name).join(", ") || "No cohort picked"}${limits ? ` · ${limits}` : ""}`],
                  ["Who it contacts", "Likely responsive customers, sent by the Propensity Router"],
                  ["Treatments", form.treatment_codes.map(name).join(", ") || "None picked"],
                  ["If nothing works", form.escalate_to ? `${name(form.escalate_to)} after ${form.escalate_after_days} days` : "No escalation"],
                ].map(([k, v]) => <div key={k} className="flex gap-4 px-3 py-2"><dt className="w-32 shrink-0 text-fg-3">{k}</dt><dd className="min-w-0 text-fg">{v}</dd></div>)}
              </dl>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi label="Customers it reaches" value={num(est?.eligible)} sub={est ? `of ${num(est.matching)} in the cohorts picked` : "Pick a cohort first"} />
              <Kpi label="Control / treated" value={est ? `${num(est.control)} / ${num(est.treatment)}` : "—"} sub="randomised split" />
              <Kpi label="Detectable effect" value={mde ? `${(mde * 100).toFixed(1)} pp` : "—"} tone={mde && mde > 0.12 ? "warn" : "neutral"} sub="smallest lift this audience can prove" />
            </div>
            {mde && mde > 0.12 && (
              <Banner tone="warn" title="This audience is too small to prove a typical effect">
                Collections treatments usually move payment by 4-9 points. Run it as a standing strategy over several months, or widen the audience, before treating the result as a verdict.
              </Banner>
            )}
            <Optional title="Contact rhythm" summary={rhythm}>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Cadence (days between touches)"><input id="cadence" type="number" min={1} className={inputCls} value={form.cadence_days} onChange={(e) => set("cadence_days", Number(e.target.value))} /></Field>
                <Field label="Maximum touches"><input id="max-touches" type="number" min={1} max={6} className={inputCls} value={form.max_touches} onChange={(e) => set("max_touches", Number(e.target.value))} /></Field>
                <Field label="Tone"><Select value={form.tone} onChange={(v) => set("tone", v)} options={["Supportive", "Neutral", "Direct"].map((x) => ({ value: x, label: x }))} /></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Send window start (local hour)" hint="Inside the platform's permitted contact hours."><input id="window-start" type="number" min={0} max={23} className={inputCls} value={form.send_window_start} onChange={(e) => set("send_window_start", Number(e.target.value))} /></Field>
                <Field label="Send window end (local hour)"><input id="window-end" type="number" min={1} max={24} className={inputCls} value={form.send_window_end} onChange={(e) => set("send_window_end", Number(e.target.value))} /></Field>
              </div>
              <div>
                <p className="label mb-1.5">Message preview (approved template, SMS)</p>
                <div className="max-w-sm rounded-lg bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-5 text-fg ring-1 ring-line">{TONE_PREVIEW[form.tone]}</div>
              </div>
              {form.cadence_days < 2 && form.max_touches >= 4 && (
                <Banner tone="warn">Daily touches with {form.max_touches} messages, plus the bank's own dialler, can reach the 7-in-7 contact limit. The guard will hold messages that would breach it.</Banner>
              )}
            </Optional>
            <Optional title="Experiment" summary={experiment}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Control share" hint="Fixed for the life of the strategy.">
                  <Select value={String(form.control_pct)} onChange={(v) => set("control_pct", Number(v))}
                    options={[0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map((x) => ({ value: String(x), label: pct(x, 0) }))} />
                </Field>
                <Field label="Wave size (treated)"><input id="wave-size" type="number" className={inputCls} value={form.wave_size} onChange={(e) => set("wave_size", Number(e.target.value))} /></Field>
                <Field label="Evaluation window (days)"><input id="evaluation-days" type="number" className={inputCls} value={form.evaluation_days} onChange={(e) => set("evaluation_days", Number(e.target.value))} /></Field>
                <Field label="Recovery target"><Select value={String(form.recovery_target)} onChange={(v) => set("recovery_target", Number(v))}
                  options={[0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((x) => ({ value: String(x), label: pct(x, 0) }))} /></Field>
              </div>
            </Optional>
          </div>
        )}
      </Card>

      {/* assistant rail */}
      <div className="space-y-4">
        <Card title="Live estimate" subtitle="Who this strategy would reach, as you fill it in">
          {est ? (
            <div className="space-y-2.5">
              <div className="flex items-baseline justify-between"><span className="text-xs text-fg-2">Customers in the cohorts picked</span><span className="num text-[15px] font-semibold">{num(est.matching)}</span></div>
              <div className="flex items-baseline justify-between"><span className="text-xs text-fg-2">Sent to strategies by the router</span><span className="num text-[15px] font-semibold text-primary-500">{num(est.eligible)}</span></div>
              {est.validation > 0 && <p className="flex justify-between gap-2 text-2xs text-fg-3"><span>of which its validation share</span><span className="num">{num(est.validation)}</span></p>}
              {est.exclusions.length > 0 && (
                <div className="border-t border-line pt-2">
                  <p className="label mb-1">Kept off strategies</p>
                  {est.exclusions.map((x) => <p key={x.reason} className="flex justify-between gap-2 text-2xs text-fg-2"><span>{x.reason.replace(" (Propensity Router)", "")}</span><span className="num">{x.count}</span></p>)}
                </div>
              )}
            </div>
          ) : <p className="text-xs text-fg-3">Pick a cohort to see who this strategy would reach.</p>}
        </Card>
        <Card title="Recommendations" subtitle="From live results in the cohorts you picked">
          {!form.target_cohorts.length && <p className="text-xs text-fg-3">Pick a cohort to see recommendations.</p>}
          <div className="space-y-2.5">
            {recs?.recommendations.map((r) => (
              <div key={r.title} className="rounded-lg border border-line bg-surface-sunken/60 p-2.5">
                <p className="text-xs font-semibold text-fg">{r.title}</p>
                <p className="mt-1 text-2xs leading-4 text-fg-2">{r.body}</p>
                {r.campaign_id && (
                  <button className="mt-1.5 text-2xs font-semibold text-primary-500 hover:underline"
                    onClick={() => run("clone", () => api.post<Strategy>(`/strategies/${r.campaign_id}/clone`), (x) => `Cloned into ${x.campaign_id}.`)
                      .then((x) => x && navigate(`/builder/${x.campaign_id}`))}>Clone {r.campaign_id} →</button>
                )}
              </div>
            ))}
            {recs && !recs.recommendations.length && <p className="text-xs text-fg-3">No matches yet for this audience.</p>}
          </div>
          {recs && recs.library.length > 0 && (
            <div className="mt-3 border-t border-line pt-2.5">
              <p className="label mb-1.5">Import from library</p>
              {recs.library.map((l) => (
                <button key={l.campaign_id} onClick={() => run("clone", () => api.post<Strategy>(`/strategies/${l.campaign_id}/clone`), (x) => `Cloned into ${x.campaign_id}.`)
                  .then((x) => x && navigate(`/builder/${x.campaign_id}`))}
                  className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-hover">
                  <span className="truncate">{l.name}</span><span className="num text-2xs text-fg-3">{l.campaign_id} · {pct(l.rate, 0)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
