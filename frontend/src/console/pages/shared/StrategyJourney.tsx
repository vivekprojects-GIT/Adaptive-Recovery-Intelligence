/** Strategy Journey: one recovery account walked through CARE from start to finish.
 *  The flow across the top is the recovery process itself (with the branch at the
 *  customer's response and the loop back to the decision); below it, what the
 *  business does at each step beside the systems that take part and what they pass
 *  each other. The decision is real Thompson sampling over each treatment's track
 *  record, so every outcome visibly changes the next one. */
import clsx from "clsx";
import { animate, createScope, stagger, type Scope } from "animejs";
import {
  ArrowLeft, ArrowRight, Boxes, Check, CircleDollarSign, Clock3, Cpu, FolderInput, Info, Landmark, MessageCircle,
  MessageSquareReply, Phone, Play, RotateCcw, Route, Scale, Send, ShieldCheck, Smartphone, TrendingUp, Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { dateOnly, money, pct } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Button, ErrorState, Page, PageHeader, Select, Spinner } from "../../ui/ui";

interface Treatment { code: string; name: string; description: string; channel: string; timing: string; status: string }
interface Factor { label: string; value: string; weight: string }
interface Account {
  recovery_id: number; account_number: string; name: string; product: string; charge_off_date: string;
  charge_off_balance: number; recovered: number; remaining: number; status: string; payments: number;
  last_payment: string | null; segment: { name: string; factors: { label: string; value: string; why: string }[] };
  propensity: { pay: number; respond: number; pay_factors: Factor[]; respond_factors: Factor[] };
  history: { control: { s: number; attempts: number }; treatments: Record<string, { s: number; attempts: number }> };
  held_out: boolean[];
  recommended: Treatment & { reason: string };
}
interface Data {
  accounts: Account[]; treatments: Treatment[];
  rules: { specialist_threshold: number; settlement_share: number; charge_off_dpd: number; control_share: number };
}

type Step = "start" | "segment" | "decide" | "execute" | "response" | "learn" | "next";
type Outcome = "paid" | "none" | "feedback";
type Belief = { s: number; f: number };
type Beliefs = Record<string, Belief>;
interface Attempt { n: number; code: string; outcome: Outcome | null }

const ORDER: Step[] = ["start", "segment", "decide", "execute", "response", "learn", "next"];
const STEP: Record<Step, { title: string; short: string[]; icon: LucideIcon; lead: string }> = {
  start: { title: "Start recovery journey", short: ["Start recovery", "journey"], icon: FolderInput,
    lead: "The account arrives in recovery" },
  segment: { title: "Customer / business segmentation", short: ["Customer / business", "segmentation"], icon: Users,
    lead: "CARE places the account in a segment" },
  decide: { title: "AI strategy decision", short: ["AI strategy", "decision"], icon: Scale,
    lead: "CARE chooses the treatment, inside the bank's rules" },
  execute: { title: "Customer contact / execution", short: ["Customer contact /", "execution"], icon: Send,
    lead: "The treatment goes out through the bank's channels" },
  response: { title: "Customer response", short: ["Customer", "response"], icon: MessageSquareReply,
    lead: "What the customer does next" },
  learn: { title: "Learning engine", short: ["Learning", "engine"], icon: TrendingUp,
    lead: "Every outcome teaches CARE something" },
  next: { title: "Next best strategy", short: ["Next best", "strategy"], icon: Route,
    lead: "What happens to the account now" },
};
const OUTCOME: Record<Outcome, { label: string; hint: string; icon: LucideIcon }> = {
  paid: { label: "Payment received", hint: "The customer pays", icon: CircleDollarSign },
  none: { label: "No payment / no response", hint: "Nothing within 30 days", icon: Clock3 },
  feedback: { label: "Customer feedback", hint: "The customer replies with a request", icon: MessageCircle },
};
const FEEDBACK = "I can't pay that all at once. Can I pay monthly?";
// Decisions held back at random get no treatment, so every treatment is measured against doing nothing.
const CONTROL = "CTRL";
const NO_CONTACT: Treatment = { code: CONTROL, name: "No contact", channel: "None", timing: "Not contacted this attempt", status: "",
  description: "Held back at random, so each treatment can be measured against doing nothing." };

