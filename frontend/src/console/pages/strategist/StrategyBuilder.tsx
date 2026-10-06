import clsx from "clsx";
import { ArrowLeft, ArrowRight, BookOpen, Check, Copy, FilePenLine, Search, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type Cohort, type Population, type Strategy, type Treatment } from "../../lib/api";
import { money, num, pct, pp, SEGMENT_LABEL, SEGMENTS } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { SegmentChip } from "../../ui/domain";
import {
  Banner, Button, Card, CheckCard, Chip, Field, Kpi, Page, PageHeader, Pills, Select, Spinner, StatusChip, Tabs,
  inputCls, useAction,
} from "../../ui/ui";

type Tab = "library" | "guided" | "ai";

/* =================================================================== library */
function Library() {
  const { data } = useApi<Strategy[]>("/strategies?scope=all");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const { can } = useSession();
  if (!data) return <Spinner />;
  const rows = data.filter((s) => ["Live", "Paused", "Approved"].includes(s.status))
    .filter((s) => filter === "all" || s.channels.some((c) => c.includes(filter)) ||
      s.target_cohorts.includes(filter))
    .filter((s) => !q || `${s.name} ${s.campaign_id} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Pills value={filter} onChange={setFilter} options={[
          { id: "all", label: "All" }, { id: "C1", label: "Early arrears" }, { id: "C2", label: "30 DPD" },
          { id: "C3", label: "60 DPD" }, { id: "C4", label: "90+ DPD" }, { id: "SMS", label: "SMS" },
          { id: "App", label: "App" }, { id: "call", label: "Call" },
        ]} />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library" className={`${inputCls} pl-8`} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {rows.map((s) => {
          const st = s.stats!;
          return (
            <div key={s.campaign_id} className="flex flex-col rounded-lg border border-line bg-surface p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-2xs text-fg-3">{s.campaign_id} · v{s.version}</p>
                  <p className="mt-0.5 truncate text-[15px] font-semibold text-fg">{s.name}</p>
                </div>
                <div className="text-right">
                  <p className="num text-xl font-semibold text-fg">{pct(st.recovery_rate, 0)}</p>
                  <p className="text-2xs text-fg-3">recovery rate</p>
                </div>
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-fg-2">{s.description}</p>
              <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-fg-2">Uplift over its control</span>
                  <span className={clsx("num font-semibold", st.significant ? (st.uplift! > 0 ? "text-good" : "text-bad") : "text-fg")}>
                    {st.uplift === null ? "—" : pp(st.uplift)}</span>
                </div>
                <p className="mt-0.5 text-2xs text-fg-3">
                  Control {pct(st.control_rate, 0)} · {st.significant ? "significant" : `not yet significant (n=${st.treated}/${st.control})`}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {s.channels.map((c) => <Chip key={c} tone="info">{c}</Chip>)}
                {s.include_segments.map((g) => <SegmentChip key={g} segment={g} />)}
              </div>
              <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-2xs text-fg-3">
                <span>{s.owner} · {num(st.decisions)} accounts</span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/strategies/${s.campaign_id}`)}>View</Button>
                  {can("create_strategy") && (
                    <Button size="sm" variant="secondary" icon={<Copy className="h-3 w-3" />} loading={busy === s.campaign_id}
                      onClick={() => run(s.campaign_id, () => api.post<Strategy>(`/strategies/${s.campaign_id}/clone`), (r) => `Cloned into ${r.campaign_id}.`)
                        .then((r) => r && navigate(`/builder/${r.campaign_id}`))}>Clone</Button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <Banner tone="neutral">Recovery rates include customers who would have paid anyway. Compare strategies on uplift over their own control group.</Banner>
    </div>
  );
}

/* ============================================================== guided build */
type Form = Omit<Strategy, "campaign_id" | "status" | "version" | "source" | "created_at" | "updated_at" | "submitted_at" |
  "approved_at" | "launched_at" | "waves_run" | "owner_id" | "owner" | "created_by" | "approved_by" | "approver" | "channels" | "treatments" |
  "parent_id" | "has_history" | "editable" | "revisable" | "deletable" | "open_revision" | "pool_remaining" | "created">;

