import clsx from "clsx";
import { ArrowLeft, CheckCircle2, SlidersHorizontal, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, type DecisionRow } from "../../lib/api";
import { dateTime, money, pct, SEGMENT_LABEL } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList, SERIES } from "../../ui/charts";
import {
  Banner, Button, Card, Chip, Drawer, ErrorState, Field, KV, Page, PageHeader, Select, Spinner, StatusChip, Table, Td, Th, Tr, inputCls, useAction,
} from "../../ui/ui";

interface Data {
  decision: DecisionRow; explanation: string; override_reason: string | null; original_treatment: string | null;
  snapshot: Record<string, number | string | boolean>;
  ranking: { code: string; name: string; belief: number; base_sample: number; fit: number; score: number; selection_probability?: number; fit_reasons?: string[] }[];
  trace: { step: string; agent: string; ok: boolean; detail: string }[];
  factors: { factor: string; points: number; max_points: number }[]; self_cure: number;
  nudges: { nudge_id: string; channel: string; status: string; scheduled_at: string; touch: number; escalation: boolean }[];
  metadata: Record<string, string | number | null>;
}

export default function DecisionAudit() {
  const { id = "" } = useParams();
  const { can, me } = useSession();
  const { data, error, loading, reload } = useApi<Data>(`/decisions/${id}`, [id]);
  const [open, setOpen] = useState(false);
  const [treat, setTreat] = useState("");
  const [reason, setReason] = useState("");
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading decision" />;
  const d = data.decision;
  const m = data.metadata;
  const headline = d.group === "Control" ? { tone: "neutral" as const, title: "Control holdout", body: "This customer is in the randomised comparison group and received business-as-usual treatment only." }
    : d.review_status === "pending" ? { tone: "warn" as const, title: `Held for human review: ${d.treatment}`, body: "A forbearance offer. Nothing is sent until a strategist approves it." }
    : d.overridden ? { tone: "warn" as const, title: `Overridden by a person: ${data.original_treatment} → ${d.treatment ?? "no treatment"}`, body: data.override_reason ?? "" }
    : d.review_policy === "human_review" ? { tone: "good" as const, title: `Approved by a person: ${d.treatment}`, body: `Selected by the model, approved before sending.` }
    : { tone: "info" as const, title: `Executed automatically: ${d.treatment}`, body: "A communication treatment. Policy allows these to send without review, inside the contact rules." };

  return (
    <>
      <PageHeader title="AI Decision Audit" subtitle={`${d.decision_id} · ${d.strategy} · ${d.customer}${d.origin === "mcp" ? " · asked by Nova over MCP" : ""}`}
        crumbs={[{ label: "Decisions", to: "/decisions" }, { label: d.decision_id }]} role={me?.user.role_label}
        actions={<>
          <Link to={`/journeys/${d.customer_id}`}><Button variant="secondary" icon={<ArrowLeft className="h-3.5 w-3.5" />}>Customer</Button></Link>
          {can("override_decisions") && d.group === "Treatment" && (
            <Button variant="secondary" icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Override decision</Button>
          )}
        </>} />
      <Page>
        <Banner tone={headline.tone} title={headline.title}
          action={d.selection_probability !== null ? (
            <div className="text-right">
              <p className="num text-2xl font-semibold leading-7">{pct(d.selection_probability, 0)}</p>
              <p className="text-2xs opacity-80">selection probability</p>
            </div>) : undefined}>
          {headline.body} Decision time {Number(m.latency_ms).toFixed(0)} ms · model {m.model} · strategy v{m.strategy_version}.
        </Banner>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-4">
            <Card title="Decision trace" subtitle="Each stage the decision passed through, in order, with what it found">
              <ol className="space-y-2">
                {data.trace.map((t, i) => (
                  <li key={i} className="rounded-lg border border-line p-3">
                    <div className="flex items-start gap-2.5">
                      <span className={clsx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
                        t.ok ? "bg-primary-50 text-primary-600" : "bg-bad-bg text-bad")}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[13px] font-semibold">{t.step}</p>
                          <Chip tone="neutral">{t.agent}</Chip>
                          {t.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-good" /> : <XCircle className="h-3.5 w-3.5 text-bad" />}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-fg-2">{t.detail}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            {data.ranking.length > 0 && (
              <Card title="What Thompson sampling drew" subtitle="One draw per eligible treatment from its belief, tilted by customer fit. Highest score wins." flush>
                <Table>
                  <thead><tr><Th>Treatment</Th><Th align="right">Belief</Th><Th align="right">Draw</Th><Th align="right">Fit ×</Th><Th align="right">Score</Th><Th align="right">P(select)</Th><Th>Fit reasons</Th></tr></thead>
                  <tbody>
                    {data.ranking.map((r, i) => (
                      <Tr key={r.code} className={i === 0 ? "bg-primary-50/40" : undefined}>
                        <Td><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i % 5] }} /><span className={i === 0 ? "font-semibold" : ""}>{r.name}</span>{i === 0 && <Chip tone="primary">chosen</Chip>}</span></Td>
                        <Td align="right">{pct(r.belief, 0)}</Td><Td align="right">{r.base_sample.toFixed(3)}</Td><Td align="right">{r.fit.toFixed(2)}</Td>
                        <Td align="right" className="font-semibold">{r.score.toFixed(3)}</Td><Td align="right">{pct(r.selection_probability ?? null, 0)}</Td>
                        <Td className="text-xs text-fg-3">{r.fit_reasons?.join(" · ") || "—"}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card title="Decision factors" subtitle="Points toward nudge propensity">
              <BarList rows={data.factors.map((f) => ({ label: f.factor, value: f.points, sub: `of ${f.max_points}` }))} format={(v) => (v ?? 0).toFixed(1)} max={30} />
              <p className="mt-3 border-t border-line pt-2 text-xs text-fg-2">Self-cure likelihood <span className="num font-semibold text-fg">{data.self_cure}</span> → {SEGMENT_LABEL[String(data.snapshot.segment)]}</p>
            </Card>
            <Card title="Decision metadata">
              <KV items={[
                { label: "Decision ID", value: <span className="font-mono">{m.decision_id}</span> },
                { label: "Requested by", value: m.origin === "mcp" ? <Chip tone="ai">Nova agent · MCP</Chip> : "Strategy wave" },
                { label: "Timestamp", value: dateTime(String(m.timestamp)) },
                { label: "AI model", value: m.model },
                { label: "Strategy", value: <Link className="text-primary-500 hover:underline" to={`/strategies/${m.strategy}`}>{m.strategy} v{m.strategy_version}</Link> },
                { label: "Segment", value: `${m.risk_band} risk · ${SEGMENT_LABEL[String(m.segment)]}` },
                { label: "Group", value: <StatusChip status={d.group} /> },
                { label: "Review", value: d.review_policy === "auto" ? "Not required" : <StatusChip status={d.review_status} /> },
                { label: "Outcome", value: <StatusChip status={d.outcome ?? "In window"} /> },
                { label: "Amount", value: d.amount ? money(d.amount) : "—" },
              ]} />
            </Card>
            {data.nudges.length > 0 && (
              <Card title="Messages from this decision">
                <ul className="space-y-1.5">
                  {data.nudges.map((n) => (
                    <li key={n.nudge_id} className="flex items-center justify-between gap-2 text-xs">
                      <Link to={`/nudges/${n.nudge_id}`} className="font-mono text-primary-500 hover:underline">{n.nudge_id}</Link>
                      <span className="text-fg-3">{n.escalation ? "escalation" : `touch ${n.touch}`} · {n.channel}</span>
                      <StatusChip status={n.status} />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </div>
      </Page>
      <Drawer open={open} onClose={() => setOpen(false)} title={`Override ${d.decision_id}`} subtitle={`${d.customer} · currently ${d.treatment ?? "no treatment"}`} width="max-w-md"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={reason.trim().length < 5} loading={busy === "ov"}
            onClick={() => run("ov", () => api.post(`/decisions/${d.decision_id}/override`, { treatment_code: treat || null, reason }), "Override recorded.")
              .then((r) => { if (r) { setOpen(false); setReason(""); reload(); } })}>Record override</Button></>}>
        <div className="space-y-3">
          <Banner tone="warn">An override is a human decision. It is logged with your name and reason, and it stops the model learning from this customer's outcome.</Banner>
          <Field label="Replace with">
            <Select value={treat} onChange={setTreat} options={[{ value: "", label: "No treatment (hold)" }, ...data.ranking.map((r) => ({ value: r.code, label: r.name }))]} />
          </Field>
          <Field label="Reason" required><textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputCls} h-auto py-2`} placeholder="e.g. Customer called in and agreed a plan with an agent" /></Field>
        </div>
      </Drawer>
    </>
  );
}