type Sys = "host" | "recovery" | "ai" | "exec" | "learn";
const SYSTEMS: { id: Sys; name: string; what: string; icon: LucideIcon }[] = [
  { id: "host", name: "Host system", what: "Bank core and Nova", icon: Landmark },
  { id: "recovery", name: "Recovery engine", what: "Files, segments, rules", icon: Boxes },
  { id: "ai", name: "AI engine", what: "Chooses the treatment", icon: Cpu },
  { id: "exec", name: "Execution system", what: "Channels and people", icon: Send },
  { id: "learn", name: "Learning engine", what: "Learns from outcomes", icon: TrendingUp },
];

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---- Thompson sampling: a seeded generator so the same journey always plays the same way ---- */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gamma(k: number, r: () => number): number {
  if (k < 1) return gamma(k + 1, r) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const betaDraw = (b: Belief, r: () => number) => {
  const x = gamma(1 + b.s, r), y = gamma(1 + b.f, r);
  return x / (x + y);
};
function chanceBest(beliefs: Beliefs, codes: string[], seed: number, draws = 3000): Record<string, number> {
  const r = generator(seed), wins: Record<string, number> = Object.fromEntries(codes.map((c) => [c, 0]));
  for (let i = 0; i < draws; i++) {
    let best = codes[0], top = -1;
    for (const c of codes) {
      const v = betaDraw(beliefs[c], r);
      if (v > top) { top = v; best = c; }
    }
    wins[best] += 1;
  }
  return Object.fromEntries(codes.map((c) => [c, wins[c] / draws]));
}
const rate = (b: Belief) => (1 + b.s) / (2 + b.s + b.f);
// Log-gamma (Lanczos), for drawing a belief as a curve.
function lgamma(z: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61503916999185,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const betaPdf = (x: number, b: Belief) => {
  const a = 1 + b.s, c = 1 + b.f;
  return Math.exp((a - 1) * Math.log(x) + (c - 1) * Math.log(1 - x) - (lgamma(a) + lgamma(c) - lgamma(a + c)));
};

export default function StrategyJourney() {
  const { data, error, loading, reload } = useApi<Data>("/journey/recovery");
  const [accountId, setAccountId] = useState<number | null>(null);
  if (loading && !data) return <><PageHeader title="Strategy Journey" /><Page><Spinner /></Page></>;
  if (error || !data) return <><PageHeader title="Strategy Journey" /><Page><ErrorState message={error ?? "Not available"} onRetry={reload} /></Page></>;
  // Opens on an account in Active Recovery with nothing paid yet and an automated offer allowed: the plainest case.
  const account = data.accounts.find((a) => a.recovery_id === accountId)
    ?? data.accounts.find((a) => a.status === "Active Recovery" && a.remaining < data.rules.specialist_threshold)
    ?? data.accounts[0];
  if (!account) return <><PageHeader title="Strategy Journey" /><Page><ErrorState message="No recovery accounts are open for a treatment." /></Page></>;
  return <Journey key={account.recovery_id} data={data} account={account} onAccount={setAccountId} />;
}

function Journey({ data, account, onAccount }: { data: Data; account: Account; onAccount: (id: number) => void }) {
  // Records are kept per segment: this account's segment, for each treatment the rules allow and for no contact.
  const codes = useMemo(() => data.treatments.map((t) => t.code).filter((c) => c in account.history.treatments), [data, account]);
  const byCode = useMemo<Record<string, Treatment>>(() => ({ ...Object.fromEntries(data.treatments.map((t) => [t.code, t])), [CONTROL]: NO_CONTACT }), [data]);
  const start = useMemo<Beliefs>(() => ({
    ...Object.fromEntries(Object.entries(account.history.treatments).map(([c, h]) => [c, { s: h.s, f: h.attempts - h.s }])),
    [CONTROL]: { s: account.history.control.s, f: account.history.control.attempts - account.history.control.s },
  }), [account]);

  const [started, setStarted] = useState(false);
  const [step, setStep] = useState<Step>("start");
  const [visited, setVisited] = useState<Set<Step>>(new Set());
  const [beliefs, setBeliefs] = useState<Beliefs>(start);
  const [before, setBefore] = useState<Beliefs>(start);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [instalments, setInstalments] = useState(false);
  const [learned, setLearned] = useState(0);   // attempts already taught to the learning engine

  const current = attempts[attempts.length - 1];
  const locked = !!current && learned >= current.n;   // its outcome is already learned from
  // An attempt runs from its decision to the next best strategy; going back round the loop starts the next one.
  const attemptNo = !current ? 1 : step === "decide" && current.outcome ? current.n + 1 : current.n;

  // The decision for this attempt: business rules first, then Thompson sampling among what the rules allow.
  const decision = useMemo(() => {
    const misses = attempts.filter((a) => a.outcome === "none").length;
    const last = attempts.filter((a) => a.outcome).slice(-1)[0];
    let eligible = codes;
    let rule = "All three treatments are open to this account.";
    if (account.remaining >= data.rules.specialist_threshold) {
      eligible = ["R3"];
      rule = `${money(account.remaining)} is left. At ${money(data.rules.specialist_threshold)} or more a specialist always handles the account.`;
    } else if (instalments) {
      eligible = ["R3"];
      rule = "The customer asked to pay monthly, so a specialist agrees a payment plan with them.";
    } else if (misses >= 2) {
      eligible = ["R3"];
      rule = "Two offers have gone unanswered, so the account goes to a specialist.";
    } else if (last && last.outcome === "none") {
      eligible = codes.filter((c) => c !== last.code);
      rule = `${byCode[last.code].name} went unanswered, so it is not repeated straight away.`;
    }
    const done = attempts.filter((a) => a.outcome).length;
    const hold = account.held_out[done] ?? false;
    const r = generator(account.recovery_id * 97 + done + 1);
    const draws = Object.fromEntries(eligible.map((c) => [c, betaDraw(beliefs[c], r)]));
    const best = eligible.reduce((a, b) => (draws[b] > draws[a] ? b : a));
    return { eligible, rule, draws, chosen: hold ? CONTROL : best, best, hold };
  }, [attempts, beliefs, instalments, account, data.rules, codes, byCode]);
  const lift = (b: Beliefs, c: string) => rate(b[c]) - rate(b[CONTROL]);

  const chance = useMemo(() => chanceBest(beliefs, codes, 11), [beliefs, codes]);
  const chanceBefore = useMemo(() => chanceBest(before, codes, 11), [before, codes]);

  const go = (s: Step) => { setStep(s); setVisited((v) => new Set(v).add(s)); };
  const begin = () => { setStarted(true); go("start"); };
  const restart = () => {
    setStarted(false); setStep("start"); setVisited(new Set()); setBeliefs(start); setBefore(start);
    setAttempts([]); setInstalments(false); setLearned(0);
  };
  const chosen = step === "decide" && (!current || current.outcome) ? decision.chosen : current?.code ?? decision.chosen;
  const result = current?.outcome ? settle(account, current.code, current.outcome, data.rules.settlement_share) : null;
  const finished = step === "next" && current?.outcome === "paid" && current.code !== CONTROL;
  const canNext = started && step !== "next" && !(step === "response" && !current?.outcome);
  const canLoop = started && step === "next" && !finished && !!current?.outcome;

  const next = () => {
    if (canLoop) { go("decide"); return; }
    if (!canNext) return;
    if (step === "decide" && (!current || current.outcome)) {
      setAttempts((a) => [...a, { n: a.length + 1, code: decision.chosen, outcome: null }]);
    }
    if (step === "response" && current?.outcome && !locked) {
      const o = current.outcome;
      setLearned(current.n);
      setBefore(beliefs);
      setBeliefs((b) => ({ ...b, [current.code]: o === "paid" ? { ...b[current.code], s: b[current.code].s + 1 }
        : { ...b[current.code], f: b[current.code].f + 1 } }));
      if (o === "feedback") setInstalments(true);
    }
    go(ORDER[Math.min(ORDER.indexOf(step) + 1, ORDER.length - 1)]);
  };
  const back = () => started && step !== "start" && go(ORDER[ORDER.indexOf(step) - 1]);
  const answer = (o: Outcome) => !locked && setAttempts((a) => a.map((x, i) => (i === a.length - 1 ? { ...x, outcome: o } : x)));

  // Arrow keys step through the journey, unless the person is typing or choosing in a field.
  const keys = useRef({ next, back });
  keys.current = { next, back };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); keys.current.next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); keys.current.back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Each step's content settles in; the systems' messages draw in one after another.
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!started || !stage.current || reduced()) return;
    const scope: Scope = createScope({ root: stage as React.RefObject<HTMLElement> }).add(() => {
      animate("[data-rise]", { opacity: [0, 1], y: [8, 0], duration: 320, ease: "out(3)", delay: stagger(40) });
      animate("[data-wire]", { scaleX: [0, 1], duration: 420, ease: "inOut(2)", delay: stagger(220, { start: 120 }) });
      animate("[data-wire-label]", { opacity: [0, 1], duration: 260, delay: stagger(220, { start: 300 }) });
    });
    return () => { scope.revert(); };
  }, [step, started, attemptNo]);

  const sys = tech(step, account, decision, current, result, byCode);
  const t = byCode[chosen];

  return (
    <>
      <PageHeader title="Strategy Journey"
        subtitle="How a recovery account moves through CARE: what the business does at each step, and how the systems decide, act and learn"
        actions={<>
          <label className="sr-only" htmlFor="journey-account">Account</label>
          <Select className="w-[330px]" value={String(account.recovery_id)} onChange={(v) => onAccount(Number(v))}
            options={data.accounts.map((a) => ({ value: String(a.recovery_id),
              label: `${a.account_number} · ${a.product} · ${money(a.remaining)} left` }))} />
          {started
            ? <Button icon={<RotateCcw className="h-4 w-4" />} onClick={restart}>Start over</Button>
            : <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={begin}>Start journey</Button>}
        </>} />
      <Page>
        <AccountStrip account={account} step={started ? step : null} result={step === "next" ? result : null} />

        <section className="rounded-xl border border-line bg-surface shadow-card">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">Recovery flow</h2>
              <p className="text-xs text-fg-3">{started ? `Attempt ${attemptNo} · step ${ORDER.indexOf(step) + 1} of ${ORDER.length} · select any step you have reached` : "Seven steps, with a learning loop back to the decision"}</p>
            </div>
            {started && (
              <div className="flex items-center gap-2">
                <span className="hidden text-2xs text-fg-3 md:inline">Arrow keys move between steps</span>
                <Button size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={back} disabled={step === "start"}>Back</Button>
                {canLoop
                  ? <Button size="sm" variant="primary" onClick={next}>Back to AI strategy decision <RotateCcw className="h-4 w-4" /></Button>
                  : step !== "next" && <Button size="sm" variant="primary" onClick={next} disabled={!canNext}
                      title={step === "response" && !current?.outcome ? "Choose how the customer responds first" : undefined}>
                      Next step <ArrowRight className="h-4 w-4" /></Button>}
              </div>
            )}
          </header>
          <FlowStepper step={started ? step : null} visited={visited} outcome={current?.outcome ?? null}
            onPick={(s) => started && visited.has(s) && go(s)} />
        </section>

        {!started ? (
          <Intro onStart={begin} />
        ) : (
          <div ref={stage} className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            {/* ---------------- business ---------------- */}
            <section className="rounded-xl border border-line bg-surface shadow-card">
              <header className="flex items-start gap-3 border-b border-line px-5 py-4">
                <StepIcon step={step} />
                <div className="min-w-0">
                  <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Business journey · step {ORDER.indexOf(step) + 1}</p>
                  <h3 className="text-[17px] font-semibold leading-6 text-fg">{STEP[step].title}</h3>
                  <p className="text-sm text-fg-2">{STEP[step].lead}</p>
                </div>
              </header>
              <div className="space-y-4 px-5 py-5">
                {step === "start" && <>
                  <Lead>{account.name}'s {account.product} was charged off on {dateOnly(account.charge_off_date)}. Collections has ended, so the account now belongs to recovery.</Lead>
                  <LifeLine account={account} chargeOffDpd={data.rules.charge_off_dpd} />
                  <Callout icon={Info}>Nobody sorts accounts by hand. An account that is charged off, or {data.rules.charge_off_dpd} or more days past due, is recovery; anything else stays in collections.</Callout>
                </>}

                {step === "segment" && <>
                  <div data-rise className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-primary-50 px-4 py-3">
                    <span className="text-2xs font-medium uppercase tracking-[0.08em] text-primary-500">Segment</span>
                    <span className="text-[15px] font-semibold text-fg">{account.segment.name}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {account.segment.factors.map((f) => (
                      <div key={f.label} data-rise className="rounded-lg border border-line px-4 py-3">
                        <p className="text-2xs text-fg-3">{f.label}</p>
                        <p className="num mt-0.5 text-lg font-semibold text-fg">{f.value}</p>
                        <p className="mt-1 text-xs leading-5 text-fg-2">{f.why}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ScoreCard title="Likelihood to pay" score={account.propensity.pay} factors={account.propensity.pay_factors} />
                    <ScoreCard title="Likelihood to respond" score={account.propensity.respond} factors={account.propensity.respond_factors} />
                  </div>
                  <Lead muted>CARE keeps a separate record of what works for each segment, so this account is judged against customers in the same position.</Lead>
                </>}

                {step === "decide" && <>
                  <RuleCheck text={decision.rule} />
                  <Baseline control={beliefs[CONTROL]} share={data.rules.control_share} hold={decision.hold} />
                  <div className="grid gap-3 md:grid-cols-3">
                    {data.treatments.map((tr) => (
                      <TreatmentCard key={tr.code} t={tr} belief={beliefs[tr.code]} uplift={beliefs[tr.code] ? lift(beliefs, tr.code) : 0}
                        chance={chance[tr.code] ?? 0} allowed={decision.eligible.includes(tr.code)} draw={decision.draws[tr.code]}
                        chosen={!decision.hold && tr.code === decision.chosen} />
                    ))}
                  </div>
                  <Callout icon={Scale}>
                    {decision.hold
                      ? <>Without the comparison check CARE would have chosen <b className="font-semibold text-fg">{byCode[decision.best].name}</b>. This time the account is held back, and what it does with no contact is what every treatment's uplift is measured against.</>
                      : decision.eligible.length > 1
                        ? <>For each allowed treatment CARE draws a plausible payment rate from what it has learned for this segment, and picks the one with the biggest uplift over no contact: <b className="font-semibold text-fg">{byCode[decision.chosen].name}</b> this time. A treatment with less evidence still gets chosen now and then, which is how CARE keeps learning.</>
                        : <>Only one treatment is allowed here, so the rules decide: <b className="font-semibold text-fg">{byCode[decision.chosen].name}</b>.</>}
                  </Callout>
                </>}

                {step === "execute" && chosen === CONTROL && <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Fact label="Treatment" value="No contact" />
                    <Fact label="Channel" value="None" />
                    <Fact label="Why" value="Comparison group" />
                  </div>
                  <Callout icon={ShieldCheck}>Nothing is sent to {firstName(account)} this attempt. The account is recorded as held back, and whatever happens over the next 30 days shows what customers like this do without any contact.</Callout>
                </>}
                {step === "execute" && t && chosen !== CONTROL && <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Fact label="Treatment" value={t.name} />
                    <Fact label="Channel" value={t.channel} />
                    <Fact label="Timing" value={t.timing} />
                  </div>
                  {chosen !== "R2" && <Callout icon={ShieldCheck}>{chosen === "R1"
                    ? "A settlement changes what the customer owes, so a reviewer approves it in the Review Queue before it goes out. The person who proposed it cannot approve it."
                    : "A specialist takes the account, reviews the customer's situation, and agrees the next step with them by phone."}</Callout>}
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
                    <Preview account={account} code={chosen} share={data.rules.settlement_share} />
                    <div data-rise>
                      <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Checked before anything is sent</p>
                      <ul className="space-y-2">
                        {["Inside the permitted hours, 08:00 to 21:00 local time", "Under the weekly contact limit",
                          "No opt-out, dispute or vulnerability flag", "Wording approved for recovery messages"].map((c) => (
                          <li key={c} className="flex items-start gap-2 text-sm text-fg-2">
                            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-good-bg"><Check className="h-3 w-3 text-good" /></span>{c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </>}

                {step === "response" && current && <>
                  <Lead>{current.code === CONTROL ? `With no contact, what did ${firstName(account)} do?` : `How did ${firstName(account)} respond to the ${byCode[current.code].name.toLowerCase()}?`}</Lead>
                  <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Customer response">
                    {((current.code === CONTROL ? ["paid", "none"] : ["paid", "none", "feedback"]) as Outcome[]).map((o) => {
                      const on = current.outcome === o, O = OUTCOME[o];
                      return (
                        <button key={o} type="button" role="radio" aria-checked={on} data-rise onClick={() => answer(o)}
                          disabled={locked && !on}
                          className={clsx("group flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-150",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
                            on ? "border-primary-500 bg-primary-50 shadow-[inset_0_0_0_1px_theme(colors.primary.500)]"
                              : "border-line hover:border-line-strong hover:bg-surface-hover",
                            !locked && "cursor-pointer", locked && !on && "opacity-45")}>
                          <span className={clsx("flex h-9 w-9 items-center justify-center rounded-lg", on ? "bg-primary-500 text-white" : "bg-surface-sunken text-fg-2")}>
                            <O.icon className="h-[18px] w-[18px]" /></span>
                          <span className="text-sm font-semibold text-fg">{O.label}</span>
                          <span className="text-xs leading-5 text-fg-3">{o === "feedback" ? `"${FEEDBACK}"` : o === "paid" && current.code === CONTROL ? "The customer pays on their own" : O.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                  {result ? <Callout icon={OUTCOME[current.outcome!].icon}>{result.story}</Callout>
                    : <p className="text-sm text-fg-3">Choose one to continue.</p>}
                </>}

                {step === "learn" && current?.outcome && <>
                  <Lead>{current.code === CONTROL
                    ? `${firstName(account)} was held back and ${current.outcome === "paid" ? "paid anyway" : "did not pay"}, so the comparison group's record changes, and with it every treatment's uplift.`
                    : `${byCode[current.code].name} ${current.outcome === "paid" ? "worked" : "did not work"} this time, so CARE adds ${current.outcome === "paid" ? "a success" : "a failure"} to its record for this segment.`}</Lead>
                  <BeliefCurves name={current.code === CONTROL ? "no contact" : byCode[current.code].name} before={before[current.code]} after={beliefs[current.code]} />
                  <div data-rise>
                    <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Uplift over no contact, in points (extra payers per 100 customers)</p>
                    <UpliftBars treatments={data.treatments.filter((x) => codes.includes(x.code))} before={before} after={beliefs} />
                  </div>
                  <div data-rise>
                    <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Chance each treatment is the best</p>
                    <ChanceBars treatments={data.treatments.filter((x) => codes.includes(x.code))} before={chanceBefore} after={chance} />
                  </div>
                  {current.outcome === "feedback" && <Callout icon={MessageCircle}>The customer's request is kept on the account: they want to pay monthly. That limits what CARE offers next.</Callout>}
                </>}

                {step === "next" && current?.outcome && result && (current.outcome === "paid" && current.code !== CONTROL ? <>
                  <div data-rise className="rounded-xl border border-good/25 bg-good-bg px-5 py-4">
                    <p className="flex items-center gap-2 text-sm font-semibold text-good"><Check className="h-4 w-4" />{result.status}</p>
                    <p className="mt-1 text-[15px] leading-6 text-fg">{result.story}</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Fact label="Received now" value={money(result.received)} />
                    <Fact label="Recovery status" value={result.status} />
                    <Fact label="Attempts" value={String(attempts.length)} />
                  </div>
                  <Callout icon={Route}>{result.status === "Paid in Full"
                    ? "The account is closed for recovery and nobody contacts the customer again."
                    : "CARE keeps the arrangement on track with a reminder before each payment is due. A missed payment brings the account back to the AI strategy decision."}</Callout>
                  <div><Button icon={<RotateCcw className="h-4 w-4" />} onClick={restart}>Run the journey again</Button></div>
                </> : <>
                  <Lead>{current.code === CONTROL
                    ? (current.outcome === "paid" ? "A payment came in with no contact. The account was held back for one attempt only, so CARE now decides again." : "The account was held back for one attempt only, so CARE now decides again.")
                    : current.outcome === "feedback" ? "The customer asked to pay monthly, so the next step changes." : "The offer did not work, so CARE tries again with what it has learned."}</Lead>
                  <RuleCheck text={decision.rule} />
                  <div data-rise className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary-500 bg-primary-50 px-5 py-4">
                    <div>
                      <p className="text-2xs font-medium uppercase tracking-[0.08em] text-primary-500">Next best strategy</p>
                      <p className="text-[17px] font-semibold text-fg">{byCode[decision.chosen].name}</p>
                      <p className="text-sm text-fg-2">{byCode[decision.chosen].channel} · {byCode[decision.chosen].timing}</p>
                    </div>
                    <Button variant="primary" onClick={next}>Back to AI strategy decision <RotateCcw className="h-4 w-4" /></Button>
                  </div>
                </>)}
              </div>
            </section>

            {/* ---------------- systems ---------------- */}
            <section className="rounded-xl border border-line bg-surface shadow-card">
              <header className="border-b border-line px-5 py-4">
                <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Technical journey</p>
                <h3 className="text-[17px] font-semibold leading-6 text-fg">Systems at work</h3>
                <p className="text-sm text-fg-2">Which systems take part, and what they pass to each other</p>
              </header>
              <Sequence active={sys.active} flows={sys.flows} />
            </section>
          </div>
        )}

        {attempts.some((a) => a.outcome) && <Trail attempts={attempts} byCode={byCode} />}
      </Page>
    </>
  );
}

/* ------------------------------------------------------------- account strip */

function AccountStrip({ account: a, step, result }: { account: Account; step: Step | null; result: ReturnType<typeof settle> | null }) {
  const status = result && result.status !== a.status ? result.status : a.status;
  const share = a.charge_off_balance ? a.recovered / a.charge_off_balance : 0;
  return (
    <section className="grid gap-4 rounded-xl border border-line bg-surface px-5 py-4 shadow-card md:grid-cols-[minmax(0,1.1fr)_repeat(3,minmax(0,0.8fr))_minmax(0,1.1fr)] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-sm font-semibold text-white">
          {a.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
        </span>
        <div className="min-w-0">
          <p className="font-mono text-xs text-fg-3">{a.account_number}</p>
          <p className="truncate text-[15px] font-semibold text-fg">{a.name}</p>
          <p className="truncate text-xs text-fg-2">{a.product} · charged off {dateOnly(a.charge_off_date)}</p>
        </div>
      </div>
      <Fact label="Charge-off balance" value={money(a.charge_off_balance)} />
      <Fact label="Current recovery balance" value={money(a.remaining)} />
      <div>
        <p className="text-2xs text-fg-3">Recovery status</p>
        <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
          <span className={clsx("h-2 w-2 rounded-full", status === "Active Recovery" ? "bg-primary-300" : status === "Partial Recovery" ? "bg-warn" : "bg-good")} />
          {status}{step && status !== a.status && <span className="text-2xs font-normal text-fg-3">was {a.status}</span>}
        </p>
      </div>
      <div>
        <div className="flex items-baseline justify-between text-2xs text-fg-3">
          <span>Recovered so far</span><span className="num font-medium text-fg-2">{money(a.recovered)} · {pct(share, 0)}</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-hover">
          <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.max(share * 100, share ? 2 : 0)}%` }} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- the flow */

// Node positions on a fixed canvas: the main line, the three responses stacked, and the loop above.
// The canvas scales down to fit narrower screens, and scrolls below 80%.
const CW = 1082, CH = 204, W = 112, H = 72, MID = 124;
const X: Record<Step, number> = { start: 0, segment: 134, decide: 268, execute: 402, response: 536, learn: 836, next: 970 };
const OX = 684, OW = 116, OH = 40;
const OY: Record<Outcome, number> = { paid: MID - 50, none: MID, feedback: MID + 50 };

function FlowStepper({ step, visited, outcome, onPick }: {
  step: Step | null; visited: Set<Step>; outcome: Outcome | null; onPick: (s: Step) => void;
}) {
  const state = (s: Step) => (step === s ? "on" : visited.has(s) ? "done" : "idle");
  const reached = (s: Step) => visited.has(s);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.max(0.8, Math.min(1, e.contentRect.width / CW))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="overflow-x-auto px-5 pb-4 pt-1">
      <div style={{ width: CW * scale, height: CH * scale }} className="mx-auto">
      <div className="relative origin-top-left" style={{ width: CW, height: CH, transform: `scale(${scale})` }}>
        <svg width={CW} height={CH} className="absolute inset-0" aria-hidden>
          <defs>
            <marker id="sj-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0L8 4L0 8z" className="fill-line-strong" />
            </marker>
            <marker id="sj-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0L8 4L0 8z" className="fill-primary-500" />
            </marker>
          </defs>
          {(["start", "segment", "decide", "execute"] as Step[]).map((s, i) => {
            const nx = X[ORDER[i + 1]], on = reached(ORDER[i + 1]);
            return <path key={s} d={`M${X[s] + W + 2} ${MID}H${nx - 4}`} strokeWidth="1.5" fill="none"
              className={on ? "stroke-primary-500" : "stroke-line-strong"} markerEnd={on ? "url(#sj-arrow-on)" : "url(#sj-arrow)"} />;
          })}
          {(Object.keys(OY) as Outcome[]).map((o) => {
            const on = outcome === o && reached("response");
            return (
              <g key={o} fill="none" strokeWidth="1.5" className={on ? "stroke-primary-500" : "stroke-line-strong"}>
                <path d={`M${X.response + W + 2} ${MID}C${X.response + W + 30} ${MID} ${OX - 30} ${OY[o]} ${OX - 4} ${OY[o]}`} markerEnd={on ? "url(#sj-arrow-on)" : "url(#sj-arrow)"} />
                <path d={`M${OX + OW + 2} ${OY[o]}C${OX + OW + 24} ${OY[o]} ${X.learn - 24} ${MID} ${X.learn - 4} ${MID}`} markerEnd={on && reached("learn") ? "url(#sj-arrow-on)" : "url(#sj-arrow)"} />
              </g>
            );
          })}
          <path d={`M${X.learn + W + 2} ${MID}H${X.next - 4}`} strokeWidth="1.5" fill="none"
            className={reached("next") ? "stroke-primary-500" : "stroke-line-strong"} markerEnd={reached("next") ? "url(#sj-arrow-on)" : "url(#sj-arrow)"} />
          <path d={`M${X.next + W / 2} ${MID - H / 2 - 2}V22Q${X.next + W / 2} 12 ${X.next + W / 2 - 10} 12H${X.decide + W / 2 + 10}Q${X.decide + W / 2} 12 ${X.decide + W / 2} 22V${MID - H / 2 - 4}`}
            strokeWidth="1.5" strokeDasharray="5 4" fill="none" className="stroke-line-strong" markerEnd="url(#sj-arrow)" />
        </svg>
        <span className="absolute -translate-x-1/2 rounded-full border border-line bg-surface px-2.5 py-0.5 text-2xs text-fg-3"
          style={{ left: (X.decide + X.next + W) / 2, top: 3 }}>Learns, then decides again</span>

        {ORDER.map((s, i) => {
          const st = state(s), Icon = STEP[s].icon, click = reached(s) && step !== s;
          return (
            <button key={s} type="button" onClick={() => onPick(s)} disabled={!click} aria-current={st === "on" ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${STEP[s].title}`}
              className={clsx("absolute flex flex-col items-center justify-center gap-1.5 rounded-xl border px-1.5 text-center transition-[background-color,border-color,box-shadow] duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300",
                st === "on" && "border-primary-500 bg-primary-500 text-white shadow-[0_6px_16px_-8px_rgba(29,54,90,0.6)]",
                st === "done" && "border-primary-500/60 bg-surface text-fg hover:bg-primary-50",
                st === "idle" && "border-line bg-surface-sunken text-fg-3",
                click ? "cursor-pointer" : "cursor-default",
                s === "response" && "rounded-[14px]")}
              style={{ left: X[s], top: MID - H / 2, width: W, height: H }}>
              <span className={clsx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                st === "on" ? "bg-white/15" : st === "done" ? "bg-primary-50 text-primary-500" : "bg-surface text-fg-3")}>
                {st === "done" ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
              </span>
              <span className="text-[11px] font-medium leading-[13px]">{STEP[s].short[0]}<br />{STEP[s].short[1]}</span>
            </button>
          );
        })}
        {(Object.keys(OY) as Outcome[]).map((o) => {
          const on = outcome === o && reached("response"), O = OUTCOME[o];
          return (
            <span key={o} className={clsx("absolute flex items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium leading-[13px] transition-colors duration-200",
              on ? (o === "paid" ? "border-good/40 bg-good-bg text-good" : "border-primary-500/60 bg-primary-50 text-fg") : "border-line bg-surface text-fg-3")}
              style={{ left: OX, top: OY[o] - OH / 2, width: OW, height: OH }}>
              <O.icon className="h-3.5 w-3.5 shrink-0" />{o === "none" ? "No payment / reply" : O.label}
            </span>
          );
        })}
      </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- systems */

type Flow = { from: Sys; to: Sys; msg: string; code?: string };

function Sequence({ active, flows }: { active: Sys[]; flows: Flow[] }) {
  const col = (s: Sys) => SYSTEMS.findIndex((x) => x.id === s);
  return (
    <div className="px-5 py-5">
      <div className="grid grid-cols-5 gap-2">
        {SYSTEMS.map((s) => {
          const on = active.includes(s.id);
          return (
            <div key={s.id} className="flex flex-col items-center text-center">
              <span className={clsx("flex h-10 w-10 items-center justify-center rounded-xl border transition-colors duration-200",
                on ? "border-primary-500 bg-primary-500 text-white" : "border-line bg-surface-sunken text-fg-3")}>
                <s.icon className="h-[18px] w-[18px]" /></span>
              <p className={clsx("mt-1.5 text-[11.5px] font-semibold leading-4", on ? "text-fg" : "text-fg-3")}>{s.name}</p>
              <p className="hidden text-2xs leading-4 text-fg-3 2xl:block">{s.what}</p>
            </div>
          );
        })}
      </div>
      <div className="relative mt-3">
        {SYSTEMS.map((s, i) => (
          <span key={s.id} aria-hidden className={clsx("absolute inset-y-0 w-px border-l border-dashed", active.includes(s.id) ? "border-primary-300" : "border-line")}
            style={{ left: `${(i + 0.5) * 20}%` }} />
        ))}
        <ol className="relative space-y-1">
          {flows.map((f, i) => {
            const a = col(f.from), b = col(f.to), self = a === b, lo = Math.min(a, b), hi = Math.max(a, b);
            const right = b >= a;
            return (
              <li key={`${i}-${f.msg}`} className="pb-3 pt-2">
                <div className="relative h-6">
                  {self ? (
                    <span data-wire className="absolute top-1 h-4 w-8 rounded-r-md border-2 border-l-0 border-primary-500"
                      style={{ left: `${(a + 0.5) * 20}%`, transformOrigin: "left center" }} />
                  ) : (
                    <span data-wire className="absolute top-[11px] h-0.5 bg-primary-500"
                      style={{ left: `${(lo + 0.5) * 20}%`, width: `${(hi - lo) * 20}%`, transformOrigin: right ? "left center" : "right center" }}>
                      <span className={clsx("absolute top-1/2 h-0 w-0 -translate-y-1/2 border-y-[5px] border-y-transparent",
                        right ? "-right-0.5 border-l-[7px] border-l-primary-500" : "-left-0.5 border-r-[7px] border-r-primary-500")} />
                    </span>
                  )}
                  <span className="absolute top-0 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border-2 border-surface bg-primary-500 text-[10.5px] font-semibold text-white"
                    style={{ left: `${(a + 0.5) * 20}%` }}>{i + 1}</span>
                </div>
                <div data-wire-label className="relative mt-1 rounded-lg border border-line bg-surface px-3 py-2">
                  <p className="text-2xs font-medium text-fg-3">{SYSTEMS[a].name}{!self && <> <ArrowRight className="mx-0.5 inline h-3 w-3" /> {SYSTEMS[b].name}</>}</p>
                  <p className="mt-0.5 text-sm leading-5 text-fg">{f.msg}</p>
                  {f.code && <code className="mt-1.5 block whitespace-pre-wrap break-all rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-[11.5px] leading-4 text-fg-2">{f.code}</code>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the pieces */

function StepIcon({ step }: { step: Step }) {
  const Icon = STEP[step].icon;
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white"><Icon className="h-5 w-5" /></span>;
}
const Lead = ({ children, muted }: { children: ReactNode; muted?: boolean }) =>
  <p data-rise className={clsx("leading-6", muted ? "text-sm text-fg-2" : "text-[15px] text-fg")}>{children}</p>;
function Callout({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div data-rise className="flex gap-3 rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm leading-6 text-fg-2">
      <Icon className="mt-1 h-4 w-4 shrink-0 text-primary-500" /><div>{children}</div>
    </div>
  );
}
const RuleCheck = ({ text }: { text: string }) => (
  <div data-rise className="flex items-start gap-3 rounded-lg border border-info/20 bg-info-bg px-4 py-3 text-sm leading-6">
    <ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-info" />
    <p><span className="font-semibold text-fg">Rule check.</span> <span className="text-fg-2">{text}</span></p>
  </div>
);
const Fact = ({ label, value }: { label: string; value: ReactNode }) => (
  <div data-rise className="min-w-0"><p className="text-2xs text-fg-3">{label}</p><p className="num mt-0.5 truncate text-sm font-semibold text-fg">{value}</p></div>
);
const firstName = (a: Account) => (a.product === "Small Business Card" ? a.name : a.name.split(" ")[0]);

/** Where the account sits in its life: collections, charge-off, recovery. */
function LifeLine({ account: a, chargeOffDpd }: { account: Account; chargeOffDpd: number }) {
  const days = Math.max(0, Math.round((Date.now() - new Date(a.charge_off_date).getTime()) / 86_400_000));
  return (
    <div data-rise className="rounded-xl border border-line px-5 py-4">
      <div className="relative grid grid-cols-3">
        <span className="absolute left-[16.6%] right-[16.6%] top-[7px] h-0.5 bg-line" />
        <span className="absolute left-1/2 right-[16.6%] top-[7px] h-0.5 bg-primary-500" />
        {[["Collections", `Up to ${chargeOffDpd} days past due`, false],
          ["Charged off", dateOnly(a.charge_off_date), true],
          ["Recovery", `${days} days so far · ${a.status}`, true]].map(([t, s, on], i) => (
          <div key={i} className="relative flex flex-col items-center text-center">
            <span className={clsx("h-4 w-4 rounded-full border-2", on ? "border-primary-500 bg-primary-500" : "border-line-strong bg-surface", i === 2 && "ring-4 ring-primary-100")} />
            <p className="mt-2 text-sm font-semibold text-fg">{t}</p>
            <p className="text-xs text-fg-3">{s}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
        <Fact label="Charge-off balance" value={money(a.charge_off_balance)} />
        <Fact label="Amount recovered" value={money(a.recovered)} />
        <Fact label="Current recovery balance" value={money(a.remaining)} />
        <Fact label="Payments since charge-off" value={a.payments ? `${a.payments}, last ${dateOnly(a.last_payment)}` : "None"} />
      </div>
    </div>
  );
}

function TreatmentCard({ t, belief, uplift, chance, allowed, draw, chosen }: {
  t: Treatment; belief: Belief | undefined; uplift: number; chance: number; allowed: boolean; draw: number | undefined; chosen: boolean;
}) {
  if (!belief) {
    return (
      <div data-rise className="flex flex-col rounded-xl border border-line bg-surface-sunken p-4">
        <p className="text-sm font-semibold text-fg-3">{t.name}</p>
        <p className="text-xs text-fg-3">Not allowed by the rules</p>
        <p className="mt-3 text-xs leading-5 text-fg-3">Never offered to accounts in this segment, so there is no record for it.</p>
      </div>
    );
  }
  return (
    <div data-rise className={clsx("relative flex flex-col rounded-xl border p-4 transition-colors",
      chosen ? "border-primary-500 bg-primary-50 shadow-[inset_0_0_0_1px_theme(colors.primary.500)]" : "border-line",
      !allowed && "bg-surface-sunken")}>
      {chosen && <span className="absolute -top-2.5 left-4 rounded-full bg-primary-500 px-2 py-0.5 text-[10.5px] font-semibold text-white">Chosen</span>}
      <p className={clsx("text-sm font-semibold", allowed ? "text-fg" : "text-fg-3")}>{t.name}</p>
      <p className="text-xs text-fg-3">{allowed ? t.channel : "Not allowed by the rules"}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div><p className="text-2xs text-fg-3">Pay rate</p><p className={clsx("num whitespace-nowrap text-base font-semibold", allowed ? "text-fg" : "text-fg-3")}>{pct(rate(belief))}</p></div>
        <div><p className="text-2xs text-fg-3">Uplift</p><p className={clsx("num whitespace-nowrap text-base font-semibold", !allowed ? "text-fg-3" : uplift > 0 ? "text-good" : "text-bad")}>{points(uplift)}</p></div>
      </div>
      <p className="mt-1 text-2xs text-fg-3">{belief.s} of {belief.s + belief.f} paid in this segment</p>
      <div className="mt-3">
        <div className="flex justify-between text-2xs text-fg-3"><span>Chance it is the best</span><span className="num font-medium text-fg-2">{pct(chance, 0)}</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-hover">
          <div className={clsx("h-full rounded-full", chosen ? "bg-primary-500" : "bg-primary-200")} style={{ width: `${Math.round(chance * 100)}%` }} />
        </div>
      </div>
      <p className="mt-3 border-t border-line pt-2 text-2xs text-fg-3">
        This draw: <span className={clsx("num font-semibold", chosen ? "text-primary-500" : "text-fg-2")}>{allowed && draw !== undefined ? pct(draw) : "—"}</span>
      </p>
    </div>
  );
}

function Preview({ account, code, share }: { account: Account; code: string; share: number }) {
  if (code === "R3") {
    return (
      <div data-rise className="rounded-xl border border-line p-4">
        <p className="mb-3 flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3"><Phone className="h-3.5 w-3.5" />Specialist call plan</p>
        <ol className="space-y-2 text-sm text-fg-2">
          {[`Call ${firstName(account)} within two working days`, "Confirm identity and listen to their situation",
            `Agree a way to clear ${money(account.remaining)}: a plan, a settlement, or hardship support`, "Record the outcome on the account"].map((s, i) => (
            <li key={i} className="flex gap-2.5"><span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-fg-2">{i + 1}</span>{s}</li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <div data-rise className="rounded-xl border border-line bg-surface-sunken p-4">
      <p className="mb-3 flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3"><Smartphone className="h-3.5 w-3.5" />What the customer receives</p>
      <div className="max-w-[300px] rounded-2xl rounded-tl-md bg-surface px-4 py-3 text-sm leading-6 text-fg shadow-card">
        {message(account, code, share)}
      </div>
      <p className="mt-2 text-2xs text-fg-3">From {account.product === "Small Business Card" ? "Business" : "Card"} Services · {code === "R1" ? "also sent by letter" : "with a secure payment link"}</p>
    </div>
  );
}

/** A treatment's belief before and after one outcome, drawn as two curves. */
function BeliefCurves({ name, before, after }: { name: string; before: Belief; after: Belief }) {
  const m = rate(after), sd = Math.sqrt((m * (1 - m)) / (3 + after.s + after.f));
  const lo = Math.max(0.001, m - 4.2 * sd), hi = Math.min(0.999, m + 4.2 * sd);
  const w = 520, h = 120, n = 90;
  const xs = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  const ya = xs.map((x) => betaPdf(x, before)), yb = xs.map((x) => betaPdf(x, after));
  const top = Math.max(...ya, ...yb) * 1.08;
  const path = (ys: number[]) => xs.map((x, i) => `${i ? "L" : "M"}${((x - lo) / (hi - lo)) * w} ${h - (ys[i] / top) * h}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <div data-rise className="rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-fg">What CARE believes about {name}</p>
        <div className="flex items-center gap-4 text-2xs text-fg-3">
          <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-dashed border-fg-3" />Before · {pct(rate(before))}</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-primary-500" />After · {pct(rate(after))}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h + 18}`} className="mt-2 w-full" role="img" aria-label={`${name}: payment rate belief moved from ${pct(rate(before))} to ${pct(rate(after))}`}>
        <path d={`${path(yb)}V${h}H0Z`} className="fill-primary-500/10" />
        <path d={path(ya)} fill="none" strokeWidth="1.5" strokeDasharray="5 4" className="stroke-fg-3" />
        <path d={path(yb)} fill="none" strokeWidth="2" className="stroke-primary-500" />
        <line x1="0" x2={w} y1={h} y2={h} className="stroke-line" />
        {ticks.map((v, i) => (
          <text key={i} x={((v - lo) / (hi - lo)) * w} y={h + 14} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="fill-fg-3 text-[10.5px]">{pct(v, 0)}</text>
        ))}
      </svg>
      <p className="text-2xs text-fg-3">Payment rate. The narrower the curve, the surer CARE is.</p>
    </div>
  );
}

const points = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)} points`;

/** What happens with no contact: the line every treatment is measured against. */
function Baseline({ control, share, hold }: { control: Belief; share: number; hold: boolean }) {
  return (
    <div data-rise className={clsx("flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3",
      hold ? "border-warn/30 bg-warn-bg" : "border-line bg-surface-sunken")}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{hold ? "Held back this attempt: no contact" : "Comparison check: treated"}</p>
        <p className="text-xs leading-5 text-fg-2">
          {pct(share, 0)} of decisions are held back at random with no contact. In this segment {control.s} of {control.s + control.f} held-back
          accounts paid, a {pct(rate(control))} rate; each treatment's uplift is its rate above that.
        </p>
      </div>
      <div className="text-right">
        <p className="text-2xs text-fg-3">Pay rate with no contact</p>
        <p className="num text-lg font-semibold text-fg">{pct(rate(control))}</p>
      </div>
    </div>
  );
}

function ScoreCard({ title, score, factors }: { title: string; score: number; factors: Factor[] }) {
  const level = score >= 65 ? "High" : score >= 35 ? "Medium" : "Low";
  return (
    <div data-rise className="rounded-lg border border-line px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-2xs text-fg-3">{title}</p>
        <p className="text-2xs font-medium text-fg-2">{level}</p>
      </div>
      <p className="num mt-0.5 text-2xl font-semibold text-fg">{score}<span className="text-sm font-normal text-fg-3"> / 100</span></p>
      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-hover">
        <span className="absolute inset-y-0 left-[35%] w-px bg-surface" /><span className="absolute inset-y-0 left-[65%] w-px bg-surface" />
        <span className="block h-full rounded-full bg-primary-500" style={{ width: `${score}%` }} />
      </div>
      <ul className="mt-3 space-y-1">
        {factors.map((f) => (
          <li key={f.label} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-fg-2">{f.label} <span className="text-fg-3">· {f.weight}</span></span>
            <span className="num font-medium text-fg">{f.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpliftBars({ treatments, before, after }: { treatments: Treatment[]; before: Beliefs; after: Beliefs }) {
  const up = (b: Beliefs, c: string) => rate(b[c]) - rate(b[CONTROL]);
  const max = Math.max(0.05, ...treatments.flatMap((t) => [up(before, t.code), up(after, t.code)]));
  return (
    <ul className="space-y-2.5">
      {treatments.map((t) => {
        const a = up(before, t.code), b = up(after, t.code), d = b - a;
        return (
          <li key={t.code} className="grid grid-cols-[120px_minmax(0,1fr)_96px] items-center gap-3 text-sm">
            <span className="truncate text-fg-2">{t.name}</span>
            <span className="relative h-2.5 overflow-hidden rounded-full bg-surface-hover">
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary-200" style={{ width: `${Math.max(0, a / max) * 100}%` }} />
              <span className="absolute inset-y-[3px] left-0 rounded-full bg-primary-500 transition-[width] duration-500" style={{ width: `${Math.max(0, b / max) * 100}%` }} />
            </span>
            <span className="num text-right text-xs">
              <span className="font-semibold text-fg">{points(b)}</span>{" "}
              <span className={clsx(Math.abs(d) < 0.0005 ? "text-fg-3" : d > 0 ? "text-good" : "text-bad")}>{Math.abs(d) < 0.0005 ? "" : `${d > 0 ? "▲" : "▼"}${Math.abs(d * 100).toFixed(1)}`}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ChanceBars({ treatments, before, after }: { treatments: Treatment[]; before: Record<string, number>; after: Record<string, number> }) {
  return (
    <ul className="space-y-2.5">
      {treatments.map((t) => {
        const d = after[t.code] - before[t.code];
        return (
          <li key={t.code} className="grid grid-cols-[120px_minmax(0,1fr)_64px] items-center gap-3 text-sm">
            <span className="truncate text-fg-2">{t.name}</span>
            <span className="relative h-2.5 overflow-hidden rounded-full bg-surface-hover">
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary-200" style={{ width: `${before[t.code] * 100}%` }} />
              <span className="absolute inset-y-[3px] left-0 rounded-full bg-primary-500 transition-[width] duration-500" style={{ width: `${after[t.code] * 100}%` }} />
            </span>
            <span className="num text-right text-xs">
              <span className="font-semibold text-fg">{pct(after[t.code], 0)}</span>{" "}
              <span className={clsx(Math.abs(d) < 0.005 ? "text-fg-3" : d > 0 ? "text-good" : "text-bad")}>{Math.abs(d) < 0.005 ? "" : `${d > 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}`}</span>
            </span>
          </li>
        );
      })}
      <li className="flex items-center gap-4 pt-1 text-2xs text-fg-3">
        <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-primary-200" />Before</span>
        <span className="flex items-center gap-1.5"><span className="h-1 w-4 rounded-full bg-primary-500" />After</span>
      </li>
    </ul>
  );
}

function Trail({ attempts, byCode }: { attempts: Attempt[]; byCode: Record<string, Treatment> }) {
  return (
    <section className="rounded-xl border border-line bg-surface px-5 py-4 shadow-card">
      <p className="mb-3 text-sm font-semibold text-fg">Journey so far</p>
      <ol className="flex flex-wrap items-center gap-2">
        {attempts.filter((a) => a.outcome).map((a, i) => {
          const O = OUTCOME[a.outcome as Outcome];
          return (
            <li key={a.n} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="h-3.5 w-3.5 text-fg-3" />}
              <span className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                <span className="text-2xs text-fg-3">#{a.n}</span>
                <span className="font-medium text-fg">{byCode[a.code].name}</span>
                <O.icon className={clsx("h-3.5 w-3.5", a.outcome === "paid" ? "text-good" : "text-fg-3")} />
                <span className="text-fg-2">{O.label}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <section className="grid gap-6 rounded-xl border border-line bg-surface px-6 py-6 shadow-card lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-fg">Follow one account through recovery</h2>
        <p className="mt-2 max-w-xl text-[15px] leading-6 text-fg-2">
          Each step shows what the business does and, beside it, which systems take part and what they pass to each other.
          At the customer's response you choose what happens, and the learning engine shows how that changes the next decision.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={onStart}>Start journey</Button>
          <span className="text-xs text-fg-3">About two minutes · arrow keys move between steps</span>
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
        {[[Users, "Business journey", "Segmentation, the offer, the customer's answer"],
          [Cpu, "Technical journey", "Host system, recovery, AI, execution and learning engines"],
          [TrendingUp, "Learning loop", "Every outcome changes the next best strategy"]].map(([Icon, t, s], i) => {
          const I = Icon as LucideIcon;
          return (
            <li key={i} className="rounded-lg border border-line px-4 py-3">
              <I className="h-4 w-4 text-primary-500" />
              <p className="mt-2 text-sm font-semibold text-fg">{t as string}</p>
              <p className="text-xs leading-5 text-fg-3">{s as string}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- the content */

function settle(a: Account, code: string, o: Outcome, share: number) {
  const first = firstName(a);
  if (code === CONTROL) {
    const paid = Math.max(50, Math.round((a.remaining * 0.1) / 50) * 50);
    return o === "paid"
      ? { story: `${first} paid ${money(paid)} on their own, with no contact.`, status: "Partial Recovery", received: paid }
      : { story: `No contact was made, and no payment came in within 30 days.`, status: a.status, received: 0 };
  }
  if (o === "none") return { story: `No reply from ${first} and no payment within 30 days.`, status: a.status, received: 0 };
  if (o === "feedback") return { story: `${first} replied: "${FEEDBACK}"`, status: a.status, received: 0 };
  if (code === "R1") {
    const agreed = Math.round((a.remaining * share) / 50) * 50, paid = Math.round(agreed / 4);
    return { story: `${first} accepted a settlement of ${money(agreed)} for the ${money(a.remaining)} left, and paid the first of four payments, ${money(paid)}.`, status: "Settlement Agreement", received: paid };
  }
  if (code === "R2") return { story: `${first} paid the full ${money(a.remaining)} in one payment.`, status: "Paid in Full", received: a.remaining };
  const monthly = Math.round(a.remaining / 12);
  return { story: `The specialist agreed a 12-month plan of ${money(monthly)} a month with ${first}, and the first payment arrived.`, status: "Payment Plan", received: monthly };
}

function message(a: Account, code: string, share: number) {
  const first = firstName(a);
  if (code === "R1") return `Hi ${first}, we can close your ${a.product} account for ${money(Math.round((a.remaining * share) / 50) * 50)} instead of ${money(a.remaining)}, paid by the end of next month. Reply YES to accept, or call us to talk it through. Reply STOP to opt out.`;
  return `Hi ${first}, your ${a.product} balance of ${money(a.remaining)} can be cleared in one secure payment. Pay online by the end of next month, or call us if you need to talk. Reply STOP to opt out.`;
}

function tech(step: Step, a: Account, d: { eligible: string[]; chosen: string; rule: string; hold: boolean },
  cur: Attempt | undefined, result: ReturnType<typeof settle> | null, byCode: Record<string, Treatment>): { active: Sys[]; flows: Flow[] } {
  const t = byCode[cur?.code ?? d.chosen];
  switch (step) {
    case "start": return { active: ["host", "recovery"], flows: [
      { from: "host", to: "recovery", msg: "The bank sends the account with its status.", code: `get_recovery_strategy(account_id="${a.account_number}", account_status="charged_off", current_balance=${a.remaining})` },
      { from: "recovery", to: "recovery", msg: `Classified as recovery and filed as ${a.account_number}, status ${a.status}.` },
    ] };
    case "segment": return { active: ["recovery"], flows: [
      { from: "recovery", to: "recovery", msg: "Reads the holder type, balance left, payments since charge-off and time in recovery, and assigns the segment." },
      { from: "recovery", to: "recovery", msg: "Names are tokenised in logs and traces; card numbers and government IDs are dropped before anything is stored." },
    ] };
    case "decide": return { active: ["recovery", "ai"], flows: [
      { from: "recovery", to: "ai", msg: "Segment, propensity scores and the treatments the rules allow.", code: `eligible = [${d.eligible.join(", ")}]` },
      { from: "ai", to: "ai", msg: d.hold ? "Comparison check: this decision is in the 10% held back at random, so no treatment."
        : "Comparison check: treated. Then draws a payment rate for each allowed treatment from this segment's record and picks the biggest uplift over no contact (Thompson sampling)." },
      { from: "ai", to: "recovery", msg: `${d.hold ? "Held back: no contact" : `Chosen: ${byCode[d.chosen].name}`}. The decision, its reason and every rule checked go to the audit trail.` },
    ] };
    case "execute": return t.code === CONTROL ? { active: ["recovery", "host"], flows: [
      { from: "recovery", to: "host", msg: "No contact this attempt. The account is recorded as held back, so its outcome counts in the comparison group." },
    ] } : { active: ["recovery", "exec", "host"], flows: [
      { from: "recovery", to: "exec", msg: `${t.name} for ${a.account_number}. Channel: ${t.channel}. Timing: ${t.timing}.` },
      ...(t.code === "R1" ? [{ from: "exec" as Sys, to: "exec" as Sys, msg: "Held in the Review Queue until a second person approves the settlement." }] : []),
      { from: "exec", to: "host", msg: "The contact is recorded against the account, so the bank's own teams see it." },
    ] };
    case "response": return { active: ["exec", "host", "learn"], flows: [
      { from: "exec", to: "host", msg: "The customer's payment or reply lands in the bank's systems." },
      { from: "host", to: "learn", msg: cur?.outcome === "feedback" ? "The reply is passed on as feedback." : "The bank reports the outcome.",
        code: cur?.outcome ? (cur.outcome === "feedback" ? `feedback(account_id="${a.account_number}", text="${FEEDBACK}")`
          : `report_payment_outcome(account_id="${a.account_number}", paid=${cur.outcome === "paid"}, amount=${result?.received ?? 0})`) : "waiting for the customer" },
    ] };
    case "learn": return { active: ["learn", "recovery", "host"], flows: [
      { from: "learn", to: "learn", msg: `Updates ${t.code === CONTROL ? "the no-contact record" : `the record for ${t.name}`} in this segment: one more ${cur?.outcome === "paid" ? "payment" : "non-payment"}. Uplift is each treatment's rate less the no-contact rate.` },
      { from: "learn", to: "recovery", msg: result && result.status !== a.status ? `Recovery status becomes ${result.status}.` : "Recovery status stays as it is." },
      { from: "recovery", to: "host", msg: "A signed update goes back to Nova, so the bank's systems stay in step." },
    ] };
    case "next": return { active: cur?.outcome === "paid" ? ["recovery", "host"] : ["learn", "ai", "recovery"], flows: cur?.outcome === "paid" ? [
      { from: "recovery", to: "host", msg: result?.status === "Paid in Full" ? "Account closed for recovery; contact stops." : "Reminders scheduled before each payment is due." },
    ] : [
      { from: "learn", to: "ai", msg: "The updated beliefs, and anything the customer told us, feed the next decision." },
      { from: "ai", to: "recovery", msg: `Next best strategy: ${byCode[d.chosen].name}.` },
    ] };
  }
}
