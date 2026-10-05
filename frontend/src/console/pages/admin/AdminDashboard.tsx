import { Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { ago, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Avatar, Button, Card, Chip, ErrorState, Kpi, Page, PageHeader, Progress, Spinner, StatusChip, Table, Td, Th, Tr } from "../../ui/ui";

export interface Health {
  metrics: { uptime_seconds: number; requests_total: number; requests_last_hour: number; error_rate: number; latency_avg_ms: number;
    latency_p50_ms: number; latency_p95_ms: number; latency_p99_ms: number; availability: number; started_at: string };
  components: { name: string; status: string; detail: string }[];
  model_version: string; decisions_24h: number; decision_latency_ms: number; started_at: string;
}
interface Data {
  kpis: { users: number; active_users: number; live_strategies: number; strategists: number; roles: number; permissions: number; availability: number };
  users: { user_id: string; name: string; email: string; role: string; role_label: string; status: string; strategies: number; last_login: string | null }[];
  role_distribution: { role: string; label: string; count: number }[];
  health: Health;
  audit: { at: string; actor: string; action: string; summary: string }[];
}

export const fmtUptime = (s: number) => s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;

export default function AdminDashboard() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/admin/overview");
  const navigate = useNavigate();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const k = data.kpis;
  const h = data.health;
  return (
    <>
      <PageHeader title="Admin Dashboard" subtitle={`Platform management · ${me?.user.name}`} role={me?.user.role_label}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/admin/users?invite=1")}>Add User</Button>} />
      <Page>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Total users" value={k.users} sub={`${k.active_users} active`} />
          <Kpi label="Live strategies" value={k.live_strategies} sub={`across ${k.strategists} strategists`} tone="primary" />
          <Kpi label="Permission model" value={`${k.permissions}`} sub={`permissions across ${k.roles} roles`} />
          <Kpi label="API availability" value={pct(k.availability, 2)} tone={k.availability < 0.999 ? "warn" : "good"} sub={`since start · ${fmtUptime(h.metrics.uptime_seconds)}`} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card title="Users" flush actions={<Link to="/admin/users" className="text-xs font-medium text-primary-500 hover:underline">Manage all</Link>}>
            <Table>
              <thead><tr><Th>User</Th><Th>Role</Th><Th>Status</Th><Th align="right">Strategies</Th><Th>Last login</Th></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <Tr key={u.user_id} onClick={() => navigate(`/admin/users?u=${u.user_id}`)}>
                    <Td><span className="flex items-center gap-2"><Avatar name={u.name} size="sm" /><span><span className="block font-medium">{u.name}</span><span className="block text-2xs text-fg-3">{u.email}</span></span></span></Td>
                    <Td><Chip tone="primary">{u.role_label}</Chip></Td><Td><StatusChip status={u.status} /></Td><Td align="right">{u.strategies}</Td>
                    <Td className="text-xs text-fg-3">{u.last_login ? ago(u.last_login) : "never"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <div className="space-y-4">
            <Card title="Role distribution">
              <ul className="space-y-3">
                {data.role_distribution.map((r) => (
                  <li key={r.role}>
                    <div className="flex justify-between text-xs"><span>{r.label}</span><span className="num font-medium">{r.count}</span></div>
                    <Progress value={(r.count / Math.max(1, k.users)) * 100} className="mt-1" />
                  </li>
                ))}
              </ul>
              <Button variant="secondary" size="sm" onClick={() => navigate("/admin/roles")}>Manage roles & permissions</Button>
            </Card>
            <Card title="Recent audit" actions={<Link to="/admin/audit" className="text-xs font-medium text-primary-500 hover:underline">View all</Link>}>
              <ul className="space-y-2.5">
                {data.audit.map((a, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <Chip tone={a.action === "CREATE" ? "good" : a.action === "DELETE" ? "bad" : a.action === "APPROVE" ? "info" : "neutral"}>{a.action}</Chip>
                    <span className="min-w-0 flex-1"><span className="block truncate">{a.summary}</span><span className="text-2xs text-fg-3">{a.actor} · {ago(a.at)}</span></span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
        <Card title="System health" actions={<Link to="/admin/health" className="text-xs font-medium text-primary-500 hover:underline">Full status</Link>}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg bg-surface-sunken p-3"><p className="label">API availability</p><p className="num mt-1 text-lg font-semibold">{pct(h.metrics.availability, 2)}</p><p className="text-2xs text-fg-3">{num(h.metrics.requests_total)} requests since start</p></div>
            <div className="rounded-lg bg-surface-sunken p-3"><p className="label">API response</p><p className="num mt-1 text-lg font-semibold">{h.metrics.latency_avg_ms} ms</p><p className="text-2xs text-fg-3">p95 {h.metrics.latency_p95_ms} ms (measured)</p></div>
            <div className="rounded-lg bg-surface-sunken p-3"><p className="label">Decision model</p><p className="mt-1 text-lg font-semibold">{h.model_version}</p><p className="text-2xs text-fg-3">{h.decision_latency_ms} ms per decision</p></div>
            <div className="rounded-lg bg-surface-sunken p-3"><p className="label">Decisions, 24h</p><p className="num mt-1 text-lg font-semibold">{num(h.decisions_24h)}</p><p className="text-2xs text-fg-3">{h.components.filter((c) => c.status === "Operational").length}/{h.components.length} components operational</p></div>
          </div>
        </Card>
      </Page>
    </>
  );
}
