import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { Strategy } from "../../lib/api";
import { ago, money, num } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { ResultCell, StrategyActions } from "../../ui/domain";
import { Button, Card, Empty, ErrorState, Page, PageHeader, Pills, Spinner, StatusChip, Table, Td, Th, Tr } from "../../ui/ui";

export default function MyStrategies() {
  const { me, can } = useSession();
  const [scope, setScope] = useState<"mine" | "all">(me?.user.role === "strategist" ? "mine" : "all");
  const [status, setStatus] = useState("all");
  const { data, error, loading, reload } = useApi<Strategy[]>(`/strategies?scope=${scope}`, [scope]);
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const rows = (data ?? []).filter((s) => status === "all" || s.status === status);
  const count = (st: string) => (data ?? []).filter((s) => s.status === st).length;
  return (
    <>
      <PageHeader title={scope === "mine" ? "My Strategies" : "All Strategies"} subtitle="Every strategy with its lifecycle state and its result against its own control group"
       
        actions={can("create_strategy") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/builder")}>New Strategy</Button>} />
      <Page>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Pills value={status} onChange={setStatus} options={[
            { id: "all", label: "All", count: data?.length }, { id: "Live", label: "Live", count: count("Live") },
            { id: "In review", label: "In review", count: count("In review") }, { id: "Approved", label: "Approved", count: count("Approved") },
            { id: "Draft", label: "Draft", count: count("Draft") }, { id: "Paused", label: "Paused", count: count("Paused") },
            { id: "Archived", label: "Archived", count: count("Archived") },
          ]} />
          <Pills value={scope} onChange={setScope} options={[{ id: "mine", label: "Mine" }, { id: "all", label: "Everyone's" }]} />
        </div>
        <Card flush>
          {loading && !data ? <Spinner /> : (
            <Table>
              <thead><tr><Th>Strategy</Th><Th>Owner</Th><Th>Status</Th><Th align="right">Accounts</Th><Th>Recovery vs control</Th>
                <Th align="right">Recovered</Th><Th align="right">Cost / recovery</Th><Th>Updated</Th><Th align="right">Actions</Th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <Tr key={s.campaign_id}>
                    <Td><button className="text-left" onClick={() => navigate(`/strategies/${s.campaign_id}`)}>
                      <span className="block font-medium text-fg hover:text-primary-500">{s.name}</span>
                      <span className="font-mono text-2xs text-fg-3">{s.campaign_id} · v{s.version}{s.source !== "manual" ? ` · ${s.source.replace("_", " ")}` : ""}</span>
                    </button></Td>
                    <Td className="text-fg-2">{s.owner}</Td>
                    <Td><StatusChip status={s.status} /></Td>
                    <Td align="right">{num(s.stats?.decisions)}</Td>
                    <Td><ResultCell rate={s.stats?.recovery_rate} uplift={s.stats?.uplift} significant={s.stats?.significant} underpowered={s.stats?.underpowered} /></Td>
                    <Td align="right">{money(s.stats?.recovered)}</Td>
                    <Td align="right">{money(s.stats?.cost_per_recovery)}</Td>
                    <Td className="text-xs text-fg-3">{ago(s.updated_at)}</Td>
                    <Td align="right"><div className="flex justify-end"><StrategyActions s={s} onChange={reload} compact /></div></Td>
                  </Tr>
                ))}
                {!rows.length && <Empty cols={9}>No strategies match.</Empty>}
              </tbody>
            </Table>
          )}
        </Card>
      </Page>
    </>
  );
}
