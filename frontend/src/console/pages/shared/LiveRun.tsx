/** Live run: one customer through a live strategy, step by step. The engine picks
 *  a customer, weighs the treatments (explore or exploit), sends through the
 *  channel, hears back, records the outcome and learns from it. Every step is a
 *  real engine record, so the decision, the message and the outcome can be opened
 *  afterwards like any other. */
import clsx from "clsx";
import {
  ArrowLeft, ArrowRight, BellRing, Check, ClipboardCheck, Pause, Phone, Play, RotateCcw, Scale, Send, Smartphone,
  TrendingDown, TrendingUp, UserRound, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api } from "../../lib/api";
import { money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Avatar, Button, ErrorState, Page, PageHeader, Pills, Select, Spinner, useAction } from "../../ui/ui";

interface Arm { code: string; name: string; channel: string; mean: number; low: number; high: number; p_best: number; learned: number }
interface Weighed extends Arm { allowed: boolean; why_not: string | null; draw: number | null; fit: number | null; score: number | null; chosen: boolean }
interface Contact {
  nudge_id: string; touch: number; channel: string; gateway: string; content: string; status: string; ref: string;
  day: number; sent_at: string; rules_check: string | null; events: { event: string; minutes: number }[];
}
interface Attempt {
  decision_id: string; day: number;
  choice: { treatments: Weighed[]; chosen: { code: string; name: string; channel: string }; mode: "exploit" | "explore" | "named";
    reason: string; fit_reasons: string[]; chosen_share: number | null; set_aside: string | null };
  contacts: Contact[];
  outcome: { outcome_id: number; paid: boolean; amount: number; days_to_pay: number | null; window_days: number; reward: number | null; learned: boolean };
  arms_before: Arm[]; arms_after: Arm[];
}
interface Run {
  scenario: Scenario; started: string;
  strategy: { id: string; name: string; audience: number; waiting: number; window_days: number; tone: string };
  customer: { id: number; name: string; first: string; days_past_due: number; balance: number; past_due: number; risk: string;
    late: string; sms: boolean; app: boolean; missed: number; hardship: boolean };
  attempts: Attempt[];
}
interface StrategyOpt { id: string; name: string; audience: number; waiting: number; window_days: number; treatments: { code: string; name: string; channel: string }[] }

