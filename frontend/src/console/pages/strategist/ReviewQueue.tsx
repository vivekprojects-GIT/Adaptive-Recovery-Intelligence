import { Check, X } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";

import { api, type DecisionRow } from "../../lib/api";
import { ago, money, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Banner, Button, Card, Empty, ErrorState, Field, Modal, Page, PageHeader, Spinner, Table, Td, Th, Tr, inputCls, useAction } from "../../ui/ui";

interface Detail { snapshot: Record<string, number | string>; explanation: string }

export default function ReviewQueue() {
  const { me, refresh } = useSession();
  const { data, error, loading, reload } = useApi<{ rows: DecisionRow[]; total: number }>("/decisions?review=pending&page_size=100");
  const [reject, setReject] = useState<DecisionRow | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Detail>>({});
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner />;

  const decide = (d: DecisionRow, approve: boolean, n = "") =>
    run(d.decision_id, () => api.post<{ status?: string }>(`/decisions/${d.decision_id}/review`, { approve, note: n }),
      (r) => approve ? `${d.decision_id} approved and sent (${r.status ?? "executed"}).` : `${d.decision_id} rejected. Nothing was sent.`)
      .then((r) => { if (r) { reload(); refresh(); } });

  const toggle = async (id: string) => {
    setOpen(open === id ? null : id);
    if (!detail[id]) {
      const d = await api.get<Detail>(`/decisions/${id}`);
      setDetail((x) => ({ ...x, [id]: d }));
    }
  };

  return (
    <>
      <PageHeader title="Review Queue" subtitle="Forbearance offers chosen by the engine, waiting for a person" role={me?.user.role_label} />
      <Page>
        <Banner tone="info" title="Why these wait">
          Payment plans, deferrals and hardship referrals change what a customer owes or when. They are chosen by the model like any treatment, but nothing is sent until you approve it. Approving sends it; rejecting records why and sends nothing.
        </Banner>
        <Card flush title={`${data?.total ?? 0} decisions waiting`}>
          <Table>
            <thead><tr><Th>Decision</Th><Th>Customer</Th><Th>Strategy</Th><Th>Proposed offer</Th><Th align="right">Chosen</Th><Th>Waiting</Th><Th align="right">Action</Th></tr></thead>
            <tbody>
              {data?.rows.map((d) => (
                <Fragment key={d.decision_id}>
                  <Tr>
                    <Td><button onClick={() => toggle(d.decision_id)} className="font-mono text-xs font-medium text-primary-500 hover:underline">{d.decision_id}</button></Td>
                    <Td><Link to={`/journeys/${d.customer_id}`} className="hover:text-primary-500">{d.customer}</Link><span className="block text-2xs text-fg-3">#{d.customer_id}</span></Td>
                    <Td className="text-xs">{d.campaign_id}</Td>
                    <Td className="font-medium">{d.treatment}</Td>
                    <Td align="right">{pct(d.selection_probability, 0)}</Td>
                    <Td className="text-xs text-fg-3">{ago(d.decided_at)}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy === d.decision_id} onClick={() => decide(d, true)}>Approve</Button>
                        <Button size="sm" variant="secondary" icon={<X className="h-3.5 w-3.5" />} onClick={() => setReject(d)}>Reject</Button>
                      </div>
                    </Td>
                  </Tr>
                  {open === d.decision_id && detail[d.decision_id] && (
                    <tr><td colSpan={7} className="border-b border-line bg-surface-sunken px-4 py-3 text-xs leading-5 text-fg-2">
                      <p>{detail[d.decision_id].explanation}</p>
                      <p className="mt-1 text-fg-3">
                        Balance {money(Number(detail[d.decision_id].snapshot.balance))} · arrears {money(Number(detail[d.decision_id].snapshot.arrears))} ·
                        {" "}{detail[d.decision_id].snapshot.days_past_due} DPD · missed {detail[d.decision_id].snapshot.missed_payments} in 12 months ·
                        {" "}hardship flag {detail[d.decision_id].snapshot.hardship_flag ? "yes" : "no"} · <Link to={`/decisions/${d.decision_id}`} className="text-primary-500 hover:underline">full audit</Link>
                      </p>
                    </td></tr>
                  )}
                </Fragment>
              ))}
              {!data?.rows.length && <Empty cols={7}>Nothing is waiting. New plan and deferral offers appear here when a wave runs.</Empty>}
            </tbody>
          </Table>
        </Card>
      </Page>
      <Modal open={!!reject} onClose={() => { setReject(null); setNote(""); }} title={`Reject ${reject?.decision_id}`}
        footer={<><Button variant="ghost" onClick={() => setReject(null)}>Cancel</Button>
          <Button variant="danger" disabled={!note.trim()} onClick={() => { decide(reject!, false, note); setReject(null); setNote(""); }}>Reject offer</Button></>}>
        <Field label="Reason" required hint="Recorded in the audit log against your name.">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} h-auto py-2`} placeholder="e.g. Customer already agreed a plan with an agent" />
        </Field>
      </Modal>
    </>
  );
}
