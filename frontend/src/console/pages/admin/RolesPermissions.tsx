import clsx from "clsx";
import { Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { useApi, useSession } from "../../lib/session";
import { Banner, Button, Card, Chip, ErrorState, Page, PageHeader, Spinner, Tabs, Toggle, useAction } from "../../ui/ui";

interface Data {
  roles: { role: string; label: string; users: number; granted: number }[];
  permissions: { key: string; label: string; description: string; category: string }[];
  matrix: Record<string, Record<string, boolean>>;
  locked: [string, string][];
}

export default function RolesPermissions() {
  const { me, refresh } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/admin/roles");
  const [matrix, setMatrix] = useState<Data["matrix"]>({});
  const [role, setRole] = useState("strategist");
  const { run, busy } = useAction();
  useEffect(() => { if (data) setMatrix(JSON.parse(JSON.stringify(data.matrix))); }, [data]);
  const dirty = useMemo(() => data ? JSON.stringify(matrix) !== JSON.stringify(data.matrix) : false, [matrix, data]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data || !matrix[role]) return <Spinner />;
  const locked = new Set(data.locked.map(([r, p]) => `${r}:${p}`));
  const cats = Array.from(new Set(data.permissions.map((p) => p.category)));
  const rolesFor = (key: string) => data.roles.filter((r) => matrix[r.role]?.[key]).map((r) => r.label);
  const granted = data.permissions.filter((p) => matrix[role][p.key]);
  const denied = data.permissions.filter((p) => !matrix[role][p.key]);
  const grantedCats = new Set(granted.map((p) => p.category)).size;

  const Row = ({ p }: { p: Data["permissions"][number] }) => {
    const on = matrix[role][p.key];
    const isLocked = locked.has(`${role}:${p.key}`);
    return (
      <div className={clsx("flex items-center gap-4 border-b border-line px-4 py-3 last:border-0", !on && "opacity-70")}>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">{p.label}{isLocked && <Lock className="h-3 w-3 text-fg-3" />}</p>
          <p className="text-xs text-fg-3">{p.description}</p>
          <div className="mt-1 flex flex-wrap gap-1">{rolesFor(p.key).map((l) => <Chip key={l} tone="neutral">{l}</Chip>)}</div>
        </div>
        <span className={clsx("text-xs font-medium", on ? "text-good" : "text-fg-3")}>{on ? "✓ Granted" : "✕ Denied"}</span>
        <Toggle checked={on} disabled={isLocked && on} label={p.label}
          onChange={(v) => setMatrix((m) => ({ ...m, [role]: { ...m[role], [p.key]: v } }))} />
      </div>
    );
  };

  return (
    <>
      <PageHeader title="Roles & Permissions" subtitle="Configure access control policies. Enforced by the API on every request." role={me?.user.role_label}
        actions={<>
          {dirty && <Button variant="ghost" onClick={() => setMatrix(JSON.parse(JSON.stringify(data.matrix)))}>Discard</Button>}
          <Button variant="primary" disabled={!dirty} loading={busy === "save"}
            onClick={() => run("save", () => api.put<{ changed: string[] }>("/admin/roles", { matrix }), (r) => `Saved ${r.changed.length} permission change${r.changed.length === 1 ? "" : "s"}.`)
              .then((r) => { if (r) { reload(); refresh(); } })}>Save Changes</Button>
        </>} />
      <Page>
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-3">
            <Card flush>
              <p className="label px-3 pt-3">Roles</p>
              <ul className="p-2">
                {data.roles.map((r) => (
                  <li key={r.role}>
                    <button onClick={() => setRole(r.role)} className={clsx("flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px]",
                      role === r.role ? "bg-primary-50 font-medium text-primary-600" : "text-fg-2 hover:bg-surface-hover")}>
                      <span className="flex items-center gap-2"><span className={clsx("h-1.5 w-1.5 rounded-full", role === r.role ? "bg-primary-500" : "bg-fg-3")} />{r.label}</span>
                      <span className="num text-2xs text-fg-3">{r.users} users</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <div className="rounded-lg border border-line bg-surface-sunken p-3">
              <p className="label">Active role preview</p>
              <p className="mt-1 text-[13px] font-semibold">{data.roles.find((r) => r.role === role)?.label}</p>
              <p className="mt-0.5 text-xs text-fg-2">{granted.length} permissions granted across {grantedCats} categories</p>
            </div>
            {dirty && <Banner tone="warn">Unsaved changes. Users pick them up on their next request.</Banner>}
          </div>
          <div className="space-y-4">
            <Card flush>
              <Tabs<string> className="px-2" active={role} onChange={setRole} tabs={data.roles.map((r) => ({ id: r.role, label: r.label }))} />
            </Card>
            {cats.map((c) => {
              const ps = granted.filter((p) => p.category === c);
              return ps.length ? <Card key={c} title={c} flush>{ps.map((p) => <Row key={p.key} p={p} />)}</Card> : null;
            })}
            {denied.length > 0 && <Card title="Denied permissions" subtitle="Switch on to grant" flush>{denied.map((p) => <Row key={p.key} p={p} />)}</Card>}
          </div>
        </div>
      </Page>
    </>
  );
}
