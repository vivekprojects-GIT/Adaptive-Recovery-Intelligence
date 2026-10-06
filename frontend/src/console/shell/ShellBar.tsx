/** The header bar: product name, environment label, search, help, alerts, account. */
import { ChevronsLeft, ChevronsRight, CircleHelp } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useSession } from "../lib/session";
import { ProductLockup } from "../ui/brand";
import { HOME } from "./nav";
import { Notifications } from "./Notifications";
import { UserMenu } from "./UserMenu";
import { AboutDrawer } from "./AboutDrawer";
import { GlobalSearch } from "./GlobalSearch";

export function ShellBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me } = useSession();
  const [about, setAbout] = useState(false);
  if (!me) return null;
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-4 bg-ink px-4 text-white shadow-[0_1px_0_rgba(255,255,255,0.06)]">
      <button onClick={onToggle} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        className="flex h-9 w-9 items-center justify-center rounded-md text-primary-100 hover:bg-white/10 hover:text-white">
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
      </button>
      <Link to={HOME[me.user.role]} className="shrink-0"><ProductLockup onDark /></Link>
      {me.agent.shadow_mode && (
        <button onClick={() => setAbout(true)} title="Pilot environment: test data, channel delivery not connected"
          className="hidden shrink-0 rounded border border-white/20 px-1.5 py-px text-[11px] font-medium uppercase tracking-[0.08em] text-primary-100 hover:border-white/40 hover:text-white sm:block">
          Pilot
        </button>
      )}
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-1.5">
        <button onClick={() => setAbout(true)} aria-label="About this environment"
          className="flex h-9 w-9 items-center justify-center rounded-md text-primary-100 hover:bg-white/10 hover:text-white"><CircleHelp className="h-[18px] w-[18px]" /></button>
        <Notifications />
        <span className="mx-1 h-6 w-px bg-white/15" />
        <UserMenu />
      </div>
      <AboutDrawer open={about} onClose={() => setAbout(false)} />
    </header>
  );
}

