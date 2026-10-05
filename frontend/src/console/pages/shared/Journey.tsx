import clsx from "clsx";
import {
  Ban, CheckCircle2, CircleDollarSign, Clock, Hand, Inbox, MousePointerClick, Pause, Phone, Send, SkipForward, Split,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../../lib/api";
import { dateTime, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList } from "../../ui/charts";
import { SegmentChip } from "../../ui/domain";
import {
  Banner, Button, Card, Chip, Drawer, ErrorState, Field, KV, Page, PageHeader, Spinner, StatusChip, inputCls, useAction,
} from "../../ui/ui";

interface Event { at: string; kind: string; title: string; detail: string; tag: string; decision_id?: string; nudge_id?: string }
interface Data {
  customer: Record<string, number | string | boolean>;
  events: Event[];
  summary: { days_active: number; nudges_sent: number; decisions: number; engagement_events: number; response_rate: number; amount_recovered: number; status: string };
  next_action: { action: string; when: string; reason: string } | null;
  nudge_profile: { score: number; contributions: { factor: string; points: number; max_points: number }[]; severity_penalty: number; self_cure_score: number; segment: string };
  eligibility: { code: string; name: string; eligible: boolean; reason: string; fit_reasons: string[] }[];
}

const ICON: Record<string, typeof Send> = {
  system: Inbox, decision: Split, nudge: Send, engagement: MousePointerClick, payment: CircleDollarSign, bau: Phone,
};
const COLOR: Record<string, string> = {
  system: "bg-surface-sunken text-fg-3", decision: "bg-info-bg text-info", nudge: "bg-primary-50 text-primary-600",
  engagement: "bg-info-bg text-info", payment: "bg-good-bg text-good", bau: "bg-surface-sunken text-fg-3",
};

export default function Journey() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<Data>(`/customers/${id}/journey`, [id]);
  const [action, setAction] = useState<null | "pause_journey" | "manual_nudge" | "skip_next_step">(null);
  const [text, setText] = useState("");
  const [showBau, setShowBau] = useState(true);
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading journey" />;
  const c = data.customer;
  const events = data.events.filter((e) => showBau || e.kind !== "bau");
  const submit = () => run("act", () => api.post<{ message?: string; status?: string; note?: string }>(`/customers/${id}/actions`,
    action === "manual_nudge" ? { action, message: text } : { action, reason: text }),
    (r) => r.status ? `Manual nudge ${r.status.toLowerCase()}${r.note ? `: ${r.note}` : ""}.` : r.message ?? "Done.")
    .then((r) => { if (r) { setAction(null); setText(""); reload(); } });

  return (
    <>
      <PageHeader title="Recovery Journey" subtitle={`${c.name} · CUS-${10000 + Number(c.customer_id)}`}
        crumbs={[{ label: "Journeys", to: "/journeys" }, { label: String(c.name) }]}
        meta={<><StatusChip status={data.summary.status} /><SegmentChip segment={String(c.segment)} /><Chip tone="neutral">{String(c.cohort_id)} · {c.days_past_due} DPD</Chip>
          <Chip tone="neutral">Client risk {String(c.client_risk_band)} ({Number(c.client_risk_score).toFixed(0)})</Chip></>} />
      <Page>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-4">
            <Card title="Recovery timeline" subtitle="Newest first. Everything ARI decided and sent, what the customer did, and the bank's own contacts."
              actions={<label className="flex items-center gap-1.5 text-xs text-fg-2"><input type="checkbox" checked={showBau} onChange={(e) => setShowBau(e.target.checked)} className="h-3.5 w-3.5 rounded border-line-strong" />Show BAU contacts</label>}>
              <ol className="relative">
                {events.map((e, i) => {
                  const Icon = e.tag === "Held" ? Ban : ICON[e.kind] ?? Clock;
                  return (
                    <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                      {i < events.length - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-24px)] w-px bg-line" />}
                      <span className={clsx("z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface", COLOR[e.kind])}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-[13px] font-semibold text-fg">{e.title}</p>
                          <StatusChip status={e.tag} />
                          {e.nudge_id && e.kind !== "engagement" && <Link to={`/nudges/${e.nudge_id}`} className="font-mono text-2xs text-primary-500 hover:underline">{e.nudge_id}</Link>}
                          {e.decision_id && <Link to={`/decisions/${e.decision_id}`} className="font-mono text-2xs text-primary-500 hover:underline">{e.decision_id}</Link>}
                        </div>
                        <p className="mt-0.5 text-xs leading-5 text-fg-2">{e.detail}</p>
                        <p className="mt-0.5 text-2xs text-fg-3">{dateTime(e.at)}</p>
                      </div>
                    </li>
                  );
                })}
                {!events.length && <p className="py-8 text-center text-sm text-fg-3">This customer has not entered a strategy yet.</p>}
              </ol>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Intervention fit" subtitle="ARI's scores. Delinquency risk comes from the client's model.">
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <div><p className="label">Nudge propensity</p><p className="num text-xl font-semibold">{data.nudge_profile.score}</p></div>
                  <div><p className="label">Self-cure likelihood</p><p className="num text-xl font-semibold">{data.nudge_profile.self_cure_score}</p></div>
                </div>
                <BarList rows={data.nudge_profile.contributions.map((f) => ({ label: f.factor, value: f.points, sub: `of ${f.max_points}` }))}
                  format={(v) => (v ?? 0).toFixed(1)} max={30} />
                {data.nudge_profile.severity_penalty < 0 && <p className="mt-2 text-2xs text-fg-3">Arrears severity reduced the score by {Math.abs(data.nudge_profile.severity_penalty).toFixed(1)} points.</p>}
              </Card>
              <Card title="Treatment eligibility" subtitle="Business rules, applied before the model chooses">
                <ul className="space-y-1.5">
                  {data.eligibility.map((e) => (
                    <li key={e.code} className={clsx("rounded-lg border px-2.5 py-1.5", e.eligible ? "border-good/20 bg-good-bg/50" : "border-line bg-surface-sunken")}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={clsx("text-xs font-medium", e.eligible ? "text-fg" : "text-fg-3 line-through")}>{e.name}</span>
                        {e.eligible ? <CheckCircle2 className="h-3.5 w-3.5 text-good" /> : <Ban className="h-3.5 w-3.5 text-fg-3" />}
                      </div>
                      <p className="text-2xs text-fg-3">{e.reason}{e.eligible && e.fit_reasons.length ? ` · ${e.fit_reasons.join(" · ")}` : ""}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>

          <div className="space-y-4">
            <Card title="Journey summary">
              <KV items={[
                { label: "Days active", value: data.summary.days_active },
                { label: "Nudges sent", value: data.summary.nudges_sent },
                { label: "AI decisions", value: data.summary.decisions },
                { label: "Engagement events", value: data.summary.engagement_events },
                { label: "Response rate", value: pct(data.summary.response_rate, 0) },
                { label: "Amount recovered", value: money(data.summary.amount_recovered) },
                { label: "Status", value: <StatusChip status={data.summary.status} /> },
              ]} />
            </Card>
            <Card title="Next AI action">
              {data.next_action ? (
                <div className="rounded-lg border border-line bg-surface-sunken/60 p-3">
                  <p className="text-[13px] font-semibold text-fg">{data.next_action.action}</p>
                  <p className="mt-1 text-xs leading-5 text-fg-2">{data.next_action.reason}</p>
                  <p className="mt-1.5 text-2xs text-fg-3">Scheduled {dateTime(data.next_action.when)}</p>
                </div>
              ) : <p className="text-xs text-fg-3">No further automated step is scheduled.</p>}
            </Card>
            <Card title="Customer">
              <KV items={[
                { label: "Balance", value: money(Number(c.balance)) },
                { label: "Arrears", value: money(Number(c.arrears)) },
                { label: "Credit limit", value: money(Number(c.credit_limit)) },
                { label: "On-time history", value: pct(Number(c.payment_history), 0) },
                { label: "Missed (12m)", value: num(Number(c.missed_payments)) },
                { label: "Tenure", value: `${c.tenure_years} years` },
                { label: "Channels", value: [c.sms_responsive && "SMS", c.app_user && "App"].filter(Boolean).join(", ") || "none" },
                { label: "Hardship flag", value: c.hardship_flag ? "Yes" : "No" },
              ]} />
            </Card>
            {can("override_decisions") && data.summary.decisions > 0 && (
              <Card title="Actions">
                <div className="space-y-2">
                  <Button variant="secondary" icon={<SkipForward className="h-3.5 w-3.5" />} onClick={() => setAction("skip_next_step")}>Override next step</Button>
                  <Button variant="secondary" icon={<Pause className="h-3.5 w-3.5" />} onClick={() => setAction("pause_journey")}>Pause journey</Button>
                  <Button variant="primary" icon={<Hand className="h-3.5 w-3.5" />} onClick={() => setAction("manual_nudge")}>Send manual nudge</Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      </Page>
      <Drawer open={!!action} onClose={() => { setAction(null); setText(""); }} width="max-w-md"
        title={action === "manual_nudge" ? "Send a manual nudge" : action === "pause_journey" ? "Pause this journey" : "Override the next step"}
        subtitle={String(c.name)}
        footer={<><Button variant="ghost" onClick={() => setAction(null)}>Cancel</Button>
          <Button variant="primary" disabled={!text.trim()} loading={busy === "act"} onClick={submit}>{action === "manual_nudge" ? "Send" : "Confirm"}</Button></>}>
        {action === "manual_nudge" ? (
          <div className="space-y-3">
            <Banner tone="warn">Manual messages skip the approved templates, so the compliance monitor checks them for opt-out text, pressure language and account numbers. The contact guard still applies.</Banner>
            <Field label="SMS text" required hint={`${text.length}/320 characters`}>
              <textarea rows={5} maxLength={320} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} h-auto py-2`}
                placeholder={`Hi ${String(c.name).split(" ")[0]}, ... Reply STOP to opt out.`} />
            </Field>
            {!/stop/i.test(text) && text.length > 10 && <p className="text-2xs text-warn">No “Reply STOP” instruction: this will be flagged as a disclosure breach.</p>}
          </div>
        ) : (
          <Field label="Reason" required hint="Recorded in the audit log against your name.">
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} h-auto py-2`} />
          </Field>
        )}
      </Drawer>
    </>
  );
}

