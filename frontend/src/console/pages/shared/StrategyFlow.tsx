/** One customer's strategy decisions from start to finish: what ARI chose and
 *  why, what was sent, what the customer did, the result, and how that result
 *  changed the treatment's score in the strategy. */
import clsx from "clsx";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { dateTime, money, pct, pp } from "../../lib/format";
import { Card } from "../../ui/ui";

interface Side { mean: number; low: number; high: number; p_best: number; learned: number }
export interface Flow {
  decision_id: string; campaign_id: string; campaign_name: string; version: number | null; wave: number;
  routing: { fit_group: string; fit_label: string; nudge_score: number; self_cure_score: number; validation: boolean };
  origin: string; decided_at: string; group: string; treatment_code: string | null; treatment: string | null;
  explanation: string; exclusion_reason: string | null; review_status: string;
  why: { allowed: number; selection_probability: number | null; belief: number; fit: number; score: number;
    runner_up: string | null; runner_up_score: number | null } | null;
  contact: { sent: number; held: number; channels: string[]; first_sent_at: string | null };
  engagement: string[];
  outcome: { state: string; amount?: number; days_to_pay?: number; full?: boolean; window_days: number;
    observed_at: string | null; window_ends: string };
  learning: { state: string; reason?: string; code?: string; name?: string; reward?: number; arms?: number;
    before?: Side; after?: Side; now?: { mean: number; p_best: number; learned: number } };
}

function Step({ n, label, done, children }: { n: number; label: string; done: boolean; children: ReactNode }) {
  return (
    <li className={clsx("min-w-0 border-t-2 pt-2", done ? "border-primary-500" : "border-line")}>
      <p className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">{n} · {label}</p>
      <div className="mt-1 space-y-0.5 text-xs leading-5 text-fg-2">{children}</div>
    </li>
  );
}

const Main = ({ children }: { children: ReactNode }) => <p className="text-[13px] font-medium text-fg">{children}</p>;

function Change({ before, after, digits }: { before: number; after: number; digits: number }) {
  const d = after - before;
  return (
    <span className="num">
      {pct(before, digits)} → <span className={clsx("font-medium", d > 0 ? "text-good" : d < 0 ? "text-bad" : "text-fg")}>{pct(after, digits)}</span>
    </span>
  );
}

