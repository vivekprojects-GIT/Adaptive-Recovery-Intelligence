import clsx from "clsx";
import { Lightbulb, MessageSquareText, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type InsightRow } from "../../lib/api";
import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Banner, Button, Card, Chip, ErrorState, Page, PageHeader, Spinner, StatusChip, useAction } from "../../ui/ui";

interface Area { id: string; kind: string; campaign_id: string | null; severity: string; title: string; metrics: string }
interface Idea { title: string; body: string; evidence: string; priority: string; change: Record<string, unknown>; area_id?: string; campaign_id?: string | null }
interface Msg { from: "ai" | "me"; text: string; ideas?: Idea[] }

export default function Workbench() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ areas: Area[]; sent: InsightRow[] }>("/workbench");
  const [active, setActive] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const { run, busy } = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [msgs]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;

  const pick = async (a: Area) => {
    setActive(a.id);
    setMsgs((m) => [...m, { from: "me", text: `Analyse: ${a.title}` }]);
    const r = await api.get<{ area: Area; ideas: Idea[] }>(`/workbench/areas/${a.id}`);
    setIdeas(r.ideas);
    setMsgs((m) => [...m, { from: "ai", text: `${a.title}. ${a.metrics}. I found ${r.ideas.length} improvement idea${r.ideas.length === 1 ? "" : "s"} grounded in this data.`, ideas: r.ideas }]);
  };
  const ask = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    setMsgs((m) => [...m, { from: "me", text: t }]);
    const r = await run("ask", () => api.post<{ reply: string; ideas: Idea[] }>("/workbench/ask", { text: t }));
    if (r) { setIdeas(r.ideas); setMsgs((m) => [...m, { from: "ai", text: r.reply, ideas: r.ideas }]); }
  };
  const send = (i: Idea) => run(i.title, () => api.post("/insights", { title: i.title, body: i.body, evidence: i.evidence, priority: i.priority, campaign_id: i.campaign_id ?? null, change: i.change }),
    "Sent to the strategy owner. They can accept, decline, or apply it as a new draft.").then(reload);

  return (
    <>
      <PageHeader title="AI Strategy Workbench" subtitle="Find what is underperforming, draft improvements, send them to the strategy owner" role={me?.user.role_label} />
      <Page>
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_280px]">
          <div className="space-y-3">
            <p className="label">Problem areas · detected from live data</p>
            {data.areas.map((a) => (
              <button key={a.id} onClick={() => pick(a)} className={clsx("w-full rounded-lg border bg-surface p-3 text-left shadow-card transition",
                active === a.id ? "border-primary-500 ring-2 ring-primary-500/15" : "border-line hover:border-line-strong")}>
                <StatusChip status={a.severity} />
                <p className="mt-1.5 text-[13px] font-semibold">{a.title}</p>
                <p className="mt-0.5 text-2xs leading-4 text-fg-3">{a.metrics}</p>
              </button>
            ))}
            {!data.areas.length && <p className="text-xs text-fg-3">No problem areas detected.</p>}
            {data.sent.length > 0 && (
              <div className="pt-2">
                <p className="label mb-2">Sent</p>
                <ul className="space-y-1.5">
                  {data.sent.slice(0, 8).map((s) => (
                    <li key={s.insight_id} className="rounded-lg border border-line bg-surface px-2.5 py-2">
                      <p className="truncate text-xs font-medium">{s.title}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-fg-3"><StatusChip status={s.status} />to {s.to} · {ago(s.created_at)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <Card flush className="flex min-h-[560px] flex-col">
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              <div className="flex gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-fg-2 ring-1 ring-line"><MessageSquareText className="h-3.5 w-3.5" /></span>
                <div className="max-w-xl rounded-xl rounded-tl-sm bg-surface-sunken px-3.5 py-2.5 text-[13px] leading-5">
                  Pick a problem area on the left, or ask about a strategy, for example “why is STR-031 escalating?”. Every figure in an answer comes from the decision log.
                </div>
              </div>
              {msgs.map((m, i) => (
                <div key={i} className={clsx("flex gap-2.5", m.from === "me" && "justify-end")}>
                  {m.from === "ai" && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-fg-2 ring-1 ring-line"><MessageSquareText className="h-3.5 w-3.5" /></span>}
                  <div className={clsx("max-w-xl whitespace-pre-line rounded-xl px-3.5 py-2.5 text-[13px] leading-5",
                    m.from === "me" ? "rounded-tr-sm bg-primary-500 text-white" : "rounded-tl-sm bg-surface-sunken")}>{m.text}</div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); ask(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe what could be improved, or ask about any strategy's performance…"
                className="h-9 flex-1 rounded-lg border border-line-strong px-3 text-[13px] focus:border-primary-500 focus:outline-none" />
              <Button type="submit" variant="primary" loading={busy === "ask"} icon={<Send className="h-3.5 w-3.5" />}>Send</Button>
            </form>
          </Card>

          <div className="space-y-3">
            <p className="label">Suggested improvements · review, then send to the owner</p>
            {ideas.map((i) => (
              <div key={i.title} className="rounded-lg border border-line bg-surface p-3 shadow-card">
                <div className="flex items-center gap-1.5"><Lightbulb className="h-3.5 w-3.5 text-fg-3" /><StatusChip status={i.priority} />
                  {i.campaign_id && <Chip tone="primary">{i.campaign_id}</Chip>}</div>
                <p className="mt-1.5 text-[13px] font-semibold leading-5">{i.title}</p>
                <p className="mt-1 text-xs leading-5 text-fg-2">{i.body}</p>
                <p className="mt-1.5 text-2xs leading-4 text-fg-3">Evidence: {i.evidence}</p>
                {Object.keys(i.change).length > 0 && (
                  <p className="mt-1.5 rounded-md bg-surface-sunken px-2 py-1 font-mono text-2xs text-fg-2">{JSON.stringify(i.change)}</p>
                )}
                <div className="mt-2">
                  <Button size="sm" variant="primary" loading={busy === i.title} icon={<Send className="h-3 w-3" />} onClick={() => send(i)}>
                    Send to owner
                  </Button>
                </div>
              </div>
            ))}
            {!ideas.length && (
              <div className="rounded-lg border border-dashed border-line-strong p-6 text-center text-xs text-fg-3">
                <Lightbulb className="mx-auto mb-2 h-5 w-5" />Select a problem area or send a message to generate ideas.
              </div>
            )}
            <Banner tone="neutral">Ideas never change a running strategy. Applied ideas become a new draft version that goes through approval.</Banner>
          </div>
        </div>
      </Page>
    </>
  );
}
