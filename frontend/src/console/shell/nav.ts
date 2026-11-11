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
  CirclePlay,
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
      { to: "/cohorts", label: "Cohorts and handoffs", icon: Layers },
    ] },
    { section: "Strategy workspace", items: [
      { to: "/workspace", label: "Strategy workspace", icon: Columns3 },
      { to: "/journey", label: "Collections journey", icon: Workflow, perm: "view_customer_list" },
      { to: "/builder", label: "Strategy builder", icon: Wrench, perm: "create_strategy" },
      { to: "/strategies", label: "My strategies", icon: BookOpen },
      { to: "/treatments", label: "Treatment playbook", icon: Library },
    ] },
    { section: "Analysis", items: [
      { to: "/analytics", label: "Strategy analytics", icon: ChartColumnBig },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
    ] },
    { section: "Execution", items: [
      { to: "/campaigns", label: "Live campaigns", icon: FlaskConical, badge: (b) => b.live_campaigns },
      { to: "/live-run", label: "Live run", icon: CirclePlay, perm: "view_ai_decisions" },
      { to: "/review", label: "Review queue", icon: ClipboardCheck, perm: "override_decisions", badge: (b) => b.pending_review },
      { to: "/agencies", label: "Collection agencies", icon: Briefcase },
      { to: "/nudges", label: "Nudges", icon: Send, perm: "view_ai_decisions" },
      { to: "/activity", label: "Activity", icon: Activity, perm: "view_ai_decisions" },
    ] },
  ],
  leader: [
    { section: "Overview", items: [
      { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
      { to: "/portfolio", label: "Portfolio health", icon: HeartPulse },
    ] },
    { section: "Accounts", items: [
      { to: "/customers", label: "Customers", icon: Users, perm: "view_customer_list" },
      { to: "/decisions", label: "Decisions", icon: MessageSquare, perm: "view_ai_decisions" },
    ] },
    { section: "Strategy workspace", items: [
      { to: "/workspace", label: "Strategy workspace", icon: Columns3 },
      { to: "/journey", label: "Collections journey", icon: Workflow, perm: "view_customer_list" },
      { to: "/approvals", label: "Approvals", icon: ListChecks, perm: "approve_strategy", badge: (b) => b.awaiting_approval },
      { to: "/compare", label: "Strategy compare", icon: GitCompare, perm: "compare_strategies" },
      { to: "/treatments", label: "Treatment playbook", icon: Library },
      { to: "/workbench", label: "Strategy workbench", icon: Lightbulb, perm: "use_ai_workbench" },
    ] },
    { section: "Analysis", items: [
      { to: "/analytics", label: "Strategy analytics", icon: ChartColumnBig },
      { to: "/scorecards", label: "Scorecards", icon: Scale },
      { to: "/team", label: "Team performance", icon: Users },
      { to: "/reports", label: "Reports", icon: FileText, perm: "export_reports" },
    ] },
    { section: "Execution", items: [
      { to: "/agencies", label: "Collection agencies", icon: Briefcase, badge: (b) => b.pending_placements },
      { to: "/compliance", label: "Compliance", icon: ShieldCheck, perm: "view_compliance", badge: (b) => b.open_violations },
      { to: "/governance", label: "Security and governance", icon: Landmark, perm: "view_compliance" },
    ] },
  ],
  admin: [
    { section: "Overview", items: [
      { to: "/admin", label: "Admin dashboard", icon: LayoutDashboard },
      { to: "/admin/users", label: "User management", icon: UserCog, perm: "manage_users" },
      { to: "/admin/roles", label: "Roles and permissions", icon: Lock, perm: "manage_roles" },
    ] },
    { section: "Configuration", items: [
      { to: "/admin/config", label: "Platform configuration", icon: SlidersHorizontal, perm: "configure_platform" },
      { to: "/admin/integrations", label: "API and integrations", icon: Plug, perm: "manage_integrations" },
      { to: "/admin/audit", label: "Audit log", icon: ScrollText, perm: "view_audit_log" },
      { to: "/governance", label: "Security and governance", icon: Landmark, perm: "manage_roles" },
    ] },
    { section: "Monitor", items: [
      { to: "/admin/health", label: "System health", icon: Gauge, perm: "view_system_health" },
      { to: "/admin/observability", label: "Observability", icon: Waypoints, perm: "view_system_health" },
      { to: "/admin/alerts", label: "Alert rules", icon: Bell, perm: "manage_alert_rules" },
    ] },
  ],
};

export const HOME: Record<Role, string> = { strategist: "/overview", leader: "/overview", admin: "/admin" };
export const WORKSPACE: Record<Role, string> = { strategist: "Strategy analyst workspace", leader: "Executive workspace", admin: "Platform administration" };

