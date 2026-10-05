import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import clsx from "clsx";
import { CohortChip, FlowBar, ScopeToggle } from "../components/flow";
import { Bar, ErrorBox, Loading, PageHeader, Pill, SegmentBadge } from "../components/ui";
import {
  api,
  pct,
  SEGMENT_PLAIN,
  STATUS_TONE,
  STRATEGY_COLOR,
  type CohortSheet,
  type CustomerSheet,
} from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

export default function StrategySheet({ scope }: { scope: "cohort" | "customer" }) {
  const params = useParams();
  const key = scope === "cohort" ? params.cohortId! : params.id!;
  const { data, error, loading } = useAsync<CohortSheet | CustomerSheet>(
    () => (scope === "cohort" ? api.cohortSheet(key) : api.customerSheet(Number(key))),
    [scope, key],
  );
  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <Loading what="strategy sheet" />;
  return data.scope === "cohort" ? <CohortSheetView sheet={data} /> : <CustomerSheetView sheet={data} />;
}

function useSelection(defaults: string[], deps: unknown[]) {
  const [sel, setSel] = useState<Set<string>>(new Set(defaults));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSel(new Set(defaults)), deps);
  const toggle = (code: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  return { sel, toggle };
}

function Checkbox({ on, disabled, onClick }: { on: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={clsx(
        "grid h-5 w-5 place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-30",
        on ? "border-brand-500 bg-brand-600" : "border-white/20 bg-white/5 hover:border-brand-500/60",
      )}
    >
      {on && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
    </button>
  );
}

function StrategyCell({ code, name, offer }: { code: string; name: string; offer: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STRATEGY_COLOR[code] }} />
      <div>
        <p className="font-semibold text-slate-100">
          {name} <span className="font-mono text-[10px] font-normal text-slate-500">{code}</span>
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{offer}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cohort level
function CohortSheetView({ sheet }: { sheet: CohortSheet }) {
  const nav = useNavigate();
  const { flow, update } = useFlow();
  const recommended = sheet.rows.filter((r) => r.status === "Recommended").map((r) => r.code);
  const defaults = flow.cohortId === sheet.cohort_id && flow.strategies ? flow.strategies : recommended;
  const { sel, toggle } = useSelection(defaults, [sheet.cohort_id]);
  const selected = sheet.rows.filter((r) => sel.has(r.code));

  const go = () => {
    const strategies = selected.map((r) => r.code);
    update({ cohortId: sheet.cohort_id, strategies, experimentId: null });
    nav(`/experiment/new/${sheet.cohort_id}`);
  };

  return (
    <>
      <FlowBar current={2} />
      <PageHeader
        eyebrow="Step 02 · Strategy sheet · group view"
        title={`Intervention strategies for ${sheet.cohort_name}`}
        blurb="Every strategy in the playbook, checked against this cohort: who qualifies, what it costs, how it has performed, and how well it fits these customers. Pick the ones to test."
        right={
          <ScopeToggle
            scope="cohort"
            cohortHref={`/strategies/cohort/${sheet.cohort_id}`}
            customerHref={flow.customerId ? `/strategies/customer/${flow.customerId}` : null}
          />
        }
      />
      <div className="mb-4">
        <CohortChip dpd={sheet.dpd_bucket} band={sheet.client_risk_band} expected={sheet.expected_payment} customers={sheet.customers} />
      </div>
      <p className="mb-5 rounded-xl border border-brand-500/30 bg-brand-500/[0.06] p-3.5 text-xs leading-relaxed text-slate-300">
        <strong className="text-white">{sheet.target_customers} of {sheet.customers}</strong> customers in this cohort can be
        helped by an intervention, so they're the ones the strategies are tested on. The rest follow a fixed route: those
        who will pay anyway get a cheap reminder, hardship cases go to the specialist team, and customers who react badly
        to contact are left alone.
      </p>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[980px] text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="w-10 px-4 py-3" />
              <th className="px-3 py-3 font-semibold">Strategy</th>
              <th className="px-3 py-3 font-semibold">Channel · timing</th>
              <th className="px-3 py-3 font-semibold">Eligibility rule</th>
              <th className="w-36 px-3 py-3 font-semibold">Eligible</th>
              <th className="px-3 py-3 font-semibold">Cost</th>
              <th className="px-3 py-3 font-semibold">Past success</th>
              <th className="px-3 py-3 font-semibold">Fit</th>
              <th className="px-3 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r) => {
              const on = sel.has(r.code);
              return (
                <tr
                  key={r.code}
                  className={clsx("border-t border-white/5 align-top", on && "bg-brand-500/[0.06]")}
                >
                  <td className="px-4 py-3.5">
                    <Checkbox on={on} disabled={r.eligible_in_target === 0} onClick={() => toggle(r.code)} />
                  </td>
                  <td className="px-3 py-3.5">
                    <StrategyCell code={r.code} name={r.name} offer={r.offer} />
                    <p className="mt-1.5 pl-5 text-[10px] text-slate-500">Best for: {r.best_for}</p>
                  </td>
                  <td className="px-3 py-3.5 text-slate-300">
                    {r.channel}
                    <p className="text-[11px] text-slate-500">{r.timing}</p>
                  </td>
                  <td className="max-w-[200px] px-3 py-3.5 text-[11px] leading-snug text-slate-400">{r.eligibility_rule}</td>
                  <td className="px-3 py-3.5">
                    <p className="font-mono text-slate-200">
                      {r.eligible_in_target}
                      <span className="text-slate-500"> / {sheet.target_customers}</span>
                    </p>
                    <div className="mt-1.5">
                      <Bar value={r.reach_in_target * 100} color={STRATEGY_COLOR[r.code]} />
                    </div>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-slate-300">${r.cost_per_contact.toFixed(2)}</td>
                  <td className="px-3 py-3.5">
                    <p className="font-mono text-slate-200">{pct(r.hist_success_rate)}</p>
                    <p className="text-[10px] text-slate-500">{r.hist_trials} past cases</p>
                  </td>
                  <td className="px-3 py-3.5">
                    <span
                      className={clsx(
                        "font-mono",
                        r.avg_fit > 1.05 ? "text-emerald-400" : r.avg_fit < 0.97 ? "text-rose-400" : "text-slate-400",
                      )}
                    >
                      ×{r.avg_fit.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-3.5">
                    <Pill tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Pill>
                    <p className="mt-1 max-w-[150px] text-[10px] leading-snug text-slate-500">{r.note}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        <strong className="text-slate-400">Past success</strong> is the client's historical record for each strategy.{" "}
        <strong className="text-slate-400">Fit</strong> is how much this cohort's profile favours it (above ×1.00 means a
        better match than average). <strong className="text-slate-400">Recommended</strong> weighs expected success
        against cost.
      </p>

      <div className="sticky bottom-4 z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-500/40 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-400">{selected.length} selected:</span>
          {selected.map((r) => (
            <span key={r.code} className="rounded-md bg-white/5 px-2 py-1 font-medium text-slate-200">
              {r.name}
            </span>
          ))}
        </div>
        <button
          onClick={go}
          disabled={selected.length === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40"
        >
          Set up experiment <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ customer level
function CustomerSheetView({ sheet }: { sheet: CustomerSheet }) {
  const nav = useNavigate();
  const { update } = useFlow();
  const defaults = useMemo(
    () => sheet.rows.filter((r) => r.eligible && (r.status === "Recommended" || r.status === "Applicable")).map((r) => r.code),
    [sheet],
  );
  const { sel, toggle } = useSelection(defaults, [sheet.customer_id]);
  const selected = sheet.rows.filter((r) => sel.has(r.code));

  useEffect(() => {
    update({ cohortId: sheet.cohort_id, customerId: sheet.customer_id });
  }, [sheet, update]);

  return (
    <>
      <FlowBar current={2} />
      <PageHeader
        eyebrow="Step 02 · Strategy sheet · customer view"
        title={`Intervention strategies for ${sheet.name}`}
        blurb="The same playbook, checked against one customer: which strategies they qualify for, and how well each suits their situation."
        right={
          <ScopeToggle
            scope="customer"
            cohortHref={`/strategies/cohort/${sheet.cohort_id}`}
            customerHref={`/strategies/customer/${sheet.customer_id}`}
          />
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
        <SegmentBadge segment={sheet.segment} />
        <span className="text-sm font-semibold text-white">{SEGMENT_PLAIN[sheet.segment]}</span>
        <span className="text-xs text-slate-400">· {sheet.recommended_action}</span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="w-10 px-4 py-3" />
              <th className="px-3 py-3 font-semibold">Strategy</th>
              <th className="px-3 py-3 font-semibold">Channel · timing</th>
              <th className="px-3 py-3 font-semibold">Eligible?</th>
              <th className="px-3 py-3 font-semibold">Why it fits (or doesn't)</th>
              <th className="px-3 py-3 font-semibold">Cost</th>
              <th className="px-3 py-3 font-semibold">Past success</th>
              <th className="px-3 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r) => {
              const on = sel.has(r.code);
              return (
                <tr key={r.code} className={clsx("border-t border-white/5 align-top", on && "bg-brand-500/[0.06]", !r.eligible && "opacity-60")}>
                  <td className="px-4 py-3.5">
                    <Checkbox on={on} disabled={!r.eligible} onClick={() => toggle(r.code)} />
                  </td>
                  <td className="px-3 py-3.5">
                    <StrategyCell code={r.code} name={r.name} offer={r.offer} />
                  </td>
                  <td className="px-3 py-3.5 text-slate-300">
                    {r.channel}
                    <p className="text-[11px] text-slate-500">{r.timing}</p>
                  </td>
                  <td className="px-3 py-3.5">
                    <p className={r.eligible ? "font-semibold text-emerald-400" : "font-semibold text-rose-400"}>
                      {r.eligible ? "Yes" : "No"}
                    </p>
                    <p className="mt-0.5 max-w-[160px] text-[10px] leading-snug text-slate-500">{r.eligibility_reason}</p>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className={clsx("font-mono", r.fit > 1.05 ? "text-emerald-400" : r.fit < 0.97 ? "text-rose-400" : "text-slate-400")}>
                      ×{r.fit.toFixed(2)}
                    </span>
                    <ul className="mt-1 space-y-0.5 text-[10px] text-slate-400">
                      {r.fit_reasons.map((f) => (
                        <li key={f}>· {f}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-slate-300">${r.cost_per_contact.toFixed(2)}</td>
                  <td className="px-3 py-3.5 font-mono text-slate-200">{pct(r.hist_success_rate)}</td>
                  <td className="px-3 py-3.5">
                    <Pill tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Pill>
                    <p className="mt-1 max-w-[150px] text-[10px] leading-snug text-slate-500">{r.note}</p>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="sticky bottom-4 z-20 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-500/40 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
        <p className="text-xs text-slate-400">
          {selected.length} strategies selected for {sheet.name.split(" ")[0]}
        </p>
        <button
          onClick={() => nav(`/customer/${sheet.customer_id}/assignment?s=${selected.map((r) => r.code).join(",")}`)}
          disabled={selected.length === 0}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40"
        >
          See how {sheet.name.split(" ")[0]} is assigned <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}
