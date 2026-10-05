import clsx from "clsx";
import { CheckCircle2, XCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { dateTime, pct, timeOnly } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Banner, Card, Chip, ErrorState, KV, Page, PageHeader, Spinner, StatusChip } from "../../ui/ui";

interface Data {
  nudge: { nudge_id: string; decision_id: string; campaign_id: string; customer_id: number; customer: string; channel: string;
    treatment_code: string; status: string; touch: number; escalation: boolean; manual: boolean; scheduled_at: string;
    sent_at: string | null; failure_reason: string | null; content: string };
  pipeline: { stage: string; at: string; detail: string; ok: boolean }[];
  reasoning: { summary: string; fit_reasons: string[]; ranking: { code: string; name: string; belief: number; base_sample: number; fit: number; score: number; selection_probability?: number }[] };
  engagement: { events: { event: string; at: string }[]; opened: boolean; clicked: boolean; form_completed: boolean; time_to_click_min: number | null };
  violations: { violation_id: string; rule: string; severity: string; status: string }[];
}

export default function NudgeDetail() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useApi<Data>(`/nudges/${id}`, [id]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const n = data.nudge;
  return (
    <>
      <PageHeader title="Nudge Detail" subtitle={`${n.nudge_id} · ${n.customer} · ${n.campaign_id}`}
        crumbs={[{ label: "Nudges", to: "/nudges" }, { label: n.nudge_id }]}
        actions={<Link to={`/journeys/${n.customer_id}`} className="text-[13px] font-medium text-primary-500 hover:underline">Customer journey →</Link>} />
      <Page>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line shadow-card sm:grid-cols-4">
          {[["Nudge ID", <span className="font-mono">{n.nudge_id}</span>], ["Channel", n.channel], ["Status", <StatusChip status={n.status} />],
            ["Delivery time", n.sent_at ? timeOnly(n.sent_at) : "—"]].map(([k, v], i) => (
            <div key={i} className="bg-surface px-4 py-3"><p className="label">{k}</p><div className="mt-1 text-[15px] font-semibold">{v}</div></div>
          ))}
        </div>
        {data.violations.length > 0 && (
          <Banner tone="bad" title="This message breached policy">
            {data.violations.map((v) => `${v.violation_id}: ${v.rule} (${v.severity}, ${v.status})`).join(" · ")}
          </Banner>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            <Card title="Delivery pipeline">
              <ol className="relative">
                {data.pipeline.map((s, i) => (
                  <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < data.pipeline.length - 1 && <span className="absolute left-[9px] top-6 h-[calc(100%-16px)] w-px bg-line" />}
                    <span className={clsx("z-10 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-surface", s.ok ? "bg-good text-white" : "bg-bad text-white")}>
                      {s.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <p className="text-[13px] font-semibold">{s.stage}</p>
                        <span className="num text-2xs text-fg-3">{dateTime(s.at)}</span>
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-fg-2">{s.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="Message content" subtitle={n.manual ? "Typed by a strategist (not an approved template)" : "Approved template"}>
              <div className="max-w-md rounded-2xl rounded-bl-sm bg-surface-sunken px-4 py-3 text-[13px] leading-5 ring-1 ring-line">{n.content}</div>
            </Card>
          </div>
          <div className="space-y-4">
            <Card title="Why this channel">
              <p className="rounded-lg border border-ai-100 bg-ai-50/60 p-3 text-xs leading-5 text-fg">{data.reasoning.summary}</p>
              {data.reasoning.fit_reasons.length > 0 && (
                <ul className="mt-3 space-y-1">{data.reasoning.fit_reasons.map((r) => <li key={r} className="flex gap-1.5 text-xs text-fg-2"><CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-good" />{r}</li>)}</ul>
              )}
              {data.reasoning.ranking.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="label mb-1.5">Scores this decision drew</p>
                  {data.reasoning.ranking.map((r) => (
                    <div key={r.code} className="flex items-center justify-between gap-2 py-0.5 text-xs">
                      <span className={r.code === n.treatment_code ? "font-semibold" : "text-fg-2"}>{r.name}</span>
                      <span className="num text-fg-3">{r.score.toFixed(2)} · chosen {pct(r.selection_probability ?? null, 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Engagement">
              <KV items={[
                { label: "Opened", value: data.engagement.opened ? "Yes" : "No" },
                { label: "Link clicked", value: data.engagement.clicked ? "Yes" : "No" },
                { label: "Time to click", value: data.engagement.time_to_click_min !== null ? `${data.engagement.time_to_click_min} min` : "—" },
                { label: "Form completed", value: data.engagement.form_completed ? "Yes" : "No" },
              ]} />
              <div className="mt-2 flex flex-wrap gap-1">{data.engagement.events.map((e, i) => <Chip key={i} tone="info">{e.event} · {timeOnly(e.at)}</Chip>)}</div>
            </Card>
            <Card title="Links">
              <KV items={[
                { label: "Decision", value: <Link className="font-mono text-primary-500 hover:underline" to={`/decisions/${n.decision_id}`}>{n.decision_id}</Link> },
                { label: "Strategy", value: <Link className="text-primary-500 hover:underline" to={`/strategies/${n.campaign_id}`}>{n.campaign_id}</Link> },
                { label: "Touch", value: n.escalation ? "Escalation" : n.manual ? "Manual" : `#${n.touch}` },
              ]} />
            </Card>
          </div>
        </div>
      </Page>
    </>
  );
}
