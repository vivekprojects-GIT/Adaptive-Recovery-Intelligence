import clsx from "clsx";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import type { CustomerRow } from "../../lib/api";
import { ago, money } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { SegmentChip } from "../../ui/domain";
import { Avatar, Card, Empty, ErrorState, Page, PageHeader, Pager, Pills, Progress, Spinner, StatusChip, Table, Td, Th, Tr, inputCls } from "../../ui/ui";

interface Data { total: number; page: number; page_size: number; counts: Record<string, number>; rows: CustomerRow[] }

export function RiskBar({ score }: { score: number }) {
  const tone = score >= 75 ? "bg-bad" : score >= 50 ? "bg-warn" : "bg-good";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-sunken"><span className={clsx("block h-full rounded-full", tone)} style={{ width: `${score}%` }} /></span>
      <span className="num text-xs text-fg-2">{score.toFixed(0)}</span>
    </span>
  );
}

export default function Customers({ journeys }: { journeys?: boolean }) {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? (journeys ? "in_strategy" : "all");
  const page = Number(params.get("page") ?? 1);
  const [q, setQ] = useState(params.get("q") ?? "");
  useEffect(() => setQ(params.get("q") ?? ""), [params]);
  const path = `/customers?view=${view}&page=${page}&page_size=20&q=${encodeURIComponent(params.get("q") ?? "")}`;
  const { data, error, loading, reload } = useApi<Data>(path, [path]);
  const navigate = useNavigate();
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); v ? n.set(k, v) : n.delete(k); if (k !== "page") n.delete("page"); setParams(n); };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const c = data?.counts ?? {};
  return (
    <>
      <PageHeader title={journeys ? "Journeys" : "Customers"} role={me?.user.role_label}
        subtitle={journeys ? "Every customer a strategy has touched, with where their journey stands" : `${data?.total ?? "…"} accounts handed over by the client's collections system`} />
      <Page>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Pills value={view} onChange={(v) => set("view", v)} options={[
            ...(journeys ? [] : [{ id: "all", label: "All", count: c.all }]),
            { id: "in_strategy", label: "In a strategy", count: c.in_strategy }, { id: "high_risk", label: "High risk", count: c.high_risk },
            { id: "unresponsive", label: "Unresponsive", count: c.unresponsive }, { id: "resolved", label: "Resolved", count: c.resolved },
            { id: "pending", label: "Pending review", count: c.pending },
          ]} />
          <form className="relative w-72" onSubmit={(e) => { e.preventDefault(); set("q", q); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or ID" className={`${inputCls} pl-8`} />
          </form>
        </div>
        <Card flush>
          {loading && !data ? <Spinner /> : (
            <Table>
              <thead><tr><Th>Customer</Th><Th>Ref ID</Th><Th align="right">Balance</Th>
                <Th>Client risk</Th><Th>Fit group</Th><Th>AI strategy</Th><Th>Status</Th><Th w="110px">Progress</Th><Th>Last contact</Th></tr></thead>
              <tbody>
                {data?.rows.map((r) => (
                  <Tr key={r.customer_id} onClick={() => navigate(`/journeys/${r.customer_id}`)}>
                    <Td><span className="flex items-center gap-2"><Avatar name={r.name} size="sm" />
                      <span className="min-w-0"><span className="block whitespace-nowrap font-medium">{r.name}</span>
                        <span className="block whitespace-nowrap text-2xs text-fg-3">{r.cohort_id} · {r.days_past_due} DPD</span></span></span></Td>
                    <Td mono className="whitespace-nowrap text-primary-500">CUS-{10000 + r.customer_id}</Td>
                    <Td align="right"><span className="block">{money(r.balance)}</span><span className="block text-2xs text-fg-3">{money(r.arrears)} due</span></Td>
                    <Td><RiskBar score={r.risk_score} /></Td>
                    <Td><SegmentChip segment={r.segment} /></Td>
                    <Td className="text-xs">{r.treatment ?? <span className="text-fg-3">—</span>}{r.campaign_id && <span className="block font-mono text-2xs text-fg-3">{r.campaign_id}</span>}</Td>
                    <Td className="whitespace-nowrap"><StatusChip status={r.status} /></Td>
                    <Td><span className="flex items-center gap-2"><Progress value={r.progress} tone={r.progress >= 100 ? "good" : "primary"} /><span className="num w-8 text-2xs text-fg-3">{r.progress}%</span></span></Td>
                    <Td className="whitespace-nowrap text-xs text-fg-3">{ago(r.last_contact)}</Td>
                  </Tr>
                ))}
                {!data?.rows.length && <Empty cols={9}>No customers match.</Empty>}
              </tbody>
            </Table>
          )}
          {data && <Pager page={page} pageSize={data.page_size} total={data.total} onPage={(p) => set("page", String(p))} />}
        </Card>
      </Page>
    </>
  );
}
