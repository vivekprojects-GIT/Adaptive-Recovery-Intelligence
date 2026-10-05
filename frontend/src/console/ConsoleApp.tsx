import clsx from "clsx";
import {
  Bell, BookOpen, ChartColumnBig, ChevronDown, ChevronsLeft, ChevronsRight, CircleHelp, ClipboardCheck, FileText, FlaskConical,
  Gauge, GitCompare, HeartPulse, Layers, LayoutDashboard, Library, Lightbulb, ListChecks, Lock, LogOut, MessageSquare,
  Plug, Route as RouteIcon, ScrollText, Search, Send, ShieldCheck, SlidersHorizontal, Sparkles, UserCog, Users,
  Wrench, type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { api, type Alert, type Role } from "./lib/api";
import { SessionProvider, useSession } from "./lib/session";
import { num } from "./lib/format";
import { ProductLockup } from "./ui/brand";
import { Avatar, Drawer, KV, Spinner, ToastProvider } from "./ui/ui";

import AdminDashboard from "./pages/admin/AdminDashboard";
import AlertRules from "./pages/admin/AlertRules";
import AuditLog from "./pages/admin/AuditLog";
import Integrations from "./pages/admin/Integrations";
import PlatformConfig from "./pages/admin/PlatformConfig";
import RolesPermissions from "./pages/admin/RolesPermissions";
import SystemHealth from "./pages/admin/SystemHealth";
import UserManagement from "./pages/admin/UserManagement";
import Approvals from "./pages/leader/Approvals";
import Compliance from "./pages/leader/Compliance";
import KpiDashboard from "./pages/leader/KpiDashboard";
import PortfolioHealth from "./pages/leader/PortfolioHealth";
import Reports from "./pages/leader/Reports";
import StrategyCompare from "./pages/leader/StrategyCompare";
import TeamPerformance from "./pages/leader/TeamPerformance";
import Workbench from "./pages/leader/Workbench";
import Activity_ from "./pages/shared/Activity";
import Cohorts from "./pages/shared/Cohorts";
import Customers from "./pages/shared/Customers";
import DecisionAudit from "./pages/shared/DecisionAudit";
import Decisions from "./pages/shared/Decisions";
import Journey from "./pages/shared/Journey";
import Journeys from "./pages/shared/Journeys";
import NudgeDetail from "./pages/shared/NudgeDetail";
import Nudges from "./pages/shared/Nudges";
import StrategyAnalytics from "./pages/shared/StrategyAnalytics";
import StrategyDetail from "./pages/shared/StrategyDetail";
import TreatmentsPage from "./pages/shared/Treatments";
import SignIn from "./pages/SignIn";
import LiveCampaigns from "./pages/strategist/LiveCampaigns";
import MyDashboard from "./pages/strategist/MyDashboard";
import MyStrategies from "./pages/strategist/MyStrategies";
import ReviewQueue from "./pages/strategist/ReviewQueue";
import StrategyBuilder from "./pages/strategist/StrategyBuilder";

interface NavItem { to: string; label: string; icon: LucideIcon; perm?: string; badge?: (b: Badges) => number }
type Badges = { live_campaigns: number; open_violations: number; pending_review: number; awaiting_approval: number; new_insights: number };

const NAV: Record<Role, { section?: string; items: NavItem[] }[]> = {
  strategist: [
    { items: [
      { to: "/dashboard", label: "My Dashboard", icon: LayoutDashboard },
      { to: "/builder", label: "Strategy Builder", icon: Wrench, perm: "create_strategy" },
      { to: "/strategies", label: "My Strategies", icon: BookOpen },
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
    ] },
    { section: "Campaign", items: [
      { to: "/customers", label: "Customers", icon: Users, perm: "view_customer_list" },
      { to: "/campaigns", label: "Live Campaigns", icon: FlaskConical, badge: (b) => b.live_campaigns },
      { to: "/review", label: "Review Queue", icon: ClipboardCheck, perm: "override_decisions", badge: (b) => b.pending_review },
      { to: "/activity", label: "AI Activity", icon: Sparkles, perm: "view_ai_decisions" },
    ] },
    { section: "Analyse", items: [
      { to: "/journeys", label: "Journeys", icon: RouteIcon, perm: "view_customer_list" },
      { to: "/nudges", label: "Nudges", icon: Send, perm: "view_ai_decisions" },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
      { to: "/cohorts", label: "Cohorts & Handoffs", icon: Layers },
    ] },
  ],
  leader: [
    { items: [
      { to: "/kpis", label: "KPI Dashboard", icon: LayoutDashboard },
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/portfolio", label: "Portfolio Health", icon: HeartPulse },
      { to: "/compare", label: "Strategy Compare", icon: GitCompare, perm: "compare_strategies" },
    ] },
    { section: "Governance", items: [
      { to: "/approvals", label: "Approvals", icon: ListChecks, perm: "approve_strategy", badge: (b) => b.awaiting_approval },
      { to: "/compliance", label: "Compliance", icon: ShieldCheck, perm: "view_compliance", badge: (b) => b.open_violations },
      { to: "/workbench", label: "AI Workbench", icon: Lightbulb, perm: "use_ai_workbench" },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
    ] },
    { section: "Performance", items: [
      { to: "/team", label: "Team Performance", icon: Users },
      { to: "/reports", label: "Reports", icon: FileText, perm: "export_reports" },
    ] },
    { section: "Drill-down", items: [
      { to: "/customers", label: "Customers", icon: Users, perm: "view_customer_list" },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
    ] },
  ],
  admin: [
    { items: [
      { to: "/admin", label: "Admin Dashboard", icon: LayoutDashboard },
      { to: "/admin/users", label: "User Management", icon: UserCog, perm: "manage_users" },
      { to: "/admin/roles", label: "Roles & Permissions", icon: Lock, perm: "manage_roles" },
    ] },
    { section: "Configuration", items: [
      { to: "/admin/config", label: "Platform Config", icon: SlidersHorizontal, perm: "configure_platform" },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
      { to: "/admin/integrations", label: "API & Integrations", icon: Plug, perm: "manage_integrations" },
      { to: "/admin/audit", label: "Audit Log", icon: ScrollText, perm: "view_audit_log" },
    ] },
    { section: "Monitor", items: [
      { to: "/admin/health", label: "System Health", icon: Gauge, perm: "view_system_health" },
      { to: "/admin/alerts", label: "Alert Rules", icon: Bell, perm: "manage_alert_rules" },
    ] },
  ],
  viewer: [
    { items: [
      { to: "/kpis", label: "KPI Dashboard", icon: LayoutDashboard },
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/portfolio", label: "Portfolio Health", icon: HeartPulse },
    ] },
  ],
};

export const HOME: Record<Role, string> = { strategist: "/dashboard", leader: "/kpis", admin: "/admin", viewer: "/kpis" };
const WORKSPACE: Record<Role, string> = { strategist: "Strategist workspace", leader: "Leadership workspace", admin: "Platform administration", viewer: "Read-only workspace" };

/* ------------------------------------------------------------- popovers */

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open, close]);
  return ref;
}

