import { ArrowRight, GitBranch, Info, Users } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { DecisionRow, Learning, StrategyDetail as SD } from "../../lib/api";
import { dateTime, money, num, pct, pp, SEGMENT_LABEL } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { AllocationChart, BarList, BeliefBars, BeliefTrajectory, RateVsControl, SERIES, UpliftRow } from "../../ui/charts";
import { SegmentChip, StrategyActions, WaveButton } from "../../ui/domain";
import {
  Banner, Button, Card, Chip, Empty, ErrorState, Kpi, KV, Page, PageHeader, Spinner, StatusChip, Table, Tabs, Td, Th, Tr,
} from "../../ui/ui";

/** Plain-language reading of the learning trajectory. */
function learningSummary(l: Learning): { tone: "good" | "info"; text: string } | null {
  const last = l.waves[l.waves.length - 1];
  if (!last || last.wave === 0 || !l.arms.length) return null;
  const ranked = l.arms.map((a) => ({ a, p: last.posterior[a.code]?.p_best ?? 0 })).sort((x, y) => y.p - x.p);
  const recent = l.waves.filter((w) => w.wave > 0).slice(-3);
  const treated = recent.reduce((n, w) => n + w.treated, 0);
  const share = treated ? recent.reduce((n, w) => n + (w.counts[ranked[0].a.code] ?? 0), 0) / treated : 0;
  const waves = l.waves.length - 1;
  const after = `After ${waves} wave${waves === 1 ? "" : "s"}`;
  if (ranked[0].p >= 0.8) {
    return { tone: "good", text: `${after}, ${ranked[0].a.name} is the best treatment for this audience with ${pct(ranked[0].p, 0)} probability, and it received ${pct(share, 0)} of treated customers in the last ${recent.length} waves.` };
  }
  const second = ranked[1] ? ` ${ranked[1].a.name} is still in contention (${pct(ranked[1].p, 0)}),` : "";
  return { tone: "info", text: `${after} there is no clear winner yet. ${ranked[0].a.name} leads with a ${pct(ranked[0].p, 0)} probability of being best.${second} so the engine keeps exploring.` };
}

type Tab = "overview" | "experiment" | "learning" | "decisions" | "config";

function FlowStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-500 text-xs font-semibold text-white">{n}</span>
        <h3 className="text-[13px] font-semibold">{title}</h3>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function StrategyDetail() {
  const { id = "" } = useParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<SD>(`/strategies/${id}`, [id]);
  const decisions = useApi<{ rows: DecisionRow[]; total: number }>(`/decisions?campaign=${id}&page_size=25`, [id]);
  const [tab, setTab] = useState<Tab>("overview");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label={`Loading ${id}`} />;
  const s = data.stats;
  const p = data.population;
  const hasData = s.treated > 0 && s.control > 0;
  const story = learningSummary(data.learning);
  const final = data.learning.waves[data.learning.waves.length - 1];

  return (
    <>
      <PageHeader title={data.name} subtitle={data.description}
        crumbs={[{ label: "Strategies", to: "/strategies" }, { label: data.campaign_id }]}
        meta={<>
          <StatusChip status={data.status} /><Chip tone="neutral">{data.campaign_id} · v{data.version}</Chip>
          {data.parent_id && (
            <Link to={`/strategies/${data.parent_id}`}><Chip tone="info" icon={<GitBranch className="h-3 w-3" />}>replaces {data.parent_id}</Chip></Link>
          )}
          <Chip tone="neutral">Owner {data.owner}</Chip>{data.approver && <Chip tone="info">Approved by {data.approver}</Chip>}
          {data.source !== "manual" && data.source !== "revision" && <Chip tone="ai">{data.source.replace("_", " ")}</Chip>}
          {data.pool_remaining !== null && (
            <span title="Customers in this audience that no strategy has decided yet">
              <Chip tone={data.pool_remaining > 0 ? "neutral" : "warn"} icon={<Users className="h-3 w-3" />}>{num(data.pool_remaining)} left to decide</Chip>
            </span>
          )}
        </>}
        actions={<>
          <WaveButton s={data} onDone={() => { reload(); decisions.reload(); }} />
          <StrategyActions s={data} onChange={() => { reload(); refresh(); }} onDeleted={() => { refresh(); navigate("/strategies"); }} />
        </>} />
      {data.open_revision && (
        <div className="border-b border-line bg-surface px-6 py-2.5">
          <Banner tone="info" title={`Version ${data.version + 1} is being prepared as ${data.open_revision}`}
            action={<Button size="sm" onClick={() => navigate(`/builder/${data.open_revision}`)}>Open draft</Button>}>
            This version keeps running unchanged until v{data.version + 1} is approved and launched. Launching it archives this version.
          </Banner>
        </div>
      )}
      <div className="bg-surface px-6"><Tabs<Tab> active={tab} onChange={setTab} tabs={[
        { id: "overview", label: "Overview" }, { id: "experiment", label: "Experiment" },
        { id: "learning", label: "Arms & learning" }, { id: "decisions", label: "Decisions", count: decisions.data?.total },
        { id: "config", label: "Configuration" },
      ]} /></div>
      <Page>
        {tab === "overview" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Recovery rate (treated)" value={pct(s.recovery_rate)} sub={`${num(s.treated_paid)} of ${num(s.treated)} paid`}
                target={pct(data.recovery_target, 0)} progress={s.recovery_rate !== null ? s.recovery_rate / data.recovery_target : null}
                tone={s.recovery_rate !== null && s.recovery_rate < data.recovery_target - 0.05 ? "warn" : "neutral"} />
              <Kpi label="Control rate" value={pct(s.control_rate)} sub={`${num(s.control_paid)} of ${num(s.control)} on business as usual`} />
              <Kpi label="Uplift over control" value={pp(s.uplift)} tone={s.significant ? (s.uplift! > 0 ? "good" : "bad") : "neutral"}
                delta={hasData ? (s.significant ? "significant" : "not significant") : null} deltaGood={hasData ? (s.significant ? true : null) : null}
                sub={s.mde ? `detectable at this size: ${pp(s.mde)}` : undefined} />
              <Kpi label="Recovered" value={money(s.recovered)} sub={`${money(s.cost_per_recovery)} contact cost per payer`} />
            </div>
            {hasData && s.underpowered && (s.significant ? (
              <Banner tone="info" title="Significant, on a small sample">
                The 95% interval excludes zero, so the strategy is helping. But this sample only reliably detects effects of {pp(s.mde)} or more, so the true uplift is probably smaller than the {pp(s.uplift)} observed. Keep it running before quoting a number.
              </Banner>
            ) : (
              <Banner tone="warn" title="Directional, not yet a verdict">
                The observed uplift ({pp(s.uplift)}) is smaller than this sample can reliably detect ({pp(s.mde)}). Keep the strategy running so the control group grows before drawing a conclusion.
              </Banner>
            ))}
            <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
              <Card title="Treated vs control, by week" subtitle="The gap between the lines is what this strategy caused">
                <RateVsControl data={data.weekly} target={data.recovery_target} />
              </Card>
              <Card title="Uplift over control" subtitle="Point estimate with its 95% interval. Crossing zero means not yet proven.">
                <UpliftRow uplift={s.uplift} ci={s.uplift_ci} mde={s.mde} />
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[13px]">
                  <div><p className="label">Escalation rate</p><p className="num mt-0.5 font-semibold">{pct(s.escalation_rate)}</p></div>
                  <div><p className="label">Avg days to pay</p><p className="num mt-0.5 font-semibold">{s.avg_resolution_days ?? "—"}</p></div>
                  <div><p className="label">Contacts sent</p><p className="num mt-0.5 font-semibold">{num(s.contacts)}</p></div>
                  <div><p className="label">Contact cost</p><p className="num mt-0.5 font-semibold">{money(s.contact_cost)}</p></div>
                </div>
              </Card>
            </div>
            <Card title="Waves" flush>
              <Table>
                <thead><tr><Th>Wave</Th><Th align="right">Decided</Th><Th align="right">Treated</Th><Th align="right">Treated rate</Th><Th align="right">Control</Th><Th align="right">Control rate</Th><Th align="right">Uplift</Th><Th align="right">Recovered</Th></tr></thead>
                <tbody>
                  {data.waves.map((w) => (
                    <Tr key={w.wave}><Td>Wave {w.wave}</Td><Td align="right">{w.decisions}</Td><Td align="right">{w.treated}</Td><Td align="right">{pct(w.recovery_rate)}</Td>
                      <Td align="right">{w.control}</Td><Td align="right">{pct(w.control_rate)}</Td><Td align="right" className="font-medium">{pp(w.uplift)}</Td><Td align="right">{money(w.recovered)}</Td></Tr>
                  ))}
                  {!data.waves.length && <Empty cols={8}>No waves yet.</Empty>}
                </tbody>
              </Table>
            </Card>
          </>
        )}

        {tab === "experiment" && (
          <>
            <div className="grid gap-4 lg:grid-cols-4">
              <FlowStep n={1} title="Eligible population">
                <p className="num text-2xl font-semibold">{num(p.eligible)}</p>
                <p className="text-xs text-fg-3">of {num(p.matching)} customers in the target cohorts</p>
                <div className="mt-3 space-y-1.5">
                  {Object.entries(p.segments).map(([g, n]) => (
                    <div key={g} className="flex items-center justify-between gap-2 text-xs">
                      <SegmentChip segment={g} /><span className="num text-fg-2">{n}{data.include_segments.includes(g) ? "" : " · excluded"}</span>
                    </div>
                  ))}
                </div>
                {p.exclusions.length > 0 && (
                  <div className="mt-3 border-t border-line pt-2">
                    {p.exclusions.map((x) => <p key={x.reason} className="flex justify-between gap-2 text-2xs text-fg-3"><span>{x.reason}</span><span className="num">{x.count}</span></p>)}
                  </div>
                )}
              </FlowStep>
              <FlowStep n={2} title="Random split">
                <div className="flex h-3 overflow-hidden rounded-full">
                  <div style={{ width: `${(p.treatment / Math.max(1, p.eligible)) * 100}%`, background: SERIES[0] }} />
                  <div className="ml-0.5" style={{ width: `${(p.control / Math.max(1, p.eligible)) * 100}%`, background: "var(--control)" }} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div><p className="label">Treatment</p><p className="num text-xl font-semibold">{num(p.treatment)}</p></div>
                  <div><p className="label">Control</p><p className="num text-xl font-semibold">{num(p.control)}</p></div>
                </div>
                <p className="mt-2 text-2xs leading-4 text-fg-3">
                  {pct(data.control_pct, 0)} held out at random on business as usual. The split is fixed for the life of the strategy, so the comparison stays fair.
                </p>
              </FlowStep>
              <FlowStep n={3} title="Assignment">
                <BarList rows={data.arms.map((a, i) => ({ label: a.name, value: a.n, color: SERIES[i % 5],
                  sub: `${num(p.arm_eligibility[a.code] ?? 0)} eligible` }))} format={(v) => num(v ?? 0)} />
                <p className="mt-3 text-2xs leading-4 text-fg-3">Contextual Thompson sampling, in waves of {data.wave_size}. Beliefs update between waves, not within one.</p>
              </FlowStep>
              <FlowStep n={4} title="Outcome tracking">
                <div className="space-y-2.5">
                  <div className="flex items-baseline justify-between text-xs"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[0] }} />Treated</span><span className="num font-semibold">{pct(s.recovery_rate)}</span></div>
                  <div className="flex items-baseline justify-between text-xs"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--control)" }} />Control</span><span className="num font-semibold">{pct(s.control_rate)}</span></div>
                  <div className="flex items-baseline justify-between border-t border-line pt-2 text-xs"><span>Uplift</span><span className="num font-semibold">{pp(s.uplift)}</span></div>
                </div>
                <p className="mt-3 text-2xs leading-4 text-fg-3">Payment within a {data.evaluation_days}-day window, per customer.</p>
              </FlowStep>
            </div>
            <Banner tone="info" title="Open design item: delayed outcomes">
              Payments can arrive after the evaluation window. This version scores each decision at the end of its window. Whether to extend windows, credit late payments, or learn from early signals such as clicks is still to be agreed with the bank.
            </Banner>
          </>
        )}

        {tab === "learning" && (
          <>
          {story ? <Banner tone={story.tone} title="What Thompson sampling has learned">{story.text}</Banner> : (
            <Banner tone="neutral" title="Nothing learned yet">
              {data.status === "Live"
                ? "Run a wave. Each one is decided with everything learned before it, and its outcomes update the beliefs below."
                : "Learning starts when the strategy is live and its first wave runs."}
            </Banner>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Belief in each treatment, wave by wave" subtitle="Line: estimated payment rate. Band: 95% interval. Bands narrow as outcomes come in.">
              <BeliefTrajectory learning={data.learning} />
            </Card>
            <Card title="Who got what, wave by wave" subtitle="Share of each wave's treated customers. Allocation follows the beliefs from the wave before.">
              <AllocationChart learning={data.learning} />
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_1.3fr]">
            <Card title="What the engine believes now" subtitle="Posterior payment rate per treatment for this strategy. Wide ranges still get explored.">
              <BeliefBars rows={data.beliefs.map((b) => ({ name: b.name, mean: b.mean, low: b.low, high: b.high,
                sub: `${num(b.learned)} outcomes learned · ` + (b.prior === "uniform"
                  ? "no track record, so it started from a flat prior"
                  : `started from ${pct(b.prior_mean, 0)} (playbook history, low weight)`) }))} />
              {final && (
                <div className="mt-4 border-t border-line pt-3">
                  <p className="label mb-2">Probability each treatment is the best</p>
                  <BarList rows={data.learning.arms.map((a, i) => ({ label: a.name, value: final.posterior[a.code]?.p_best ?? 0, color: SERIES[i % 5] }))}
                    format={(v) => pct(v, 0)} max={1} />
                </div>
              )}
            </Card>
            <Card title="Per-treatment results" subtitle="Raw rates are confounded: the engine routes different customers to different treatments." flush>
              <Table>
                <thead><tr><Th>Treatment</Th><Th align="right">n</Th><Th align="right">Raw rate</Th><Th align="right">Reweighted</Th><Th align="right">vs control</Th><Th>95% interval</Th></tr></thead>
                <tbody>
                  {data.arms.map((a) => (
                    <Tr key={a.code}><Td className="font-medium">{a.name}</Td><Td align="right">{a.n}</Td><Td align="right">{pct(a.rate)}</Td>
                      <Td align="right">{pct(a.ipw_rate)}</Td><Td align="right">{pp(a.uplift)}</Td><Td className="num text-xs text-fg-3">{pct(a.ci[0], 0)}–{pct(a.ci[1], 0)}</Td></Tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex items-start gap-2 border-t border-line px-4 py-3 text-2xs leading-4 text-fg-3">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Reweighted = inverse-propensity weighted, using the selection probability logged on every decision. Only the strategy-versus-control figure on Overview is an unbiased estimate; use these to rank treatments, not to quote effects.
              </div>
            </Card>
          </div>
          </>
        )}

        {tab === "decisions" && (
          <Card flush title="Recent decisions" actions={<Link to={`/decisions?campaign=${id}`} className="text-xs font-medium text-primary-500 hover:underline">All decisions <ArrowRight className="inline h-3 w-3" /></Link>}>
            <Table>
              <thead><tr><Th>Decision</Th><Th>Customer</Th><Th>Wave</Th><Th>Group</Th><Th>Treatment</Th><Th align="right">P(select)</Th><Th>Review</Th><Th>Outcome</Th></tr></thead>
              <tbody>
                {decisions.data?.rows.map((d) => (
                  <Tr key={d.decision_id}>
                    <Td><Link className="font-mono text-xs text-primary-500 hover:underline" to={`/decisions/${d.decision_id}`}>{d.decision_id}</Link></Td>
                    <Td><Link to={`/journeys/${d.customer_id}`} className="hover:text-primary-500">{d.customer}</Link></Td>
                    <Td>{d.wave}</Td><Td><StatusChip status={d.group} /></Td><Td>{d.treatment ?? "—"}</Td>
                    <Td align="right">{pct(d.selection_probability, 0)}</Td>
                    <Td>{d.review_policy === "auto" ? <span className="text-xs text-fg-3">auto</span> : <StatusChip status={d.review_status} />}</Td>
                    <Td><StatusChip status={d.outcome ?? "In window"} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        {tab === "config" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Audience & treatments">
              <KV items={[
                { label: "Cohorts", value: data.target_cohorts.join(", ") || "—" },
                { label: "Fit groups", value: data.include_segments.map((g) => SEGMENT_LABEL[g]).join(", ") },
                { label: "Risk bands", value: data.risk_bands.join(", ") || "all" },
                { label: "Days past due", value: `${data.min_dpd ?? "any"} – ${data.max_dpd ?? "any"}` },
                { label: "Balance", value: `${data.min_balance !== null ? money(data.min_balance) : "any"} – ${data.max_balance !== null ? money(data.max_balance) : "any"}` },
                { label: "Treatments", value: data.treatments.map((t) => t.name).join(", ") },
                { label: "Cadence", value: `every ${data.cadence_days} days · max ${data.max_touches} touches · ${data.tone}` },
                { label: "Send window", value: `${data.send_window_start}:00 – ${data.send_window_end}:00` },
                { label: "Escalation", value: data.escalate_to ? `${data.escalate_to} after ${data.escalate_after_days} days` : "none" },
              ]} />
            </Card>
            <Card title="Experiment & governance">
              <KV items={[
                { label: "Control share", value: pct(data.control_pct, 0) },
                { label: "Wave size", value: data.wave_size },
                { label: "Evaluation window", value: `${data.evaluation_days} days` },
                { label: "Recovery target", value: pct(data.recovery_target, 0) },
                { label: "Created", value: `${dateTime(data.created_at)} by ${data.owner}` },
                { label: "Submitted", value: dateTime(data.submitted_at) },
                { label: "Approved", value: data.approved_at ? `${dateTime(data.approved_at)} by ${data.approver}` : "—" },
                { label: "Launched", value: dateTime(data.launched_at) },
                { label: "Version", value: `v${data.version}` },
              ]} />
            </Card>
            {data.versions.length > 1 && (
              <Card title="Version history" subtitle="Each version is its own experiment with its own control group." flush className="lg:col-span-2">
                <Table>
                  <thead><tr><Th>Version</Th><Th>Strategy</Th><Th>Status</Th><Th>Owner</Th><Th>Created</Th><Th>Launched</Th></tr></thead>
                  <tbody>
                    {data.versions.map((v) => (
                      <Tr key={v.campaign_id} onClick={v.current ? undefined : () => navigate(`/strategies/${v.campaign_id}`)}>
                        <Td className="font-medium">v{v.version}{v.current && <span className="ml-1.5 text-2xs font-normal text-fg-3">(this one)</span>}</Td>
                        <Td mono>{v.campaign_id}</Td><Td><StatusChip status={v.status} /></Td><Td className="text-fg-2">{v.owner}</Td>
                        <Td className="text-xs text-fg-3">{dateTime(v.created_at)}</Td><Td className="text-xs text-fg-3">{dateTime(v.launched_at)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
          </div>
        )}
      </Page>
    </>
  );
}
