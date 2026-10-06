/** The header bell: alerts and work waiting for the signed-in user. */
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type Alert } from "../lib/api";
import { useSession } from "../lib/session";
import { useOutside } from "./useOutside";

export function Notifications() {
  const { me, can } = useSession();
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const ref = useOutside(open, () => setOpen(false));
  useEffect(() => {
    if (open && can("view_kpi_dashboard")) api.get<Alert[]>("/alerts").then(setAlerts).catch(() => setAlerts([]));
  }, [open, can]);
  if (!me) return null;
  const b = me.badges;
  const items: { label: string; count: number; to: string; perm?: string }[] = [
    { label: "New insights from your strategy leader", count: me.user.role === "strategist" ? b.new_insights : 0, to: "/dashboard" },
    { label: "Forbearance offers waiting for review", count: b.pending_review, to: "/review", perm: "override_decisions" },
    { label: "Strategies waiting for approval", count: b.awaiting_approval, to: "/approvals", perm: "approve_strategy" },
    { label: "Open high and critical violations", count: b.open_violations, to: "/compliance", perm: "view_compliance" },
  ].filter((i) => i.count > 0 && (!i.perm || can(i.perm)));
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="Notifications"
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-primary-100 hover:bg-white/10 hover:text-white">
        <Bell className="h-[18px] w-[18px]" />
        {total > 0 && <span className="num absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#dd1d46] px-1 text-[9px] font-semibold text-white">{total > 99 ? "99+" : total}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-[360px] overflow-hidden rounded-lg border border-line bg-surface text-fg shadow-pop">
          <p className="border-b border-line px-4 py-2.5 text-[13px] font-medium">Notifications</p>
          <ul className="max-h-96 overflow-y-auto">
            {items.map((i) => (
              <li key={i.label}>
                <Link to={i.to} onClick={() => setOpen(false)} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] hover:bg-surface-hover">
                  <span>{i.label}</span><span className="num rounded-full bg-primary-50 px-2 text-xs font-medium text-primary-500">{i.count}</span>
                </Link>
              </li>
            ))}
            {alerts.slice(0, 5).map((a, n) => (
              <li key={n} className="border-t border-line px-4 py-2.5">
                <p className="text-[13px] font-medium">{a.name}</p>
                <p className="text-xs text-fg-3">{a.message}</p>
              </li>
            ))}
            {!items.length && !alerts.length && <li className="px-4 py-8 text-center text-[13px] text-fg-3">You're all caught up.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
