import { money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList, SERIES } from "../../ui/charts";
import { ResultCell } from "../../ui/domain";
import { Avatar, Card, ErrorState, Page, PageHeader, Spinner, StatusChip, Table, Td, Th, Tr } from "../../ui/ui";

interface Row { user_id: string; name: string; status: string; strategies: number; live: number; drafts: number; accounts: number;
  recovery_rate: number | null; uplift: number | null; recovered: number; overrides: number; reviews: number; cost_per_recovery: number | null }

export default function TeamPerformance() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ team: Row[] }>("/team");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  return (
    <>
      <PageHeader title="Team Performance" subtitle="Strategists, their strategies and what those strategies caused" role={me?.user.role_label} />
      <Page>
        <Card flush>
          <Table>
            <thead><tr><Th>Strategist</Th><Th>Status</Th><Th align="right">Strategies</Th><Th align="right">Live</Th><Th align="right">Drafts / review</Th>
              <Th align="right">Accounts</Th><Th>Recovery vs control</Th><Th align="right">Recovered</Th><Th align="right">Offers reviewed</Th><Th align="right">Overrides</Th></tr></thead>
            <tbody>
              {data.team.map((r) => (
                <Tr key={r.user_id}>
                  <Td><span className="flex items-center gap-2"><Avatar name={r.name} size="sm" /><span className="font-medium">{r.name}</span></span></Td>
                  <Td><StatusChip status={r.status} /></Td><Td align="right">{r.strategies}</Td><Td align="right">{r.live}</Td><Td align="right">{r.drafts}</Td>
                  <Td align="right">{num(r.accounts)}</Td>
                  <Td><ResultCell rate={r.recovery_rate} uplift={r.uplift} /></Td>
                  <Td align="right">{money(r.recovered)}</Td><Td align="right">{r.reviews}</Td><Td align="right">{r.overrides}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Recovered by strategist"><BarList rows={data.team.map((r, i) => ({ label: r.name, value: r.recovered, color: SERIES[i % 5] }))} format={(v) => money(v ?? 0)} /></Card>
          <Card title="Uplift over control by strategist" subtitle="Small portfolios swing; read alongside account counts">
            <BarList rows={data.team.map((r, i) => ({ label: r.name, value: Math.max(0, r.uplift ?? 0), color: SERIES[i % 5], sub: `${num(r.accounts)} accounts` }))} format={(v) => pct(v ?? 0)} />
          </Card>
        </div>
      </Page>
    </>
  );
}
