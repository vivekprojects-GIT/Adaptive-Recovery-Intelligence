/** The header bar: product, client, search, help, alerts, account. */
import { ChevronsLeft, ChevronsRight, CircleHelp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useSession } from "../lib/session";
import { CLIENT_BANK, ProductLockup } from "../ui/brand";
import { AboutDrawer } from "./AboutDrawer";
import { GlobalSearch } from "./GlobalSearch";
import { HOME } from "./nav";
import { Notifications } from "./Notifications";
import { UserMenu } from "./UserMenu";

const ICON_BUTTON = "flex h-9 w-9 items-center justify-center rounded-md text-primary-100 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40";

/** An icon button with a tooltip naming what it does. */
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onClick} aria-label={label} className={ICON_BUTTON}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ShellBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me } = useSession();
  const [about, setAbout] = useState(false);
  if (!me) return null;
  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-4 bg-ink px-4 text-white shadow-[0_1px_0_rgba(255,255,255,0.06)]">
      <IconButton label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={onToggle}>
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
      </IconButton>
      <Link to={HOME[me.user.role]} className="shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-white/40"><ProductLockup onDark /></Link>
      <Separator orientation="vertical" className="hidden h-6 bg-white/15 xl:block" />
      <span className="hidden shrink-0 text-[13px] text-primary-100 xl:block">{CLIENT_BANK}</span>
      <GlobalSearch />
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton label="About ARI" onClick={() => setAbout(true)}><CircleHelp className="h-[18px] w-[18px]" /></IconButton>
        <Notifications />
        <Separator orientation="vertical" className="mx-1 h-6 bg-white/15" />
        <UserMenu />
      </div>
      <AboutDrawer open={about} onClose={() => setAbout(false)} />
    </header>
  );
}
