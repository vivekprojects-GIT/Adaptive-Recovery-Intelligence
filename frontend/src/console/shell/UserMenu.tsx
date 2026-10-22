/** The header account menu: who is signed in, switching account, signing out (shadcn dropdown menu). */
import { ChevronDown, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { useSession } from "../lib/session";
import { Avatar } from "../ui/ui";
import { HOME } from "./nav";

export function UserMenu() {
  const { me, users, switchUser, signOut } = useSession();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-md py-1 pl-1 pr-2 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 data-[state=open]:bg-white/10">
        <Avatar name={me.user.name} />
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-medium text-white">{me.user.name}</span>
          <span className="block text-2xs text-primary-200">{me.user.role_label}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-primary-200" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <Avatar name={me.user.name} />
          <div className="min-w-0"><p className="truncate text-[13px] font-medium">{me.user.name}</p><p className="truncate text-xs text-fg-3">{me.user.email}</p></div>
        </div>
        <DropdownMenuSeparator className="mx-0 my-0" />
        <DropdownMenuLabel className="px-4 pb-1 pt-2.5">Switch account</DropdownMenuLabel>
        <div className="px-1 pb-1">
          {users.map((u) => (
            <DropdownMenuItem key={u.user_id} disabled={u.status !== "Active"}
              onSelect={async () => { await switchUser(u.user_id); navigate(HOME[u.role]); }}
              className={cn("gap-2.5 px-3", u.user_id === me.user.user_id && "bg-primary-50/70")}>
              <Avatar name={u.name} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{u.name}</span>
                <span className="block text-2xs text-fg-3">{u.role_label}{u.status !== "Active" ? ` · ${u.status}` : ""}</span></span>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator className="mx-0 my-0" />
        <div className="p-1">
          <DropdownMenuItem onSelect={() => { signOut(); navigate("/", { replace: true }); }} className="px-3 text-fg-2">
            <LogOut />Sign out
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
