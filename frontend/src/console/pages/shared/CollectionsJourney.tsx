/** Collections Journey: the demo's storyline, told with the collections book's own
 *  numbers. It starts from the problem, walks the journey as it runs today, shows
 *  how information flows through CARE, how the target base is found, how a
 *  campaign runs on it, where CARE steps in, and what that changes. The recovery
 *  journey sits beside it as a second tab. */
import clsx from "clsx";
import { animate, createScope, stagger, type Scope } from "animejs";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Ban, Boxes, CircleDollarSign, Cpu, Database, Gauge, HeartHandshake, Landmark,
  Layers, MessageSquareText, Repeat, Route as RouteIcon, Scale, Send, ShieldCheck, Target, TrendingUp, Users, Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { money, num, pct, pp } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Button, ErrorState, Page, PageHeader, Spinner, Tabs } from "../../ui/ui";
import StrategyJourney from "./StrategyJourney";

interface Persona {
  customer_id: number; name: string; account_number: string; product: string; cohort_id: string; risk_band: string;
  risk_score: number; balance: number; delinquent_amount: number; days_past_due: number; nudge_score: number;
  self_cure_score: number; group: string; route: string; route_label: string; why: string; reason: string; note: string;
  decision: null | { decision_id: string; strategy: string; campaign_id: string; group: string; treatment: string | null;
    probability: number | null; explanation: string; outcome: string | null; amount: number | null };
}
interface Data {
  problem: { accounts: number; delinquent: number; self_cure: number; do_not_contact: number; needs_support: number; responsive: number };
  cohorts: { cohort_id: string; name: string; dpd_bucket: string; risk_band: string; accounts: number }[];
  groups: { key: string; label: string; accounts: number; route: string; route_label: string; why: string }[];
  routes: Record<"strategy" | "bau" | "hardship" | "suppress", number>;
  personas: Persona[];
  strategies: { campaign_id: string; name: string; status: string; treated: number; payment_rate: number | null;
    control_rate: number | null; lift: number | null; collected: number }[];
  control_pct: number;
  results: { treated: number | null; payment_rate: number | null; control_rate: number | null; lift: number | null; collected_30d: number | null };
}

type Step = "problem" | "today" | "flow" | "target" | "campaign" | "intervene" | "better";
const ORDER: Step[] = ["problem", "today", "flow", "target", "campaign", "intervene", "better"];
const STEP: Record<Step, { title: string; short: string; icon: LucideIcon; lead: string }> = {
  problem: { title: "The problem", short: "The problem", icon: AlertTriangle, lead: "Why collections needs to change" },
  today: { title: "The collections journey today", short: "Journey today", icon: RouteIcon, lead: "What happens to an account that falls behind" },
  flow: { title: "How information flows through CARE", short: "Information flow", icon: Waypoints, lead: "What moves between the bank's systems and CARE" },
  target: { title: "Identify the target base", short: "Target base", icon: Target, lead: "Who should be contacted at all, and who should not" },
  campaign: { title: "Run the campaign", short: "Run the campaign", icon: Send, lead: "How a strategy works on the accounts it is given" },
  intervene: { title: "Where CARE intervenes", short: "Where CARE acts", icon: Layers, lead: "The points in the bank's process where CARE steps in" },
  better: { title: "Better collections", short: "Better collections", icon: TrendingUp, lead: "What changes, and how we know" },
};

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The page: Collections and Recovery journeys as two tabs. */
export default function JourneyPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "recovery" ? "recovery" : "collections";
  const tabs = <Tabs tabs={[{ id: "collections", label: "Collections" }, { id: "recovery", label: "Recovery" }]} active={tab}
    onChange={(t) => setParams(t === "recovery" ? { tab: "recovery" } : {})} />;
  return tab === "recovery" ? <StrategyJourney title="Collections Journey" tabs={tabs} /> : <CollectionsStory tabs={tabs} />;
}

