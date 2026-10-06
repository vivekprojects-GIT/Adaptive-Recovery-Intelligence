import { Download, Search } from "lucide-react";
import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Button, Card, Empty, ErrorState, Page, PageHeader, Pager, Select, Spinner, Table, Td, Th, Tr, inputCls, useAction } from "../../ui/ui";

interface Row { audit_id: number; at: string; actor: string; actor_name: string; action: string; entity: string; entity_id: string; summary: string; detail: Record<string, unknown> }
interface Data { total: number; rows: Row[]; actors: { id: string; name: string }[]; entities: string[] }

export default function AuditLog() {
  const { can } = useSession();
  const [p, setP] = useSearchParams();
  const [q, setQ] = useState(p.get("q") ?? "");
  const [open, setOpen] = useState<number | null>(null);
  const page = Number(p.get("page") ?? 1);
  const path = `/admin/audit?actor=${p.get("actor") ?? ""}&action=${p.get("action") ?? ""}&entity=${p.get("entity") ?? ""}&q=${encodeURIComponent(p.get("q") ?? "")}&page=${page}&page_size=30`;
  const { data, error, loading, reload } = useApi<Data>(path, [path]);
  const { run, busy } = useAction();
  const set = (k: string, v: string) => { const n = new URLSearchParams(p); v ? n.set(k, v) : n.delete(k); if (k !== "page") n.delete("page"); setP(n); };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <PageHeader title="Audit Log" subtitle="Every user and system action, in order. Read-only."
        actions={can("export_reports") && <Button icon={<Download className="h-3.5 w-3.5" />} loading={busy === "x"} onClick={() => run("x", () => api.download("/reports/audit.csv", "ari-audit.csv"), "Downloaded.")}>Export</Button>} />
      <Page>
        <div className="flex flex-wrap items-end gap-2">
          <Select className="w-48" value={p.get("actor") ?? ""} onChange={(v) => set("actor", v)} options={[{ value: "", label: "All actors" }, ...(data?.actors ?? []).map((a) => ({ value: a.id, label: a.name }))]} />
          <Select className="w-40" value={p.get("action") ?? ""} onChange={(v) => set("action", v)} options={["", "CREATE", "UPDATE", "APPROVE", "DELETE", "EXPORT", "READ"].map((a) => ({ value: a, label: a || "All actions" }))} />
          <Select className="w-44" value={p.get("entity") ?? ""} onChange={(v) => set("entity", v)} options={[{ value: "", label: "All entities" }, ...(data?.entities ?? []).map((e) => ({ value: e, label: e }))]} />
          <form className="relative w-72" onSubmit={(e) => { e.preventDefault(); set("q", q); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search summaries" className={`${inputCls} pl-8`} />
          </form>
        </div>
        <Card flush>
          {loading && !data ? <Spinner /> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Summary</Th></tr></thead>
              <tbody>
                {data?.rows.map((r) => (
                  <Fragment key={r.audit_id}>
                    <Tr onClick={() => setOpen(open === r.audit_id ? null : r.audit_id)}>
                      <Td className="whitespace-nowrap text-xs text-fg-3">{dateTime(r.at)}</Td>
                      <Td>{r.actor_name}</Td>
                      <Td mono className={r.action === "DELETE" ? "text-bad" : "text-fg-2"}>{r.action}</Td>
                      <Td mono className="text-fg-2">{r.entity}{r.entity_id ? ` · ${r.entity_id}` : ""}</Td>
                      <Td className="text-[13px]">{r.summary}</Td>
                    </Tr>
                    {open === r.audit_id && Object.keys(r.detail).length > 0 && (
                      <tr><td colSpan={5} className="border-b border-line bg-surface-sunken px-4 py-2"><pre className="whitespace-pre-wrap font-mono text-2xs text-fg-2">{JSON.stringify(r.detail, null, 2)}</pre></td></tr>
                    )}
                  </Fragment>
                ))}
                {!data?.rows.length && <Empty cols={5}>No events match.</Empty>}
              </tbody>
            </Table>
          )}
          {data && <Pager page={page} pageSize={30} total={data.total} onPage={(n) => set("page", String(n))} />}
        </Card>
      </Page>
    </>
  );
}
