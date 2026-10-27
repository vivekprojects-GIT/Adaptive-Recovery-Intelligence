/** Callbacks to Nova: when a person approves, rejects, cancels or overrides a decision Nova asked for,
 *  CARE posts a signed event to Nova's URL. The same events can be read with get_decision_updates. */
import { Copy, Eye, EyeOff, RefreshCw, RotateCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../lib/api";
import { ago, num } from "../../lib/format";
import { useApi } from "../../lib/session";
import { Button, Card, Chip, Empty, ErrorState, Spinner, Table, Td, Th, Tr, useAction, useToast } from "../../ui/ui";

interface Status {
  url: string | null; secret_source: string; events: number; by_status: Record<string, number>; max_attempts: number;
  recent: { event_id: number; event: string; decision_id: string; account_id: string | null; status: string; attempts: number;
    created_at: string; delivered_at: string | null; last_error: string | null }[];
}

const STATUS_LABEL: Record<string, string> = {
  delivered: "Delivered", pending: "Sending", failed: "Failed", not_configured: "Waiting for a URL",
};

function EventStatus({ s }: { s: string }) {
  if (s === "failed") return <Chip tone="bad">Failed</Chip>;
  if (s === "not_configured") return <Chip tone="warn">Waiting for a URL</Chip>;
  return <span className="text-xs text-fg-2">{STATUS_LABEL[s] ?? s}</span>;
}

export function NovaCallbacks() {
  const { data, error, loading, reload } = useApi<Status>("/admin/callbacks");
  const { run, busy } = useAction();
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading callbacks" />;
  const failed = (data.by_status.failed ?? 0) + (data.by_status.not_configured ?? 0);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("good", "Copied.");
    } catch {
      toast("bad", "Copy is blocked here; select the text instead.");
    }
  };

  return (
    <Card title="Nova callbacks"
      subtitle="When a person approves, rejects, cancels or overrides a decision Nova asked for, CARE posts a signed event so Nova can carry out or stop the treatment. Nova can also read the same events with the MCP tool get_decision_updates."
      actions={<Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === "retry"} disabled={!failed || !data.url}
        onClick={() => run("retry", () => api.post<{ delivered: number; failed: number }>("/admin/callbacks/retry"),
          (r) => `${r.delivered} delivered, ${r.failed} failed.`).then(() => reload())}>Retry undelivered</Button>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <dl className="space-y-2.5 text-[13px]">
          <div>
            <dt className="text-xs text-fg-3">Callback URL</dt>
            <dd className="mt-0.5 break-all">{data.url
              ? <span className="font-mono text-xs">{data.url}</span>
              : <span className="text-fg-2">Not set. Set <Link to="/admin/config" className="text-primary-500 hover:underline">Nova callback URL</Link> in Platform Config.</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-3">Signing secret <span className="text-fg-3">({data.secret_source})</span></dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{secret ?? "whsec_••••••••••••••••"}</span>
              {secret
                ? <>
                    <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(secret)}>Copy</Button>
                    <Button size="sm" variant="ghost" icon={<EyeOff className="h-3.5 w-3.5" />} onClick={() => setSecret(null)}>Hide</Button>
                  </>
                : <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} loading={busy === "reveal"}
                    onClick={() => run("reveal", () => api.post<{ secret: string }>("/admin/callbacks/secret")).then((r) => r && setSecret(r.secret))}>Reveal</Button>}
              <Button size="sm" variant="ghost" icon={<RotateCw className="h-3.5 w-3.5" />} loading={busy === "rotate"}
                onClick={() => run("rotate", () => api.post<{ secret: string }>("/admin/callbacks/secret/rotate"),
                  "Secret rotated. Give Nova the new one.").then((r) => r && setSecret(r.secret))}>Rotate</Button>
            </dd>
            <p className="mt-1 text-2xs leading-4 text-fg-3">Each POST carries X-ARI-Signature: sha256=HMAC of the raw body with this secret, plus X-ARI-Event and X-ARI-Event-Id.</p>
          </div>
        </dl>
        <div className="grid grid-cols-2 gap-3 self-start sm:grid-cols-4">
          {(["delivered", "pending", "failed", "not_configured"] as const).map((k) => (
            <div key={k} className="rounded-md bg-surface-sunken p-3">
              <p className="text-2xs text-fg-3">{STATUS_LABEL[k]}</p>
              <p className="num text-lg font-semibold">{num(data.by_status[k] ?? 0)}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="-mx-4 -mb-4 mt-4 border-t border-line">
        <Table>
          <thead><tr><Th>Event</Th><Th>Decision</Th><Th>Nova account</Th><Th>Status</Th><Th align="right">Attempts</Th><Th>When</Th></tr></thead>
          <tbody>
            {data.recent.map((e) => (
              <Tr key={e.event_id}>
                <Td><span className="font-mono text-xs">{e.event}</span><span className="block text-2xs text-fg-3">#{e.event_id}</span></Td>
                <Td><Link to={`/decisions/${e.decision_id}`} className="font-mono text-xs text-primary-500 hover:underline">{e.decision_id}</Link></Td>
                <Td mono>{e.account_id ?? "—"}</Td>
                <Td><EventStatus s={e.status} />{e.last_error && <span className="mt-0.5 block max-w-[280px] truncate text-2xs text-fg-3" title={e.last_error}>{e.last_error}</span>}</Td>
                <Td align="right">{e.attempts} / {data.max_attempts}</Td>
                <Td className="text-xs text-fg-2">{e.delivered_at ? `Delivered ${ago(e.delivered_at)}` : `Raised ${ago(e.created_at)}`}</Td>
              </Tr>
            ))}
            {!data.recent.length && <Empty cols={6}>No reviewer has changed a decision Nova asked for yet.</Empty>}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
