import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowRight, BarChart3, Layers, ShieldAlert, UserSearch } from "lucide-react";
import { FlowBar } from "../components/flow";
import { Card, ErrorBox, Loading, PageHeader, SegmentBadge } from "../components/ui";
import { api, money } from "../lib/api";
import { useFlow } from "../lib/flow";
import { useAsync } from "../lib/hooks";

const CLIENT_STAGES = [
  { icon: BarChart3, title: "Collections dashboard", body: "Portfolio view of accounts in arrears" },
  { icon: Layers, title: "DPD buckets", body: "Accounts grouped by days past due" },
  { icon: ShieldAlert, title: "Risk segmentation", body: "Client risk model assigns a risk band" },
  { icon: UserSearch, title: "Cohort identification", body: "Customers / cohorts selected for action" },
];

export default function Upstream() {
  const nav = useNavigate();
  const { update } = useFlow();
  const { data: cohorts, error, loading } = useAsync(() => api.cohorts(), []);
  const [search, setSearch] = useState("");
  const { data: results } = useAsync(
    () => (search.length >= 2 ? api.customers({ search, limit: 8 }) : Promise.resolve([])),
    [search],
  );
  const { data: personas } = useAsync(() => api.customers({ cohort_id: "C2", limit: 3 }), []);

  if (error) return <ErrorBox message={error} />;
  if (loading || !cohorts) return <Loading what="client handoff" />;

  const handoff = (cohortId: string) => {
    update({ cohortId, customerId: null, strategies: null, experimentId: null });
    nav(`/cohort/${cohortId}`);
  };

  return (
    <>
      <FlowBar current={0} />
      <PageHeader
        eyebrow="Upstream · client's existing capability"
        title="Where ARI plugs in"
        blurb="The client already runs a collections dashboard, buckets accounts by days past due, scores them with its own risk model and identifies who needs action. ARI does not rebuild any of that. It picks up the cohort or customer that comes out of it and decides what intervention to run."
      />

      {/* Client pipeline, shown as context only */}
      <div className="card border-dashed border-slate-600/70 bg-transparent p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-300">
            Leverage existing client screens / risk models
          </p>
          <span className="rounded-md border border-dashed border-slate-600 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Not rebuilt in this prototype
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CLIENT_STAGES.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="relative rounded-xl border border-dashed border-slate-600/70 p-3.5">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-slate-500" />
                <p className="text-xs font-semibold text-slate-300">{title}</p>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{body}</p>
              {i < CLIENT_STAGES.length - 1 && (
                <ArrowRight className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-slate-600 xl:block" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="my-3 flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-brand-400">
        <ArrowDown className="h-4 w-4" /> Handoff to ARI <ArrowDown className="h-4 w-4" />
      </div>

      <div className="card border-brand-500/40 bg-brand-500/[0.06] p-5">
        <p className="text-xs font-semibold text-white">ARI · intervention layer</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {["Cohort / customer", "Strategy sheet", "Select strategies", "Experiment & sampling", "Outcome tracking & learning"].map(
            (s, i, a) => (
              <span key={s} className="flex items-center gap-2">
                <span className="rounded-lg bg-brand-500/15 px-2.5 py-1.5 font-medium text-brand-200 ring-1 ring-inset ring-brand-500/30">
                  {s}
                </span>
                {i < a.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-brand-400" />}
              </span>
            ),
          )}
        </div>
      </div>

      <Card
        className="mt-6"
        title="Cohorts handed off by the client"
        subtitle="DPD bucket, risk band and expected payment window come from the client's systems. Pick one to start the intervention flow."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-semibold">DPD bucket</th>
                <th className="px-3 py-2.5 font-semibold">Client risk band</th>
                <th className="px-3 py-2.5 font-semibold">Expected payment</th>
                <th className="px-3 py-2.5 font-semibold">Customers</th>
                <th className="px-3 py-2.5 font-semibold">Balance</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => {
                const featured = c.cohort_id === "C2";
                return (
                  <tr
                    key={c.cohort_id}
                    className={
                      "border-t border-white/5 " + (featured ? "bg-brand-500/[0.07]" : "hover:bg-white/[0.02]")
                    }
                  >
                    <td className="px-3 py-3 font-semibold text-slate-100">{c.dpd_bucket}</td>
                    <td className="px-3 py-3 text-slate-300">{c.client_risk_band}</td>
                    <td className="px-3 py-3 text-slate-300">{c.expected_payment}</td>
                    <td className="px-3 py-3 font-mono text-slate-200">{c.customers.toLocaleString()}</td>
                    <td className="px-3 py-3 font-mono text-slate-400">{money(c.balance)}</td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => handoff(c.cohort_id)}
                        className={
                          "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold " +
                          (featured
                            ? "bg-brand-600 text-white hover:bg-brand-500"
                            : "border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10")
                        }
                      >
                        Hand off to ARI <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 rounded-lg border border-brand-500/30 bg-brand-500/[0.06] p-3 text-xs leading-relaxed text-slate-300">
          <span className="font-semibold text-white">Example:</span> the client flags accounts at{" "}
          <strong className="text-white">30 DPD</strong> → its model rates them{" "}
          <strong className="text-white">medium risk</strong> → payment is expected in{" "}
          <strong className="text-white">7–10 days</strong> → about{" "}
          <strong className="text-white">{cohorts.find((c) => c.cohort_id === "C2")?.customers ?? 500} customers</strong>{" "}
          need a decision. That is where ARI takes over.
        </p>
      </Card>

      <Card
        className="mt-5"
        title="Or hand off a single customer"
        subtitle="The same flow works for one account."
      >
        <div className="flex flex-wrap items-center gap-2">
          {personas?.map((p) => (
            <Link
              key={p.customer_id}
              to={`/customer/${p.customer_id}`}
              onClick={() => update({ cohortId: p.cohort_id, customerId: p.customer_id })}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-white/10"
            >
              {p.name} <SegmentBadge segment={p.segment} />
            </Link>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search any customer…"
            className="w-52 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-brand-500/50"
          />
        </div>
        {results && results.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {results.map((r) => (
              <Link
                key={r.customer_id}
                to={`/customer/${r.customer_id}`}
                onClick={() => update({ cohortId: r.cohort_id, customerId: r.customer_id })}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/5"
              >
                {r.name} <span className="text-slate-500">· {r.cohort_id}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
