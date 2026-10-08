import clsx from "clsx";
import { ArrowRight, Check, ClipboardCheck, Lightbulb, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { api, type InsightRow, type Strategy, type WeekPoint } from "../../lib/api";
import { ago, num, pct, pp } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { RateVsControl } from "../../ui/charts";
import { ResultCell } from "../../ui/domain";
import {
  Banner, Button, Card, Chip, Empty, ErrorState, Kpi, Page, PageHeader, Spinner, StatusChip, Table, Td, Th, Tr, useAction,
} from "../../ui/ui";
import { STEPS, stepsDone } from "./builder/steps";

interface Data {
  kpis: { strategies: number; live: number; accounts: number; recovery_rate: number | null; uplift: number | null;
    control_rate: number | null; decisions_24h: number; pending_review: number };
  draft: Strategy | null; strategies: Strategy[]; insights: InsightRow[]; weekly: WeekPoint[];
}

export function Stepper({ stored }: { stored: number }) {
  const done = stepsDone(stored);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-1">
          <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold",
            i < done ? "bg-good text-white" : i === done ? "bg-primary-500 text-white" : "bg-surface-sunken text-fg-3 ring-1 ring-line")}>
            {i < done ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          <span className={clsx("text-xs", i === done ? "font-medium text-fg" : "text-fg-3")}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-4 bg-line-strong" />}
        </li>
      ))}
    </ol>
  );
}

export function InsightCard({ i, onDone, compact }: { i: InsightRow; onDone: () => void; compact?: boolean }) {
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const { can } = useSession();
  const respond = (action: string) => run(action, () => api.post<{ campaign_id?: string }>(`/insights/${i.insight_id}/respond`, { action }),
    (r) => action === "apply" ? `Applied as new draft ${r.campaign_id}. It needs approval before it runs.` : `Insight ${action === "review" ? "marked for review" : action + "ed"}.`)
    .then((r) => { if (r) { onDone(); if (action === "apply" && r.campaign_id) navigate(`/builder/${r.campaign_id}`); } });
  const open = ["New", "In review"].includes(i.status);
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">{i.insight_id}</Chip>
        <StatusChip status={i.status} />
        <Chip tone={i.priority === "Critical" ? "bad" : i.priority === "High" ? "serious" : "warn"}>{i.priority}</Chip>
        {i.campaign_id && <Chip tone="primary">{i.campaign_id}</Chip>}
      </div>
      <p className="mt-2 text-[13px] font-semibold leading-5 text-fg">{i.title}</p>
      {!compact && <p className="mt-1 text-xs leading-5 text-fg-2">{i.body}</p>}
      <p className="mt-1.5 text-2xs text-fg-3">From {i.from} · {ago(i.created_at)}</p>
      {open && can("edit_strategy") && (
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="secondary" loading={busy === "accept"} onClick={() => respond("accept")}>Accept</Button>
          <Button size="sm" variant="secondary" loading={busy === "review"} onClick={() => respond("review")}>Review</Button>
          <Button size="sm" variant="ghost" loading={busy === "decline"} onClick={() => respond("decline")}>Decline</Button>
          <Button size="sm" variant="primary" disabled={!Object.keys(i.change).length} loading={busy === "apply"}
            title={Object.keys(i.change).length ? "Creates a new draft version with this change" : "No strategy change to apply"}
            onClick={() => respond("apply")}>Apply</Button>
        </div>
      )}
    </div>
  );
}

export default function MyDashboard() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/dashboard/strategist");
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading your workspace" />;
  const k = data.kpis;
  return (
    <>
      <PageHeader title="My Dashboard" subtitle={`Strategist workspace · ${me?.user.name}`}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/builder")}>New Strategy</Button>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="My strategies" value={k.strategies} sub={`${k.live} live`} />
          <Kpi label="Accounts decided" value={num(k.accounts)} sub="across my strategies" />
          <Kpi label="Recovery rate (treated)" value={pct(k.recovery_rate)}
            sub={k.control_rate !== null ? `control ${pct(k.control_rate)} · uplift ${pp(k.uplift)}` : "no control yet"} />
          <Kpi label="Decisions, last 24h" value={num(k.decisions_24h)} sub="from my strategies" />
        </div>

        {k.pending_review > 0 && (
          <Banner tone="warn" title={`${k.pending_review} offers are waiting for your review`}
            action={<Button size="sm" variant="primary" icon={<ClipboardCheck className="h-3.5 w-3.5" />} onClick={() => navigate("/review")}>Open queue</Button>}>
            Payment plans, deferrals and hardship referrals are forbearance. They wait for a person before anything is sent.
          </Banner>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            {data.draft && (
              <div className="rounded-lg border border-line border-l-[3px] border-l-primary-500 bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-2xs font-semibold uppercase tracking-wide text-primary-600">
                      Draft in progress · {data.draft.campaign_id} · step {Math.min(stepsDone(data.draft.steps_completed) + 1, STEPS.length)} of {STEPS.length}
                    </p>
                    <p className="mt-1 text-[15px] font-semibold text-fg">{data.draft.name}</p>
                  </div>
                  <Button variant="primary" onClick={() => navigate(`/builder/${data.draft!.campaign_id}`)}>Continue <ArrowRight className="h-3.5 w-3.5" /></Button>
                </div>
                <div className="mt-3"><Stepper stored={data.draft.steps_completed} /></div>
              </div>
            )}

            <Card title="My Strategies" flush actions={<Link to="/strategies" className="text-xs font-medium text-primary-500 hover:underline">View all</Link>}>
              <Table>
                <thead><tr><Th>Strategy</Th><Th>Status</Th><Th align="right">Accounts</Th><Th>Recovery vs control</Th><Th>Channels</Th><Th>Last edited</Th></tr></thead>
                <tbody>
                  {data.strategies.map((s) => (
                    <Tr key={s.campaign_id} onClick={() => navigate(`/strategies/${s.campaign_id}`)}>
                      <Td><span className="block font-medium">{s.name}</span><span className="font-mono text-2xs text-fg-3">{s.campaign_id} · v{s.version}</span></Td>
                      <Td><StatusChip status={s.status} /></Td>
                      <Td align="right">{num(s.stats?.decisions)}</Td>
                      <Td><ResultCell rate={s.stats?.recovery_rate} uplift={s.stats?.uplift} significant={s.stats?.significant} underpowered={s.stats?.underpowered} /></Td>
                      <Td className="text-xs text-fg-2">{s.channels.join(" + ")}</Td>
                      <Td className="text-xs text-fg-3">{ago(s.updated_at)}</Td>
                    </Tr>
                  ))}
                  {!data.strategies.length && <Empty cols={6}>No strategies yet. Build one in the Strategy Builder.</Empty>}
                </tbody>
              </Table>
            </Card>

            <Card title="Treated vs control, by week" subtitle="Across my strategies. The gap between the lines is what the strategies caused.">
              <RateVsControl data={data.weekly} />
            </Card>
          </div>

          <Card title={<span className="flex items-center gap-1.5"><Lightbulb className="h-4 w-4 text-fg-3" />Leadership Insights</span>}
            subtitle="From the Strategy Workbench, sent by your strategy leader">
            <div className="space-y-2.5">
              {data.insights.map((i) => <InsightCard key={i.insight_id} i={i} onDone={reload} />)}
              {!data.insights.length && <p className="py-6 text-center text-xs text-fg-3">No insights yet.</p>}
            </div>
          </Card>
        </div>
      </Page>
    </>
  );
}
