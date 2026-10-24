/** The header over the content: search, help, alerts, account. */
import { CircleHelp } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useSession } from "../lib/session";
import { AboutDrawer } from "./AboutDrawer";
import { GlobalSearch } from "./GlobalSearch";
import { WORKSPACE } from "./nav";
import { Notifications } from "./Notifications";
import { UserMenu } from "./UserMenu";

const ICON_BUTTON = "flex h-9 w-9 items-center justify-center rounded-md text-fg-2 outline-none hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring";

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

export function ShellBar() {
  const { me } = useSession();
  const [about, setAbout] = useState(false);
  if (!me) return null;
  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-6">
      <p className="hidden shrink-0 text-xs text-fg-3 md:block">{WORKSPACE[me.user.role]}</p>
      <GlobalSearch />
      <div className="flex items-center gap-1">
        <IconButton label="About" onClick={() => setAbout(true)}><CircleHelp className="h-[18px] w-[18px]" /></IconButton>
        <Notifications />
        <span className="mx-2 h-6 w-px bg-line" />
        <UserMenu />
      </div>
      <AboutDrawer open={about} onClose={() => setAbout(false)} />
    </header>
  );
}
