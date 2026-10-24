/** A recommendation as a tree: the account, the Propensity Router's branch, the
 *  strategy, then one branch per candidate treatment (blocked by a rule, or
 *  scored), the chosen one, the review and the outcome. Built from the
 *  decision's frozen record, so it shows exactly what was known then. */
import clsx from "clsx";
import { type ReactNode } from "react";

import { money, num, pct, SEGMENT_LABEL } from "../../lib/format";
import { Card } from "../../ui/ui";

type Snapshot = Record<string, number | string | boolean>;
interface Ranked { code: string; name: string; belief: number; fit: number; score: number; selection_probability?: number; fit_reasons?: string[] }
interface Evaluation { arm_id: string; arm: string; result: "PASS" | "BLOCK"; reason: string; stage: string }
interface Props {
  snapshot: Snapshot; ranking: Ranked[]; evaluations: Evaluation[];
  group: string; strategy: string | null; campaignId: string; treatment: string | null;
  reviewPolicy: string; reviewStatus: string; reviewReason: string | null; outcome: string | null; amount: number | null;
}

const ROUTE = { strategy: "Strategy", bau: "Business as usual", hardship: "Hardship team", suppress: "Suppressed" } as Record<string, string>;

function Node({ title, detail, tone = "neutral", children }: { title: ReactNode; detail?: ReactNode; tone?: "neutral" | "chosen" | "blocked" | "muted"; children?: ReactNode }) {
  return (
    <li className="relative pl-6 before:absolute before:left-2 before:top-0 before:h-full before:w-px before:bg-line last:before:h-4
      after:absolute after:left-2 after:top-4 after:h-px after:w-3 after:bg-line">
      <div className={clsx("rounded-lg border px-3 py-2", {
        neutral: "border-line bg-surface", chosen: "border-primary-500 bg-primary-50/50",
        blocked: "border-line bg-surface-sunken", muted: "border-dashed border-line bg-surface",
      }[tone])}>
        <p className={clsx("text-[13px] font-medium", tone === "blocked" || tone === "muted" ? "text-fg-2" : "text-fg")}>{title}</p>
        {detail && <div className="mt-0.5 text-2xs leading-4 text-fg-3">{detail}</div>}
      </div>
      {children && <ul className="mt-2 space-y-2">{children}</ul>}
    </li>
  );
}

export function DecisionTree(p: Props) {
  const s = p.snapshot;
  const route = String(s.route ?? "strategy");
  const validation = Boolean(s.route_validation);
  const arms = [...new Set(p.evaluations.map((e) => e.arm_id))];
  const scored = new Map(p.ranking.map((r) => [r.code, r]));
  const chosenName = p.treatment;
  const control = p.group === "Control";

  const branches = arms.map((code) => {
    const rows = p.evaluations.filter((e) => e.arm_id === code);
    const name = rows[0]?.arm ?? code;
    const blocks = rows.filter((e) => e.result === "BLOCK");
    const r = scored.get(code);
    if (blocks.length) {
      return <Node key={code} tone="blocked" title={`${name}: blocked`} detail={blocks.map((b) => b.reason).join(" · ")} />;
    }
    if (!r) return <Node key={code} tone="muted" title={`${name}: allowed`} detail="Passed every rule; not scored because the account is in the control group." />;
    const chosen = !control && r.name === chosenName;
    return (
      <Node key={code} tone={chosen ? "chosen" : "neutral"}
        title={<span className="flex flex-wrap items-baseline gap-x-2">{name}{chosen && <span className="text-2xs font-medium text-primary-600">Recommended</span>}</span>}
        detail={<>
          Score <span className="num font-medium text-fg-2">{r.score.toFixed(2)}</span> = belief {pct(r.belief, 0)} × fit {r.fit.toFixed(2)}
          {r.selection_probability !== undefined && <> · picked {pct(r.selection_probability, 0)} of the time</>}
          {r.fit_reasons && r.fit_reasons.length > 0 && <span className="block">{r.fit_reasons.join(" · ")}</span>}
        </>} />
    );
  });

  return (
    <Card title="Decision tree" subtitle="How this recommendation was reached, branch by branch, from what was known at the time">
      <ul className="space-y-2">
        <Node title={`Account · ${s.product ?? "Consumer Credit Card"}`}
          detail={`Balance ${money(Number(s.balance))} · arrears ${money(Number(s.arrears ?? 0))} · ${s.days_past_due} days past due · ${s.client_risk_band} risk`}>
          <Node title={`Propensity Router: ${SEGMENT_LABEL[String(s.segment)] ?? s.segment} → ${validation ? "Strategy (validation share)" : ROUTE[route] ?? route}`}
            detail={`Nudge propensity ${num(Number(s.nudge_score))} · self-cure likelihood ${num(Number(s.self_cure_score))}`}>
            <Node title={`Strategy ${p.campaignId}${p.strategy ? ` · ${p.strategy}` : ""}`}
              detail={control ? "Randomly held back as control: stays on business as usual, so the strategy can be measured." : "Audience matched: the account's bucket, balance and risk fit this strategy."}>
              {control
                ? <Node tone="muted" title="Control group: business as usual" detail={p.outcome ? `Outcome: ${p.outcome}` : "Outcome not known yet"} />
                : <>
                    <li className="pl-6 text-2xs font-medium text-fg-3">Candidate treatments: rules first, then scores</li>
                    {branches}
                    <Node tone={p.reviewStatus === "pending" ? "neutral" : "muted"}
                      title={p.reviewPolicy === "human_review"
                        ? `Human review: ${p.reviewStatus === "pending" ? "waiting for a person" : p.reviewStatus}`
                        : "Sent automatically"}
                      detail={p.reviewPolicy === "human_review" ? (p.reviewReason ?? "Needs a person's approval") : "Below the review threshold and not a forbearance offer"}>
                      <Node tone="muted" title={`Outcome: ${p.outcome ?? "within the performance window"}`}
                        detail={p.amount ? `Paid ${money(p.amount)}` : undefined} />
                    </Node>
                  </>}
            </Node>
          </Node>
        </Node>
      </ul>
    </Card>
  );
}

