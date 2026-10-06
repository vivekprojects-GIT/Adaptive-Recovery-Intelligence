import clsx from "clsx";
import { ArrowRight, BarChart3, KeyRound, Lock, Scale, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { Role } from "../lib/api";
import { useSession } from "../lib/session";
import { BrandMark } from "../ui/brand";
import { Avatar } from "../ui/ui";

const HOME: Record<Role, string> = { strategist: "/dashboard", leader: "/kpis", admin: "/admin", viewer: "/kpis" };

const WHAT: Record<Role, string> = {
  strategist: "Builds strategies, runs waves, reviews forbearance offers and follows customer journeys.",
  leader: "Approves strategies, compares results, watches compliance and sends improvements.",
  admin: "Manages users, permissions, platform settings, integrations and alerts.",
  viewer: "Read-only access to portfolio KPIs.",
};

export default function SignIn() {
  const { users, switchUser, error } = useSession();
  const navigate = useNavigate();
  const order: Role[] = ["strategist", "leader", "admin", "viewer"];
  // Active accounts first, then by role, so the usable personas lead the list.
  const people = [...users].sort((a, b) =>
    Number(a.status !== "Active") - Number(b.status !== "Active")
    || order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name));

  return (
    <div className="flex min-h-full">
      {/* brand panel */}
      <section className="brand-gradient relative hidden w-[46%] max-w-[640px] flex-col justify-between overflow-hidden p-10 text-white lg:flex">
        <BrandMark onDark size="lg" />
        <div className="relative">
          <p className="text-sm font-medium uppercase tracking-[0.14em] text-primary-200">ARI Console</p>
          <h1 className="mt-3 text-[40px] font-light leading-[1.1] tracking-tight">Adaptive Recovery<br />Intelligence</h1>
          <p className="mt-4 max-w-md text-[15px] leading-6 text-primary-100">
            Decide which collections treatment works for which customer, and prove it against a randomised control group.
          </p>
          <ul className="mt-8 space-y-3.5 text-[14px] text-white/90">
            {[
              [BarChart3, "Every result reported as uplift over its own control group"],
              [ShieldCheck, "Maker-checker approval, contact guard and compliance monitoring built in"],
              [Scale, "Thompson sampling over business-approved treatments, inside the contact rules"],
            ].map(([Icon, t], i) => {
              const I = Icon as typeof BarChart3;
              return (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 ring-1 ring-white/15"><I className="h-3.5 w-3.5" /></span>
                  <span className="pt-1">{t as string}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <div aria-hidden />
      </section>

      {/* sign-in */}
      <section className="flex flex-1 flex-col bg-surface">
        <div className="flex items-center px-8 py-6 lg:hidden">
          <BrandMark />
        </div>
        <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-8 pb-12">
          <h2 className="text-[26px] font-medium tracking-tight text-fg">Sign in</h2>
          <p className="mt-1.5 text-sm text-fg-2">to ARI Console</p>

          <button disabled title="Connects to the organisation's identity provider in production"
            className="mt-7 flex h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-sunken text-sm font-medium text-fg-3">
            <KeyRound className="h-4 w-4" /> Continue with single sign-on
          </button>
          <p className="mt-1.5 text-center text-2xs text-fg-3">Available when connected to the bank's identity provider.</p>

          <div className="my-6 flex items-center gap-3 text-2xs font-medium uppercase tracking-[0.1em] text-fg-3">
            <span className="h-px flex-1 bg-line" />Accounts in this environment<span className="h-px flex-1 bg-line" />
          </div>

          {error && !users.length && <p className="mb-3 text-sm text-bad">Cannot reach the ARI service: {error}</p>}
          <ul className="space-y-2">
            {people.map((u) => {
              const active = u.status === "Active";
              return (
                <li key={u.user_id}>
                  <button disabled={!active}
                    onClick={async () => { await switchUser(u.user_id); navigate(HOME[u.role], { replace: true }); }}
                    className={clsx("group flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition",
                      active ? "border-line hover:border-primary-300 hover:bg-primary-50/50" : "cursor-not-allowed border-line opacity-55")}>
                    <Avatar name={u.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[14px] font-medium text-fg">{u.name}</span>
                        <span className="rounded bg-primary-50 px-1.5 py-0.5 text-2xs font-medium text-primary-500">{u.role_label}</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-4 text-fg-3">{active ? WHAT[u.role] : `Account ${u.status.toLowerCase()} - ask an administrator to activate it.`}</span>
                    </span>
                    {active ? <ArrowRight className="h-4 w-4 text-fg-3 transition group-hover:translate-x-0.5 group-hover:text-primary-500" />
                      : <Lock className="h-4 w-4 text-fg-3" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 text-xs leading-5 text-fg-3">
            Single sign-on is not connected in this environment. Every action is recorded in the audit log against the account you choose, and permissions are enforced on every request.
          </p>
        </div>
      </section>
    </div>
  );
}
