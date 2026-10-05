import clsx from "clsx";
import { ChevronDown, ExternalLink, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { AnalyticsRow } from "../../lib/api";
import { money, num, pct, pp } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { AllocationChart, SERIES, UpliftRow } from "../../ui/charts";
import { LEARNING_TONE, RESULT_TONE } from "../../ui/domain";
import {
  Button, Card, Chip, Empty, ErrorState, Kpi, KV, Page, PageHeader, Pills, Select, Spinner, StatusChip, Table, Td, Th, Tr,
  inputCls,
} from "../../ui/ui";

type View = "running" | "Live" | "Paused" | "Archived";
type SortKey = "uplift" | "confidence" | "recovery" | "recovered" | "name";

const BY: Record<SortKey, (a: AnalyticsRow, b: AnalyticsRow) => number> = {
  uplift: (a, b) => (b.stats.uplift ?? -9) - (a.stats.uplift ?? -9),
  confidence: (a, b) => (b.learning_state.lead?.p_best ?? -1) - (a.learning_state.lead?.p_best ?? -1),
  recovery: (a, b) => (b.stats.recovery_rate ?? -1) - (a.stats.recovery_rate ?? -1),
  recovered: (a, b) => b.stats.recovered - a.stats.recovered,
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Share of recent treated customers each treatment received. Colours follow the treatment, as in every chart. */
function MixBar({ row }: { row: AnalyticsRow }) {
  const arms = row.learning_state.arms;
  if (!arms.some((a) => a.recent_share)) return <span className="text-xs text-fg-3">—</span>;
  return (
    <div title={arms.map((a) => `${a.name}: ${pct(a.recent_share, 0)}`).join("\n")}
      className="flex h-2.5 w-28 gap-0.5 overflow-hidden rounded-full bg-surface-sunken">
      {arms.map((a, i) => (a.recent_share ? (
        <div key={a.code} style={{ width: `${a.recent_share * 100}%`, background: SERIES[i % 5] }} />
      ) : null))}
    </div>
  );
}

function Detail({ row }: { row: AnalyticsRow }) {
  const navigate = useNavigate();
  const ls = row.learning_state;
  const s = row.stats;
  return (
    <div className="grid gap-5 border-t border-line bg-surface-sunken/40 px-4 py-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
        <div className="space-y-1.5 text-[13px] leading-5">
          <p><span className="label mr-2 inline-block w-16">Result</span>{row.results_state.verdict}</p>
          <p><span className="label mr-2 inline-block w-16">Learning</span>{ls.verdict}</p>
        </div>
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <Table>
            <thead><tr><Th>Treatment</Th><Th align="right">Payment rate</Th><Th>Chance it is best</Th>
              <Th align="right">Recent customers</Th><Th align="right">Eligible</Th><Th align="right">Learned</Th></tr></thead>
            <tbody>
              {ls.arms.map((a, i) => (
                <Tr key={a.code}>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i % 5] }} />
                      <span className={a.code === ls.lead?.code ? "font-medium" : "text-fg-2"}>{a.name}</span>
                      {a.prior === "uniform" && <Chip tone="info" title="No track record: started from a flat prior">new</Chip>}
                    </span>
                  </Td>
                  <Td align="right">{pct(a.mean, 0)}<span className="block text-2xs text-fg-3">{pct(a.low, 0)}–{pct(a.high, 0)}</span></Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                        <span className="block h-full rounded-full" style={{ width: `${a.p_best * 100}%`, background: SERIES[i % 5] }} />
                      </span>
                      <span className="num text-xs">{pct(a.p_best, 0)}</span>
                    </span>
                  </Td>
                  <Td align="right">{pct(a.recent_share, 0)}</Td>
                  <Td align="right">{pct(a.eligible_share, 0)}</Td>
                  <Td align="right">{num(a.learned)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
        <p className="text-2xs leading-4 text-fg-3">
          Payment rate is the engine's current belief, with its 95% range. Recent customers covers the last {ls.recent_waves} wave{ls.recent_waves === 1 ? "" : "s"}. Eligible is the share of this strategy's audience the treatment's rules allow.
        </p>
      </div>
      <div className="min-w-0 space-y-3">
        <div>
          <p className="label mb-1">Who got what, wave by wave</p>
          <AllocationChart learning={row.learning} height={190} />
        </div>
        <KV items={[
          { label: "Waves run", value: num(row.waves_run) },
          { label: "Contacts sent", value: num(s.contacts) },
          { label: "Cost per recovery", value: money(s.cost_per_recovery) },
          { label: "Escalation rate", value: pct(s.escalation_rate) },
          { label: "Waiting for approval", value: num(s.pending_review) },
        ]} />
        <div className="flex justify-end">
          <Button size="sm" icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => navigate(`/strategies/${row.campaign_id}?tab=learning`)}>Open {row.campaign_id}</Button>
        </div>
      </div>
    </div>
  );
}

/** Every strategy side by side: its result against its own control group, and
 *  where Thompson sampling stands in it. */
export default function StrategyAnalytics() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ strategies: AnalyticsRow[] }>("/analytics/strategies?include_archived=true");
  const [view, setView] = useState<View>("running");
  const [sort, setSort] = useState<SortKey>("uplift");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const all = useMemo(() => data?.strategies ?? [], [data]);
  const running = all.filter((r) => r.status !== "Archived");
  const rows = useMemo(() => all
    .filter((r) => (view === "running" ? r.status !== "Archived" : r.status === view))
    .filter((r) => !q || `${r.name} ${r.campaign_id} ${r.owner}`.toLowerCase().includes(q.toLowerCase()))
    .sort(BY[sort]), [all, view, q, sort]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Loading strategy analytics" />;

  const count = (f: (r: AnalyticsRow) => boolean) => running.filter(f).length;
  const proven = count((r) => r.results_state.state === "Proven");
  const worse = count((r) => r.results_state.state === "Worse than control");
  const settled = count((r) => r.learning_state.state === "Settled");
  const learning = count((r) => ["Leaning", "Exploring"].includes(r.learning_state.state));
  const live = count((r) => r.status === "Live");

  return (
    <>
      <PageHeader title="Strategy Analytics" role={me?.user.role_label}
        subtitle="How every strategy is doing against its own control group, and what Thompson sampling has learned in each" />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Kpi label="Strategies running" value={live} sub={`${running.length - live} paused`} />
          <Kpi label="Proven better than control" value={proven} tone={proven ? "good" : "neutral"}
            sub={worse ? `${worse} proven worse` : "the 95% range clears zero"} />
          <Kpi label="Thompson sampling settled" value={settled} sub="confident in one treatment" />
          <Kpi label="Still learning" value={learning} sub="testing more than one treatment" />
          <Kpi label="Recovered" value={money(running.reduce((t, r) => t + r.stats.recovered, 0), true)}
            sub="across running strategies" />
        </div>

        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <Pills value={view} onChange={setView} options={[
              { id: "running", label: "Running", count: running.length },
              { id: "Live", label: "Live", count: live },
              { id: "Paused", label: "Paused", count: running.length - live },
              { id: "Archived", label: "Archived versions", count: all.length - running.length },
            ]} />
            <div className="flex items-center gap-2">
              <div className="relative w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search strategies" />
              </div>
              <Select className="w-52" value={sort} onChange={(v) => setSort(v as SortKey)} options={[
                { value: "uplift", label: "Sort: uplift over control" },
                { value: "confidence", label: "Sort: learning confidence" },
                { value: "recovery", label: "Sort: paid rate" },
                { value: "recovered", label: "Sort: amount recovered" },
                { value: "name", label: "Sort: name" },
              ]} />
            </div>
          </div>
          <Table>
            <thead><tr>
              <Th>Strategy</Th><Th>Status</Th><Th>Paid vs control</Th><Th>Uplift over control</Th>
              <Th>Thompson sampling</Th><Th>Recent mix</Th><Th align="right">Recovered</Th><Th w="36px" />
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.campaign_id;
                const ls = r.learning_state;
                return (
                  <Fragment key={r.campaign_id}>
                    <Tr onClick={() => setOpen(isOpen ? null : r.campaign_id)} className={isOpen ? "bg-primary-50/40" : undefined}>
                      <Td>
                        <span className="block font-medium text-fg">{r.name}</span>
                        <span className="font-mono text-2xs text-fg-3">{r.campaign_id} · v{r.version} · {r.owner}</span>
                      </Td>
                      <Td><StatusChip status={r.status} /></Td>
                      <Td>
                        <span className="num font-medium">{pct(r.stats.recovery_rate, 0)}</span>
                        <span className="text-fg-3"> vs </span><span className="num">{pct(r.stats.control_rate, 0)}</span>
                        <span className="block text-2xs text-fg-3">{num(r.stats.treated)} treated · {num(r.stats.control)} control</span>
                      </Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <UpliftRow compact uplift={r.stats.uplift} ci={r.stats.uplift_ci} />
                          <span className="num text-xs font-medium">{pp(r.stats.uplift)}</span>
                        </span>
                        <Chip tone={RESULT_TONE[r.results_state.state]} className="mt-1">{r.results_state.state}</Chip>
                      </Td>
                      <Td>
                        <Chip tone={LEARNING_TONE[ls.state]}>{ls.state}</Chip>
                        {ls.lead && ls.learned > 0 && (
                          <span className="mt-1 block text-xs text-fg-2">{ls.lead.name} · {pct(ls.lead.p_best, 0)} sure</span>
                        )}
                      </Td>
                      <Td><MixBar row={r} /></Td>
                      <Td align="right">{money(r.stats.recovered, true)}</Td>
                      <Td align="right"><ChevronDown className={clsx("h-4 w-4 text-fg-3 transition", isOpen && "rotate-180")} /></Td>
                    </Tr>
                    {isOpen && (
                      // w-0 + min-w-full: the panel fills the row but adds nothing to the
                      // table's own sizing, so opening a row never reflows the columns.
                      <tr><td colSpan={8} className="p-0"><div className="w-0 min-w-full"><Detail row={r} /></div></td></tr>
                    )}
                  </Fragment>
                );
              })}
              {!rows.length && <Empty cols={8}>No strategies match.</Empty>}
            </tbody>
          </Table>
        </Card>

        <Card title="How to read this">
          <ul className="grid gap-3 text-[13px] leading-5 text-fg-2 md:grid-cols-3">
            <li><span className="font-medium text-fg">Uplift over control</span> is the honest measure: the strategy's paid rate minus its own randomised control group's. It is proven once the 95% range clears zero. Until then, small groups can swing either way.</li>
            <li><span className="font-medium text-fg">Thompson sampling</span> shows how sure the engine is that one treatment is best: settled at 80% or more, leaning from 60%, exploring below that. Exploring is normal while the evidence is thin.</li>
            <li><span className="font-medium text-fg">A favourite can still reach few customers</span> when few are eligible for it, or when customer fit sends people elsewhere. Open a strategy to see which: the verdict says so.</li>
          </ul>
        </Card>
      </Page>
    </>
  );
}
