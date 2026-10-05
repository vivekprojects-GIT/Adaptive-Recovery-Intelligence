import clsx from "clsx";
import { CheckCircle2, Plus, Search, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type Role } from "../../lib/api";
import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Avatar, Banner, Button, Card, Drawer, ErrorState, Field, Kpi, Page, PageHeader, Select, Spinner, StatusChip, inputCls, useAction } from "../../ui/ui";

interface U { user_id: string; name: string; email: string; role: Role; role_label: string; status: string; last_login: string | null; created_at: string; strategies: number }
interface Data { users: U[]; role_permissions: Record<string, string[]>; permissions: { key: string; label: string; description: string; category: string }[] }
const ROLE_LABEL: Record<Role, string> = { strategist: "Strategist", leader: "Strategy Leader", admin: "Platform Admin", viewer: "Viewer" };

export default function UserManagement() {
  const { me, refresh } = useSession();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useApi<Data>("/admin/users");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role>("strategist");
  const [invite, setInvite] = useState(params.get("invite") === "1");
  const [form, setForm] = useState({ name: "", email: "", role: "strategist" });
  const { run, busy } = useAction();
  const selId = params.get("u") ?? data?.users[0]?.user_id;
  const sel = data?.users.find((u) => u.user_id === selId);
  useEffect(() => { if (sel) setRole(sel.role); }, [sel]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data || !sel) return <Spinner />;
  const users = data.users.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  const granted = new Set(data.role_permissions[role]);
  const patch = (body: Record<string, string>, ok: string) => run("p", () => api.patch(`/admin/users/${sel.user_id}`, body), ok).then((r) => { if (r) { reload(); refresh(); } });

  return (
    <>
      <PageHeader title="User Management" subtitle="Manage access, roles and status" role={me?.user.role_label}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setInvite(true)}>Invite User</Button>} />
      <Page>
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card flush>
            <div className="border-b border-line p-3"><div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" className={`${inputCls} pl-8`} /></div></div>
            <ul>
              {users.map((u) => (
                <li key={u.user_id}>
                  <button onClick={() => setParams({ u: u.user_id })} className={clsx("flex w-full items-center gap-2.5 border-l-2 px-3 py-2.5 text-left",
                    u.user_id === sel.user_id ? "border-primary-500 bg-primary-50/60" : "border-transparent hover:bg-surface-hover")}>
                    <Avatar name={u.name} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{u.name}</span>
                      <span className="flex items-center gap-1.5 text-2xs text-fg-3">{u.role_label} · <StatusChip status={u.status} /></span></span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-4">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3"><Avatar name={sel.name} /><div><p className="text-[16px] font-semibold">{sel.name}</p><p className="text-xs text-fg-3">{sel.email}</p></div></div>
                <StatusChip status={sel.status} />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Kpi label="Strategies owned" value={sel.strategies} />
                <Kpi label="Last login" value={sel.last_login ? ago(sel.last_login) : "never"} />
                <Kpi label="Status" value={sel.status} tone={sel.status === "Active" ? "good" : "warn"} />
              </div>
            </Card>

            <Card title="Role assignment" footer={<div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRole(sel.role)}>Cancel</Button>
              <Button variant="primary" disabled={role === sel.role} loading={busy === "p"} onClick={() => patch({ role }, `${sel.name} is now ${ROLE_LABEL[role]}.`)}>Save Changes</Button>
            </div>}>
              {sel.user_id === me?.user.user_id && <div className="mb-3"><Banner tone="info">You cannot change your own role.</Banner></div>}
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <label key={r} className={clsx("flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5",
                    role === r ? "border-primary-500 bg-primary-50/60" : "border-line hover:bg-surface-hover")}>
                    <input type="radio" name="role" checked={role === r} disabled={sel.user_id === me?.user.user_id} onChange={() => setRole(r)} className="h-4 w-4 text-primary-500" />
                    <span className="text-[13px] font-medium">{ROLE_LABEL[r]}</span>
                    <span className="ml-auto text-2xs text-fg-3">{data.role_permissions[r].length} permissions</span>
                  </label>
                ))}
              </div>
            </Card>

            <Card title={`Permissions for ${ROLE_LABEL[role]}`} subtitle="Defined in Roles & Permissions; shown here as a preview">
              <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
                {data.permissions.map((p) => (
                  <div key={p.key} className="flex items-center justify-between gap-2 border-b border-line py-1.5 text-xs">
                    <span className={granted.has(p.key) ? "text-fg" : "text-fg-3"}>{p.label}</span>
                    {granted.has(p.key) ? <span className="flex items-center gap-1 text-good"><CheckCircle2 className="h-3.5 w-3.5" />Granted</span>
                      : <span className="flex items-center gap-1 text-fg-3"><XCircle className="h-3.5 w-3.5" />Denied</span>}
                  </div>
                ))}
              </div>
            </Card>

            {sel.user_id !== me?.user.user_id && (
              <Card title="Account status">
                <div className="flex flex-wrap gap-2">
                  {sel.status !== "Active" && <Button variant="primary" loading={busy === "p"} onClick={() => patch({ status: "Active" }, `${sel.name} activated.`)}>Activate</Button>}
                  {sel.status === "Active" && <Button variant="danger" loading={busy === "p"} onClick={() => patch({ status: "Inactive" }, `${sel.name} deactivated. They can no longer sign in.`)}>Deactivate</Button>}
                </div>
              </Card>
            )}
          </div>
        </div>
      </Page>
      <Drawer open={invite} onClose={() => setInvite(false)} title="Invite a user" subtitle="They join as Pending until activated" width="max-w-md"
        footer={<><Button variant="ghost" onClick={() => setInvite(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.name || !form.email} loading={busy === "inv"}
            onClick={() => run("inv", () => api.post<{ user_id: string }>("/admin/users", form), `Invited ${form.name}.`)
              .then((r) => { if (r) { setInvite(false); setForm({ name: "", email: "", role: "strategist" }); reload(); setParams({ u: r.user_id }); } })}>Send invite</Button></>}>
        <div className="space-y-3">
          <Field label="Full name" required><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Work email" required><input type="email" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role"><Select value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} /></Field>
        </div>
      </Drawer>
    </>
  );
}
