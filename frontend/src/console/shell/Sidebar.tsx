/** The sidebar: the signed-in role's sections, with counts of work waiting. */
import clsx from "clsx";
import { Link, useLocation } from "react-router-dom";

import { useSession } from "../lib/session";
import { NAV, WORKSPACE } from "./nav";

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { me, can } = useSession();
  const { pathname } = useLocation();
  if (!me) return null;
  const groups = NAV[me.user.role];
  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200", collapsed ? "w-[64px]" : "w-[248px]")}>
      {!collapsed && (
        <div className="border-b border-line px-4 py-3">
          <p className="label">{WORKSPACE[me.user.role]}</p>
        </div>
      )}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((g, gi) => (
          <div key={gi} className={gi ? "mt-5" : ""}>
            {g.section && !collapsed && <p className="mb-1.5 px-3 text-2xs font-medium uppercase tracking-[0.1em] text-fg-3">{g.section}</p>}
            {g.section && collapsed && <div className="mx-3 mb-2 h-px bg-line" />}
            <ul className="space-y-0.5">
              {g.items.filter((i) => !i.perm || can(i.perm)).map((i) => {
                const active = pathname === i.to || (i.to !== "/admin" && pathname.startsWith(i.to + "/"));
                const Icon = i.icon;
                const badge = i.badge ? i.badge(me.badges) : 0;
                return (
                  <li key={i.to}>
                    <Link to={i.to} title={collapsed ? i.label : undefined}
                      className={clsx("relative flex items-center gap-3 rounded-md py-2 text-[13px] transition",
                        collapsed ? "justify-center px-0" : "px-3",
                        active ? "bg-primary-50 font-medium text-primary-500" : "text-fg-2 hover:bg-surface-hover hover:text-fg")}>
                      {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-azure" />}
                      <Icon className={clsx("h-[17px] w-[17px] shrink-0", active ? "text-azure" : "text-fg-3")} />
                      {!collapsed && <span className="flex-1">{i.label}</span>}
                      {badge > 0 && (collapsed
                        ? <span className="absolute right-2.5 top-1.5 h-1.5 w-1.5 rounded-full bg-azure" />
                        : <span className={clsx("num min-w-5 rounded-full px-1.5 text-center text-2xs font-semibold",
                          active ? "bg-azure text-white" : "bg-primary-50 text-primary-500")}>{badge}</span>)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

