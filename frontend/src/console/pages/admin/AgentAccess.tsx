import { Copy, Eye, EyeOff, Plug, RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type AgentDecision, type McpStatus, type OutcomeReport } from "../../lib/api";
import { ago, dateTime, num, pct } from "../../lib/format";
import { useApi } from "../../lib/session";
import {
  Banner, Button, Card, Chip, Empty, Modal, Pills, Table, Td, Th, Tr, inputCls, useAction, useToast, type Tone,
} from "../../ui/ui";

const ACTION: Record<string, { label: string; tone: Tone }> = {
  contact: { label: "Contact", tone: "good" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  contact_blocked: { label: "Held by the contact guard", tone: "serious" },
  control_bau: { label: "Control: business as usual", tone: "neutral" },
  no_action: { label: "No action", tone: "neutral" },
  refer_to_specialist: { label: "Refer to a specialist", tone: "info" },
  would_contact: { label: "Would contact", tone: "primary" },
  would_need_approval: { label: "Would need approval", tone: "warn" },
  rejected: { label: "Declined by a reviewer", tone: "bad" },
};

const freshId = () => `NOVA-${Math.floor(10000 + Math.random() * 90000)}`;

/** Accounts shaped like the Nova data contract (C1-C6). Same cohort, different right answers. */
const SAMPLES: Record<string, { label: string; account: () => Record<string, unknown> }> = {
  helped: { label: "Can be helped · 31 DPD", account: () => ({
    account_id: freshId(), customer_name: "Priya Sharma", days_past_due: 31, current_balance: 4180, credit_limit: 5000,
    opened_date: "2020-03-01", prior_delinquencies_12m: 1, on_time_payment_ratio: 0.94, risk_segment: "Medium",
    risk_score: 62, app_user: true, sms_responsive: true, hardship_flag: true,
    consent: { sms: true, email: true, call: false }, contacts_last_7d: 1, source_system: "CRM_PROD" }) },
  selfcure: { label: "Will pay anyway · 30 DPD", account: () => ({
    account_id: freshId(), customer_name: "John Mitchell", days_past_due: 30, current_balance: 7920, credit_limit: 9000,
    opened_date: "2018-01-15", prior_delinquencies_12m: 1, on_time_payment_ratio: 0.85, risk_segment: "Medium",
    risk_score: 58, app_user: false, sms_responsive: false, hardship_flag: false, source_system: "CRM_PROD" }) },
  hardship: { label: "Severe hardship · 62 DPD", account: () => ({
    account_id: freshId(), customer_name: "Mike Torres", days_past_due: 62, current_balance: 7640, credit_limit: 8000,
    opened_date: "2023-02-01", prior_delinquencies_12m: 4, on_time_payment_ratio: 0.44, risk_segment: "High",
    risk_score: 77, app_user: false, sms_responsive: false, hardship_flag: true, source_system: "CRM_PROD" }) },
  minimal: { label: "Required fields only", account: () => ({
    account_id: freshId(), days_past_due: 45, current_balance: 5000 }) },
};

/** One MCP tools/call over Streamable HTTP, exactly as an external agent sends it. */
async function mcpCall<T>(path: string, token: string, name: string, args: unknown): Promise<{ data: T; raw: unknown }> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(body?.error?.message ?? `The MCP endpoint answered HTTP ${res.status}.`);
  if (body.error) throw new Error(body.error.message);
  const r = body.result;
  if (r.isError) throw new Error(r.content?.[0]?.text ?? "The tool reported an error.");
  return { data: (r.structuredContent ?? JSON.parse(r.content[0].text)) as T, raw: body };
}

