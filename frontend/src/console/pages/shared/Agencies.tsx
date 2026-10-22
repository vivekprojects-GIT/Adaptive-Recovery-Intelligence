/** Outsourced collections: the agency panel, each agency's results, and the
 *  placements waiting for a person to approve them. */
import { Check, ScanSearch, Undo2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../lib/api";
import { dateOnly, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import {
  Banner, Button, Card, Chip, Empty, ErrorState, Field, Kpi, MetricInfo, Modal, Page, PageHeader, Spinner, Table, Tabs, Td, Th, Tr,
  inputCls, useAction,
} from "../../ui/ui";

interface Agency {
  agency_id: string; name: string; fee_rate: number; products: string[]; min_dpd: number; capacity: number;
  placement_days: number; status: string; contract_ref: string; audited_at: string | null; placements: number; open: number;
  recovered_in_full: number; returned: number; recalled: number; placed_amount: number; recovered: number; fees: number;
  net_recovered: number; liquidation_rate: number | null; net_liquidation_rate: number | null; paying_rate: number | null;
  avg_days_to_first_payment: number | null;
}
interface Panel {
  agencies: Agency[]; policy: string;
  totals: { placed_amount: number; recovered: number; fees: number; net_recovered: number; placements: number; open: number;
    pending: number; liquidation_rate: number | null; net_liquidation_rate: number | null };
}
interface Placement {
  placement_id: string; customer_id: number; customer_ref: string; customer_name: string | null; product: string;
  days_past_due: number | null; agency_id: string; agency: string; fee_rate: number; status: string; amount: number;
  recovered: number; fee: number; net: number; reason: string; proposed_by: string; proposed_by_id: string; proposed_at: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string; placed_at: string | null; closed_at: string | null;
}

type Tab = "Proposed" | "Placed" | "Closed";
const CLOSED = new Set(["Recovered", "Returned", "Recalled", "Declined"]);

/** Plain text for normal states; a label only where someone should look. */
function PlacementStatus({ status }: { status: string }) {
  if (status === "Proposed") return <Chip tone="warn">Waiting for approval</Chip>;
  if (status === "Recalled" || status === "Declined") return <span className="text-xs text-fg-3">{status}</span>;
  return <span className="text-xs text-fg-2">{status === "Recovered" ? "Recovered in full" : status}</span>;
}

export default function Agencies() {
  const { me, can, refresh: refreshSession } = useSession();
  const panel = useApi<Panel>("/agencies");
  const list = useApi<Placement[]>("/placements");
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>("Proposed");
  const [acting, setActing] = useState<{ p: Placement; kind: "decline" | "recall" } | null>(null);
  const [note, setNote] = useState("");

  if (panel.error) return <ErrorState message={panel.error} onRetry={panel.reload} />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!panel.data || !list.data) return <Spinner label="Loading agencies" />;
  const t = panel.data.totals;
  const rows = list.data.filter((p) => (tab === "Closed" ? CLOSED.has(p.status) : p.status === tab));
  const count = (s: Tab) => list.data!.filter((p) => (s === "Closed" ? CLOSED.has(p.status) : p.status === s)).length;
  const approver = can("approve_placements");
  const refresh = () => { panel.reload(); list.reload(); refreshSession(); };

  const review = (p: Placement, approve: boolean, why = "") =>
    run(`r-${p.placement_id}`, () => api.post(`/placements/${p.placement_id}/review`, { approve, note: why }),
      approve ? `${p.customer_ref} placed with ${p.agency}.` : `Placement of ${p.customer_ref} declined.`).then((r) => { if (r) refresh(); return r; });
  const recall = (p: Placement, why: string) =>
    run(`c-${p.placement_id}`, () => api.post(`/placements/${p.placement_id}/recall`, { note: why }),
      `${p.customer_ref} recalled from ${p.agency}.`).then((r) => { if (r) refresh(); return r; });

  return (
    <>
      <PageHeader title="Collection agencies"
        subtitle="Late-stage accounts placed with the bank's external agency panel, and what each agency recovers"
        actions={can("override_decisions") && (
          <Button variant="primary" icon={<ScanSearch className="h-3.5 w-3.5" />} loading={busy === "scan"}
            onClick={() => run("scan", () => api.post<{ proposed: number }>("/placements/scan"),
              (r) => r.proposed ? `ARI proposed ${r.proposed} accounts for placement. Each waits for approval.` : "No more accounts are eligible for placement.")
              .then((r) => { if (r) { refresh(); setTab("Proposed"); } })}>
            Find accounts to place
          </Button>
        )} />
      <Page>
        <Banner tone="neutral" title="Placement policy">{panel.data.policy}</Banner>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Kpi label="Balance placed" metric="balance_placed" value={money(t.placed_amount, true)} sub={`${num(t.placements)} placements, ${num(t.open)} open`} />
          <Kpi label="Recovered by agencies" metric="agency_liquidation" value={money(t.recovered, true)}
            sub={`${pct(t.liquidation_rate)} of the balance placed`} />
          <Kpi label="Agency fees" metric="agency_fee" value={money(t.fees, true)} />
          <Kpi label="Net recovered" metric="net_liquidation" value={money(t.net_recovered, true)}
            sub={`${pct(t.net_liquidation_rate)} net liquidation`} />
          <Kpi label="Waiting for approval" metric="placement_approval" value={num(t.pending)} sub={approver ? "you can approve these" : "a leader approves these"} />
        </div>

        <Card title="Agency panel" subtitle="Contract terms and results to date. Agencies are compared on net recovery, after their fee." flush>
          <Table>
            <thead><tr><Th>Agency</Th><Th>Products</Th><Th align="right">Fee</Th><Th align="right">From DPD</Th>
              <Th align="right">Open / capacity</Th><Th align="right">Balance placed</Th><Th align="right">Recovered</Th>
              <Th align="right"><span className="inline-flex items-center gap-1">Net liquidation <MetricInfo metric="net_liquidation" /></span></Th>
              <Th align="right">Paying</Th><Th align="right">Days to first payment</Th></tr></thead>
            <tbody>{panel.data.agencies.map((a) => (
              <Tr key={a.agency_id}>
                <Td className="whitespace-nowrap"><span className="font-medium">{a.name}</span>
                  <span className="block text-2xs text-fg-3">{a.agency_id} · {a.contract_ref}{a.audited_at ? ` · audited ${dateOnly(a.audited_at)}` : ""}</span></Td>
                <Td className="min-w-[160px] text-fg-2">{a.products.join(", ")}</Td>
                <Td align="right" className="num">{pct(a.fee_rate, 0)}</Td>
                <Td align="right" className="num">{a.min_dpd}</Td>
                <Td align="right" className="num">{num(a.open)} / {num(a.capacity)}</Td>
                <Td align="right" className="num">{money(a.placed_amount)}</Td>
                <Td align="right" className="num">{money(a.recovered)}</Td>
                <Td align="right" className="num font-medium">{pct(a.net_liquidation_rate)}</Td>
                <Td align="right" className="num">{pct(a.paying_rate, 0)}</Td>
                <Td align="right" className="num">{a.avg_days_to_first_payment ?? "—"}</Td>
              </Tr>))}</tbody>
          </Table>
        </Card>

        <Card title="Placements" flush
          subtitle="ARI proposes; a person approves every placement, and never their own proposal. A placed account is not contacted by ARI.">
          <div className="px-4 pt-1">
            <Tabs<Tab> active={tab} onChange={setTab} tabs={[
              { id: "Proposed", label: "Waiting for approval", count: count("Proposed") },
              { id: "Placed", label: "With an agency", count: count("Placed") },
              { id: "Closed", label: "Closed", count: count("Closed") },
            ]} />
          </div>
          <Table maxHeight="560px">
            <thead><tr><Th>Placement</Th><Th>Customer</Th><Th>Product</Th><Th align="right">DPD</Th><Th>Agency</Th>
              <Th align="right">Balance</Th><Th align="right">Recovered</Th><Th>Status</Th><Th>{tab === "Proposed" ? "Why" : "History"}</Th>
              {approver && tab !== "Closed" && <Th align="right" w="170px"> </Th>}</tr></thead>
            <tbody>
              {rows.map((p) => (
                <Tr key={p.placement_id}>
                  <Td mono className="text-xs">{p.placement_id}</Td>
                  <Td className="whitespace-nowrap">{can("view_customer_list")
                    ? <Link to={`/journeys/${p.customer_id}`} className="font-medium hover:underline">{p.customer_name}</Link>
                    : <span className="font-medium">{p.customer_name}</span>}
                    <span className="block font-mono text-2xs text-fg-3">{p.customer_ref}</span></Td>
                  <Td className="whitespace-nowrap text-fg-2">{p.product}</Td>
                  <Td align="right" className="num">{p.days_past_due ?? "—"}</Td>
                  <Td className="whitespace-nowrap">{p.agency}<span className="block text-2xs text-fg-3">{pct(p.fee_rate, 0)} fee</span></Td>
                  <Td align="right" className="num">{money(p.amount)}</Td>
                  <Td align="right" className="num">{p.recovered ? money(p.recovered) : "—"}
                    {p.fee > 0 && <span className="block text-2xs text-fg-3">{money(p.net)} net</span>}</Td>
                  <Td className="whitespace-nowrap"><PlacementStatus status={p.status} /></Td>
                  <Td className="min-w-[300px] max-w-[440px] text-xs leading-5 text-fg-2">
                    {tab === "Proposed" ? p.reason : <>
                      Proposed by {p.proposed_by} {dateOnly(p.proposed_at)}
                      {p.reviewed_by && <>; {p.status === "Declined" ? "declined" : "approved"} by {p.reviewed_by} {dateOnly(p.reviewed_at)}</>}
                      {p.review_note && <span className="block text-fg-3">{p.review_note}</span>}</>}
                  </Td>
                  {approver && tab !== "Closed" && (
                    <Td align="right">
                      {p.status === "Proposed" && (
                        <div className="flex justify-end gap-1.5 whitespace-nowrap">
                          <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy === `r-${p.placement_id}`}
                            disabled={p.proposed_by_id === me?.user.user_id}
                            title={p.proposed_by_id === me?.user.user_id ? "You proposed this placement; someone else approves it" : undefined}
                            onClick={() => review(p, true)}>Approve</Button>
                          <Button size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => { setNote(""); setActing({ p, kind: "decline" }); }}>Decline</Button>
                        </div>
                      )}
                      {p.status === "Placed" && (
                        <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />}
                          onClick={() => { setNote(""); setActing({ p, kind: "recall" }); }}>Recall</Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
              {!rows.length && <Empty cols={approver && tab !== "Closed" ? 10 : 9}>
                {tab === "Proposed" ? "No placements are waiting for approval." : "No placements here yet."}</Empty>}
            </tbody>
          </Table>
        </Card>
      </Page>

      <Modal open={!!acting} onClose={() => setActing(null)}
        title={acting?.kind === "decline" ? `Decline placement ${acting?.p.placement_id}` : `Recall ${acting?.p.customer_ref} from ${acting?.p.agency}`}
        footer={<>
          <Button onClick={() => setActing(null)}>Cancel</Button>
          <Button variant={acting?.kind === "decline" ? "danger" : "primary"} disabled={note.trim().length < 5}
            loading={!!acting && (busy === `r-${acting.p.placement_id}` || busy === `c-${acting.p.placement_id}`)}
            onClick={async () => {
              if (!acting) return;
              const ok = acting.kind === "decline" ? await review(acting.p, false, note) : await recall(acting.p, note);
              if (ok) setActing(null);
            }}>{acting?.kind === "decline" ? "Decline placement" : "Recall account"}</Button>
        </>}>
        <Field label="Reason" hint="Recorded in the audit log." required>
          <textarea className={`${inputCls} h-24 py-2`} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={acting?.kind === "decline" ? "For example: customer called in with a payment offer" : "For example: dispute raised by the customer"} />
        </Field>
      </Modal>
    </>
  );
}