type Scenario = "pays" | "retry";
type Stage = "pick" | "weigh" | "send" | "respond" | "record" | "learn";
const STAGES: Stage[] = ["pick", "weigh", "send", "respond", "record", "learn"];
const STAGE: Record<Stage, { label: string; icon: LucideIcon }> = {
  pick: { label: "Pick customer", icon: UserRound },
  weigh: { label: "Weigh treatments", icon: Scale },
  send: { label: "Send", icon: Send },
  respond: { label: "Customer responds", icon: Smartphone },
  record: { label: "Record outcome", icon: ClipboardCheck },
  learn: { label: "Learn", icon: TrendingUp },
};
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "pays", label: "Pays on the first message" },
  { id: "retry", label: "No answer, then a second try" },
];
// How long each step stays on screen when playing. The reply plays out on the phone first.
const HOLD: Record<Stage, number> = { pick: 3200, weigh: 5200, send: 3400, respond: 5600, record: 3400, learn: 4800 };
const BANK = "Meridian Valley Bank";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const dayDate = (start: string, day: number) =>
  new Date(new Date(start).getTime() + day * 86400000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const after = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const EVENT: Record<string, string> = { Opened: "Opened the message", Clicked: "Tapped the link", FormCompleted: "Filled in the payment form", Answered: "Answered the call", OptOut: "Opted out" };

export default function LiveRun() {
  const { can } = useSession();
  const { data: options, error, loading, reload } = useApi<StrategyOpt[]>("/live-run/strategies");
  const { run: act, busy } = useAction();
  const [strategy, setStrategy] = useState("");
  const [scenario, setScenario] = useState<Scenario>("pays");
  const [trace, setTrace] = useState<Run | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  const usable = useMemo(() => (options ?? []).filter((o) => o.waiting > 0), [options]);
  // A strategy with a text message among three or more treatments shows the choice best.
  useEffect(() => {
    if (strategy || !usable.length) return;
    const rich = usable.filter((o) => o.treatments.length >= 3 && o.treatments.some((t) => t.channel.startsWith("SMS")));
    setStrategy([...(rich.length ? rich : usable)].sort((a, b) => b.waiting - a.waiting)[0].id);
  }, [usable, strategy]);
  const picked = usable.find((o) => o.id === strategy);

  const frames = useMemo(() => (trace?.attempts ?? []).flatMap((_, a) =>
    (a === 0 ? STAGES : STAGES.slice(1)).map((stage) => ({ a, stage }))), [trace]);
  const cur = frames[frame];

  const start = () => act("run", () => api.post<Run>("/live-run", { strategy, scenario }))
    .then((r) => { if (r) { setTrace(r); setFrame(0); setPlaying(true); reload(); } });
  const go = (n: number) => { setFrame(Math.max(0, Math.min(frames.length - 1, n))); };

  useEffect(() => {
    if (!playing || !cur) return;
    if (frame >= frames.length - 1) { setPlaying(false); return; }
    const t = window.setTimeout(() => setFrame((f) => f + 1), HOLD[cur.stage]);
    return () => window.clearTimeout(t);
  }, [playing, frame, frames.length, cur]);

  const keys = useRef({ frame, go });
  keys.current = { frame, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); keys.current.go(keys.current.frame + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); keys.current.go(keys.current.frame - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const header = <PageHeader title="Live run" subtitle="Follow one customer through the engine: pick, send, reply, learn." />;
  if (loading && !options) return <>{header}<Page><Spinner /></Page></>;
  if (error || !options) return <>{header}<Page><ErrorState message={error ?? "Not available"} onRetry={reload} /></Page></>;

  const runner = can("launch_strategy");
  return (
    <>
      {header}
      <Page>
        <section className="rounded-xl border border-line bg-surface shadow-card">
          <div className="flex flex-wrap items-end gap-3 px-5 py-4">
            <label className="block min-w-[240px] flex-1">
              <span className="label">Campaign</span>
              <Select className="mt-1" value={strategy} onChange={(v) => { setStrategy(v); setTrace(null); }}
                options={usable.map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }))} />
            </label>
            <div>
              <span className="label">Scenario</span>
              <div className="mt-1"><Pills options={SCENARIOS} value={scenario} onChange={(v) => { setScenario(v); setTrace(null); }} /></div>
            </div>
            <Button variant="primary" loading={busy === "run"} disabled={!runner || !strategy} onClick={() => void start()}
              icon={trace ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              title={runner ? undefined : "A Strategy Analyst starts a run"}>{trace ? "Run another customer" : "Start"}</Button>
          </div>
          {picked && (
            <p className="border-t border-line px-5 py-2.5 text-[13px] text-fg-2">
              <span className="num font-semibold text-fg">{num(picked.audience)}</span> customers in this campaign ·{" "}
              <span className="num font-semibold text-fg">{num(picked.waiting)}</span> waiting for a first contact · treatments:{" "}
              {picked.treatments.map((t) => t.name).join(", ")}
              {!runner && <span className="text-fg-3"> · A Strategy Analyst starts a run.</span>}
            </p>
          )}
        </section>

        <Stepper trace={trace} cur={cur} frames={frames} frame={frame} onPick={(n) => { setPlaying(false); go(n); }}
          controls={trace && (
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<ArrowLeft className="h-4 w-4" />} disabled={frame === 0} onClick={() => { setPlaying(false); go(frame - 1); }}>Back</Button>
              <Button size="sm" icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                onClick={() => (frame >= frames.length - 1 ? (setFrame(0), setPlaying(true)) : setPlaying((p) => !p))}>
                {playing ? "Pause" : frame >= frames.length - 1 ? "Replay" : "Play"}</Button>
              <Button size="sm" variant="primary" disabled={frame >= frames.length - 1} onClick={() => { setPlaying(false); go(frame + 1); }}>
                Next <ArrowRight className="h-4 w-4" /></Button>
            </div>
          )} />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="min-h-[420px] rounded-xl border border-line bg-surface shadow-card">
            {trace && cur ? <EnginePanel key={frame} run={trace} a={cur.a} stage={cur.stage} />
              : <div className="flex h-full min-h-[420px] items-center justify-center px-6 text-center text-sm text-fg-3">
                  Pick a campaign and a scenario, then start.</div>}
          </section>
          <PhonePanel run={trace} a={cur?.a ?? 0} stage={cur?.stage ?? null} />
        </div>

        {trace && cur && <Record run={trace} a={cur.a} stage={cur.stage} />}
      </Page>
    </>
  );
}