const BLANK: Form = {
  name: "", description: "", steps_completed: 0, target_cohorts: [], include_segments: ["Persuadable"], risk_bands: [],
  min_balance: null, max_balance: null, min_dpd: null, max_dpd: null, treatment_codes: [], cadence_days: 3,
  max_touches: 3, tone: "Supportive", send_window_start: 9, send_window_end: 19, escalate_after_days: 14,
  escalate_to: null, control_pct: 0.2, wave_size: 40, evaluation_days: 7, recovery_target: 0.45,
};

const TONE_PREVIEW: Record<string, string> = {
  Supportive: "Hi Priya, a quick reminder that $146 is past due on your account. You can pay in seconds here: ari.bank/p/3fa1c2. Reply STOP to opt out.",
  Neutral: "Priya, your account has $146 past due. Pay now: ari.bank/p/3fa1c2. Reply STOP to opt out.",
  Direct: "Priya, $146 on your account is now 30 days overdue. Please pay today: ari.bank/p/3fa1c2. Reply STOP to opt out.",
};

function numOrNull(v: string) { return v === "" ? null : Number(v); }

function Guided({ id }: { id?: string }) {
  const navigate = useNavigate();
  const { can } = useSession();
  const { run, busy } = useAction();
  const cohorts = useApi<Cohort[]>("/cohorts").data;
  const treatments = useApi<Treatment[]>("/treatments").data;
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
      setStep(Math.min(s.steps_completed, 5));
    });
    api.get<typeof recs>(`/strategies/${id}/recommendations`).then(setRecs).catch(() => setRecs(null));
  }, [id]);

  const estimateQuery = useMemo(() => {
    const p = new URLSearchParams({
      cohorts: form.target_cohorts.join(","), segments: form.include_segments.join(","), risk_bands: form.risk_bands.join(","),
      treatments: form.treatment_codes.join(","),
    });
    (["min_balance", "max_balance", "min_dpd", "max_dpd"] as const).forEach((k) => form[k] !== null && p.set(k, String(form[k])));
    return p.toString();
  }, [form]);

  useEffect(() => {
    const t = setTimeout(() => api.get<Population>(`/strategies/estimate?${estimateQuery}`).then(setEst).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [estimateQuery]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: "target_cohorts" | "include_segments" | "risk_bands" | "treatment_codes", v: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  const save = useCallback(async (next: number) => {
    const body = { ...form, steps_completed: Math.max(form.steps_completed, next) };
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

  const steps = ["Segment", "Risk rules", "Channels", "Nudge config", "Escalation", "Review & launch"];
  return (
    <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)_280px]">
      {/* step rail */}
      <div className="space-y-1">
        <p className="label px-2 pb-1">Steps</p>
        {steps.map((s, i) => (
          <button key={s} onClick={() => setStep(i)} className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]",
            step === i ? "bg-primary-50 font-medium text-primary-600" : "text-fg-2 hover:bg-surface-hover")}>
            <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold",
              i < form.steps_completed ? "bg-good text-white" : step === i ? "bg-primary-500 text-white" : "bg-surface-sunken text-fg-3 ring-1 ring-line")}>
              {i < form.steps_completed ? <Check className="h-3 w-3" /> : i + 1}
            </span>{s}
          </button>
        ))}
        <div className="mt-3 rounded-lg border border-line p-2.5">
          <p className="label">Progress</p>
          <div className="mt-1.5 h-1.5 rounded-full bg-surface-sunken"><div className="h-full rounded-full bg-primary-500" style={{ width: `${(form.steps_completed / 6) * 100}%` }} /></div>
          <p className="mt-1 text-2xs text-fg-3">Step {step + 1} of 6</p>
        </div>
        {meta && <div className="mt-2 space-y-1 px-1"><StatusChip status={meta.status} /><p className="font-mono text-2xs text-fg-3">{meta.campaign_id} · v{meta.version}</p></div>}
      </div>

      {/* step body */}
      <Card title={steps[step]} subtitle={[
        "Define which customers this strategy targets.",
        "Bound the strategy by the client's risk band and days past due. Risk comes from the client's model, not ARI.",
        "Choose the treatments the bandit may choose among. Only these can ever be sent.",
        "How often, how many times and in what voice.",
        "What happens when nothing works.",
        "Experiment design, then submit for approval.",
      ][step]}
        footer={<div className="flex items-center justify-between">
          <Button variant="ghost" disabled={step === 0} icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => setStep((s) => s - 1)}>Back</Button>
          {step < 5 ? (
            <Button variant="primary" disabled={!editable || !form.name.trim()} loading={busy === "save"}
              onClick={async () => { if (await save(step + 1)) setStep((s) => s + 1); }}>Save & continue <ArrowRight className="h-3.5 w-3.5" /></Button>
          ) : (
            <div className="flex gap-2">
              <Button disabled={!editable} loading={busy === "save"} onClick={() => save(6)}>Save draft</Button>
              <Button variant="primary" disabled={!editable || !meta || meta.status !== "Draft"} loading={busy === "submit"}
                onClick={async () => {
                  const s = await save(6);
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
            <Field label="Strategy name" required><input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Medium-Risk Payment Plan Flow" /></Field>
            <Field label="Description"><textarea rows={2} className={`${inputCls} h-auto py-2`} value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="Target cohorts" hint="Handed over by the client's collections system. ARI does not re-segment them.">
              <div className="grid gap-2 sm:grid-cols-2">
                {cohorts.map((c) => (
                  <CheckCard key={c.cohort_id} checked={form.target_cohorts.includes(c.cohort_id)} onChange={() => toggle("target_cohorts", c.cohort_id)}
                    title={c.name} sub={`${c.dpd_bucket} · ${c.risk_band} risk · ${num(c.customers)} customers`} />
                ))}
              </div>
            </Field>
            <Field label="Intervention-fit groups to include" hint="Labelled by what the score estimates. Treating likely self-curers wastes contact; contacting the do-not-contact group can backfire.">
              <div className="grid gap-2 sm:grid-cols-2">
                {SEGMENTS.map((g) => (
                  <CheckCard key={g} checked={form.include_segments.includes(g)} onChange={() => toggle("include_segments", g)}
                    title={SEGMENT_LABEL[g]} sub={{ Persuadable: "Behaviour can be changed by a treatment", "Sure Thing": "Expected to pay without help",
                      "Lost Cause": "Needs hardship support, not reminders", "Sleeping Dog": "Contact likely to backfire" }[g]}
                    right={g === "Sleeping Dog" && form.include_segments.includes(g) ? <Chip tone="bad">risk</Chip> : undefined} />
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Minimum balance ($)"><input type="number" className={inputCls} value={form.min_balance ?? ""} onChange={(e) => set("min_balance", numOrNull(e.target.value))} placeholder="No floor" /></Field>
              <Field label="Maximum balance ($)"><input type="number" className={inputCls} value={form.max_balance ?? ""} onChange={(e) => set("max_balance", numOrNull(e.target.value))} placeholder="No ceiling" /></Field>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <Field label="Client risk bands" hint="Leave empty to accept every band in the chosen cohorts.">
              <div className="flex flex-wrap gap-2">
                {["Low", "Medium", "High", "Very high"].map((b) => (
                  <button key={b} onClick={() => toggle("risk_bands", b)} className={clsx("h-8 rounded-lg border px-3 text-[13px]",
                    form.risk_bands.includes(b) ? "border-primary-500 bg-primary-50 font-medium text-primary-600" : "border-line-strong text-fg-2 hover:bg-surface-hover")}>{b}</button>
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Minimum days past due"><input type="number" className={inputCls} value={form.min_dpd ?? ""} onChange={(e) => set("min_dpd", numOrNull(e.target.value))} placeholder="Any" /></Field>
              <Field label="Maximum days past due"><input type="number" className={inputCls} value={form.max_dpd ?? ""} onChange={(e) => set("max_dpd", numOrNull(e.target.value))} placeholder="Any" /></Field>
            </div>
            <Banner tone="neutral">Consent, opt-outs and contact caps are checked before a treatment is chosen and again before every send, and a vulnerability flag from Nova stops automated treatment. They are platform rules, not strategy settings, and cannot be switched off here.</Banner>
          </div>
        )}

        {step === 2 && (
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
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-2xs text-fg-3">The bandit learns which of the selected treatments works for which customer. Historical rates seed its prior with low weight.</p>
              {can("manage_treatments") && (
                <Link to="/treatments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-500 hover:underline">
                  Add or edit treatments in the playbook <ArrowRight className="h-3 w-3" /></Link>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Cadence (days between touches)"><input type="number" min={1} className={inputCls} value={form.cadence_days} onChange={(e) => set("cadence_days", Number(e.target.value))} /></Field>
              <Field label="Maximum touches"><input type="number" min={1} max={6} className={inputCls} value={form.max_touches} onChange={(e) => set("max_touches", Number(e.target.value))} /></Field>
              <Field label="Tone"><Select value={form.tone} onChange={(v) => set("tone", v)} options={["Supportive", "Neutral", "Direct"].map((x) => ({ value: x, label: x }))} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send window start (local hour)" hint="Must sit inside the platform's permitted contact hours."><input type="number" min={0} max={23} className={inputCls} value={form.send_window_start} onChange={(e) => set("send_window_start", Number(e.target.value))} /></Field>
              <Field label="Send window end (local hour)"><input type="number" min={1} max={24} className={inputCls} value={form.send_window_end} onChange={(e) => set("send_window_end", Number(e.target.value))} /></Field>
            </div>
            <div>
              <p className="label mb-1.5">Message preview (approved template, SMS)</p>
              <div className="max-w-sm rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-5 text-fg ring-1 ring-line">{TONE_PREVIEW[form.tone]}</div>
              <p className="mt-1.5 text-2xs text-fg-3">Content comes from approved templates. Opt-out instructions are always included.</p>
            </div>
            {form.max_touches * form.cadence_days > 0 && form.cadence_days < 2 && form.max_touches >= 4 && (
              <Banner tone="warn">Daily touches with {form.max_touches} messages, plus the bank's own dialler, can reach the 7-in-7 contact limit. The guard will hold messages that would breach it.</Banner>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Escalate to">
                <Select value={form.escalate_to ?? ""} onChange={(v) => set("escalate_to", v || null)}
                  options={[{ value: "", label: "No escalation" }, ...treatments.filter((t) => t.status === "Active" || t.code === form.escalate_to)
                    .map((t) => ({ value: t.code, label: `${t.name} (${t.channel})${t.status === "Retired" ? " - retired" : ""}` }))]} />
              </Field>
              <Field label="After (days with no payment)"><input type="number" min={1} disabled={!form.escalate_to} className={inputCls} value={form.escalate_after_days} onChange={(e) => set("escalate_after_days", Number(e.target.value))} /></Field>
            </div>
            <Banner tone="neutral">
              Escalations count toward contact limits and cost. Many digital payers settle in the second week, so escalating early often pays for calls that were not needed.
            </Banner>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Control share" hint="Fixed for the life of the strategy.">
                <Select value={String(form.control_pct)} onChange={(v) => set("control_pct", Number(v))}
                  options={[0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map((x) => ({ value: String(x), label: pct(x, 0) }))} />
              </Field>
              <Field label="Wave size (treated)"><input type="number" className={inputCls} value={form.wave_size} onChange={(e) => set("wave_size", Number(e.target.value))} /></Field>
              <Field label="Evaluation window (days)" hint="Open item: how late payments are credited."><input type="number" className={inputCls} value={form.evaluation_days} onChange={(e) => set("evaluation_days", Number(e.target.value))} /></Field>
              <Field label="Recovery target"><Select value={String(form.recovery_target)} onChange={(v) => set("recovery_target", Number(v))}
                options={[0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((x) => ({ value: String(x), label: pct(x, 0) }))} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi label="Eligible customers" value={num(est?.eligible)} sub={`${num(est?.matching)} match the segment`} />
              <Kpi label="Control / treated" value={`${num(est?.control)} / ${num(est?.treatment)}`} sub="randomised split" />
              <Kpi label="Detectable effect" value={mde ? pp(mde) : "—"} tone={mde && mde > 0.12 ? "warn" : "neutral"}
                sub="smallest lift this audience can prove" />
            </div>
            {mde && mde > 0.12 && (
              <Banner tone="warn" title="This audience is too small to prove a typical effect">
                Collections treatments usually move payment by 4-9 points. Run it as a standing strategy over several months, or widen the audience, before treating the result as a verdict.
              </Banner>
            )}
            <div className="rounded-lg border border-line">
              <dl className="divide-y divide-line text-[13px]">
                {[
                  ["Audience", `${form.target_cohorts.map((c) => cohorts.find((x) => x.cohort_id === c)?.name).join(", ") || "—"} · ${form.include_segments.map((g) => SEGMENT_LABEL[g]).join(", ")}`],
                  ["Balance", `${form.min_balance !== null ? money(form.min_balance) : "any"} – ${form.max_balance !== null ? money(form.max_balance) : "any"}`],
                  ["Risk", `${form.risk_bands.join(", ") || "all bands"} · DPD ${form.min_dpd ?? "any"}–${form.max_dpd ?? "any"}`],
                  ["Treatments", form.treatment_codes.map((c) => treatments.find((t) => t.code === c)?.name).join(", ") || "—"],
                  ["Cadence", `every ${form.cadence_days} days, up to ${form.max_touches} touches, ${form.tone.toLowerCase()} tone, ${form.send_window_start}:00–${form.send_window_end}:00`],
                  ["Escalation", form.escalate_to ? `${treatments.find((t) => t.code === form.escalate_to)?.name} after ${form.escalate_after_days} days` : "none"],
                ].map(([k, v]) => <div key={k} className="flex gap-4 px-3 py-2"><dt className="w-28 shrink-0 text-fg-3">{k}</dt><dd className="text-fg">{v}</dd></div>)}
              </dl>
            </div>
          </div>
        )}
      </Card>

      {/* assistant rail */}
      <div className="space-y-4">
        <Card title="Live estimate">
          {est ? (
            <div className="space-y-2.5">
              <div className="flex items-baseline justify-between"><span className="text-xs text-fg-2">Matching segment</span><span className="num text-[15px] font-semibold">{num(est.matching)}</span></div>
              <div className="flex items-baseline justify-between"><span className="text-xs text-fg-2">Eligible for a treatment</span><span className="num text-[15px] font-semibold text-primary-500">{num(est.eligible)}</span></div>
              {est.exclusions.length > 0 && (
                <div className="border-t border-line pt-2">
                  <p className="label mb-1">Excluded</p>
                  {est.exclusions.map((x) => <p key={x.reason} className="flex justify-between gap-2 text-2xs text-fg-2"><span>{x.reason}</span><span className="num">{x.count}</span></p>)}
                </div>
              )}
            </div>
          ) : <p className="text-xs text-fg-3">Pick a cohort to see the audience.</p>}
        </Card>
        <Card title="Recommendations" subtitle="From live results in this cohort">
          {!meta && <p className="text-xs text-fg-3">Save the first step to get recommendations.</p>}
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
            {meta && recs && !recs.recommendations.length && <p className="text-xs text-fg-3">No matches yet for this audience.</p>}
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

/* =============================================================== ai generate */
function AIGenerate() {
  const presets = useApi<{ presets: { label: string; brief: string; risk: string; goal: string }[]; goals: string[]; risks: string[] }>("/ai/presets").data;
  const [brief, setBrief] = useState("");
  const [risk, setRisk] = useState("Medium");
  const [goal, setGoal] = useState("Payment plan");
  const [result, setResult] = useState<Strategy | null>(null);
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (!presets) return <Spinner />;
  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_1fr]">
      <Card title="Describe the recovery campaign"
        subtitle="ARI drafts a complete strategy from your brief. Every setting is explained and you review it before it is submitted.">
        <p className="label mb-1.5">Quick presets</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {presets.presets.map((p) => (
            <button key={p.label} onClick={() => { setBrief(p.brief); setRisk(p.risk); setGoal(p.goal); }}
              className="rounded-full border border-line-strong px-3 py-1 text-xs text-fg-2 hover:border-primary-500 hover:bg-primary-50 hover:text-primary-600">{p.label}</button>
          ))}
        </div>
        <textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. Build a recovery campaign for medium-risk 30 DPD card accounts with balances between $2k-$10k. Offer flexible payment plans and avoid aggressive escalation in the first 14 days."
          className={`${inputCls} h-auto py-2 leading-5`} />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Risk profile"><Select value={risk} onChange={setRisk} options={presets.risks.map((r) => ({ value: r, label: r }))} /></Field>
          <Field label="Campaign goal"><Select value={goal} onChange={setGoal} options={presets.goals.map((g) => ({ value: g, label: g }))} /></Field>
        </div>
        <div className="mt-4">
          <Button variant="primary" disabled={brief.trim().length < 10} loading={busy === "gen"} icon={<FilePenLine className="h-4 w-4" />}
            onClick={() => run("gen", () => api.post<Strategy>("/strategies/ai-draft", { brief, risk, goal }), (r) => `Drafted ${r.campaign_id}.`).then((r) => r && setResult(r))}>
            Draft the strategy
          </Button>
        </div>
        <p className="mt-3 text-2xs leading-4 text-fg-3">
          Drafting reads your brief for audience, balance range, tone, touches and escalation timing. It only picks from approved treatments, and the result is a Draft that someone else must approve.
        </p>
      </Card>

      <Card title="Draft" subtitle={result ? `${result.campaign_id} · ${result.status}` : "The drafted strategy appears here"}>
        {!result ? (
          <div className="flex h-64 flex-col items-center justify-center text-center text-xs text-fg-3">
            <FilePenLine className="mb-2 h-6 w-6 text-fg-3/60" />Choose a preset or write a brief, then draft it.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-[15px] font-semibold">{result.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">{result.treatments.map((t) => <Chip key={t.code} tone="info">{t.name}</Chip>)}</div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Kpi label="Eligible" value={num(result.population?.eligible)} />
              <Kpi label="Control" value={num(result.population?.control)} />
              <Kpi label="Treated" value={num(result.population?.treatment)} />
            </div>
            <div>
              <p className="label mb-1.5">Why these settings</p>
              <ul className="space-y-1.5">
                {result.rationale?.map((r) => (
                  <li key={r} className="flex gap-2 text-xs leading-5 text-fg-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{r}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="primary" onClick={() => navigate(`/builder/${result.campaign_id}`)}>Review in guided build</Button>
              <Button variant="ghost" onClick={() => setResult(null)}>Discard view</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ===================================================================== page */
export default function StrategyBuilder() {
  const { id } = useParams();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>(id ? "guided" : "library");
  useEffect(() => { if (id) setTab("guided"); }, [id]);
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Strategy Builder" subtitle={id ? `${id} · editing` : "Build, clone or draft a recovery strategy"} role={me?.user.role_label}
        crumbs={[{ label: "Strategies", to: "/strategies" }, { label: "Builder" }]} />
      <div className="bg-surface px-6"><Tabs<Tab> active={tab} onChange={(t) => { setTab(t); if (t !== "guided" && id) navigate("/builder"); }} tabs={[
        { id: "library", label: "Strategy Library", icon: <BookOpen className="h-3.5 w-3.5" /> },
        { id: "guided", label: "Guided Build", icon: <Wrench className="h-3.5 w-3.5" /> },
        { id: "ai", label: "Draft from a brief", icon: <FilePenLine className="h-3.5 w-3.5" /> },
      ]} /></div>
      <Page>
        {tab === "library" && <Library />}
        {tab === "guided" && <Guided id={id} />}
        {tab === "ai" && <AIGenerate />}
      </Page>
    </>
  );
}

