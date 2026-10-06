/** The header account menu: who is signed in, switching account, signing out. */
import clsx from "clsx";
import { ChevronDown, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSession } from "../lib/session";
import { Avatar } from "../ui/ui";
import { HOME } from "./nav";
import { useOutside } from "./useOutside";

export function UserMenu() {
  const { me, users, switchUser, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-md py-1 pl-1 pr-2 hover:bg-white/10">
        <Avatar name={me.user.name} />
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-medium text-white">{me.user.name}</span>
          <span className="block text-2xs text-primary-200">{me.user.role_label}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-primary-200" />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-72 overflow-hidden rounded-lg border border-line bg-surface text-fg shadow-pop">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Avatar name={me.user.name} />
            <div className="min-w-0"><p className="truncate text-[13px] font-medium">{me.user.name}</p><p className="truncate text-xs text-fg-3">{me.user.email}</p></div>
          </div>
          <p className="px-4 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Switch account</p>
          <ul className="pb-1">
            {users.map((u) => (
              <li key={u.user_id}>
                <button disabled={u.status !== "Active"}
                  onClick={async () => { setOpen(false); await switchUser(u.user_id); navigate(HOME[u.role]); }}
                  className={clsx("flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
                    u.user_id === me.user.user_id && "bg-primary-50/70")}>
                  <Avatar name={u.name} size="sm" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{u.name}</span>
                    <span className="block text-2xs text-fg-3">{u.role_label}{u.status !== "Active" ? ` · ${u.status}` : ""}</span></span>
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => { setOpen(false); signOut(); navigate("/", { replace: true }); }}
            className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-[13px] text-fg-2 hover:bg-surface-hover">
            <LogOut className="h-4 w-4" />Sign out
          </button>
        </div>
      )}
    </div>
  );
}