/* ---------------------------------------------------------------- stepper */

function Stepper({ trace, cur, frames, frame, onPick, controls }: {
  trace: Run | null; cur: { a: number; stage: Stage } | undefined; frames: { a: number; stage: Stage }[]; frame: number;
  onPick: (n: number) => void; controls: ReactNode;
}) {
  const at = cur ? STAGES.indexOf(cur.stage) : -1;
  const tries = trace?.attempts.length ?? 0;
  return (
    <section className="rounded-xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">
            {!trace ? "The loop" : tries > 1 ? (cur?.a === 0 ? "First try" : "Second try") : "One try"}</h2>
          <p className="text-xs text-fg-3">{trace ? `Step ${frame + 1} of ${frames.length} · arrow keys move between steps` : "Every customer goes round it; every outcome teaches the engine"}</p>
        </div>
        {controls}
      </header>
      <ol className="grid grid-cols-6 gap-1.5 overflow-x-auto px-5 py-4" aria-label="Steps">
        {STAGES.map((s, n) => {
          const on = n === at, done = n < at || (cur?.a ?? 0) > 0 && s === "pick", Icon = STAGE[s].icon;
          const target = cur ? frames.findIndex((f) => f.a === cur.a && f.stage === s) : -1;
          const jump = target >= 0 ? target : s === "pick" && cur ? 0 : -1;
          return (
            <li key={s} className="relative min-w-[96px]">
              {n > 0 && <span aria-hidden className={clsx("absolute right-1/2 top-[18px] h-0.5 w-full", n <= at ? "bg-primary-500" : "bg-line")} />}
              <button type="button" disabled={jump < 0} onClick={() => onPick(jump)} aria-current={on ? "step" : undefined}
                className="relative z-10 flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-lg px-1 py-1 text-center disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300">
                <span className={clsx("flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors duration-200",
                  on ? "border-primary-500 bg-primary-500 text-white" : done ? "border-primary-500 bg-surface text-primary-500" : "border-line bg-surface text-fg-3")}>
                  <Icon className="h-4 w-4" /></span>
                <span className={clsx("text-[11.5px] leading-4", on ? "font-semibold text-fg" : done ? "text-fg-2" : "text-fg-3")}>{STAGE[s].label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ----------------------------------------------------------- engine panel */

function EnginePanel({ run, a, stage }: { run: Run; a: number; stage: Stage }) {
  const at = run.attempts[a];
  const Icon = STAGE[stage].icon;
  const title = {
    pick: `${run.customer.name} is next`,
    weigh: a > 0 ? "What to try next" : "Which treatment?",
    send: `${at.choice.chosen.name} goes out`,
    respond: at.outcome.paid ? `${run.customer.first} pays` : `No answer from ${run.customer.first}`,
    record: at.outcome.paid ? "Recorded as a success" : "Recorded as a miss",
    learn: at.outcome.paid ? `${at.choice.chosen.name} gains` : `${at.choice.chosen.name} loses ground`,
  }[stage];
  return (
    <div className="lr-in">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white"><Icon className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">{STAGE[stage].label}{run.attempts.length > 1 ? ` · ${a === 0 ? "first" : "second"} try` : ""}</p>
          <h3 className="text-[17px] font-semibold leading-6 text-fg">{title}</h3>
        </div>
      </header>
      <div className="p-5">
        {stage === "pick" && <Pick run={run} />}
        {stage === "weigh" && <Weigh run={run} at={at} />}
        {stage === "send" && <Sent run={run} at={at} />}
        {stage === "respond" && <Respond run={run} at={at} />}
        {stage === "record" && <Outcome run={run} at={at} />}
        {stage === "learn" && <Learn run={run} at={at} last={a === run.attempts.length - 1} />}
      </div>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="rounded-lg border border-line px-3 py-2.5">
    <p className="text-2xs text-fg-3">{label}</p>
    <p className="num mt-0.5 text-[15px] font-semibold text-fg">{value}</p>
  </div>
);

function Pick({ run }: { run: Run }) {
  const c = run.customer;
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-2">
        From <span className="num font-semibold text-fg">{num(run.strategy.audience)}</span> customers in {run.strategy.name},{" "}
        <span className="num font-semibold text-fg">{num(run.strategy.waiting)}</span> were waiting. The engine takes the next one.
      </p>
      <div className="flex items-center gap-3">
        <Avatar name={c.name} />
        <div>
          <p className="text-[15px] font-semibold text-fg">{c.name}</p>
          <Link to={`/journeys/${c.id}`} className="text-xs text-azure hover:underline">Customer {c.id}</Link>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Fact label="Days late" value={`${c.days_past_due} days`} />
        <Fact label="Past due" value={money(c.past_due)} />
        <Fact label="Balance" value={money(c.balance)} />
        <Fact label="Bank risk" value={c.risk} />
        <Fact label="Text messages" value={c.sms ? "Replies" : "Rarely replies"} />
        <Fact label="Bank app" value={c.app ? "Uses it" : "Does not use it"} />
      </div>
    </div>
  );
}

/** Thompson sampling, drawn: each bar is the range a treatment's payment rate is
 *  likely in, the line is its record so far, the dot is the value drawn for this
 *  customer. The highest draw (after customer fit) is sent. */
function Weigh({ run, at }: { run: Run; at: Attempt }) {
  const ch = at.choice;
  const max = Math.min(1, Math.ceil((Math.max(...ch.treatments.map((t) => Math.max(t.high, t.score ?? 0))) + 0.05) * 10) / 10);
  const x = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx("rounded-md px-2 py-0.5 text-xs font-semibold", ch.mode === "explore" ? "border border-primary-500 text-primary-500" : "bg-primary-500 text-white")}>
          {{ exploit: "Exploit", explore: "Explore", named: "Set by the strategy" }[ch.mode]}</span>
        <p className="text-sm text-fg-2">{ch.reason}</p>
      </div>
      <div className="space-y-2.5">
        {ch.treatments.map((t) => (
          <div key={t.code} className={clsx("grid grid-cols-[150px_minmax(0,1fr)_92px] items-center gap-3 rounded-lg px-2 py-2",
            t.chosen && "bg-primary-50", !t.allowed && "opacity-60")}>
            <div className="min-w-0">
              <p className={clsx("truncate text-[13px]", t.chosen ? "font-semibold text-fg" : "text-fg")}>{t.name}</p>
              <p className="truncate text-2xs text-fg-3">{t.channel}</p>
            </div>
            {t.allowed ? (
              <div className="relative h-6" title={`Likely ${pct(t.low, 0)} to ${pct(t.high, 0)}; record ${pct(t.mean)}; draw ${pct(t.score ?? 0)}`}>
                <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
                <span className="lr-grow absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-primary-100" style={{ left: x(t.low), width: `calc(${x(t.high)} - ${x(t.low)})` }} />
                <span className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-primary-500" style={{ left: x(t.mean) }} />
                <span className={clsx("lr-drop absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface",
                  t.chosen ? "bg-primary-500" : "bg-fg-3")} style={{ left: x(t.score ?? 0) }} />
              </div>
            ) : <p className="text-xs text-fg-3">{t.why_not}</p>}
            <p className="num text-right text-[13px]">
              {t.allowed ? <><span className={t.chosen ? "font-semibold text-fg" : "text-fg-2"}>{(t.score ?? 0).toFixed(2)}</span>
                {t.chosen && <Check className="ml-1 inline h-3.5 w-3.5 text-primary-500" />}</> : <span className="text-fg-3">—</span>}
            </p>
          </div>
        ))}
        <div className="grid grid-cols-[150px_minmax(0,1fr)_92px] gap-3 px-2 text-2xs text-fg-3">
          <span />
          <span className="flex justify-between"><span>0%</span><span>{pct(max, 0)} paid</span></span>
          <span className="text-right">Draw</span>
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-3">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-5 rounded-full bg-primary-100" />Likely range</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 bg-primary-500" />Record so far</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-primary-500" />Draw for {run.customer.first}</span>
        {ch.chosen_share !== null && <span>Picked {pct(ch.chosen_share, 0)} of the time for a customer like this</span>}
      </p>
    </div>
  );
}

function Sent({ run, at }: { run: Run; at: Attempt }) {
  const m = at.contacts[0];
  const rows = [
    { label: "Contact rules", detail: m.rules_check ?? "Passed" },
    { label: m.gateway, detail: `Sent ${dayDate(run.started, m.day)}, ${clock(m.sent_at)} · ref ${m.ref}` },
    { label: "Delivered", detail: `To ${run.customer.first}'s phone` },
  ];
  return (
    <div className="space-y-4">
      <ol className="space-y-0">
        {rows.map((r, i) => (
          <li key={r.label} className="lr-rise relative flex gap-3 pb-4 last:pb-0" style={{ animationDelay: `${i * 220}ms` }}>
            {i < rows.length - 1 && <span aria-hidden className="absolute left-[11px] top-6 h-full w-px bg-line" />}
            <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-good-bg text-good"><Check className="h-3.5 w-3.5" /></span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg">{r.label}</p>
              <p className="text-xs text-fg-3">{r.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <blockquote className="rounded-lg border border-line bg-surface-sunken px-3.5 py-3 text-[13px] leading-5 text-fg-2">{m.content}</blockquote>
    </div>
  );
}

function Respond({ run, at }: { run: Run; at: Attempt }) {
  const o = at.outcome;
  const rows: { when: string; text: string; strong?: boolean }[] = [];
  for (const m of at.contacts) {
    rows.push({ when: `Day ${m.day}`, text: m.touch === 1 ? `${m.channel} delivered` : `Reminder ${m.touch - 1} delivered` });
    for (const e of m.events) rows.push({ when: `+${after(e.minutes)}`, text: EVENT[e.event] ?? e.event });
    if (!m.events.length) rows.push({ when: "", text: "Not opened" });
  }
  rows.push(o.paid
    ? { when: `Day ${at.day + (o.days_to_pay ?? 0)}`, text: `Paid ${money(o.amount)} of ${money(run.customer.past_due)} past due`, strong: true }
    : { when: `Day ${at.day + o.window_days}`, text: `${o.window_days} days passed with no payment`, strong: true });
  return (
    <ol className="space-y-2">
      {rows.map((r, i) => (
        <li key={i} className="lr-rise grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-[13px]" style={{ animationDelay: `${i * 160}ms` }}>
          <span className="num text-fg-3">{r.when}</span>
          <span className={r.strong ? (o.paid ? "font-semibold text-good" : "font-semibold text-fg") : "text-fg-2"}>{r.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Outcome({ run, at }: { run: Run; at: Attempt }) {
  const o = at.outcome;
  return (
    <div className="space-y-4">
      <div className={clsx("rounded-lg border px-4 py-3", o.paid ? "border-good/25 bg-good-bg" : "border-line bg-surface-sunken")}>
        <p className={clsx("text-[22px] font-semibold", o.paid ? "text-good" : "text-fg")}>{o.paid ? `Paid ${money(o.amount)}` : "No payment"}</p>
        <p className="text-xs text-fg-2">{o.paid ? `On day ${o.days_to_pay}, inside the ${o.window_days}-day window` : `Nothing paid inside the ${o.window_days}-day window`}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Fact label="Counts as" value={o.reward === 1 ? "Success (1)" : "Miss (0)"} />
        <Fact label="Treatment" value={at.choice.chosen.name} />
        <Fact label="Decision" value={<Link to={`/decisions/${at.decision_id}`} className="text-azure hover:underline">{at.decision_id}</Link>} />
        <Fact label="Messages" value={<Link to={`/nudges/${at.contacts[0].nudge_id}`} className="text-azure hover:underline">{at.contacts.length} sent</Link>} />
      </div>
      <p className="text-xs text-fg-3">Saved to {run.customer.first}'s journey and to {run.strategy.name}'s results.</p>
    </div>
  );
}

function Learn({ run, at, last }: { run: Run; at: Attempt; last: boolean }) {
  const code = at.choice.chosen.code;
  const b = at.arms_before.find((x) => x.code === code)!;
  const n = at.arms_after.find((x) => x.code === code)!;
  const up = n.mean >= b.mean;
  const Trend = up ? TrendingUp : TrendingDown;
  const next = at.outcome.paid
    ? `It will be picked a little more often for customers like ${run.customer.first}.`
    : last ? "" : `For ${run.customer.first}, the engine sets it aside and draws again among the rest.`;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <Change label="Expected payment rate" from={pct(b.mean)} to={pct(n.mean)} up={up} />
        <Change label="Chance it is the best" from={pct(b.p_best, 0)} to={pct(n.p_best, 0)} up={n.p_best >= b.p_best} />
        <Change label="Results learned from" from={num(b.learned)} to={num(n.learned)} up />
      </div>
      <p className="flex items-start gap-2 text-sm text-fg-2"><Trend className={clsx("mt-0.5 h-4 w-4 shrink-0", up ? "text-good" : "text-fg-3")} />
        <span>One more {at.outcome.paid ? "success" : "miss"} for {at.choice.chosen.name}. {next}</span></p>
    </div>
  );
}

const Change = ({ label, from, to, up }: { label: string; from: string; to: string; up: boolean }) => (
  <div className="rounded-lg border border-line px-3 py-2.5">
    <p className="text-2xs text-fg-3">{label}</p>
    <p className="num mt-0.5 flex items-baseline gap-1.5 text-[15px]">
      <span className="text-fg-3">{from}</span><ArrowRight className="h-3.5 w-3.5 self-center text-fg-3" />
      <span className={clsx("font-semibold", up ? "text-fg" : "text-fg-2")}>{to}</span>
    </p>
  </div>
);

/* ------------------------------------------------------------------ phone */

interface Bubble { key: string; channel: string; text: string; when: string; read: boolean }

function PhonePanel({ run, a, stage }: { run: Run | null; a: number; stage: Stage | null }) {
  // What has reached the phone by this step: earlier tries in full, this try from "send".
  const bubbles: Bubble[] = [];
  const pays: { attempt: Attempt; step: number }[] = [];
  const [sub, setSub] = useState(0);
  const pos = stage ? STAGES.indexOf(stage) : -1;
  useEffect(() => {
    setSub(0);
    if (stage !== "respond") return;
    if (reduced()) { setSub(3); return; }
    const ts = [700, 1700, 2900].map((ms, i) => window.setTimeout(() => setSub(i + 1), ms));
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [stage, a]);

  if (run) {
    run.attempts.forEach((at, i) => {
      if (i > a || (i === a && pos < STAGES.indexOf("send"))) return;
      const answered = i < a || pos > STAGES.indexOf("respond") || (pos === STAGES.indexOf("respond") && sub >= 1);
      const shown = i < a || pos >= STAGES.indexOf("respond") ? at.contacts : at.contacts.slice(0, 1);
      shown.forEach((m) => bubbles.push({ key: m.nudge_id, channel: m.channel, text: m.content,
        when: `${dayDate(run.started, m.day)}, ${clock(m.sent_at)}`, read: answered && m.events.some((e) => e.event === "Opened" || e.event === "Answered") }));
      if (at.outcome.paid && (i < a || pos >= STAGES.indexOf("respond"))) {
        pays.push({ attempt: at, step: i < a || pos > STAGES.indexOf("respond") ? 3 : sub });
      }
    });
  }
  const pay = pays[pays.length - 1];
  // The newest message is the one that matters: keep it in view, as a phone does.
  const inbox = useRef<HTMLDivElement>(null);
  useEffect(() => { inbox.current?.scrollTo({ top: inbox.current.scrollHeight }); }, [bubbles.length, a, stage]);
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="label self-start lg:self-center">{run ? `${run.customer.first}'s phone` : "Customer's phone"}</p>
      <div className="relative h-[540px] w-[280px] rounded-[38px] border-[10px] border-ink bg-ink shadow-card">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[28px] bg-[#F4F5F8]">
          <div className="flex items-center justify-between px-5 pb-1 pt-2.5 text-[11px] font-semibold text-fg">
            <span>{bubbles.length ? bubbles[bubbles.length - 1].when.split(", ")[1] : "9:41"}</span>
            <span className="h-4 w-16 rounded-full bg-ink" />
            <span className="num">5G</span>
          </div>
          <div className="border-b border-line bg-surface px-4 py-2 text-center">
            <p className="text-[12px] font-semibold text-fg">{BANK}</p>
            <p className="text-[10px] text-fg-3">Messages</p>
          </div>
          <div ref={inbox} className={clsx("flex-1 space-y-2.5 overflow-y-auto px-3 py-3", pay && pay.step >= 1 && "pb-48")}>
            {!bubbles.length && <p className="pt-24 text-center text-xs text-fg-3">No new messages</p>}
            {bubbles.map((b) => <PhoneItem key={b.key} b={b} />)}
          </div>
          {pay && pay.step >= 1 && <PaySheet run={run!} at={pay.attempt} step={pay.step} />}
        </div>
      </div>
    </div>
  );
}

function PhoneItem({ b }: { b: Bubble }) {
  const Icon = b.channel === "App push" ? BellRing : b.channel === "Outbound call" ? Phone : null;
  const body = b.text.split(/(care\.bank\/p\/\w+)/).map((s, i) =>
    /^care\.bank/.test(s) ? <span key={i} className="text-azure underline">{s}</span> : <span key={i}>{s}</span>);
  return (
    <div className="lr-msg">
      <p className="mb-1 text-center text-[9.5px] text-fg-3">{b.when}</p>
      {Icon ? (
        <div className="rounded-2xl bg-surface px-3 py-2.5 shadow-card">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-3"><Icon className="h-3 w-3" />{b.channel === "App push" ? `${BANK} app` : "Call"}</p>
          <p className="mt-1 text-[12px] leading-4 text-fg">{body}</p>
        </div>
      ) : (
        <div className="mr-6 rounded-2xl rounded-bl-md bg-surface px-3 py-2 text-[12px] leading-4 text-fg shadow-card">{body}</div>
      )}
      <p className="mt-0.5 pl-1 text-[9.5px] text-fg-3">{b.read ? "Read" : "Delivered"}</p>
    </div>
  );
}

/** The customer's side of paying: the link opens the bank's payment page, the
 *  customer sets the amount and the date, and the payment arrives that day. */
function PaySheet({ run, at, step }: { run: Run; at: Attempt; step: number }) {
  const o = at.outcome;
  const date = dayDate(run.started, at.day + (o.days_to_pay ?? 0));
  return (
    <div className="lr-sheet absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-line bg-surface px-4 pb-5 pt-3 shadow-card">
      <span className="mx-auto mb-3 block h-1 w-9 rounded-full bg-line-strong" />
      {step < 3 ? (
        <>
          <p className="text-[10px] text-fg-3">care.bank · secure payment</p>
          <p className="mt-1 text-[13px] font-semibold text-fg">{BANK}</p>
          <div className="mt-3 space-y-1.5 text-[12px]">
            <p className="flex justify-between"><span className="text-fg-3">Past due</span><span className="num">{money(run.customer.past_due)}</span></p>
            <p className="flex justify-between"><span className="text-fg-3">Paying</span><span className="num font-semibold">{money(o.amount)}</span></p>
            <p className="flex justify-between"><span className="text-fg-3">On</span><span>{date}</span></p>
          </div>
          <div className={clsx("mt-3 rounded-xl py-2 text-center text-[12px] font-semibold transition-colors duration-300",
            step >= 2 ? "bg-good text-white" : "bg-primary-500 text-white")}>
            {step >= 2 ? <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" />Payment set</span> : `Pay ${money(o.amount)}`}
          </div>
        </>
      ) : (
        <div className="text-center">
          <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-good-bg text-good"><Check className="h-5 w-5" /></span>
          <p className="mt-2 text-[13px] font-semibold text-fg">Payment received</p>
          <p className="num text-[12px] text-fg-2">{money(o.amount)} on {date}</p>
          <p className="mt-1 text-[11px] text-fg-3">Thank you, {run.customer.first}.</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------- strategy record */

/** Every treatment's record in this campaign, as the engine holds it at this step.
 *  It changes at "Learn": the outcome just recorded is counted. */
function Record({ run, a, stage }: { run: Run; a: number; stage: Stage }) {
  const at = run.attempts[a];
  const learned = stage === "learn";
  const arms = learned ? at.arms_after : at.arms_before;
  const changed = at.choice.chosen.code;
  const max = Math.min(1, Math.ceil((Math.max(...at.arms_after.map((x) => x.mean), ...at.arms_before.map((x) => x.mean)) + 0.05) * 10) / 10);
  return (
    <section className="rounded-xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold text-fg">What {run.strategy.name} has learned</h2>
        <p className="text-xs text-fg-3">{learned ? "With this outcome counted" : "Before this outcome"}</p>
      </header>
      <div className="space-y-2.5 px-5 py-4">
        {arms.map((x) => {
          const before = at.arms_before.find((y) => y.code === x.code)!;
          const delta = x.mean - before.mean;
          const hit = learned && x.code === changed;
          return (
            <div key={x.code} className="grid grid-cols-[150px_minmax(0,1fr)_150px] items-center gap-3">
              <div className="min-w-0">
                <p className={clsx("truncate text-[13px]", hit ? "font-semibold text-fg" : "text-fg")}>{x.name}</p>
                <p className="text-2xs text-fg-3">{num(x.learned)} results</p>
              </div>
              <div className="h-2.5 rounded-full bg-surface-sunken">
                <div className={clsx("h-full rounded-full transition-[width] duration-700 ease-out", hit ? "bg-primary-500" : "bg-primary-200")}
                  style={{ width: `${(x.mean / max) * 100}%` }} />
              </div>
              <p className="num text-right text-[13px]">
                <span className="font-semibold text-fg">{pct(x.mean)}</span>
                {hit && Math.abs(delta) >= 0.0005 && <span className="ml-1.5 text-xs text-fg-2">{delta > 0 ? "+" : "−"}{Math.abs(delta * 100).toFixed(1)} pts</span>}
                <span className="block text-2xs text-fg-3">{pct(x.p_best, 0)} chance best</span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

