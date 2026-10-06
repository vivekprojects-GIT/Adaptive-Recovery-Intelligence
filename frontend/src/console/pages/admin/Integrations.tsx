import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";

import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Banner, Card, ErrorState, Page, PageHeader, Spinner, StatusChip } from "../../ui/ui";
import { AgentAccess } from "./AgentAccess";

interface I { id: string; name: string; kind: string; status: string; mode: string; detail: string; last_sync: string | null }

export default function Integrations() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ feeds: I[]; channels: I[]; shadow_mode: boolean }>("/admin/integrations");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const Grid = ({ items, icon }: { items: I[]; icon: React.ReactNode }) => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <Card key={i.id}>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-2">{icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2"><p className="truncate text-[13px] font-semibold">{i.name}</p><StatusChip status={i.status} /></div>
              <p className="mt-0.5 text-xs text-fg-2">{i.detail}</p>
              <p className="mt-1.5 text-2xs text-fg-3">{i.mode} · last activity {ago(i.last_sync)}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
  return (
    <>
      <PageHeader title="API & Integrations" subtitle="Agents that ask ARI for decisions, data flowing in from the bank, and the channels ARI decides for" role={me?.user.role_label} />
      <Page>
        {data.shadow_mode && (
          <Banner tone="neutral" title="Channel delivery is not connected">
            Decisions, eligibility, approvals, compliance checks and the audit trail are recorded as normal. No message is sent to a customer until a channel gateway is connected.
          </Banner>
        )}
        <p className="label">Agents</p>
        <AgentAccess />
        <p className="label pt-2">Inbound data</p>
        <Grid items={data.feeds} icon={<ArrowDownToLine className="h-4 w-4" />} />
        <p className="label pt-2">Outbound channels</p>
        <Grid items={data.channels} icon={<ArrowUpFromLine className="h-4 w-4" />} />
      </Page>
    </>
  );
}
