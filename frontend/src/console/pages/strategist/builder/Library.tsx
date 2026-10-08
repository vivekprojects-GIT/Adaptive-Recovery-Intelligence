/** Strategy library: running strategies to clone as a starting point. */
import clsx from "clsx";
import { Copy, Search } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type Strategy } from "../../../lib/api";
import { num, pct, pp } from "../../../lib/format";
import { useApi, useSession } from "../../../lib/session";
import { Banner, Button, Chip, Pills, Spinner, inputCls, useAction } from "../../../ui/ui";

export default function Library() {
  const { data } = useApi<Strategy[]>("/strategies?scope=all");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const { can } = useSession();
  if (!data) return <Spinner />;
  const rows = data.filter((s) => ["Live", "Paused", "Approved"].includes(s.status))
    .filter((s) => filter === "all" || s.channels.some((c) => c.includes(filter)) ||
      s.target_cohorts.includes(filter))
    .filter((s) => !q || `${s.name} ${s.campaign_id} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Pills value={filter} onChange={setFilter} options={[
          { id: "all", label: "All" }, { id: "C1", label: "Early arrears" }, { id: "C2", label: "30 DPD" },
          { id: "C3", label: "60 DPD" }, { id: "C4", label: "90+ DPD" }, { id: "SMS", label: "SMS" },
          { id: "App", label: "App" }, { id: "call", label: "Call" },
        ]} />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library" className={`${inputCls} pl-8`} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {rows.map((s) => {
          const st = s.stats!;
          return (
            <div key={s.campaign_id} className="flex flex-col rounded-lg border border-line bg-surface p-4 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-2xs text-fg-3">{s.campaign_id} · v{s.version}</p>
                  <p className="mt-0.5 truncate text-[15px] font-semibold text-fg">{s.name}</p>
                </div>
                <div className="text-right">
                  <p className="num text-xl font-semibold text-fg">{pct(st.recovery_rate, 0)}</p>
                  <p className="text-2xs text-fg-3">recovery rate</p>
                </div>
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-fg-2">{s.description}</p>
              <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-fg-2">Uplift over its control</span>
                  <span className={clsx("num font-semibold", st.significant ? (st.uplift! > 0 ? "text-good" : "text-bad") : "text-fg")}>
                    {st.uplift === null ? "—" : pp(st.uplift)}</span>
                </div>
                <p className="mt-0.5 text-2xs text-fg-3">
                  Control {pct(st.control_rate, 0)} · {st.significant ? "significant" : `not yet significant (n=${st.treated}/${st.control})`}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {s.channels.map((c) => <Chip key={c} tone="info">{c}</Chip>)}
              </div>
              <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-2xs text-fg-3">
                <span>{s.owner} · {num(st.decisions)} accounts</span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/strategies/${s.campaign_id}`)}>View</Button>
                  {can("create_strategy") && (
                    <Button size="sm" variant="secondary" icon={<Copy className="h-3 w-3" />} loading={busy === s.campaign_id}
                      onClick={() => run(s.campaign_id, () => api.post<Strategy>(`/strategies/${s.campaign_id}/clone`), (r) => `Cloned into ${r.campaign_id}.`)
                        .then((r) => r && navigate(`/builder/${r.campaign_id}`))}>Clone</Button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <Banner tone="neutral">Recovery rates include customers who would have paid anyway. Compare strategies on uplift over their own control group.</Banner>
    </div>
  );
}
