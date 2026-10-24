/** The sidebar: the bank, the signed-in role's sections with counts of work waiting, and Capgemini. */
import clsx from "clsx";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { useSession } from "../lib/session";
import { BankMark, BrandMark, PRODUCT_NAME } from "../ui/brand";
import { HOME, NAV } from "./nav";

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me, can } = useSession();
  const { pathname } = useLocation();
  if (!me) return null;
  const groups = NAV[me.user.role];
  return (
    <aside className={clsx("flex shrink-0 flex-col bg-ink text-white transition-[width] duration-200", collapsed ? "w-[68px]" : "w-[248px]")}>
      <div className={clsx("flex h-16 shrink-0 items-center border-b border-white/10", collapsed ? "justify-center px-2" : "px-5")}>
        <Link to={HOME[me.user.role]} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-white/40"><BankMark compact={collapsed} /></Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((g, gi) => (
          <div key={gi} className={gi ? "mt-5" : ""}>
            {g.section && !collapsed && <p className="mb-1.5 px-3 text-2xs font-medium text-primary-200/70">{g.section}</p>}
            {g.section && collapsed && <div className="mx-3 mb-2 h-px bg-white/10" />}
            <ul className="space-y-0.5">
              {g.items.filter((i) => !i.perm || can(i.perm)).map((i) => {
                const active = pathname === i.to || (i.to !== "/admin" && pathname.startsWith(i.to + "/"));
                const Icon = i.icon;
                const badge = i.badge ? i.badge(me.badges) : 0;
                return (
                  <li key={i.to}>
                    <Link to={i.to} title={collapsed ? i.label : undefined}
                      className={clsx("relative flex items-center gap-3 rounded-md py-2 text-[13px] outline-none transition focus-visible:ring-2 focus-visible:ring-white/40",
                        collapsed ? "justify-center px-0" : "px-3",
                        active ? "bg-white/10 font-medium text-white" : "text-primary-100/85 hover:bg-white/[0.06] hover:text-white")}>
                      {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-[#12abdb]" />}
                      <Icon className={clsx("h-[17px] w-[17px] shrink-0", active ? "text-white" : "text-primary-200/80")} />
                      {!collapsed && <span className="flex-1">{i.label}</span>}
                      {badge > 0 && (collapsed
                        ? <span className="absolute right-2.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#12abdb]" />
                        : <span className="num min-w-5 rounded-full bg-white/10 px-1.5 text-center text-2xs font-semibold text-white">{badge}</span>)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={clsx("shrink-0 border-t border-white/10", collapsed ? "px-2 py-3" : "px-5 py-3.5")}>
        {!collapsed && (
          <div className="mb-3">
            <BrandMark onDark size="sm" />
            <p className="mt-1 text-2xs text-primary-200/80">{PRODUCT_NAME}</p>
          </div>
        )}
        <button type="button" onClick={onToggle} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className={clsx("flex h-8 items-center gap-2 rounded-md text-xs text-primary-200 outline-none hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-white/40",
            collapsed ? "w-full justify-center" : "px-2")}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" />Collapse</>}
        </button>
      </div>
    </aside>
  );
}