function CollectionsStory({ tabs }: { tabs: ReactNode }) {
  const { data, error, loading, reload } = useApi<Data>("/journey/collections");
  const [step, setStep] = useState<Step>("problem");
  const i = ORDER.indexOf(step);
  const go = (n: number) => setStep(ORDER[Math.max(0, Math.min(ORDER.length - 1, n))]);

  const keys = useRef({ i, go });
  keys.current = { i, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); keys.current.go(keys.current.i + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); keys.current.go(keys.current.i - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stage.current || reduced()) return;
    const scope: Scope = createScope({ root: stage as React.RefObject<HTMLElement> }).add(() => {
      animate("[data-rise]", { opacity: [0, 1], y: [8, 0], duration: 320, ease: "out(3)", delay: stagger(45) });
      animate("[data-grow]", { scaleX: [0, 1], duration: 520, ease: "out(3)", delay: stagger(60, { start: 120 }) });
    });
    return () => { scope.revert(); };
  }, [step, data]);

  const header = (
    <PageHeader title="Collections Journey"
      subtitle="The collections story from the problem to the result, told with Meridian Valley Bank's own accounts"
      meta={tabs} />
  );
  if (loading && !data) return <>{header}<Page><Spinner /></Page></>;
  if (error || !data) return <>{header}<Page><ErrorState message={error ?? "Not available"} onRetry={reload} /></Page></>;

  return (
    <>
      {header}
      <Page>
        <section className="rounded-xl border border-line bg-surface shadow-card">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">The journey, step by step</h2>
              <p className="text-xs text-fg-3">Step {i + 1} of {ORDER.length} · select any step, or use the arrow keys</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go(i - 1)} disabled={i === 0}>Back</Button>
              <Button size="sm" variant="primary" onClick={() => go(i + 1)} disabled={i === ORDER.length - 1}>Next step <ArrowRight className="h-4 w-4" /></Button>
            </div>
          </header>
          <ol className="grid grid-cols-7 gap-1.5 overflow-x-auto px-5 py-4" aria-label="Journey steps">
            {ORDER.map((s, n) => {
              const on = s === step, done = n < i, Icon = STEP[s].icon;
              return (
                <li key={s} className="relative min-w-[104px]">
                  {n > 0 && <span aria-hidden className={clsx("absolute right-1/2 top-[18px] -z-0 h-0.5 w-full", n <= i ? "bg-primary-500" : "bg-line")} />}
                  <button type="button" onClick={() => setStep(s)} aria-current={on ? "step" : undefined}
                    className="relative z-10 flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-lg px-1 py-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300">
                    <span className={clsx("flex h-9 w-9 items-center justify-center rounded-full border-2 transition-colors duration-200",
                      on ? "border-primary-500 bg-primary-500 text-white" : done ? "border-primary-500 bg-surface text-primary-500" : "border-line bg-surface text-fg-3")}>
                      <Icon className="h-4 w-4" /></span>
                    <span className={clsx("text-[11.5px] leading-4", on ? "font-semibold text-fg" : done ? "text-fg-2" : "text-fg-3")}>{STEP[s].short}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section ref={stage} className="rounded-xl border border-line bg-surface shadow-card">
          <header className="flex items-start gap-3 border-b border-line px-6 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white">
              {(() => { const I = STEP[step].icon; return <I className="h-5 w-5" />; })()}</span>
            <div>
              <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Step {i + 1}</p>
              <h3 className="text-[19px] font-semibold leading-6 text-fg">{STEP[step].title}</h3>
              <p className="text-sm text-fg-2">{STEP[step].lead}</p>
            </div>
          </header>
          <div className="space-y-5 px-6 py-6">
            {step === "problem" && <Problem d={data} />}
            {step === "today" && <Today d={data} />}
            {step === "flow" && <Flow />}
            {step === "target" && <TargetBase d={data} />}
            {step === "campaign" && <Campaign d={data} />}
            {step === "intervene" && <Intervene />}
            {step === "better" && <Better d={data} />}
          </div>
          <footer className="flex items-center justify-between border-t border-line px-6 py-3">
            <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go(i - 1)} disabled={i === 0}>
              {i > 0 ? STEP[ORDER[i - 1]].short : "Back"}</Button>
            {i < ORDER.length - 1
              ? <Button variant="primary" onClick={() => go(i + 1)}>{STEP[ORDER[i + 1]].short} <ArrowRight className="h-4 w-4" /></Button>
              : <Link to="/overview" className="inline-flex items-center gap-1 text-sm font-medium text-primary-500 hover:underline">Open the dashboard <ArrowRight className="h-4 w-4" /></Link>}
          </footer>
        </section>
      </Page>
    </>
  );
}

/* ------------------------------------------------------------------ steps */

function Problem({ d }: { d: Data }) {
  const p = d.problem;
  return (
    <>
      <p data-rise className="max-w-4xl text-[17px] leading-7 text-fg">
        Today every account that falls behind gets much the same reminders and calls. That spends money on customers who would have paid anyway,
        pushes away customers that contact makes worse, and leaves no way to prove which treatment actually brought money in.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Users} label="Accounts in collections" value={num(p.accounts)} sub={`${money(p.delinquent, true)} delinquent`} />
        <Stat icon={CircleDollarSign} label="Would pay without contact" value={num(p.self_cure)} sub={`${pct(p.self_cure / p.accounts, 0)} of the book`} />
        <Stat icon={Ban} label="Made worse by contact" value={num(p.do_not_contact)} sub="contact is likely to backfire" />
        <Stat icon={HeartHandshake} label="Cannot pay what is due" value={num(p.needs_support)} sub="reminders will not help them" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Pain icon={CircleDollarSign} title="Wasted contact" body="Reminders, calls and letters go to customers who were going to pay on their own." />
        <Pain icon={AlertTriangle} title="Customers pushed away" body="For some customers more contact means less payment and more complaints." />
        <Pain icon={Scale} title="No proof of what works" body="Without a group that was not contacted, nobody can say how much money a treatment really brought in." />
      </div>
      <Closing>CARE answers three questions for every account: should we contact this customer at all, with what, and did it make a difference?</Closing>
    </>
  );
}

