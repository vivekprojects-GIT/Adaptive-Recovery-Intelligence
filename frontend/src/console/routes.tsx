/** Every console page, the permission it needs, and the guard that enforces it in the UI. */
import { Lock } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { useSession } from "./lib/session";
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
import Scorecards from "./pages/leader/Scorecards";
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
import LiveCampaigns from "./pages/strategist/LiveCampaigns";
import MyDashboard from "./pages/strategist/MyDashboard";
import MyStrategies from "./pages/strategist/MyStrategies";
import ReviewQueue from "./pages/strategist/ReviewQueue";
import StrategyBuilder from "./pages/strategist/StrategyBuilder";
import { HOME } from "./shell/nav";

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

export const ROUTES: { path: string; el: ReactNode; perm?: string }[] = [
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
  { path: "/scorecards", el: <Scorecards />, perm: "view_kpi_dashboard" },
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