function Notifications() {
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

function UserMenu() {
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
          <p className="px-4 pb-1 pt-2.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Switch persona (demo)</p>
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

function AboutDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  if (!me) return null;
  return (
    <Drawer open={open} onClose={onClose} title="About this environment" subtitle="ARI Console · Capgemini" width="max-w-md">
      <div className="space-y-5 text-[13px] leading-5 text-fg-2">
        <KV items={[
          { label: "Product", value: "ARI Console" },
          { label: "Decision model", value: me.agent.model_version },
          { label: "Mode", value: me.agent.shadow_mode ? "Shadow (no customer contact)" : "Live" },
          { label: "Decisions logged", value: num(me.agent.decisions_total) },
          { label: "Signed in as", value: `${me.user.name} · ${me.user.role_label}` },
        ]} />
        <div>
          <p className="mb-1 font-medium text-fg">What is real</p>
          <p>Every decision, message, engagement event, outcome, compliance check and audit entry is written by the decision engine and read back by these screens. Permissions are enforced by the API on every request.</p>
        </div>
        <div>
          <p className="mb-1 font-medium text-fg">What is simulated</p>
          <p>Customer responses and channel delivery. Customers, balances and contact histories are synthetic. In shadow mode nothing is sent to a real person.</p>
        </div>
        <div>
          <p className="mb-1 font-medium text-fg">How results are reported</p>
          <p>As uplift over each strategy's own randomised control group, with a 95% interval and the smallest effect the sample can detect. Raw recovery rates include customers who would have paid anyway.</p>
        </div>
      </div>
    </Drawer>
  );
}

/* -------------------------------------------------------------- shell bar */

function ShellBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me } = useSession();
  const [q, setQ] = useState("");
  const [about, setAbout] = useState(false);
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-4 bg-ink px-4 text-white shadow-[0_1px_0_rgba(255,255,255,0.06)]">
      <button onClick={onToggle} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        className="flex h-9 w-9 items-center justify-center rounded-md text-primary-100 hover:bg-white/10 hover:text-white">
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
      </button>
      <Link to={HOME[me.user.role]} className="shrink-0"><ProductLockup onDark /></Link>
      <form className="relative ml-4 hidden max-w-[440px] flex-1 lg:block"
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/customers?q=${encodeURIComponent(q.trim())}`); }}>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-200" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers by name or ID"
          className="h-9 w-full rounded-md border border-white/10 bg-white/[0.08] pl-9 pr-3 text-[13px] text-white placeholder:text-primary-200 focus:border-ai-300/60 focus:bg-white/[0.12] focus:outline-none" />
      </form>
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

/* ---------------------------------------------------------------- sidebar */

function Sidebar({ collapsed }: { collapsed: boolean }) {
  const { me, can } = useSession();
  const { pathname } = useLocation();
  if (!me) return null;
  const groups = NAV[me.user.role];
  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200", collapsed ? "w-[64px]" : "w-[248px]")}>
      <div className={clsx("border-b border-line", collapsed ? "px-2 py-3" : "px-4 py-3.5")}>
        {!collapsed && <p className="label">{WORKSPACE[me.user.role]}</p>}
        <div className={clsx("flex items-center gap-2 rounded-md border border-ai-400/25 bg-ai-50 text-2xs font-medium text-ai-600",
          collapsed ? "mt-0 justify-center px-0 py-2" : "mt-2 px-2.5 py-1.5")} title={`Agent active · ${num(me.agent.decisions_total)} decisions`}>
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ai-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ai-400" />
          </span>
          {!collapsed && <>Agent active · <span className="num">{num(me.agent.decisions_total)}</span> decisions</>}
        </div>
      </div>
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
      {!collapsed && (
        <div className="border-t border-line px-4 py-3 text-2xs leading-4 text-fg-3">
          <p className="font-medium text-fg-2">Capgemini · ARI Console</p>
          <p>{me.agent.model_version} · Confidential</p>
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ guard */

export function RequirePerm({ perm, children }: { perm?: string; children: ReactNode }) {
  const { can, me } = useSession();
  if (!perm || can(perm)) return <>{children}</>;
  return (
    <div className="p-10">
      <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-card">
        <Lock className="mx-auto h-6 w-6 text-fg-3" />
        <h2 className="mt-3 text-[15px] font-medium">No access to this view</h2>
        <p className="mt-1 text-sm text-fg-2">
          The {me?.user.role_label} role does not have the permission this page needs. An administrator can grant it in Roles &amp; Permissions.
        </p>
        {me && <Link to={HOME[me.user.role]} className="mt-4 inline-block text-sm font-medium text-azure hover:underline">Back to your home page</Link>}
      </div>
    </div>
  );
}

const ROUTES: { path: string; el: ReactNode; perm?: string }[] = [
  { path: "/dashboard", el: <MyDashboard /> },
  { path: "/builder", el: <StrategyBuilder />, perm: "create_strategy" },
  { path: "/builder/:id", el: <StrategyBuilder />, perm: "edit_strategy" },
  { path: "/strategies", el: <MyStrategies /> },
  { path: "/strategies/:id", el: <StrategyDetail />, perm: "view_kpi_dashboard" },
  { path: "/analytics", el: <StrategyAnalytics />, perm: "view_kpi_dashboard" },
  { path: "/campaigns", el: <LiveCampaigns /> },
  { path: "/review", el: <ReviewQueue />, perm: "override_decisions" },
  { path: "/activity", el: <Activity_ />, perm: "view_ai_decisions" },
  { path: "/customers", el: <Customers />, perm: "view_customer_list" },
  { path: "/journeys", el: <Journeys />, perm: "view_customer_list" },
  { path: "/journeys/:id", el: <Journey />, perm: "view_customer_list" },
  { path: "/nudges", el: <Nudges />, perm: "view_ai_decisions" },
  { path: "/nudges/:id", el: <NudgeDetail />, perm: "view_ai_decisions" },
  { path: "/decisions", el: <Decisions />, perm: "view_ai_decisions" },
  { path: "/decisions/:id", el: <DecisionAudit />, perm: "view_ai_decisions" },
  { path: "/cohorts", el: <Cohorts /> },
  { path: "/treatments", el: <TreatmentsPage />, perm: "view_kpi_dashboard" },
  { path: "/kpis", el: <KpiDashboard />, perm: "view_kpi_dashboard" },
  { path: "/portfolio", el: <PortfolioHealth />, perm: "view_kpi_dashboard" },
  { path: "/compare", el: <StrategyCompare />, perm: "compare_strategies" },
  { path: "/approvals", el: <Approvals />, perm: "approve_strategy" },
  { path: "/compliance", el: <Compliance />, perm: "view_compliance" },
  { path: "/workbench", el: <Workbench />, perm: "use_ai_workbench" },
  { path: "/team", el: <TeamPerformance />, perm: "view_kpi_dashboard" },
  { path: "/reports", el: <Reports />, perm: "export_reports" },
  { path: "/admin", el: <AdminDashboard />, perm: "manage_users" },
  { path: "/admin/users", el: <UserManagement />, perm: "manage_users" },
  { path: "/admin/roles", el: <RolesPermissions />, perm: "manage_roles" },
  { path: "/admin/config", el: <PlatformConfig />, perm: "configure_platform" },
  { path: "/admin/integrations", el: <Integrations />, perm: "manage_integrations" },
  { path: "/admin/audit", el: <AuditLog />, perm: "view_audit_log" },
  { path: "/admin/health", el: <SystemHealth />, perm: "view_system_health" },
  { path: "/admin/alerts", el: <AlertRules />, perm: "manage_alert_rules" },
];

function Shell() {
  const { me, signedOut } = useSession();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // The content pane is its own scroll area, so the router cannot reset it:
  // without this, a new page opens wherever the last one was scrolled to.
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [pathname]);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("ari.console.nav") === "collapsed"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ari.console.nav", collapsed ? "collapsed" : "open"); } catch { /* storage blocked */ }
  }, [collapsed]);

  if (signedOut && !me) return <SignIn />;
  if (!me) return <Spinner label="Signing in" />;
  return (
    <div className="flex h-full flex-col">
      <ShellBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Navigate to={HOME[me.user.role]} replace />} />
              {ROUTES.map((r) => <Route key={r.path} path={r.path} element={<RequirePerm perm={r.perm}>{r.el}</RequirePerm>} />)}
              <Route path="*" element={<Navigate to={HOME[me.user.role]} replace />} />
            </Routes>
          </main>
          <footer className="flex shrink-0 items-center justify-end gap-4 border-t border-line bg-surface px-6 py-1.5 text-2xs text-fg-3">
            <span className="hidden items-center gap-3 md:flex">
              <span>{me.agent.model_version}</span><span>·</span>
              <span>{me.agent.shadow_mode ? "Shadow mode: no customer is contacted" : "Live mode"}</span>
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default function ConsoleApp() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionProvider>
  );
}
