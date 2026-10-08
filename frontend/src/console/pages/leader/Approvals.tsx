import { useNavigate } from "react-router-dom";

import type { Strategy, Treatment } from "../../lib/api";
import { ago, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { StrategyActions } from "../../ui/domain";
import { Banner, Card, Chip, ErrorState, KV, Page, PageHeader, Spinner, StatusChip } from "../../ui/ui";

export default function Approvals() {
  const { refresh } = useSession();
  const { data, error, loading, reload } = useApi<Strategy[]>("/strategies?scope=all&status=In review");
  const treatments = useApi<Treatment[]>("/treatments").data;
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  return (
    <>
      <PageHeader title="Approvals" subtitle="Strategies submitted by strategists, waiting for sign-off before they can run" />
      <Page>
        <Banner tone="info" title="Maker-checker">
          Nobody can approve a strategy they authored. Approving lets the owner launch it; any later change to its audience, treatments, control share or escalation sends it back here.
        </Banner>
        {data.map((s) => (
          <Card key={s.campaign_id}
            title={<button className="text-left hover:text-primary-500" onClick={() => navigate(`/strategies/${s.campaign_id}`)}>{s.name}</button>}
            subtitle={`${s.campaign_id} · v${s.version} · submitted by ${s.owner} ${ago(s.submitted_at)}`}
            actions={<><StatusChip status={s.status} />{s.source !== "manual" && <Chip tone="neutral">{s.source.replace("_", " ")}</Chip>}</>}
            footer={<div className="flex justify-end"><StrategyActions s={s} onChange={() => { reload(); refresh(); }} /></div>}>
            <p className="mb-3 text-[13px] leading-5 text-fg-2">{s.description}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <KV items={[
                { label: "Audience", value: `${s.target_cohorts.join(", ")} · Likely responsive (Propensity Router)` },
                { label: "Balance", value: `${s.min_balance !== null ? money(s.min_balance) : "any"} – ${s.max_balance !== null ? money(s.max_balance) : "any"}` },
                { label: "Treatments", value: s.treatments.map((t) => t.name).join(", ") },
                { label: "Needs human review", value: s.treatment_codes.filter((c) => treatments?.find((t) => t.code === c)?.human_review).join(", ") || "none" },
              ]} />
              <KV items={[
                { label: "Cadence", value: `every ${s.cadence_days}d · max ${s.max_touches} · ${s.tone}` },
                { label: "Escalation", value: s.escalate_to ? `${s.escalate_to} after ${s.escalate_after_days}d` : "none" },
                { label: "Control share", value: pct(s.control_pct, 0) },
                { label: "Target / window", value: `${pct(s.recovery_target, 0)} in ${s.evaluation_days} days · waves of ${num(s.wave_size)}` },
              ]} />
            </div>
          </Card>
        ))}
        {!data.length && <p className="py-16 text-center text-sm text-fg-3">Nothing is waiting for approval.</p>}
      </Page>
    </>
  );
}
