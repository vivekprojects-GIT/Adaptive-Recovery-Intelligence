import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Banner, Button, Card, ErrorState, Page, PageHeader, Spinner, Toggle, inputCls, useAction } from "../../ui/ui";

interface Item { key: string; value: string; default: string; label: string; group: string; kind: string; help: string; updated_by: string | null; updated_at: string | null }

export default function PlatformConfig() {
  const { me, refresh } = useSession();
  const { data, error, loading, reload } = useApi<Item[]>("/admin/config");
  const [vals, setVals] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  useEffect(() => { if (data) setVals(Object.fromEntries(data.map((i) => [i.key, i.value]))); }, [data]);
  const changed = useMemo(() => (data ?? []).filter((i) => vals[i.key] !== undefined && vals[i.key] !== i.value), [data, vals]);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const groups = Array.from(new Set(data.map((i) => i.group)));
  // Values arrive one render after the data; fall back to the saved value so
  // nothing renders as NaN or flashes as modified.
  const val = (i: Item) => vals[i.key] ?? i.value;
  const input = (i: Item) => {
    if (i.kind === "bool") return <Toggle checked={val(i) === "true"} onChange={(v) => setVals({ ...vals, [i.key]: String(v) })} label={i.label} />;
    if (i.kind === "percent") return (
      <div className="flex items-center gap-2"><input type="number" step="1" min="0" max="100" className={`${inputCls} w-24`}
        value={Math.round(Number(val(i)) * 100)} onChange={(e) => setVals({ ...vals, [i.key]: String(Number(e.target.value) / 100) })} /><span className="text-xs text-fg-3">%</span></div>
    );
    return <input type={i.kind === "text" ? "text" : "number"} className={`${inputCls} ${i.kind === "text" ? "w-56" : "w-24"}`}
      value={val(i)} onChange={(e) => setVals({ ...vals, [i.key]: e.target.value })} />;
  };
  return (
    <>
      <PageHeader title="Platform Config" subtitle="Platform-wide decisioning and contact settings" role={me?.user.role_label}
        actions={<>
          {changed.length > 0 && <Button variant="ghost" onClick={() => setVals(Object.fromEntries(data.map((i) => [i.key, i.value])))}>Discard</Button>}
          <Button variant="primary" disabled={!changed.length} loading={busy === "s"}
            onClick={() => run("s", () => api.put<{ changed: string[] }>("/admin/config", { values: Object.fromEntries(changed.map((i) => [i.key, vals[i.key]])) }),
              (r) => `Saved ${r.changed.length} setting${r.changed.length === 1 ? "" : "s"}.`).then((r) => { if (r) { reload(); refresh(); } })}>
            Save {changed.length ? `(${changed.length})` : ""}</Button>
        </>} />
      <Page>
        <Banner tone="info">Changes apply to new decisions. Running strategies keep their fixed control share; contact rules apply to every message immediately. Every change is audited.</Banner>
        {groups.map((g) => (
          <Card key={g} title={g} flush>
            {data.filter((i) => i.group === g).map((i) => (
              <div key={i.key} className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold">{i.label}{val(i) !== i.value && <span className="ml-2 text-2xs font-medium text-warn">modified</span>}</p>
                  {i.help && <p className="mt-0.5 text-xs leading-5 text-fg-3">{i.help}</p>}
                  <p className="mt-0.5 text-2xs text-fg-3">Default {i.default}{i.updated_by ? ` · last changed by ${i.updated_by} ${ago(i.updated_at)}` : ""}</p>
                </div>
                {input(i)}
              </div>
            ))}
          </Card>
        ))}
      </Page>
    </>
  );
}
