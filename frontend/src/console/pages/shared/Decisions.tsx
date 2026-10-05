import { Search } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { DecisionRow } from "../../lib/api";
import { dateTime, money, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Card, Chip, Empty, ErrorState, Page, PageHeader, Pager, Pills, Spinner, StatusChip, Table, Td, Th, Tr, inputCls } from "../../ui/ui";

export default function Decisions() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const group = params.get("group") ?? "";
  const review = params.get("review") ?? "";
  const campaign = params.get("campaign") ?? "";
  const page = Number(params.get("page") ?? 1);
  const [q, setQ] = useState(params.get("q") ?? "");
  const path = `/decisions?group=${group}&review=${review}&campaign=${campaign}&q=${encodeURIComponent(params.get("q") ?? "")}&page=${page}&page_size=25`;
  const { data, error, loading, reload } = useApi<{ total: number; rows: DecisionRow[] }>(path, [path]);
  const navigate = useNavigate();
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); if (k !== "page") n.delete("page"); setParams(n); };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <PageHeader title="Decisions" subtitle="The decision log: every customer the engine decided, why, and what happened" role={me?.user.role_label}
        meta={campaign ? <Chip tone="primary">Strategy {campaign} <button className="ml-1" onClick={() => set("campaign", "")}>×</button></Chip> : undefined} />
      <Page>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-3">
            <Pills value={group} onChange={(v) => set("group", v)} options={[{ id: "", label: "All groups" }, { id: "Treatment", label: "Treatment" }, { id: "Control", label: "Control" }]} />
            <Pills value={review} onChange={(v) => set("review", v)} options={[{ id: "", label: "Any review" }, { id: "pending", label: "Pending" }, { id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" }]} />
          </div>
          <form className="relative w-64" onSubmit={(e) => { e.preventDefault(); set("q", q); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Decision or customer ID" className={`${inputCls} pl-8`} />
          </form>
        </div>
        <Card flush>
          {loading && !data ? <Spinner /> : (
            <Table>
              <thead><tr><Th>Decision</Th><Th>Customer</Th><Th>Strategy</Th><Th>Wave</Th><Th>Group</Th><Th>Treatment</Th>
                <Th align="right">P(select)</Th><Th>Review</Th><Th>Outcome</Th><Th align="right">Amount</Th><Th>Decided</Th></tr></thead>
              <tbody>
                {data?.rows.map((d) => (
                  <Tr key={d.decision_id} onClick={() => navigate(`/decisions/${d.decision_id}`)}>
                    <Td mono className="font-medium text-primary-500">
                      <span className="flex items-center gap-1.5">{d.decision_id}{d.origin === "mcp" && <Chip tone="ai" title="Asked for by Nova's agent over MCP">Nova</Chip>}</span>
                    </Td>
                    <Td>{d.customer}<span className="block text-2xs text-fg-3">#{d.customer_id}</span></Td>
                    <Td className="text-xs">{d.campaign_id}</Td><Td>{d.wave}</Td>
                    <Td><StatusChip status={d.group} /></Td>
                    <Td>{d.treatment ?? <span className="text-fg-3">—</span>}{d.overridden && <Chip tone="warn" className="ml-1">override</Chip>}</Td>
                    <Td align="right">{pct(d.selection_probability, 0)}</Td>
                    <Td>{d.review_policy === "auto" ? <span className="text-xs text-fg-3">auto</span> : <StatusChip status={d.review_status} />}</Td>
                    <Td><StatusChip status={d.outcome ?? "In window"} /></Td>
                    <Td align="right">{d.amount ? money(d.amount) : "—"}</Td>
                    <Td className="text-xs text-fg-3">{dateTime(d.decided_at)}</Td>
                  </Tr>
                ))}
                {!data?.rows.length && <Empty cols={11}>No decisions match.</Empty>}
              </tbody>
            </Table>
          )}
          {data && <Pager page={page} pageSize={25} total={data.total} onPage={(p) => set("page", String(p))} />}
        </Card>
      </Page>
    </>
  );
}
