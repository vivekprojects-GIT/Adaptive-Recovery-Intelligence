import { Inbox } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api, type HandoffRow, type Strategy } from "../../lib/api";
import { ago, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { UpliftRow } from "../../ui/charts";
import { StrategyActions, WaveButton } from "../../ui/domain";
import { Banner, Button, Chip, ErrorState, Page, PageHeader, Spinner, Stat, StatusChip, useAction } from "../../ui/ui";

export default function LiveCampaigns() {
  const { me, can, refresh } = useSession();
  const scope = me?.user.role === "strategist" ? "mine" : "all";
  const { data, error, loading, reload } = useApi<Strategy[]>(`/strategies?scope=${scope}`);
  const handoffs = useApi<{ handoffs: HandoffRow[]; auto: boolean }>("/handoffs");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner />;
  const live = (data ?? []).filter((s) => ["Live", "Paused", "Approved"].includes(s.status));
  const last = handoffs.data?.handoffs[0];
  const receive = () => run("handoff", () => api.post<HandoffRow>("/handoffs"),
    (r) => `Handoff #${r.handoff} received: ${num(r.total)} new accounts across ${Object.keys(r.counts).length} cohorts.`)
    .then((r) => { if (r) { reload(); handoffs.reload(); refresh(); } });
  return (
    <>
      <PageHeader title="Live Campaigns" subtitle="Running strategies: decide the next wave, watch the comparison with control build up"
        actions={can("launch_strategy") && (
          <Button icon={<Inbox className="h-4 w-4" />} loading={busy === "handoff"} onClick={receive}>Receive next handoff</Button>
        )} />
      <Page>
        <Banner tone="neutral">
          Each wave decides the next slice of the strategy's audience: a randomised share goes to control, the rest get the treatment Thompson sampling picks, and outcomes feed the next wave's beliefs.
          {handoffs.data && <> New accounts arrive from the collections system as cohort handoffs{last?.at ? ` (last one ${ago(last.at)})` : ""}.{handoffs.data.auto ? " When a strategy's audience runs low, the next handoff arrives automatically." : " Automatic handoffs are off, so receive the next one here when an audience runs low."}</>}
        </Banner>
        <div className="grid gap-4 xl:grid-cols-2">
          {live.map((s) => {
            const st = s.stats!;
            return (
              <section key={s.campaign_id} className="rounded-lg border border-line bg-surface shadow-card">
                <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <button className="min-w-0 text-left" onClick={() => navigate(`/strategies/${s.campaign_id}`)}>
                    <p className="font-mono text-2xs text-fg-3">{s.campaign_id} · v{s.version} · {s.owner}</p>
                    <p className="truncate text-[15px] font-semibold hover:text-primary-500">{s.name}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {s.open_revision && <Chip tone="info">v{s.version + 1} in draft</Chip>}
                    <StatusChip status={s.status} />
                  </div>
                </header>
                <div className="grid grid-cols-5 gap-3 px-4 py-3">
                  <Stat label="Waves" value={s.waves_run} />
                  <Stat label="Treated" value={num(st.treated)} sub={`${pct(st.recovery_rate, 0)} paid`} />
                  <Stat label="Control" value={num(st.control)} sub={`${pct(st.control_rate, 0)} paid`} />
                  <Stat label="Recovered" value={money(st.recovered, true)} />
                  <Stat label="Left to decide" value={s.pool_remaining === null || s.pool_remaining === undefined ? "—" : num(s.pool_remaining)}
                    sub={s.pool_remaining === 0 ? "next handoff needed" : "in audience"} />
                </div>
                <div className="px-4 pb-3">
                  <p className="label mb-1">Uplift over control</p>
                  <UpliftRow uplift={st.uplift} ci={st.uplift_ci} mde={st.mde} />
                </div>
                <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {s.treatments.map((t) => <Chip key={t.code} tone={t.status === "Retired" ? "neutral" : "info"}>{t.name}{t.status === "Retired" ? " (retired)" : ""}</Chip>)}
                    {st.pending_review > 0 && <Chip tone="warn">{st.pending_review} awaiting review</Chip>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <WaveButton s={s} size="sm" onDone={() => { reload(); handoffs.reload(); }} />
                    <StrategyActions s={s} onChange={reload} compact />
                  </div>
                </footer>
              </section>
            );
          })}
        </div>
        {!live.length && <p className="py-16 text-center text-sm text-fg-3">No live strategies. Approved strategies appear here once launched.</p>}
      </Page>
    </>
  );
}