function CodeBlock({ code, onCopy }: { code: string; onCopy: () => void }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-ink px-3.5 py-3 pr-12 font-mono text-[11.5px] leading-5 text-primary-50">{code}</pre>
      <button onClick={onCopy} aria-label="Copy" title="Copy"
        className="absolute right-2 top-2 rounded-md p-1.5 text-primary-200 hover:bg-white/10 hover:text-white"><Copy className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function ResultView({ r, report, busy, onReport }: {
  r: AgentDecision; report: OutcomeReport | null; busy: string | null; onReport: (paid: boolean) => void;
}) {
  const a = ACTION[r.action] ?? { label: r.action.replace(/_/g, " "), tone: "neutral" as Tone };
  const canReport = !!r.decision_id && ["contact", "contact_blocked", "control_bau"].includes(r.action) && !r.outcome;
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={a.tone}>{a.label}</Chip>
        {r.existing && <Chip tone="info">existing decision</Chip>}
        {r.decision_id && <Link to={`/decisions/${r.decision_id}`} className="font-mono text-xs text-primary-500 hover:underline">{r.decision_id}</Link>}
        <span className="ml-auto font-mono text-2xs text-fg-3">{r.customer.account_id}</span>
      </div>
      <p className="text-[13px] leading-5 text-fg">{r.summary}</p>
      {(r.strategy || r.customer.intervention_fit) && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {r.strategy && <><dt className="text-fg-3">Strategy</dt><dd className="font-medium">
            <Link to={`/strategies/${r.strategy.strategy_id}`} className="hover:text-primary-500">{r.strategy.strategy_id} {r.strategy.name}</Link></dd></>}
          {r.treatment && <><dt className="text-fg-3">Treatment</dt><dd className="font-medium">{r.treatment.name} · {r.treatment.channel}</dd></>}
          {r.customer.intervention_fit && <><dt className="text-fg-3">Intervention fit</dt><dd>{r.customer.intervention_fit} · {r.customer.cohort}</dd></>}
          {r.selection_probability !== undefined && r.selection_probability !== null && (
            <><dt className="text-fg-3">Chosen in this context</dt><dd className="num">{pct(r.selection_probability, 0)} of the time</dd></>
          )}
        </dl>
      )}
      {r.message && (
        <div className="max-w-md rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-5 ring-1 ring-line">{r.message}</div>
      )}
      {!!r.alternatives?.length && (
        <Table>
          <thead><tr><Th>Treatment considered</Th><Th align="right">Chosen</Th><Th align="right">Belief</Th><Th align="right">Fit</Th></tr></thead>
          <tbody>
            {r.alternatives.map((x) => (
              <Tr key={x.code}><Td className={x.code === r.treatment?.code ? "font-medium" : "text-fg-2"}>{x.name}</Td>
                <Td align="right">{pct(x.selection_probability, 0)}</Td><Td align="right">{pct(x.belief, 0)}</Td><Td align="right">×{x.customer_fit.toFixed(2)}</Td></Tr>
            ))}
          </tbody>
        </Table>
      )}
      {r.contact && (
        <p className="text-2xs leading-4 text-fg-3">
          {r.contact.channel}: {r.contact.status.toLowerCase()} for {dateTime(r.contact.send_at)}{r.contact.simulated ? " (simulated - shadow mode)" : ""}. Guard: {r.contact.guard}
        </p>
      )}
      {r.note && <p className="text-2xs leading-4 text-fg-3">{r.note}</p>}
      {!!r.assumed?.length && (
        <details className="text-2xs text-fg-3">
          <summary className="cursor-pointer font-medium text-fg-2">{r.assumed.length} value{r.assumed.length === 1 ? "" : "s"} assumed - Nova did not send them</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{r.assumed.map((x) => <li key={x}>{x}</li>)}</ul>
        </details>
      )}
      {!!r.strategies_checked?.length && (
        <details className="text-2xs text-fg-3">
          <summary className="cursor-pointer font-medium text-fg-2">Live strategies checked ({r.strategies_checked.length})</summary>
          <ul className="mt-1 space-y-0.5 pl-1">{r.strategies_checked.map((x) => (
            <li key={x.strategy_id}><span className="font-mono">{x.strategy_id}</span> {x.name}: <span className={x.matches ? "text-good" : ""}>{x.reason}</span></li>
          ))}</ul>
        </details>
      )}
      {r.action === "awaiting_approval" && (
        <p className="text-xs text-fg-2">A person approves the offer in the <Link to="/review" className="font-medium text-primary-500 hover:underline">Review Queue</Link>; then the outcome can be reported.</p>
      )}
      {canReport && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="text-xs text-fg-2">Report the outcome, as Nova would:</span>
          <Button size="sm" loading={busy === "paid-true"} onClick={() => onReport(true)}>Paid</Button>
          <Button size="sm" loading={busy === "paid-false"} onClick={() => onReport(false)}>Not paid</Button>
        </div>
      )}
      {report && (
        <Banner tone={report.learned ? "good" : "neutral"} title={report.learned ? "ARI learned from it" : "Outcome recorded"}>{report.note}</Banner>
      )}
    </div>
  );
}

