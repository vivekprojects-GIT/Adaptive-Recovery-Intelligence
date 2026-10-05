import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Button, Card, Chip, Drawer, Empty, ErrorState, Field, Page, PageHeader, Select, Spinner, StatusChip, Table, Td, Th, Toggle, Tr, inputCls, useAction } from "../../ui/ui";

interface Rule { rule_id: number; name: string; metric: string; metric_label: string; comparator: string; threshold: number; scope: string;
  severity: string; enabled: boolean; notify: string; updated_at: string; firing: number }
const BLANK = { name: "", metric: "escalation_rate", comparator: "gt", threshold: 0.1, severity: "High", enabled: true, notify: "" };

export default function AlertRules() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ rules: Rule[]; metrics: { key: string; label: string }[] }>("/admin/alerts");
  const [edit, setEdit] = useState<Rule | null>(null);
  const [form, setForm] = useState(BLANK);
  const [open, setOpen] = useState(false);
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const start = (r?: Rule) => { setEdit(r ?? null); setForm(r ? { name: r.name, metric: r.metric, comparator: r.comparator, threshold: r.threshold, severity: r.severity, enabled: r.enabled, notify: r.notify } : BLANK); setOpen(true); };
  const save = () => run("s", () => edit ? api.put(`/admin/alerts/${edit.rule_id}`, form) : api.post("/admin/alerts", form), edit ? "Rule updated." : "Rule created.")
    .then((r) => { if (r) { setOpen(false); reload(); } });
  return (
    <>
      <PageHeader title="Alert Rules" subtitle="Thresholds evaluated against live metrics; firing alerts appear on the leader dashboard" role={me?.user.role_label}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => start()}>New rule</Button>} />
      <Page>
        <Card flush>
          <Table>
            <thead><tr><Th>Rule</Th><Th>Condition</Th><Th>Scope</Th><Th>Severity</Th><Th>Notify</Th><Th>Firing now</Th><Th>Enabled</Th><Th align="right">Actions</Th></tr></thead>
            <tbody>
              {data.rules.map((r) => (
                <Tr key={r.rule_id}>
                  <Td className="font-medium">{r.name}<span className="block text-2xs text-fg-3">updated {ago(r.updated_at)}</span></Td>
                  <Td className="text-xs">{r.metric_label} {r.comparator === "lt" ? "<" : ">"} <span className="num font-semibold">{r.threshold}</span></Td>
                  <Td><Chip tone="neutral">{r.scope}</Chip></Td><Td><StatusChip status={r.severity} /></Td>
                  <Td className="text-xs text-fg-2">{r.notify || "—"}</Td>
                  <Td>{r.firing ? <Chip tone="bad">{r.firing} firing</Chip> : <Chip tone="good">quiet</Chip>}</Td>
                  <Td><Toggle checked={r.enabled} label={r.name} onChange={(v) => run("t", () => api.put(`/admin/alerts/${r.rule_id}`, { ...r, enabled: v }), v ? "Rule enabled." : "Rule disabled.").then(reload)} /></Td>
                  <Td align="right"><div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => start(r)}>Edit</Button>
                    <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} loading={busy === `d${r.rule_id}`}
                      onClick={() => run(`d${r.rule_id}`, () => api.del(`/admin/alerts/${r.rule_id}`), "Rule deleted.").then(reload)}>Delete</Button>
                  </div></Td>
                </Tr>
              ))}
              {!data.rules.length && <Empty cols={8}>No alert rules.</Empty>}
            </tbody>
          </Table>
        </Card>
      </Page>
      <Drawer open={open} onClose={() => setOpen(false)} title={edit ? "Edit alert rule" : "New alert rule"} width="max-w-md"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={form.name.length < 3} loading={busy === "s"} onClick={save}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Metric"><Select value={form.metric} onChange={(v) => setForm({ ...form, metric: v })} options={data.metrics.map((m) => ({ value: m.key, label: m.label }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Condition"><Select value={form.comparator} onChange={(v) => setForm({ ...form, comparator: v })} options={[{ value: "gt", label: "Above" }, { value: "lt", label: "Below" }]} /></Field>
            <Field label="Threshold" hint="Rates as fractions (0.08 = 8%)"><input type="number" step="any" className={inputCls} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Severity"><Select value={form.severity} onChange={(v) => setForm({ ...form, severity: v })} options={["Critical", "High", "Medium", "Low"].map((s) => ({ value: s, label: s }))} /></Field>
          <Field label="Notify"><input className={inputCls} value={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.value })} placeholder="e.g. Strategy owner, James Thornton" /></Field>
          <label className="flex items-center gap-2 text-[13px]"><Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />Enabled</label>
        </div>
      </Drawer>
    </>
  );
}