const PROCESS = [
  { key: "behind", title: "Account falls behind", sub: "A payment is missed", icon: AlertTriangle },
  { key: "handoff", title: "Handed to collections", sub: "Grouped by days late and risk, C1 to C4", icon: Boxes },
  { key: "contact", title: "Reminders and calls", sub: "Much the same sequence for everyone", icon: MessageSquareText },
  { key: "agency", title: "Agency placement", sub: "Late-stage accounts, around 90+ days", icon: Users },
  { key: "chargeoff", title: "Charge-off", sub: "At 180 days the account moves to recovery", icon: Ban },
] as const;

function Today({ d }: { d: Data }) {
  return (
    <>
      <ProcessLane />
      <div data-rise>
        <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">What the bank's collections system hands over today</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {d.cohorts.map((c) => (
            <div key={c.cohort_id} className="rounded-lg border border-line px-4 py-3">
              <p className="text-2xs text-fg-3">{c.cohort_id} · {c.dpd_bucket}</p>
              <p className="text-sm font-semibold text-fg">{c.name}</p>
              <p className="num mt-1 text-xl font-semibold text-fg">{num(c.accounts)}</p>
              <p className="text-xs text-fg-2">accounts · {c.risk_band.toLowerCase()} risk</p>
            </div>
          ))}
        </div>
      </div>
      <Closing>The bank's system already knows how late each account is and how risky. What it does not decide is which customers contact will actually help.</Closing>
    </>
  );
}

