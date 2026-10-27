/** Strategy Workspace: collections and recovery, by card business.
 *  Collections works delinquent accounts before charge-off; Recovery works charged-off accounts. */
import clsx from "clsx";
import { ArrowRight, BarChart3, CircleDollarSign, Coins, Database, Info, PieChart, Plus, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";

import { api, type Treatment } from "../../lib/api";
import { dateOnly, money, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Button, Card, Chip, Empty, ErrorState, Page, PageHeader, Pager, Select, Spinner, Table, Tabs, Td, Th, Tr, useAction } from "../../ui/ui";

type Tab = "collections" | "recovery";
interface Meta { businesses: string[]; recovery_treatments: RTreatment[]; charge_off_days: number }
interface RTreatment { code: string; name: string; tag: string; description: string; status: string }
interface Delta { value: number; delta: number | null }
interface RecoveryRow {
  recovery_id: number; account_number: string; name: string; product: string; charge_off_date: string;
  charge_off_balance: number; recovered: number; remaining: number; recovery_rate: number; status: string;
  recommended: RTreatment & { reason: string }; assigned: RTreatment | null; assigned_by: string | null; eligible: boolean;
}
interface RecoveryView {
  summary: { charged_off_accounts: Delta; charge_off_balance: Delta; amount_recovered: Delta; remaining_balance: Delta;
    by_status: Record<string, number>; recovery_rate: number | null };
  treatments: RTreatment[];
  population: { total: number; rows: RecoveryRow[] } | null;
}
interface CollectionsView {
  kpis: { delinquent_accounts: number; balance: number; past_due: number; in_strategies: number; collected_30d: Delta };
  strategies: { campaign_id: string; name: string; status: string; description: string; treatments: string[];
    payment_rate: number | null; lift: number | null; target: number; cohorts: string[] }[];
  population: { total: number; rows: { customer_id: number; account_number: string; name: string; product: string;
    days_past_due: number; balance: number; past_due: number; credit_limit: number; status: string }[] } | null;
}

const TAG_VARIANT: Record<string, "secondary" | "outline" | "warning"> = {
  Recommended: "secondary", Targeted: "outline", "Special Handling": "warning",
};

function deltaText(d: number | null) {
  if (d === null || d === undefined) return null;
  return `${d >= 0 ? "▲" : "▼"} ${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%`;
}

/** A headline figure with its change on the month before. */
function Tile({ label, value, delta, icon, sub }: { label: string; value: string; delta?: number | null; icon: ReactNode; sub?: string }) {
  const d = deltaText(delta ?? null);
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface p-5 shadow-card">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-fg-2">{label}</p>
        <p className="num mt-2 text-[26px] font-semibold leading-8 tracking-tight text-fg">{value}</p>
        <p className="mt-1.5 text-xs text-fg-3">
          {d ? <><span className="num font-medium text-fg-2">{d}</span> vs. prior month</> : sub}
        </p>
      </div>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-500">{icon}</span>
    </div>
  );
}

/** Colour only where someone has to act. */
function RecoveryStatus({ s }: { s: string }) {
  if (s === "Settlement Review" || s === "Specialist Review") return <Chip tone="warn">{s}</Chip>;
  return <span className="whitespace-nowrap text-xs text-fg-2">{s}</span>;
}

