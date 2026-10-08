/** Navigation: each role's sidebar sections, home page and workspace label. */
import {
  Activity,
  Bell,
  BookOpen,
  ChartColumnBig,
  ClipboardCheck,
  FileText,
  FlaskConical,
  Gauge,
  GitCompare,
  HeartPulse,
  Layers,
  LayoutDashboard,
  Library,
  Lightbulb,
  ListChecks,
  Lock,
  MessageSquare,
  Plug,
  Route as RouteIcon,
  ScrollText,
  Send,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type Role } from "../lib/api";

export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: string; badge?: (b: Badges) => number }
export type Badges = { live_campaigns: number; open_violations: number; pending_review: number; awaiting_approval: number; new_insights: number };

export const NAV: Record<Role, { section?: string; items: NavItem[] }[]> = {
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
      { to: "/activity", label: "Activity", icon: Activity, perm: "view_ai_decisions" },
    ] },
    { section: "Analyse", items: [
      { to: "/journeys", label: "Journeys", icon: RouteIcon, perm: "view_customer_list" },
      { to: "/nudges", label: "Nudges", icon: Send, perm: "view_ai_decisions" },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
      { to: "/cohorts", label: "Cohorts & Handoffs", icon: Layers },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
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
      { to: "/workbench", label: "Strategy Workbench", icon: Lightbulb, perm: "use_ai_workbench" },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
    ] },
    { section: "Performance", items: [
      { to: "/scorecards", label: "Scorecards", icon: Scale },
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
      { to: "/scorecards", label: "Scorecards", icon: Scale },
    ] },
  ],
  viewer: [
    { items: [
      { to: "/kpis", label: "KPI Dashboard", icon: LayoutDashboard },
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/portfolio", label: "Portfolio Health", icon: HeartPulse },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
    ] },
  ],
};

export const HOME: Record<Role, string> = { strategist: "/dashboard", leader: "/kpis", admin: "/admin", viewer: "/kpis" };
export const WORKSPACE: Record<Role, string> = { strategist: "Strategist workspace", leader: "Leadership workspace", admin: "Platform administration", viewer: "Read-only workspace" };