function ProcessLane({ care }: { care?: Record<string, string> }) {
  return (
    <ol data-rise className="grid gap-3 md:grid-cols-5">
      {PROCESS.map((p, n) => (
        <li key={p.key} className="relative">
          {n > 0 && <ArrowRight aria-hidden className="absolute -left-[13px] top-7 hidden h-4 w-4 text-fg-3 md:block" />}
          <div className={clsx("h-full rounded-xl border px-4 py-3", care?.[p.key] ? "border-primary-500 bg-primary-50" : "border-line bg-surface")}>
            <p.icon className={clsx("h-4 w-4", care?.[p.key] ? "text-primary-500" : "text-fg-3")} />
            <p className="mt-2 text-sm font-semibold text-fg">{p.title}</p>
            <p className="text-xs leading-5 text-fg-2">{p.sub}</p>
            {care?.[p.key] && (
              <p className="mt-2 border-t border-primary-500/20 pt-2 text-xs leading-5 text-fg">
                <span className="font-semibold text-primary-500">CARE: </span>{care[p.key]}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Flow() {
  const node = (icon: LucideIcon, title: string, sub: string, strong?: boolean) => {
    const I = icon;
    return (
      <div className={clsx("rounded-xl border px-4 py-3", strong ? "border-primary-500 bg-primary-500 text-white" : "border-line bg-surface")}>
        <I className={clsx("h-4 w-4", strong ? "text-white" : "text-primary-500")} />
        <p className={clsx("mt-2 text-sm font-semibold", strong ? "text-white" : "text-fg")}>{title}</p>
        <p className={clsx("text-xs leading-5", strong ? "text-primary-100" : "text-fg-2")}>{sub}</p>
      </div>
    );
  };
  const arrow = (label: string) => (
    <div className="flex flex-col items-center justify-center px-1 text-center">
      <span data-grow className="block h-0.5 w-full origin-left bg-primary-500" />
      <span className="mt-1.5 text-[11px] leading-4 text-fg-2">{label}</span>
    </div>
  );
  return (
    <>
      <div data-rise className="grid items-center gap-2 lg:grid-cols-[1fr_96px_1fr_96px_1.6fr_96px_1fr]">
        {node(Landmark, "Bank systems", "Core banking and the collections system: balances, days late, risk band")}
        {arrow("Accounts, each cycle")}
        {node(Database, "Nova", "The bank's data layer: one record per account")}
        {arrow("Account details, sensitive IDs removed")}
        <div className="rounded-xl border-2 border-primary-500 bg-primary-50 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-primary-500"><Cpu className="h-3.5 w-3.5" />CARE</p>
          <div className="grid grid-cols-2 gap-2">
            {[["Score", "Likely to respond, likely to pay anyway"], ["Route", "Strategy, business as usual, hardship, no contact"],
              ["Decide", "Treatment per customer, control group held back"], ["Guard", "Contact rules checked before every send"]].map(([t, s]) => (
              <div key={t} className="rounded-lg bg-surface px-2.5 py-2"><p className="text-xs font-semibold text-fg">{t}</p><p className="text-[11px] leading-4 text-fg-2">{s}</p></div>
            ))}
          </div>
        </div>
        {arrow("Decision: who, what, when")}
        {node(Send, "Channels", "SMS, app, email, calls, letters and agencies")}
      </div>
      <div data-rise className="flex items-center gap-3 rounded-xl border border-dashed border-primary-500/50 px-4 py-3">
        <Repeat className="h-5 w-5 shrink-0 text-primary-500" />
        <p className="text-sm leading-6 text-fg-2"><span className="font-semibold text-fg">The return path.</span> Payments and replies flow back from the channels
          to the bank's systems and through Nova to CARE. CARE learns from each one, and sends a signed update to Nova whenever a person approves or changes a decision.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Pain icon={ShieldCheck} title="Protected data" body="Card numbers and government IDs are dropped before anything is stored. Names are tokenised in logs." />
        <Pain icon={Scale} title="Every decision explained" body="Each decision is stored with its reason and every rule checked, so it can be audited later." />
        <Pain icon={Gauge} title="People stay in charge" body="Strategies are approved by a leader, and offers that change what a customer owes wait for a person." />
      </div>
    </>
  );
}

function TargetBase({ d }: { d: Data }) {
  const total = d.groups.reduce((a, g) => a + g.accounts, 0) || 1;
  const tone: Record<string, string> = { Persuadable: "bg-primary-500", "Sure Thing": "bg-primary-300", "Lost Cause": "bg-primary-200", "Sleeping Dog": "bg-line-strong" };
  return (
    <>
      <p data-rise className="max-w-4xl text-[15px] leading-7 text-fg">
        CARE gives every account two scores: how likely contact is to change what the customer does, and how likely they are to pay anyway.
        Together they put each account in one of four groups, and the group decides where the account goes.
      </p>
      <div data-rise className="space-y-2.5">
        {d.groups.map((g) => (
          <div key={g.key} className="grid grid-cols-[170px_minmax(0,1fr)_170px] items-center gap-3 text-sm">
            <span className="font-semibold text-fg">{g.label}</span>
            <span className="relative h-6 overflow-hidden rounded-md bg-surface-hover">
              <span data-grow className={clsx("absolute inset-y-0 left-0 origin-left rounded-md", tone[g.key])} style={{ width: `${(g.accounts / total) * 100}%` }} />
              <span className="absolute inset-y-0 left-2 flex items-center text-xs font-semibold text-fg num">{num(g.accounts)}</span>
            </span>
            <span className="text-xs text-fg-2">→ {g.route_label}</span>
          </div>
        ))}
      </div>
      <div data-rise>
        <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Same cohort, same bank risk band, three different right answers</p>
        <div className="grid gap-3 lg:grid-cols-3">
          {d.personas.map((p) => (
            <div key={p.customer_id} className="flex flex-col rounded-xl border border-line px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-fg">{p.name}</p>
                <Link to={`/journeys/${p.customer_id}`} className="font-mono text-2xs text-primary-500 hover:underline">{p.account_number}</Link>
              </div>
              <p className="text-xs text-fg-3">{p.cohort_id} · {p.risk_band} risk · {p.days_past_due} days past due · {money(p.delinquent_amount)} behind</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Score label="Likely to respond" value={p.nudge_score} />
                <Score label="Pays anyway" value={p.self_cure_score} />
              </div>
              <p className="mt-3 text-sm font-semibold text-fg">{p.group} → {p.route_label}</p>
              <p className="text-xs leading-5 text-fg-2">{p.note}</p>
            </div>
          ))}
        </div>
      </div>
      <div data-rise className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-sunken px-4 py-3">
        <div className="flex items-start gap-3">
          <MessageSquareText className="mt-0.5 h-5 w-5 shrink-0 text-primary-500" />
          <p className="text-sm leading-6 text-fg-2"><span className="font-semibold text-fg">Pick a target base in plain English.</span> On the Customers list, ask for
            the accounts you want, see the query it runs, and use the result as a campaign's target.</p>
        </div>
        <Link to={`/customers?ask=${encodeURIComponent("Likely to respond customers in C2 who reply to texts and are not in hardship")}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary-500 hover:underline">Try it on the Customers list <ArrowRight className="h-4 w-4" /></Link>
      </div>
    </>
  );
}

function Campaign({ d }: { d: Data }) {
  const rachel = d.personas.find((p) => p.decision) ?? d.personas[0];
  const dec = rachel?.decision;
  const steps = [
    { icon: Target, title: "The audience", body: "The strategy's cohorts and filters, or a target base from a question. Only accounts routed to a strategy are in." },
    { icon: Scale, title: `${pct(d.control_pct, 0)} held back`, body: "A random share gets no treatment. It is the yardstick every result is measured against." },
    { icon: Cpu, title: "Treatment per customer", body: "CARE picks from the approved treatments by what has worked for customers like this one, and keeps testing." },
    { icon: ShieldCheck, title: "Contact rules", body: "Permitted hours, contact limits, opt-outs and hardship are checked before every message." },
    { icon: Send, title: "Sent and followed up", body: "Through the bank's channels, with follow-ups and escalation if there is no payment." },
  ];
  return (
    <>
      <ol data-rise className="grid gap-3 md:grid-cols-5">
        {steps.map((s, n) => (
          <li key={s.title} className="rounded-xl border border-line px-4 py-3">
            <div className="flex items-center gap-2"><span className="num flex h-5 w-5 items-center justify-center rounded-full bg-primary-500 text-[10.5px] font-semibold text-white">{n + 1}</span>
              <s.icon className="h-4 w-4 text-primary-500" /></div>
            <p className="mt-2 text-sm font-semibold text-fg">{s.title}</p>
            <p className="text-xs leading-5 text-fg-2">{s.body}</p>
          </li>
        ))}
      </ol>
      {rachel && dec && (
        <div data-rise className="rounded-xl border border-primary-500/40 bg-primary-50 px-5 py-4">
          <p className="text-2xs font-medium uppercase tracking-[0.08em] text-primary-500">One real decision</p>
          <p className="mt-1 text-[15px] leading-7 text-fg">
            <span className="font-semibold">{rachel.name}</span> is in <span className="font-semibold">{dec.strategy}</span>.{" "}
            {dec.group === "Control" ? "The account was held back in the control group, so nothing was sent." : <>CARE chose <span className="font-semibold">{dec.treatment}</span>{dec.probability !== null ? <> ({pct(dec.probability, 0)} chance it was the best option for this customer)</> : null}.</>}
            {dec.outcome && <> Outcome: <span className="font-semibold">{dec.outcome}</span>{dec.amount ? <>, {money(dec.amount)}</> : null}.</>}
          </p>
          <p className="mt-2 text-sm leading-6 text-fg-2">{dec.explanation}</p>
          <Link to={`/decisions/${dec.decision_id}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary-500 hover:underline">Open the full decision record <ArrowRight className="h-4 w-4" /></Link>
        </div>
      )}
      {d.strategies.length > 0 && (
        <div data-rise>
          <p className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Campaigns running now</p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {d.strategies.slice(0, 6).map((s) => (
              <Link key={s.campaign_id} to={`/strategies/${s.campaign_id}`} className="rounded-lg border border-line px-3 py-2 transition-colors hover:bg-surface-hover">
                <p className="text-sm font-medium text-fg">{s.name}</p>
                <p className="text-xs text-fg-2">{num(s.treated)} treated · {s.payment_rate !== null ? pct(s.payment_rate) : "—"} paid · {s.lift !== null ? `${pp(s.lift)} over no contact` : "control still filling"}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Intervene() {
  return (
    <>
      <ProcessLane care={{
        handoff: "Scores every account and routes it: a strategy, business as usual, the hardship team, or no contact at all.",
        contact: "Chooses the treatment, channel and timing for each customer, holds back a control group, and checks the contact rules before every send.",
        agency: "Proposes which late-stage accounts to place and with which agency. A person approves every placement.",
        chargeoff: "In recovery, offers settlements, payment requests or a specialist by what works for each segment.",
      }} />
      <div data-rise className="flex items-center gap-3 rounded-xl border border-dashed border-primary-500/50 px-4 py-3">
        <Repeat className="h-5 w-5 shrink-0 text-primary-500" />
        <p className="text-sm leading-6 text-fg-2"><span className="font-semibold text-fg">Across all of it:</span> every payment, non-payment and reply comes back
          and changes the next decision. The bank's process stays the same; CARE decides inside it.</p>
      </div>
    </>
  );
}

function Better({ d }: { d: Data }) {
  const r = d.results;
  const contacted = d.routes.strategy, spared = d.routes.bau + d.routes.suppress, total = contacted + spared + d.routes.hardship || 1;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={TrendingUp} label="Treated customers who paid" value={r.payment_rate !== null ? pct(r.payment_rate) : "—"} sub={`${num(r.treated ?? 0)} treated`} />
        <Stat icon={Scale} label="Paid with no contact" value={r.control_rate !== null ? pct(r.control_rate) : "—"} sub="the control group" />
        <Stat icon={CircleDollarSign} label="Lift over no contact" value={r.lift !== null ? pp(r.lift) : "—"}
          sub={r.lift !== null ? `about ${Math.round(r.lift * 100)} more payers in every 100 contacted` : ""} strong />
        <Stat icon={Ban} label="Accounts spared extra contact" value={num(spared)} sub={`${pct(spared / total, 0)} of the book: would pay anyway or be put off`} />
      </div>
      <div data-rise className="grid gap-3 md:grid-cols-3">
        <Pain icon={CircleDollarSign} title="More money in" body="Contact goes where it changes the outcome, and the treatment fits the customer." />
        <Pain icon={Ban} title="Less wasted contact" body="Customers who would pay anyway, and those contact would put off, are left alone or handled their own way." />
        <Pain icon={Scale} title="Proof, not opinion" body="Every result is measured against customers who were not contacted, so the gain can be shown." />
      </div>
      <Closing>CARE contacts the right customers, with the right treatment, inside the bank's rules, and proves the difference it makes.</Closing>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function Stat({ icon: Icon, label, value, sub, strong }: { icon: LucideIcon; label: string; value: string; sub: string; strong?: boolean }) {
  return (
    <div data-rise className={clsx("rounded-xl border px-4 py-3", strong ? "border-primary-500 bg-primary-50" : "border-line")}>
      <div className="flex items-center justify-between"><p className="text-xs text-fg-2">{label}</p><Icon className="h-4 w-4 text-primary-500" /></div>
      <p className="num mt-1 text-[26px] font-semibold leading-8 text-fg">{value}</p>
      <p className="text-xs text-fg-3">{sub}</p>
    </div>
  );
}

function Pain({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div data-rise className="flex gap-3 rounded-xl border border-line px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-primary-500"><Icon className="h-4 w-4" /></span>
      <div><p className="text-sm font-semibold text-fg">{title}</p><p className="text-xs leading-5 text-fg-2">{body}</p></div>
    </div>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex justify-between text-2xs text-fg-3"><span>{label}</span><span className="num font-semibold text-fg">{Math.round(value)}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-hover"><div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.min(100, value)}%` }} /></div>
    </div>
  );
}

const Closing = ({ children }: { children: ReactNode }) => (
  <p data-rise className="border-l-[3px] border-primary-500 pl-4 text-[15px] font-medium leading-7 text-fg">{children}</p>
);