function OptionCard({ checked, onSelect, title, tag, children, disabled }: {
  checked: boolean; onSelect: () => void; title: string; tag?: string; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onSelect} disabled={disabled} aria-pressed={checked}
      className={clsx("flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "border-primary-500 bg-primary-50/60 ring-1 ring-primary-500" : "border-line hover:border-line-strong hover:bg-surface-hover")}>
      <span className={clsx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
        checked ? "border-primary-500" : "border-line-strong")}>
        {checked && <span className="h-2 w-2 rounded-full bg-primary-500" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-semibold text-fg">{title}</span>
          {tag && <Badge variant={TAG_VARIANT[tag] ?? "outline"}>{tag}</Badge>}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-2">{children}</span>
      </span>
    </button>
  );
}

function RecoveryTab({ product }: { product: string }) {
  const { can } = useSession();
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const qs = product ? `product=${encodeURIComponent(product)}` : "";
  const view = useApi<RecoveryView>(`/workspace/recovery?${qs}`, [product]);
  const list = useApi<{ total: number; rows: RecoveryRow[]; page_size: number }>(
    all && can("view_customer_list") ? `/workspace/recovery/accounts?${qs}&page=${page}&page_size=15` : null, [all, page, product]);
  const [selected, setSelected] = useState<number[]>([]);
  const [choice, setChoice] = useState<string>("R1");
  const { run, busy } = useAction();
  useEffect(() => { setSelected([]); setPage(1); }, [product, all]);

  const rows = all ? list.data?.rows : view.data?.population?.rows;
  const picked = useMemo(() => (rows ?? []).filter((r) => selected.includes(r.recovery_id)), [rows, selected]);
  // Default to what CARE recommends for the selection.
  useEffect(() => {
    if (!picked.length) return;
    const counts: Record<string, number> = {};
    picked.forEach((r) => { counts[r.recommended.code] = (counts[r.recommended.code] ?? 0) + 1; });
    setChoice(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  }, [picked]);

  if (view.error) return <ErrorState message={view.error} onRetry={view.reload} />;
  if (!view.data) return <Spinner label="Loading recovery" />;
  const s = view.data.summary;
  const pop = view.data.population;
  const assign = () => run("assign", () => api.post<{ assigned: number; treatment: string; status: string }>(
    "/workspace/recovery/assign", { recovery_ids: selected, treatment: choice }),
    (r) => `${r.treatment} assigned to ${r.assigned} account${r.assigned === 1 ? "" : "s"}: now ${r.status.toLowerCase()}.`)
    .then((r) => { if (r) { setSelected([]); view.reload(); list.reload(); } });
  const one = picked.length === 1 ? picked[0] : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Charged-off accounts" value={num(s.charged_off_accounts.value)} delta={s.charged_off_accounts.delta} icon={<Users className="h-5 w-5" />} />
        <Tile label="Charge-off balance" value={money(s.charge_off_balance.value)} delta={s.charge_off_balance.delta} icon={<Database className="h-5 w-5" />} />
        <Tile label="Amount recovered" value={money(s.amount_recovered.value)} delta={s.amount_recovered.delta} icon={<BarChart3 className="h-5 w-5" />} />
        <Tile label="Current recovery balance" value={money(s.remaining_balance.value)} delta={s.remaining_balance.delta}
          sub={s.recovery_rate !== null ? `${pct(s.recovery_rate)} of the charge-off balance recovered` : undefined} icon={<PieChart className="h-5 w-5" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(320px,1fr)]">
        <Card title="Recovery account population" flush
          actions={pop && <div className="flex items-center gap-4 text-xs text-fg-2">
            <span>Showing {num(rows?.length ?? 0)} of {num(pop.total)} accounts</span>
            <button type="button" onClick={() => setAll((a) => !a)} className="inline-flex items-center gap-1 font-medium text-primary-500 hover:underline">
              {all ? "Show fewer" : "View all"} <ArrowRight className="h-3 w-3" /></button></div>}>
          {!pop ? <p className="px-4 py-6 text-sm text-fg-2">Account lists are available to strategists and leaders.</p> : (
            <>
              <Table maxHeight={all ? "560px" : undefined}>
                <thead><tr><Th w="36px"> </Th><Th>Account ID</Th><Th>Card business</Th><Th align="right">Charge-off balance</Th>
                  <Th align="right">Amount recovered</Th><Th align="right">Current recovery balance</Th>
                  <Th>Recovery status</Th></tr></thead>
                <tbody>
                  {(rows ?? []).map((r) => {
                    const on = selected.includes(r.recovery_id);
                    return (
                      <Tr key={r.recovery_id} className={on ? "bg-primary-50/50" : ""}>
                        <Td><input type="checkbox" aria-label={`Select ${r.account_number}`} disabled={!r.eligible} checked={on}
                          onChange={() => setSelected((x) => (on ? x.filter((i) => i !== r.recovery_id) : [...x, r.recovery_id]))}
                          className="h-4 w-4 accent-[hsl(var(--primary))] disabled:opacity-40" /></Td>
                        <Td className="whitespace-nowrap"><span className="font-mono text-xs">{r.account_number}</span>
                          <span className="block text-2xs text-fg-3">{r.name}</span>
                          <span className="block text-2xs text-fg-3">Charged off {dateOnly(r.charge_off_date)}</span></Td>
                        <Td className="min-w-[96px] text-xs text-fg-2">{r.product}</Td>
                        <Td align="right">{money(r.charge_off_balance)}</Td>
                        <Td align="right" className="whitespace-nowrap">{money(r.recovered)}
                          <span className="block text-2xs text-fg-3">{pct(r.recovery_rate, 0)} recovery rate</span></Td>
                        <Td align="right" className="font-medium">{money(r.remaining)}</Td>
                        <Td><RecoveryStatus s={r.status} />
                          {r.assigned && <span className="block text-2xs text-fg-3">{r.assigned.name}{r.assigned_by ? ` · ${r.assigned_by}` : ""}</span>}</Td>
                      </Tr>
                    );
                  })}
                  {!(rows ?? []).length && <Empty cols={7}>No charged-off accounts for this card business.</Empty>}
                </tbody>
              </Table>
              {all && list.data && list.data.total > list.data.page_size && (
                <div className="border-t border-line px-4 py-2"><Pager page={page} pageSize={list.data.page_size} total={list.data.total} onPage={setPage} /></div>
              )}
            </>
          )}
        </Card>

        <Card title="Recovery strategy" subtitle="Select accounts, then assign a recovery treatment. Settlement offers wait for review before they go out.">
          <div className="space-y-2.5">
            {view.data.treatments.map((t) => (
              <OptionCard key={t.code} checked={choice === t.code} onSelect={() => setChoice(t.code)} title={t.name} tag={t.tag}>
                {t.description}
              </OptionCard>
            ))}
          </div>
          <div className="mt-3 min-h-[36px] text-xs leading-5 text-fg-2">
            {one ? <>CARE recommends <span className="font-medium text-fg">{one.recommended.name}</span> for {one.account_number}: {one.recommended.reason}.</>
              : picked.length ? <>{picked.length} accounts selected. The option chosen is what CARE recommends for most of them.</>
              : <>Select accounts in active collections or partial recovery. Accounts with a payment plan, a settlement or a treatment already assigned cannot be selected.</>}
          </div>
          <div className="mt-2 [&>button]:w-full [&>button]:justify-center">
            <Button variant="primary" disabled={!picked.length || !can("edit_strategy")} loading={busy === "assign"} onClick={assign}
              title={!can("edit_strategy") ? "Strategists assign recovery treatments" : undefined}>
              Assign treatment {picked.length > 0 && `to ${picked.length}`} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CollectionsTab({ product }: { product: string }) {
  const qs = product ? `product=${encodeURIComponent(product)}` : "";
  const view = useApi<CollectionsView>(`/workspace/collections?${qs}`, [product]);
  const treatments = useApi<Treatment[]>("/treatments").data;
  const { can } = useSession();
  const [choice, setChoice] = useState<string | null>(null);
  if (view.error) return <ErrorState message={view.error} onRetry={view.reload} />;
  if (!view.data) return <Spinner label="Loading collections" />;
  const k = view.data.kpis;
  const pop = view.data.population;
  const name = (code: string) => treatments?.find((t) => t.code === code)?.name ?? code;
  const picked = view.data.strategies.find((s) => s.campaign_id === choice) ?? view.data.strategies[0];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Delinquent accounts" value={num(k.delinquent_accounts)} sub={`${num(k.in_strategies)} in a strategy`} icon={<Users className="h-5 w-5" />} />
        <Tile label="Total balance" value={money(k.balance)} sub="before charge-off" icon={<Database className="h-5 w-5" />} />
        <Tile label="Delinquent amount" value={money(k.past_due)} sub="past due, to collect" icon={<CircleDollarSign className="h-5 w-5" />} />
        <Tile label="Collected, last 30 days" value={money(k.collected_30d.value)} sub="payments on accounts in a strategy" icon={<Coins className="h-5 w-5" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(320px,1fr)]">
        <Card title="Collections account population" flush
          actions={pop && <div className="flex items-center gap-4 text-xs text-fg-2">
            <span>Showing {num(pop.rows.length)} of {num(pop.total)} accounts</span>
            <Link to="/customers" className="inline-flex items-center gap-1 font-medium text-primary-500 hover:underline">View all <ArrowRight className="h-3 w-3" /></Link></div>}>
          {!pop ? <p className="px-4 py-6 text-sm text-fg-2">Account lists are available to strategists and leaders.</p> : (
            <Table>
              <thead><tr><Th>Account ID</Th><Th>Card business</Th><Th align="right">Total balance</Th>
                <Th align="right">Delinquent amount</Th><Th align="right">Days past due</Th><Th align="right">Credit limit</Th><Th>Status</Th></tr></thead>
              <tbody>
                {pop.rows.map((r) => (
                  <Tr key={r.customer_id}>
                    <Td><Link to={`/journeys/${r.customer_id}`} className="font-mono text-xs hover:underline">{r.account_number}</Link>
                      <span className="block text-2xs text-fg-3">{r.name}</span></Td>
                    <Td className="whitespace-nowrap text-fg-2">{r.product}</Td>
                    <Td align="right">{money(r.balance)}</Td>
                    <Td align="right">{money(r.past_due)}</Td>
                    <Td align="right">{r.days_past_due}</Td>
                    <Td align="right">{money(r.credit_limit)}</Td>
                    <Td className="text-xs text-fg-2">{r.status}</Td>
                  </Tr>
                ))}
                {!pop.rows.length && <Empty cols={7}>No delinquent accounts for this card business.</Empty>}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Collection strategy" subtitle="The live strategies that decide treatments for delinquent accounts. CARE chooses the treatment for each customer.">
          <div className="space-y-2.5">
            {view.data.strategies.map((s) => (
              <OptionCard key={s.campaign_id} checked={picked?.campaign_id === s.campaign_id} onSelect={() => setChoice(s.campaign_id)}
                title={s.name} tag={s.status === "Paused" ? "Paused" : undefined}>
                {s.treatments.map(name).join(" · ")}
                <span className="mt-0.5 block text-fg-3">Payment rate {pct(s.payment_rate)} · target {pct(s.target, 0)}{s.lift !== null ? ` · lift ${s.lift >= 0 ? "+" : ""}${(s.lift * 100).toFixed(1)} pp` : ""}</span>
              </OptionCard>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 [&_button]:w-full [&_button]:justify-center">
            {picked && <Link to={`/strategies/${picked.campaign_id}`}><Button>Open strategy</Button></Link>}
            {can("create_strategy") && <Link to="/builder"><Button variant="primary" icon={<Plus className="h-4 w-4" />}>New strategy</Button></Link>}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function StrategyWorkspace() {
  const { me } = useSession();
  const meta = useApi<Meta>("/workspace");
  const [product, setProduct] = useState("");
  const [tab, setTab] = useState<Tab>("recovery");
  if (meta.error) return <ErrorState message={meta.error} onRetry={meta.reload} />;
  if (!meta.data) return <Spinner label="Loading workspace" />;
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">Strategy Workspace<Badge variant="secondary">{me?.user.role_label}</Badge></span>}
        subtitle="Manage collections and recovery treatments by card business." />
      <Page>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-fg">Card business</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="w-60" value={product} onChange={setProduct}
              options={[{ value: "", label: "All card businesses" }, ...meta.data.businesses.map((b) => ({ value: b, label: b }))]} />
            {meta.data.businesses.map((b) => (
              <button key={b} type="button" onClick={() => setProduct(product === b ? "" : b)} aria-pressed={product === b}
                className={clsx("h-9 rounded-md border px-3.5 text-[13px] transition",
                  product === b ? "border-primary-500 bg-primary-50 font-medium text-primary-600" : "border-line-strong bg-surface text-fg-2 hover:bg-surface-hover")}>
                {b}
              </button>
            ))}
          </div>
        </div>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: "collections", label: "Collections" }, { id: "recovery", label: "Recovery" }]} />
        {tab === "recovery" ? <RecoveryTab product={product} /> : <CollectionsTab product={product} />}
        <div className="flex items-start gap-2.5 rounded-lg bg-primary-50/70 px-4 py-3 text-[13px] text-fg-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
          <p><span className="font-medium text-fg">Collections:</span> pre-charge-off reminders, calls and payment plans, under {meta.data.charge_off_days} days past due.
            <span className="mx-2 text-line-strong">|</span>
            <span className="font-medium text-fg">Recovery:</span> post-charge-off settlements, one-time payments and outcomes. CARE places each account from its status.</p>
        </div>
      </Page>
    </>
  );
}
