import clsx from "clsx";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type Strategy, type WeekPoint } from "../../lib/api";
import { money, num, pct, pp } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { BarList, CompareTrend, SERIES, UpliftRow } from "../../ui/charts";
import { Banner, Button, Card, ErrorState, Page, PageHeader, Select, Spinner, Table, Td, Th, Tr, useAction } from "../../ui/ui";

type S = Strategy & { weekly: WeekPoint[] };

export default function StrategyCompare() {
  const { can } = useSession();
  const all = useApi<Strategy[]>("/strategies?scope=all");
  const [ids, setIds] = useState<string[]>([]);
  const [data, setData] = useState<S[] | null>(null);
  const { run, busy } = useAction();
  const candidates = (all.data ?? []).filter((s) => s.stats && s.stats.decisions > 0);

  useEffect(() => {
    if (!ids.length && candidates.length) setIds(candidates.slice(0, 3).map((s) => s.campaign_id));
  }, [candidates, ids.length]);
  useEffect(() => {
    if (!ids.length) return;
    api.get<{ strategies: S[] }>(`/compare?ids=${ids.join(",")}`).then((r) => setData(r.strategies));
  }, [ids]);

  if (all.error) return <ErrorState message={all.error} onRetry={all.reload} />;
  if (!all.data || !data) return <Spinner />;
  const best = [...data].filter((s) => s.stats?.uplift !== null).sort((a, b) => (b.stats!.uplift ?? -1) - (a.stats!.uplift ?? -1))[0];
  const overlap = data.length > 1 && best && data.filter((s) => s !== best).some((s) =>
    s.stats?.uplift_ci && best.stats?.uplift_ci && s.stats.uplift_ci[1] >= best.stats.uplift_ci[0]);

  const rows: { label: string; get: (s: S) => string; good?: (s: S) => boolean }[] = [
    { label: "Recovery rate (treated)", get: (s) => pct(s.stats?.recovery_rate) },
    { label: "Control rate", get: (s) => pct(s.stats?.control_rate) },
    { label: "Uplift over control", get: (s) => pp(s.stats?.uplift), good: (s) => s === best },
    { label: "Significant?", get: (s) => (s.stats?.significant ? "Yes" : `No (needs ${pp(s.stats?.mde)})`) },
    { label: "Accounts decided", get: (s) => num(s.stats?.decisions) },
    { label: "Treated / control", get: (s) => `${num(s.stats?.treated)} / ${num(s.stats?.control)}` },
    { label: "Avg days to pay", get: (s) => (s.stats?.avg_resolution_days ? `${s.stats.avg_resolution_days}d` : "—") },
    { label: "Contact cost per recovery", get: (s) => money(s.stats?.cost_per_recovery) },
    { label: "Escalation rate", get: (s) => pct(s.stats?.escalation_rate) },
    { label: "Recovered", get: (s) => money(s.stats?.recovered) },
  ];

  return (
    <>
      <PageHeader title="Strategy Comparison" subtitle="Compare up to three strategies on what they caused, not just what they recovered"
        actions={can("export_reports") && <Button variant="primary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === "x"}
          onClick={() => run("x", () => api.download("/reports/portfolio.csv", "ari-strategies.csv"), "Downloaded.")}>Export Report</Button>} />
      <Page>
        <div className="flex flex-wrap items-center gap-2">
          {data.map((s, i) => (
            <span key={s.campaign_id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i] }} />
              <span className="font-mono text-fg-2">{s.campaign_id}</span><span className="text-fg">{s.name}</span>
              <button onClick={() => setIds(ids.filter((x) => x !== s.campaign_id))} className="text-fg-3 hover:text-fg"><X className="h-3 w-3" /></button>
            </span>
          ))}
          {ids.length < 3 && (
            <Select className="w-64" value="" onChange={(v) => v && setIds([...ids, v])}
              options={[{ value: "", label: "+ Add strategy" }, ...candidates.filter((s) => !ids.includes(s.campaign_id)).map((s) => ({ value: s.campaign_id, label: `${s.campaign_id} ${s.name}` }))]} />
          )}
        </div>

        {best && (
          <Banner tone={overlap ? "warn" : "good"} title={overlap ? `${best.campaign_id} leads, but the difference is not proven` : `${best.campaign_id} has the strongest proven lift`}>
            {overlap
              ? `Its uplift (${pp(best.stats?.uplift)}) has the highest point estimate, but the intervals overlap with at least one other strategy. Keep both running before reallocating budget.`
              : `Its uplift (${pp(best.stats?.uplift)}) is clear of the others' intervals.`}
          </Banner>
        )}

        <Card title="Performance metrics" flush>
          <Table>
            <thead><tr><Th>Metric</Th>{data.map((s, i) => <Th key={s.campaign_id} align="right"><span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i] }} />{s.campaign_id}</span><span className="block font-normal normal-case tracking-normal text-fg-3">{s.name}</span></Th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.label}><Td className="text-fg-2">{r.label}</Td>
                  {data.map((s) => <Td key={s.campaign_id} align="right" className={clsx(r.good?.(s) && "font-semibold text-good")}>{r.get(s)}</Td>)}
                </Tr>
              ))}
              <Tr><Td className="text-fg-2">Uplift 95% interval</Td>{data.map((s) => <Td key={s.campaign_id} align="right"><div className="flex justify-end"><UpliftRow uplift={s.stats?.uplift ?? null} ci={s.stats?.uplift_ci ?? null} compact /></div></Td>)}</Tr>
            </tbody>
          </Table>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr_1fr]">
          <Card title="Recovery rate trend" subtitle="Treated customers, weekly"><CompareTrend series={data.map((s) => ({ id: s.campaign_id, name: s.name, weekly: s.weekly }))} /></Card>
          <Card title="Uplift over control" subtitle="Higher is better">
            <BarList rows={data.map((s, i) => ({ label: s.campaign_id, value: Math.max(0, s.stats?.uplift ?? 0), color: SERIES[i], sub: s.stats?.significant ? "significant" : "not significant" }))} format={(v) => pp(v ?? 0)} />
          </Card>
          <Card title="Contact cost per recovery" subtitle="Lower is better">
            <BarList rows={data.map((s, i) => ({ label: s.campaign_id, value: s.stats?.cost_per_recovery ?? 0, color: SERIES[i] }))} format={(v) => money(v ?? 0)} />
          </Card>
        </div>
      </Page>
    </>
  );
}