/** What the recommendation used: the account today, and the history behind it. */
export function TodayAndHistory({ snapshot: s, ranking, treatment, earlier }: {
  snapshot: Snapshot; ranking: Ranked[]; treatment: string | null; earlier: number;
}) {
  const chosen = ranking.find((r) => r.name === treatment);
  const noConsent = Array.isArray((s as unknown as { no_consent?: string[] }).no_consent) ? (s as unknown as { no_consent: string[] }).no_consent : [];
  const today: [string, ReactNode][] = [
    ["Days past due", `${s.days_past_due} days`],
    ["Balance", money(Number(s.balance))],
    ["Arrears", money(Number(s.arrears ?? 0))],
    ["Card business", String(s.product ?? "Consumer Credit Card")],
    ["Bank's risk band", `${s.client_risk_band}${s.client_risk_score !== undefined ? ` (${Number(s.client_risk_score).toFixed(0)})` : ""}`],
    ["Hardship flag", s.hardship_flag ? "On file" : "None"],
    ["Contacts in last 7 days", String(s.reported_contacts_7d ?? 0)],
    ["Consent withheld", noConsent.length ? noConsent.join(", ") : "None"],
  ];
  const history: [string, ReactNode][] = [
    ["On-time payments (12 months)", pct(Number(s.payment_history), 0)],
    ["Missed payments (12 months)", String(s.missed_payments)],
    ["Customer for", `${s.tenure_years} years`],
    ["Has replied to SMS before", s.sms_responsive ? "Yes" : "No"],
    ["Uses the mobile app", s.app_user ? "Yes" : "No"],
    ["Recommended treatment's record here", chosen ? `${pct(chosen.belief, 0)} estimated payment rate` : "—"],
    ["Earlier recommendations for this customer", String(earlier)],
  ];
  const List = ({ rows }: { rows: [string, ReactNode][] }) => (
    <dl className="divide-y divide-line text-xs">
      {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3 py-1.5"><dt className="text-fg-3">{k}</dt><dd className="num text-right text-fg">{v}</dd></div>)}
    </dl>
  );
  return (
    <Card title="What the recommendation used" subtitle="The account as it stood at the time, and the behaviour behind it">
      <div className="grid gap-5 sm:grid-cols-2">
        <div><p className="label mb-1">Current situation</p><List rows={today} /></div>
        <div><p className="label mb-1">History</p><List rows={history} /></div>
      </div>
      <p className="mt-3 border-t border-line pt-2 text-2xs leading-4 text-fg-3">
        The current situation decides what is allowed (consent, contact limits, hardship, the review threshold). The history drives the
        propensity scores and the customer-fit adjustment, and each treatment's record in this strategy comes from earlier results.
      </p>
    </Card>
  );
}