/** API & Integrations: how an agent such as Nova's reaches ARI over MCP. */
export function AgentAccess() {
  const { data: s, error, reload } = useApi<McpStatus>("/admin/mcp");
  const { run, busy } = useAction();
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [snippet, setSnippet] = useState<"claude" | "python" | "curl">("claude");
  const [sample, setSample] = useState("helped");
  const [text, setText] = useState(() => JSON.stringify(SAMPLES.helped.account(), null, 2));
  const [result, setResult] = useState<AgentDecision | null>(null);
  const [report, setReport] = useState<OutcomeReport | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [showRaw, setShowRaw] = useState(false);
  if (error) return <Banner tone="bad" title="Agent access unavailable">{error}</Banner>;
  if (!s) return null;

  const endpoint = `${window.location.origin}/api${s.path}`;
  const copy = (value: string, what: string) => navigator.clipboard.writeText(value)
    .then(() => toast("good", `${what} copied.`)).catch(() => toast("bad", "Copy failed. Select the text and copy it by hand."));
  const reveal = async () => {
    const r = await run("reveal", () => api.post<{ token: string }>("/admin/mcp/token"));
    if (r) setToken(r.token);
    return r?.token ?? null;
  };
  const getToken = async () => token ?? (await reveal());
  const live = s.stats.calls_24h > 0;
  const tok = token && shown ? token : "<token>";

  const pick = (k: string) => {
    setSample(k); setText(JSON.stringify(SAMPLES[k].account(), null, 2)); setResult(null); setReport(null); setRaw(null);
  };
  const send = (tool: "get_recovery_strategy" | "preview_recovery_strategy") => run(tool, async () => {
    let account: unknown;
    try { account = JSON.parse(text); } catch { throw new Error("The account is not valid JSON."); }
    const t = await getToken();
    if (!t) throw new Error("Could not read the access token.");
    const r = await mcpCall<AgentDecision>(s.path, t, tool, { account });
    setResult(r.data); setRaw(r.raw); setReport(null);
    reload();
    return r.data;
  });
  const reportOutcome = (paid: boolean) => run(`paid-${paid}`, async () => {
    const t = await getToken();
    if (!t || !result?.decision_id) throw new Error("Nothing to report on.");
    const r = await mcpCall<OutcomeReport>(s.path, t, "report_payment_outcome", { decision_id: result.decision_id, paid });
    setReport(r.data); setRaw(r.raw);
    reload();
    return r.data;
  });

  const snippets = {
    claude: `claude mcp add --transport http ari-recovery ${endpoint} \\\n  --header "Authorization: Bearer ${tok}"`,
    python: `from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("${endpoint}",
        headers={"Authorization": "Bearer ${tok}"}) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        answer = await session.call_tool("get_recovery_strategy", {"account": {
            "account_id": "ACC001", "days_past_due": 45, "current_balance": 5000}})`,
    curl: `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${tok}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preview_recovery_strategy","arguments":{"account":{"account_id":"ACC001","days_past_due":45,"current_balance":5000}}}}'`,
  };

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Plug className="h-4 w-4 text-fg-3" />Agent access · MCP</span>}
        subtitle="How Nova's agent, or any MCP client, sends an account and gets the recovery strategy back - then reports the payment so ARI learns."
        actions={<Chip tone={live ? "good" : "neutral"}>{live ? `Active · last call ${ago(s.stats.last_call_at)}` : s.stats.last_call_at ? `Idle · last call ${ago(s.stats.last_call_at)}` : "Waiting for the first call"}</Chip>}>
        <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
          <dl className="space-y-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt className="w-28 shrink-0 text-fg-3">Endpoint</dt>
              <dd className="flex min-w-0 items-center gap-1.5"><code className="truncate rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">{endpoint}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(endpoint, "Endpoint")} /></dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><dt className="w-28 shrink-0 text-fg-3">Transport</dt><dd>{s.transport}</dd></div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><dt className="w-28 shrink-0 text-fg-3">Protocol</dt><dd className="num text-xs">MCP {s.protocol_versions.join(" · ")}</dd></div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt className="w-28 shrink-0 text-fg-3">Access token</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                <code className="max-w-[300px] truncate rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">{token && shown ? token : s.token_hint}</code>
                <Button size="sm" variant="ghost" loading={busy === "reveal"} icon={shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  onClick={async () => { if (shown) { setShown(false); return; } if (await getToken()) setShown(true); }}>{shown ? "Hide" : "Show"}</Button>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />}
                  onClick={async () => { const t = await getToken(); if (t) copy(t, "Token"); }}>Copy</Button>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={s.token_source === "environment"}
                  title={s.token_source === "environment" ? "Set by ARI_MCP_TOKEN on the server; change it there" : undefined}
                  onClick={() => setRotating(true)}>Rotate</Button>
              </dd>
            </div>
            <p className="pl-[124px] text-2xs leading-4 text-fg-3">
              {s.token_source === "environment" ? "Set by ARI_MCP_TOKEN in the server environment." : "Generated by ARI and kept in platform config. Revealing or rotating it is recorded in the audit log."} Every call is audited as the Nova agent.
            </p>
          </dl>
          <div className="grid grid-cols-2 gap-2.5 self-start sm:grid-cols-3">
            {[["Calls, last 24h", s.stats.calls_24h], ["Accounts from Nova", s.stats.accounts], ["Decisions", s.stats.decisions],
              ["Awaiting approval", s.stats.awaiting_approval], ["Outcomes reported", s.stats.outcomes_reported], ["Calls, all time", s.stats.calls_total]]
              .map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-2xs text-fg-3">{label}</p><p className="num text-lg font-semibold">{num(value as number)}</p>
                </div>
              ))}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        <Card title="Try it: send an account as Nova would"
          subtitle="A real MCP call to this server with the access token. Whatever it records appears in Decisions, the Review Queue and the strategy's learning.">
          <Pills value={sample} onChange={pick} options={Object.entries(SAMPLES).map(([id, x]) => ({ id, label: x.label }))} />
          <textarea rows={11} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
            className={`${inputCls} mt-3 h-auto py-2 font-mono text-xs leading-5`} aria-label="Account sent to ARI" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={busy === "get_recovery_strategy"}
              onClick={() => send("get_recovery_strategy")}>Get recovery strategy</Button>
            <Button loading={busy === "preview_recovery_strategy"} onClick={() => send("preview_recovery_strategy")}>Preview only</Button>
            {raw !== null && <button onClick={() => setShowRaw((x) => !x)} className="ml-auto text-xs font-medium text-primary-500 hover:underline">{showRaw ? "Hide" : "Show"} raw MCP response</button>}
          </div>
          {result && <ResultView r={result} report={report} busy={busy} onReport={reportOutcome} />}
          {showRaw && raw !== null && <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-surface-sunken p-3 font-mono text-[11px] leading-4">{JSON.stringify(raw, null, 2)}</pre>}
        </Card>

        <div className="space-y-4">
          <Card title={`Tools (${s.tools.length})`} subtitle="What an agent sees when it lists ARI's tools." flush>
            <ul className="divide-y divide-line">
              {s.tools.map((t) => (
                <li key={t.name} className="px-4 py-2.5">
                  <div className="flex items-center gap-2"><code className="font-mono text-xs font-medium text-fg">{t.name}</code>
                    {t.read_only ? <Chip tone="neutral">read-only</Chip> : <Chip tone="primary">records</Chip>}</div>
                  <p className="mt-0.5 text-2xs leading-4 text-fg-3">{t.description}</p>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Connect an agent" subtitle={token && shown ? "The snippets include the real token - handle them like a password." : "Show the token to fill it into the snippets."}>
            <Pills value={snippet} onChange={(v) => setSnippet(v as typeof snippet)} options={[
              { id: "claude", label: "Claude Code" }, { id: "python", label: "Python (MCP SDK)" }, { id: "curl", label: "curl" }]} />
            <div className="mt-3"><CodeBlock code={snippets[snippet]} onCopy={() => copy(snippets[snippet], "Snippet")} /></div>
          </Card>
        </div>
      </div>

      <Card title="Recent calls" subtitle="From the audit log. Every MCP call is recorded as the Nova agent." flush>
        <Table>
          <thead><tr><Th>When</Th><Th>Tool</Th><Th>What happened</Th></tr></thead>
          <tbody>
            {s.recent.map((c, i) => (
              <Tr key={i}><Td className="whitespace-nowrap text-xs text-fg-3">{ago(c.at)}</Td><Td mono>{c.tool}</Td><Td className="text-xs text-fg-2">{c.summary}</Td></Tr>
            ))}
            {!s.recent.length && <Empty cols={3}>No calls yet. Use Try it, or connect an agent with one of the snippets.</Empty>}
          </tbody>
        </Table>
      </Card>

      <Modal open={rotating} onClose={() => setRotating(false)} title="Rotate the access token?"
        footer={<>
          <Button variant="ghost" onClick={() => setRotating(false)}>Cancel</Button>
          <Button variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === "rotate"}
            onClick={() => run("rotate", () => api.post<{ token: string }>("/admin/mcp/token/rotate"),
              "New token issued. Agents using the old one are cut off now.")
              .then((r) => { setRotating(false); if (r) { setToken(r.token); setShown(true); reload(); } })}>Rotate token</Button>
        </>}>
        <p className="text-[13px] leading-5 text-fg-2">
          A new token is issued and the current one stops working immediately. Every agent that calls ARI - Nova's included - needs the new token before its next call.
        </p>
      </Modal>
    </div>
  );
}
