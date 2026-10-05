import { ArrowRight, Database, Inbox } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api, type Cohort, type HandoffRow, type Treatment } from "../../lib/api";
import { ago, dateTime, money, num, pct, SEGMENT_LABEL, SEGMENTS } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { SEGMENT_TONE, SegmentChip } from "../../ui/domain";
import { Banner, Button, Card, Chip, ErrorState, Page, PageHeader, Spinner, Table, Td, Th, Tr, useAction } from "../../ui/ui";

const TRIGGER: Record<string, { label: string; tone: "neutral" | "info" | "ai" }> = {
  initial: { label: "Initial load", tone: "neutral" },
  manual: { label: "Requested", tone: "info" },
  auto: { label: "Automatic", tone: "ai" },
};

/** The intervention point: what the client hands over, and the playbook ARI can use on it. */
export default function Cohorts() {
  const { me, can, refresh } = useSession();
  const cohorts = useApi<Cohort[]>("/cohorts");
  const treatments = useApi<Treatment[]>("/treatments");
  const handoffs = useApi<{ handoffs: HandoffRow[]; auto: boolean; next_sizes: Record<string, number> }>("/handoffs");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (cohorts.error) return <ErrorState message={cohorts.error} onRetry={cohorts.reload} />;
  if (!cohorts.data || !treatments.data) return <Spinner />;
  const action = cohorts.data[0]?.segment_action ?? {};
  const active = treatments.data.filter((t) => t.status === "Active");
  const ids = cohorts.data.map((c) => c.cohort_id);
  const receive = () => run("handoff", () => api.post<HandoffRow>("/handoffs"),
    (r) => `Handoff #${r.handoff} received: ${num(r.total)} new accounts.`)
    .then((r) => { if (r) { cohorts.reload(); handoffs.reload(); refresh(); } });

  return (
    <>
      <PageHeader title="Cohorts & Handoffs" role={me?.user.role_label}
        subtitle="Where ARI starts: the delinquent accounts the client's collections system hands over, cohort by cohort"
        actions={can("launch_strategy") && <Button icon={<Inbox className="h-4 w-4" />} loading={busy === "handoff"} onClick={receive}>Receive next handoff</Button>} />
      <Page>
        <Banner tone="neutral" title="Upstream, not rebuilt">
          Delinquency risk, DPD buckets and cohort identification come from the client's existing collections system. ARI receives them as a handoff and starts at the intervention decision.
        </Banner>

        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
          {cohorts.data.map((c) => {
            const total = Object.values(c.segments).reduce((a, b) => a + b, 0) || 1;
            return (
              <Card key={c.cohort_id} title={<span className="flex items-center gap-2"><Database className="h-4 w-4 text-fg-3" />{c.name}</span>}
                subtitle={`${c.dpd_bucket} · ${c.risk_band} risk · expected payment ${c.expected_payment}`}>
                <div className="flex items-baseline justify-between">
                  <span className="num text-2xl font-semibold">{num(c.customers)}</span><span className="text-xs text-fg-3">{money(c.balance, true)} balance</span>
                </div>
                <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
                  {SEGMENTS.map((g, i) => c.segments[g] ? (
                    <div key={g} title={`${SEGMENT_LABEL[g]}: ${c.segments[g]}`} style={{ width: `${(c.segments[g] / total) * 100}%`,
                      background: ["var(--series-1)", "var(--series-3)", "var(--series-4)", "var(--control)"][i] }} />) : null)}
                </div>
                <ul className="mt-3 space-y-1">
                  {SEGMENTS.map((g) => (
                    <li key={g} className="flex items-center justify-between text-xs">
                      <SegmentChip segment={g} /><span className="num text-fg-2">{c.segments[g] ?? 0} · {pct((c.segments[g] ?? 0) / total, 0)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-2xs leading-4 text-fg-3">{c.description}</p>
                <button onClick={() => navigate(`/customers?q=&view=all`)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-500 hover:underline">
                  View customers <ArrowRight className="h-3 w-3" /></button>
              </Card>
            );
          })}
        </div>

        <Card title="Handoff history" flush
          subtitle={handoffs.data ? (handoffs.data.auto
            ? "Automatic handoffs are on: when a strategy's audience is too small for a full wave, the next handoff arrives before the wave runs."
            : "Automatic handoffs are off. Receive the next handoff here when a strategy's audience runs out.") : undefined}
          actions={handoffs.data && <Chip tone={handoffs.data.auto ? "good" : "neutral"}>Automatic {handoffs.data.auto ? "on" : "off"}</Chip>}>
          <Table maxHeight="320px">
            <thead><tr><Th>Handoff</Th><Th>Received</Th><Th>Triggered by</Th><Th>Trigger</Th><Th align="right">Accounts</Th>
              {ids.map((id) => <Th key={id} align="right">{id}</Th>)}</tr></thead>
            <tbody>
              {(handoffs.data?.handoffs ?? []).map((h) => (
                <Tr key={h.handoff_id}>
                  <Td mono>#{h.handoff_id}</Td>
                  <Td className="text-xs text-fg-2" ><span title={dateTime(h.at ?? null)}>{ago(h.at ?? null)}</span></Td>
                  <Td className="text-fg-2">{h.by}</Td>
                  <Td><Chip tone={TRIGGER[h.trigger]?.tone ?? "neutral"}>{TRIGGER[h.trigger]?.label ?? h.trigger}</Chip></Td>
                  <Td align="right" className="font-medium">{num(h.total)}</Td>
                  {ids.map((id) => <Td key={id} align="right" className="text-fg-2">{num(h.counts[id] ?? 0)}</Td>)}
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="What each fit group gets" flush>
          <Table>
            <thead><tr><Th>Fit group</Th><Th>Quadrant (provisional)</Th><Th>Default handling</Th></tr></thead>
            <tbody>
              {SEGMENTS.map((g) => (
                <Tr key={g}><Td><Chip tone={SEGMENT_TONE[g]}>{SEGMENT_LABEL[g]}</Chip></Td><Td className="text-fg-2">{g}</Td><Td className="text-fg-2">{action[g]}</Td></Tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-line px-4 py-2.5 text-2xs leading-4 text-fg-3">
            Fit groups come from two scores today (nudge propensity and self-cure). True uplift quadrants need each customer's response with and without treatment, which the control groups are now collecting for the phase-1 uplift model.
          </p>
        </Card>

        <Card title="Treatment playbook" subtitle={`${active.length} active treatments, ${active.filter((t) => t.human_review).length} needing human approval. Strategies can only choose from these.`}
          actions={<Button size="sm" onClick={() => navigate("/treatments")}>Open playbook <ArrowRight className="h-3.5 w-3.5" /></Button>}>
          <div className="flex flex-wrap gap-1.5">
            {active.map((t) => <Chip key={t.code} tone="info">{t.code} · {t.name}</Chip>)}
          </div>
        </Card>
      </Page>
    </>
  );
}
