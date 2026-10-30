/** Navigation: each role's sidebar sections, home page and workspace label. */
import {
  Activity,
  Bell,
  Briefcase,
  BookOpen,
  ChartColumnBig,
  ClipboardCheck,
  Columns3,
  FileText,
  FlaskConical,
  Gauge,
  Landmark,
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
  Waypoints,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type Role } from "../lib/api";

export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: string; badge?: (b: Badges) => number }
export type Badges = { live_campaigns: number; open_violations: number; pending_review: number; awaiting_approval: number; new_insights: number; pending_placements: number };

export const NAV: Record<Role, { section?: string; items: NavItem[] }[]> = {
  strategist: [
    { section: "Overview", items: [
      { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
    ] },
    { section: "Accounts", items: [
      { to: "/customers", label: "Customers", icon: Users, perm: "view_customer_list" },
      { to: "/journeys", label: "Journeys", icon: RouteIcon, perm: "view_customer_list" },
      { to: "/cohorts", label: "Cohorts & Handoffs", icon: Layers },
    ] },
    { section: "Strategy Workspace", items: [
      { to: "/workspace", label: "Strategy Workspace", icon: Columns3 },
      { to: "/journey", label: "Collections Journey", icon: Workflow, perm: "view_customer_list" },
      { to: "/builder", label: "Strategy Builder", icon: Wrench, perm: "create_strategy" },
      { to: "/strategies", label: "My Strategies", icon: BookOpen },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
    ] },
    { section: "Analysis", items: [
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
    ] },
    { section: "Execution", items: [
      { to: "/campaigns", label: "Live Campaigns", icon: FlaskConical, badge: (b) => b.live_campaigns },
      { to: "/review", label: "Review Queue", icon: ClipboardCheck, perm: "override_decisions", badge: (b) => b.pending_review },
      { to: "/agencies", label: "Collection Agencies", icon: Briefcase },
      { to: "/nudges", label: "Nudges", icon: Send, perm: "view_ai_decisions" },
      { to: "/activity", label: "Activity", icon: Activity, perm: "view_ai_decisions" },
    ] },
  ],
  leader: [
    { section: "Overview", items: [
      { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
      { to: "/portfolio", label: "Portfolio Health", icon: HeartPulse },
    ] },
    { section: "Accounts", items: [
      { to: "/customers", label: "Customers", icon: Users, perm: "view_customer_list" },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
    ] },
    { section: "Strategy Workspace", items: [
      { to: "/workspace", label: "Strategy Workspace", icon: Columns3 },
      { to: "/journey", label: "Collections Journey", icon: Workflow, perm: "view_customer_list" },
      { to: "/approvals", label: "Approvals", icon: ListChecks, perm: "approve_strategy", badge: (b) => b.awaiting_approval },
      { to: "/compare", label: "Strategy Compare", icon: GitCompare, perm: "compare_strategies" },
      { to: "/treatments", label: "Treatment Playbook", icon: Library },
      { to: "/workbench", label: "Strategy Workbench", icon: Lightbulb, perm: "use_ai_workbench" },
    ] },
    { section: "Analysis", items: [
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
      { to: "/team", label: "Team Performance", icon: Users },
      { to: "/reports", label: "Reports", icon: FileText, perm: "export_reports" },
    ] },
    { section: "Execution", items: [
      { to: "/agencies", label: "Collection Agencies", icon: Briefcase, badge: (b) => b.pending_placements },
      { to: "/compliance", label: "Compliance", icon: ShieldCheck, perm: "view_compliance", badge: (b) => b.open_violations },
      { to: "/governance", label: "Security & Governance", icon: Landmark, perm: "view_compliance" },
    ] },
  ],
  admin: [
    { section: "Overview", items: [
      { to: "/admin", label: "Admin Dashboard", icon: LayoutDashboard },
      { to: "/admin/users", label: "User Management", icon: UserCog, perm: "manage_users" },
      { to: "/admin/roles", label: "Roles & Permissions", icon: Lock, perm: "manage_roles" },
    ] },
    { section: "Configuration", items: [
      { to: "/admin/config", label: "Platform Config", icon: SlidersHorizontal, perm: "configure_platform" },
      { to: "/admin/integrations", label: "API & Integrations", icon: Plug, perm: "manage_integrations" },
      { to: "/admin/audit", label: "Audit Log", icon: ScrollText, perm: "view_audit_log" },
      { to: "/governance", label: "Security & Governance", icon: Landmark, perm: "manage_roles" },
    ] },
    { section: "Monitor", items: [
      { to: "/admin/health", label: "System Health", icon: Gauge, perm: "view_system_health" },
      { to: "/admin/observability", label: "Observability", icon: Waypoints, perm: "view_system_health" },
      { to: "/admin/alerts", label: "Alert Rules", icon: Bell, perm: "manage_alert_rules" },
    ] },
  ],
  viewer: [
    { section: "Overview", items: [
      { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
      { to: "/portfolio", label: "Portfolio Health", icon: HeartPulse },
    ] },
    { section: "Strategy Workspace", items: [
      { to: "/workspace", label: "Strategy Workspace", icon: Columns3 },
      { to: "/journey", label: "Collections Journey", icon: Workflow, perm: "view_customer_list" },
    ] },
    { section: "Analysis", items: [
      { to: "/analytics", label: "Strategy Analytics", icon: ChartColumnBig },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
    ] },
    { section: "Execution", items: [
      { to: "/agencies", label: "Collection Agencies", icon: Briefcase },
    ] },
  ],
};

export const HOME: Record<Role, string> = { strategist: "/overview", leader: "/overview", admin: "/admin", viewer: "/overview" };
export const WORKSPACE: Record<Role, string> = { strategist: "Strategy analyst workspace", leader: "Leadership workspace", admin: "Platform administration", viewer: "Read-only workspace" };