function FlowRow({ f }: { f: Flow }) {
  const control = f.group === "Control";
  const o = f.outcome;
  const l = f.learning;
  const outcomeKnown = ["paid", "not_paid", "not_delivered"].includes(o.state);
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] font-semibold text-fg">
          <Link to={`/strategies/${f.campaign_id}`} className="font-mono text-primary-500 hover:underline">{f.campaign_id}</Link>
          <span className="font-normal text-fg-2"> · {f.campaign_name}{f.version ? ` · v${f.version}` : ""}</span>
        </p>
        <p className="text-2xs text-fg-3">
          {f.origin === "mcp" ? "Requested by Nova" : `Wave ${f.wave}`} · {dateTime(f.decided_at)} ·{" "}
          <Link to={`/decisions/${f.decision_id}`} className="font-mono text-primary-500 hover:underline">{f.decision_id}</Link>
        </p>
      </div>
      <p className="mt-1 text-xs text-fg-2">
        <span className="font-medium text-fg">Propensity Router:</span> {f.routing.fit_label} (nudge {f.routing.nudge_score.toFixed(0)},
        self-cure {f.routing.self_cure_score.toFixed(0)}) → {f.routing.validation
          ? "strategy, from the validation share: scored, never learned from" : "strategy"}
      </p>
      <ol className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Step n={1} label="Decision" done>
          {f.treatment ? (
            <>
              <Main>{f.treatment}</Main>
              {f.why && <>
                <p className="num">Score {f.why.score.toFixed(2)}: belief {pct(f.why.belief, 0)} × fit {f.why.fit.toFixed(2)}</p>
                <p>{f.why.selection_probability !== null && `Picked ${pct(f.why.selection_probability, 0)} of the time · `}{f.why.allowed} allowed</p>
                {f.why.runner_up && <p className="text-fg-3">Runner-up {f.why.runner_up} ({f.why.runner_up_score?.toFixed(2)})</p>}
              </>}
            </>
          ) : control ? (
            <><Main>Control group</Main><p>Held back at random so the strategy can be measured against business as usual.</p></>
          ) : (
            <><Main>No treatment</Main><p>{f.exclusion_reason || f.explanation}</p></>
          )}
        </Step>

        <Step n={2} label="Contact" done={f.contact.sent > 0 || control}>
          {control ? <><Main>Business as usual</Main><p>The bank's own collections process.</p></>
            : f.contact.sent ? <><Main>{f.contact.sent} message{f.contact.sent === 1 ? "" : "s"} sent</Main><p>{f.contact.channels.join(", ")}</p></>
            : <Main>Nothing sent</Main>}
          {f.contact.held > 0 && <p className="text-warn">{f.contact.held} held by the contact rules</p>}
          {f.review_status === "pending" && <p className="text-warn">Waiting for approval</p>}
        </Step>

        <Step n={3} label="Customer response" done={f.engagement.length > 0}>
          {f.engagement.length ? f.engagement.map((e) => <p key={e} className="text-fg">{e}</p>)
            : <p className="text-fg-3">{f.contact.sent ? "No response recorded" : "—"}</p>}
        </Step>

        <Step n={4} label="Outcome" done={outcomeKnown}>
          {o.state === "paid" ? <><Main>Paid {money(o.amount ?? 0)}</Main><p>{o.days_to_pay} days after the decision · {o.full ? "full arrears" : "partial"}</p></>
            : o.state === "not_paid" ? <><Main>No payment</Main><p>within the {o.window_days}-day window</p></>
            : o.state === "in_window" ? <><Main>Waiting</Main><p>Window closes {dateTime(o.window_ends)}</p></>
            : o.state === "pending_review" ? <Main>Waiting for review</Main>
            : o.state === "not_delivered" ? <><Main>Not delivered</Main><p>No message reached the customer.</p></>
            : o.state === "cancelled" || o.state === "rejected" ? <Main>{o.state === "cancelled" ? "Cancelled" : "Rejected"}</Main>
            : <p className="text-fg-3">—</p>}
        </Step>

        <Step n={5} label="Learning" done={l.state === "learned"}>
          {l.state === "learned" && l.before && l.after ? (
            <>
              <Main>{l.name}: reward {l.reward}</Main>
              <p>Estimated payment rate <Change before={l.before.mean} after={l.after.mean} digits={1} /></p>
              <p>Chance it is best <Change before={l.before.p_best} after={l.after.p_best} digits={0} /></p>
              <p className="text-fg-3">{pp(l.after.mean - l.before.mean)} from this one result, the {ordinal(l.after.learned)} for this treatment in {f.campaign_id}</p>
              {l.now && <p className="text-fg-3">Now {pct(l.now.mean, 1)} after {l.now.learned} results</p>}
            </>
          ) : <p className={l.state === "waiting" ? "text-fg-2" : "text-fg-3"}>{l.reason}</p>}
        </Step>
      </ol>
    </div>
  );
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

export function StrategyFlow({ flows }: { flows: Flow[] }) {
  if (!flows.length) return null;
  return (
    <Card title="Strategy flow"
      subtitle="Each decision from start to finish, and how its result changed the treatment's score in the strategy">
      <div className="divide-y divide-line">
        {flows.map((f) => <FlowRow key={f.decision_id} f={f} />)}
      </div>
      <p className="mt-4 border-t border-line pt-3 text-2xs leading-4 text-fg-3">
        A treatment's score in a strategy starts from its playbook track record and adds every learned result:
        reward 1 when the customer pays within the window, 0 when they do not. Each decision draws from these
        scores, adjusted for the customer's fit, so a payment makes that treatment more likely to be chosen next time.
      </p>
    </Card>
  );
}
