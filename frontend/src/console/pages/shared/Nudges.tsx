import { useNavigate, useSearchParams } from "react-router-dom";

import { customerRef, dateTime } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Card, Chip, Empty, ErrorState, Page, PageHeader, Pager, Pills, Spinner, StatusChip, Table, Td, Th, Tr } from "../../ui/ui";

interface Row { nudge_id: string; decision_id: string; campaign_id: string; customer_id: number; customer: string; channel: string;
  treatment_code: string; status: string; touch: number; escalation: boolean; manual: boolean; scheduled_at: string; sent_at: string | null }

export default function Nudges() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? 1);
  const path = `/nudges?status=${status}&page=${page}&page_size=25`;
  const { data, error, loading, reload } = useApi<{ total: number; counts: Record<string, number>; rows: Row[] }>(path, [path]);
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const c = data?.counts ?? {};
  const all = Object.values(c).reduce((a, b) => a + b, 0);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); if (k !== "page") n.delete("page"); setParams(n); };
  return (
    <>
      <PageHeader title="Nudges" subtitle="Every message and call ARI scheduled, with what happened to it" />
      <Page>
        <Pills value={status} onChange={(v) => set("status", v)} options={[
          { id: "", label: "All", count: all }, { id: "Clicked", label: "Clicked", count: c.Clicked ?? 0 },
          { id: "Opened", label: "Opened", count: c.Opened ?? 0 }, { id: "Delivered", label: "Delivered", count: c.Delivered ?? 0 },
          { id: "Held", label: "Held by guard", count: c.Held ?? 0 }, { id: "Failed", label: "Failed", count: c.Failed ?? 0 },
        ]} />
        <Card flush>
          {loading && !data ? <Spinner /> : (
            <Table>
              <thead><tr><Th>Nudge</Th><Th>Customer</Th><Th>Strategy</Th><Th>Channel</Th><Th>Type</Th><Th>Status</Th><Th>Sent</Th></tr></thead>
              <tbody>
                {data?.rows.map((n) => (
                  <Tr key={n.nudge_id} onClick={() => navigate(`/nudges/${n.nudge_id}`)}>
                    <Td mono className="font-medium text-primary-500">{n.nudge_id}</Td>
                    <Td>{n.customer}<span className="block text-2xs text-fg-3">{customerRef(n.customer_id)}</span></Td>
                    <Td className="text-xs">{n.campaign_id}</Td>
                    <Td>{n.channel}</Td>
                    <Td>{n.manual ? <Chip tone="warn">manual</Chip> : n.escalation ? <Chip tone="serious">escalation</Chip> : <Chip tone="neutral">touch {n.touch}</Chip>}</Td>
                    <Td><StatusChip status={n.status} /></Td>
                    <Td className="text-xs text-fg-3">{dateTime(n.sent_at ?? n.scheduled_at)}</Td>
                  </Tr>
                ))}
                {!data?.rows.length && <Empty cols={7}>No nudges match.</Empty>}
              </tbody>
            </Table>
          )}
          {data && <Pager page={page} pageSize={25} total={data.total} onPage={(p) => set("page", String(p))} />}
        </Card>
      </Page>
    </>
  );
}
