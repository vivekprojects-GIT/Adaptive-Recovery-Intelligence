import { Archive, ArchiveRestore, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api, type RulePreview, type Rules, type Treatment, type TreatmentSchema } from "../../lib/api";
import { ago, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import {
  Banner, Button, Card, Chip, Drawer, Empty, ErrorState, Field, Kpi, Menu, Modal, Page, PageHeader, Pills, Progress, Select,
  Spinner, StatusChip, Table, Td, Th, Toggle, Tr, inputCls, useAction,
} from "../../ui/ui";

/** Forbearance-type kinds change what the customer owes: a person approves each offer by default. */
const REVIEW_BY_DEFAULT = new Set(["Arrangement", "Deferral", "Hardship"]);

type FormRules = Record<string, string | boolean>;
interface Form {
  name: string; kind: string; channel: string; offer: string; timing: string; cost: string;
  human_review: boolean; rules: FormRules;
}

const BLANK: Form = {
  name: "", kind: "Reminder", channel: "SMS", offer: "", timing: "Day 1", cost: "0.10", human_review: false, rules: {},
};

function toForm(t: Treatment): Form {
  const rules: FormRules = {};
  Object.entries(t.rules).forEach(([k, v]) => {
    rules[k] = typeof v === "boolean" ? v : k === "min_payment_history" ? String(Math.round(Number(v) * 100)) : String(v);
  });
  return { name: t.name, kind: t.kind, channel: t.channel, offer: t.offer, timing: t.timing, cost: String(t.cost),
    human_review: t.human_review, rules };
}

function toRules(f: FormRules, schema: TreatmentSchema): Rules {
  const out: Record<string, number | boolean> = {};
  schema.rules.forEach((r) => {
    const v = f[r.key];
    if (r.type === "bool") { if (v === true) out[r.key] = true; return; }
    if (v === undefined || v === "" || v === false) return;
    out[r.key] = r.type === "percent" ? Number(v) / 100 : Number(v);
  });
  return out as Rules;
}

/** What the customer would receive, in the channel's approved wording. Mirrors the engine. */
function messagePreview(channel: string, offer: string): string {
  const o = `${offer.trim().replace(/\.$/, "") || "Your offer text"}.`;
  if (channel === "Outbound call") return `Call script: confirm identity, explain the $146 past due, then offer: ${o} Record the outcome. No pressure language.`;
  if (channel === "Specialist team") return `Referral to the specialist team. Offer: ${o}`;
  if (channel === "Letter") return `Dear Priya, your card ending 4021 has $146 past due. ${o} Call us or visit ari.bank/p/3fa1c2 to respond.`;
  if (channel === "Email") return `Hi Priya, about the $146 past due on your card ending 4021: ${o} Details: ari.bank/p/3fa1c2. Unsubscribe at any time.`;
  if (channel === "App push") return `${o} Tap to review.`;
  return `Hi Priya, about the $146 past due on your card ending 4021: ${o} Details: ari.bank/p/3fa1c2. Reply STOP to opt out.`;
}

function Editor({ target, schema, onClose, onSaved }: {
  target: Treatment | "new"; schema: TreatmentSchema; onClose: () => void; onSaved: () => void;
}) {
  const existing = target === "new" ? null : target;
  const [form, setForm] = useState<Form>(existing ? toForm(existing) : BLANK);
  const [reviewTouched, setReviewTouched] = useState(!!existing);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const { run, busy } = useAction();
  const rules = useMemo(() => toRules(form.rules, schema), [form.rules, schema]);
  const rulesKey = JSON.stringify(rules);

  useEffect(() => {
    const t = setTimeout(() => api.post<RulePreview>("/treatments/preview", { rules: JSON.parse(rulesKey) })
      .then((r) => { setPreview(r); setPreviewError(null); })
      .catch((e: Error) => setPreviewError(e.message)), 300);
    return () => clearTimeout(t);
  }, [rulesKey]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setRule = (k: string, v: string | boolean) => setForm((f) => ({ ...f, rules: { ...f.rules, [k]: v } }));
  const setKind = (kind: string) => setForm((f) => ({ ...f, kind, human_review: reviewTouched ? f.human_review : REVIEW_BY_DEFAULT.has(kind) }));
  const kindHelp = schema.kinds.find((k) => k.kind === form.kind)?.help;
  const valid = form.name.trim().length >= 3 && form.offer.trim().length >= 3 && form.cost !== "" && Number(form.cost) >= 0;
  const live = existing?.usage.live_strategies ?? 0;

  const save = () => run("save", () => {
    const body = { name: form.name, kind: form.kind, channel: form.channel, offer: form.offer, timing: form.timing,
      cost: Number(form.cost), human_review: form.human_review, rules };
    return existing ? api.put<Treatment>(`/treatments/${existing.code}`, body) : api.post<Treatment>("/treatments", body);
  }, (t) => existing
    ? `Saved ${t.code}${t.material_change ? ` as v${t.version}` : ""}.${t.material_change && live ? ` Live strategies use it from their next wave.` : ""}`
    : `Added ${t.code} ${t.name}. Strategies can now choose it; with no track record it starts from a flat prior.`)
    .then((t) => { if (t) { onSaved(); onClose(); } });

  const bools = schema.rules.filter((r) => r.type === "bool");
  const limits = schema.rules.filter((r) => r.type !== "bool");
  return (
    <Drawer open onClose={onClose} width="max-w-3xl"
      title={existing ? `Edit ${existing.code} · ${existing.name}` : "New treatment"}
      subtitle={existing ? `Version ${existing.version}${existing.updated_by ? ` · last changed by ${existing.updated_by} ${ago(existing.updated_at)}` : ""}` : "Business-authored. Strategies can only choose treatments in the playbook."}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} loading={busy === "save"} onClick={save}>{existing ? "Save changes" : "Add to playbook"}</Button>
      </>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          {live > 0 && (
            <Banner tone="info" title={`Used by ${live} live strateg${live === 1 ? "y" : "ies"}`}>
              Saved changes apply from their next wave. Changing the kind, channel, rules or approval policy creates version {existing!.version + 1}; past decisions keep the version they were made under.
            </Banner>
          )}
          <Field label="Treatment name" required><input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. In-app instalment plan" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind" hint={kindHelp}>
              <Select value={form.kind} onChange={setKind} options={schema.kinds.map((k) => ({ value: k.kind, label: k.kind }))} />
            </Field>
            <Field label="Channel">
              <Select value={form.channel} onChange={(v) => set("channel", v)} options={schema.channels.map((c) => ({ value: c, label: c }))} />
            </Field>
          </div>
          <Field label="Offer or message" required hint="What the customer is offered. It is sent inside the channel's approved wording; SMS always carries opt-out instructions.">
            <textarea rows={2} className={`${inputCls} h-auto py-2`} value={form.offer} onChange={(e) => set("offer", e.target.value)}
              placeholder="e.g. Spread the arrears over 4 months in the app, no fee." />
          </Field>
          {!existing?.builtin && (
            <div>
              <p className="label mb-1.5">Message preview</p>
              <div className="max-w-md rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-5 text-fg ring-1 ring-line">{messagePreview(form.channel, form.offer)}</div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Timing"><input className={inputCls} value={form.timing} onChange={(e) => set("timing", e.target.value)} placeholder="Day 1" /></Field>
            <Field label="Cost per contact ($)" required><input type="number" min={0} step="0.01" className={inputCls} value={form.cost} onChange={(e) => set("cost", e.target.value)} /></Field>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium">A person approves each offer</p>
              <p className="mt-0.5 text-2xs leading-4 text-fg-3">On by default for plans, deferrals and hardship support, which change what the customer owes. Approved offers go to the Review Queue first.</p>
            </div>
            <Toggle checked={form.human_review} label="Human approval" onChange={(v) => { setReviewTouched(true); set("human_review", v); }} />
          </div>

          <div>
            <p className="text-[13px] font-semibold">Who may receive it</p>
            <p className="mb-2 text-2xs text-fg-3">Every rule must hold. Leave a limit empty for no limit. Consent, opt-outs and contact caps apply on top of these, always.</p>
            <div className="space-y-2">
              {bools.map((r) => (
                <div key={r.key} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                  <span className="text-[13px]">{r.label}</span>
                  <Toggle checked={form.rules[r.key] === true} label={r.label} onChange={(v) => setRule(r.key, v)} />
                </div>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {limits.map((r) => (
                <Field key={r.key} label={r.label}>
                  <div className="flex items-center gap-1.5">
                    {r.type === "money" && <span className="text-xs text-fg-3">$</span>}
                    <input type="number" min={0} max={r.type === "percent" ? 100 : undefined} step={r.type === "number" ? "0.5" : "1"}
                      className={inputCls} value={String(form.rules[r.key] ?? "")} placeholder="No limit"
                      onChange={(e) => setRule(r.key, e.target.value)} />
                    {r.type === "percent" && <span className="text-xs text-fg-3">%</span>}
                  </div>
                </Field>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
          <div className="rounded-lg border border-line p-3">
            <p className="label">Eligible when</p>
            <p className="mt-1 text-[13px] font-medium leading-5">{preview?.rule ?? "…"}</p>
          </div>
          <div className="rounded-lg border border-line p-3">
            <p className="label">Reach today</p>
            {previewError ? <p className="mt-1 text-xs text-bad">{previewError}</p> : preview ? (
              <>
                <p className="num mt-1 text-2xl font-semibold">{num(preview.eligible)}</p>
                <p className="text-2xs text-fg-3">of {num(preview.customers)} customers · {num(preview.persuadable)} can be helped by a treatment</p>
                <div className="mt-3 space-y-2">
                  {preview.by_cohort.map((c) => (
                    <div key={c.cohort_id}>
                      <div className="flex justify-between text-2xs"><span className="text-fg-2">{c.cohort_id}</span><span className="num text-fg-3">{num(c.eligible)} / {num(c.customers)}</span></div>
                      <Progress value={(c.eligible / Math.max(1, c.customers)) * 100} />
                    </div>
                  ))}
                </div>
                {preview.excluded_by.length > 0 && (
                  <div className="mt-3 border-t border-line pt-2">
                    <p className="label mb-1">Most often excluded by</p>
                    {preview.excluded_by.map((x) => <p key={x.reason} className="flex justify-between gap-2 text-2xs text-fg-3"><span>{x.reason}</span><span className="num">{num(x.count)}</span></p>)}
                  </div>
                )}
              </>
            ) : <p className="mt-1 text-xs text-fg-3">Calculating…</p>}
          </div>
          <p className="px-1 text-2xs leading-4 text-fg-3">
            {existing && existing.historical_n > 0
              ? `Thompson sampling starts from this treatment's track record (${pct(existing.historical_rate, 0)} over ${num(existing.historical_n)} cases), weighted lightly.`
              : "No track record yet: Thompson sampling starts from a flat prior and explores it on equal terms, then follows the evidence."}
          </p>
        </aside>
      </div>
    </Drawer>
  );
}

export default function TreatmentsPage() {
  const { me, can } = useSession();
  const list = useApi<Treatment[]>("/treatments");
  const schema = useApi<TreatmentSchema>("/treatments/schema").data;
  const [filter, setFilter] = useState<"all" | "Active" | "Retired">("Active");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Treatment | "new" | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "delete" | "retire"; t: Treatment }>(null);
  const { run, busy } = useAction();
  const manage = can("manage_treatments");
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (!list.data || !schema) return <Spinner />;
  const all = list.data;
  const rows = all.filter((t) => (filter === "all" || t.status === filter)
    && (!q || `${t.code} ${t.name} ${t.kind} ${t.channel}`.toLowerCase().includes(q.toLowerCase())));
  const active = all.filter((t) => t.status === "Active");

  const setStatus = (t: Treatment, to: "retire" | "activate") =>
    run(`${to}-${t.code}`, () => api.post<Treatment>(`/treatments/${t.code}/${to}`),
      to === "retire" ? `${t.code} retired. No strategy can choose it from the next wave on.` : `${t.code} is active again.`)
      .then((r) => { if (r) list.reload(); });

  return (
    <>
      <PageHeader title="Treatment Playbook" role={me?.user.role_label}
        subtitle="The approved actions ARI may take. Strategies choose from these, and Thompson sampling learns which works for whom."
        actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>New treatment</Button>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Active treatments" value={active.length} sub={`${all.length - active.length} retired`} />
          <Kpi label="Learning from scratch" value={active.filter((t) => t.historical_n === 0).length} sub="no track record: flat prior" />
          <Kpi label="Need human approval" value={active.filter((t) => t.human_review).length} sub="offers go to the Review Queue" />
          <Kpi label="Used by live strategies" value={active.filter((t) => t.usage.live_strategies > 0).length} sub={`of ${active.length} active`} />
        </div>

        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <Pills value={filter} onChange={setFilter} options={[
              { id: "Active", label: "Active", count: active.length },
              { id: "Retired", label: "Retired", count: all.length - active.length },
              { id: "all", label: "All", count: all.length },
            ]} />
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
              <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search treatments" />
            </div>
          </div>
          <Table>
            <thead><tr>
              <Th>Treatment</Th><Th>Channel</Th><Th>Eligible when</Th><Th align="right">Cost</Th><Th>Track record</Th>
              <Th>Approval</Th><Th>Used by</Th><Th>Status</Th>{manage && <Th align="right">Actions</Th>}
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <Tr key={t.code} className={t.status === "Retired" ? "opacity-70" : undefined}>
                  <Td>
                    <span className="flex items-center gap-1.5"><span className="font-mono text-2xs text-fg-3">{t.code}</span><span className="font-medium">{t.name}</span></span>
                    <span className="mt-0.5 flex items-center gap-1.5"><Chip tone="primary">{t.kind}</Chip><span className="text-2xs text-fg-3">v{t.version}</span></span>
                  </Td>
                  <Td className="text-fg-2">{t.channel}</Td>
                  <Td className="max-w-[260px] text-xs leading-4 text-fg-2">{t.eligibility_rule}</Td>
                  <Td align="right">{money(t.cost)}</Td>
                  <Td>{t.historical_n > 0
                    ? <span className="num text-xs">{pct(t.historical_rate, 0)}<span className="block text-2xs text-fg-3">raw, n={num(t.historical_n)}</span></span>
                    : <Chip tone="ai" title="Thompson sampling explores it from a flat prior">None yet</Chip>}</Td>
                  <Td>{t.human_review ? <Chip tone="warn">human review</Chip> : <Chip tone="neutral">automatic</Chip>}</Td>
                  <Td className="text-xs">
                    {t.usage.strategies.length ? (
                      <span className="flex flex-wrap gap-1">
                        {t.usage.strategies.slice(0, 3).map((x) => (
                          <Link key={x.campaign_id} to={`/strategies/${x.campaign_id}`} title={`${x.name} · ${x.status}`}
                            className="font-mono text-2xs text-primary-500 hover:underline">{x.campaign_id}</Link>
                        ))}
                        {t.usage.strategies.length > 3 && <span className="text-2xs text-fg-3">+{t.usage.strategies.length - 3}</span>}
                      </span>
                    ) : <span className="text-fg-3">—</span>}
                    {t.usage.decisions > 0 && <span className="block text-2xs text-fg-3">{num(t.usage.decisions)} decisions</span>}
                  </Td>
                  <Td><StatusChip status={t.status} /></Td>
                  {manage && (
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(t)}>Edit</Button>
                        <Menu size="sm" label={`More actions for ${t.code}`} items={[
                          t.status === "Active"
                            ? { label: "Retire", icon: <Archive className="h-3.5 w-3.5" />, onClick: () => setConfirm({ kind: "retire", t }),
                                disabled: active.length <= 1, reason: "At least one treatment must stay active." }
                            : { label: "Reactivate", icon: <ArchiveRestore className="h-3.5 w-3.5" />, onClick: () => setStatus(t, "activate") },
                          { label: "Delete", icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setConfirm({ kind: "delete", t }),
                            disabled: !t.usage.deletable,
                            reason: `Used by ${t.usage.strategies.length ? t.usage.strategies.map((x) => x.campaign_id).join(", ") : "past decisions"}. Retire it instead.` },
                        ]} />
                      </div>
                    </Td>
                  )}
                </Tr>
              ))}
              {!rows.length && <Empty cols={manage ? 9 : 8}>No treatments match.</Empty>}
            </tbody>
          </Table>
          <p className="border-t border-line px-4 py-2.5 text-2xs leading-4 text-fg-3">
            Track record is the bank's raw historical success rate. It includes customers who would have paid anyway, so ARI uses it only as a weak starting belief. A treatment without one is explored on equal terms.
          </p>
        </Card>
      </Page>

      {editing && <Editor target={editing} schema={schema} onClose={() => setEditing(null)} onSaved={list.reload} />}

      <Modal open={confirm?.kind === "retire"} onClose={() => setConfirm(null)} title={`Retire ${confirm?.t.code} ${confirm?.t.name}?`}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="primary" icon={<Archive className="h-3.5 w-3.5" />} loading={busy === `retire-${confirm?.t.code}`}
            onClick={() => confirm && setStatus(confirm.t, "retire").then(() => setConfirm(null))}>Retire</Button>
        </>}>
        <div className="space-y-2 text-[13px] leading-5 text-fg-2">
          <p>From the next wave on, no strategy can choose it. Every past decision keeps its record, and it can be reactivated later.</p>
          {confirm && confirm.t.usage.live_strategies > 0 && (
            <p>{confirm.t.usage.live_strategies} live strateg{confirm.t.usage.live_strategies === 1 ? "y uses" : "ies use"} it ({confirm.t.usage.strategies.filter((x) => x.status === "Live").map((x) => x.campaign_id).join(", ")}). They carry on with their other treatments.</p>
          )}
        </div>
      </Modal>

      <Modal open={confirm?.kind === "delete"} onClose={() => setConfirm(null)} title={`Delete ${confirm?.t.code} ${confirm?.t.name}?`}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} loading={busy === "delete"}
            onClick={() => confirm && run("delete", () => api.del(`/treatments/${confirm.t.code}`), `${confirm.t.code} deleted.`)
              .then((r) => { setConfirm(null); if (r) list.reload(); })}>Delete treatment</Button>
        </>}>
        <p className="text-[13px] leading-5 text-fg-2">
          No strategy or decision has used it, so it is removed permanently. The audit log keeps a record that it existed and who deleted it.
        </p>
      </Modal>
    </>
  );
}
