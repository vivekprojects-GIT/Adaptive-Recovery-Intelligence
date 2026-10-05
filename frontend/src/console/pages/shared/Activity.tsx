import clsx from "clsx";
import { Bot, CircleDollarSign, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { ago } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Card, ErrorState, Page, PageHeader, Pills, Spinner, StatusChip } from "../../ui/ui";

interface Item { at: string; kind: "decision" | "nudge" | "payment"; id: string; campaign_id: string; title: string; detail: string; status: string }

export default function Activity() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ items: Item[] }>("/activity?limit=80");
  const [kind, setKind] = useState("all");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  const items = data.items.filter((i) => kind === "all" || i.kind === kind);
  const Icon = { decision: Bot, nudge: Send, payment: CircleDollarSign };
  const tone = { decision: "bg-ai-50 text-ai-600", nudge: "bg-primary-50 text-primary-600", payment: "bg-good-bg text-good" };
  const href = (i: Item) => i.kind === "nudge" ? `/nudges/${i.id}` : `/decisions/${i.id}`;
  return (
    <>
      <PageHeader title="AI Activity" subtitle="A live feed of what the engine decided, sent and recovered" role={me?.user.role_label} />
      <Page>
        <Pills value={kind} onChange={setKind} options={[{ id: "all", label: "Everything" }, { id: "decision", label: "Decisions" }, { id: "nudge", label: "Messages" }, { id: "payment", label: "Payments" }]} />
        <Card flush>
          <ul className="divide-y divide-line">
            {items.map((i, n) => {
              const I = Icon[i.kind];
              return (
                <li key={`${i.id}-${n}`}>
                  <Link to={href(i)} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-hover">
                    <span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", tone[i.kind])}><I className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13px] font-medium">{i.title}</p>
                        <StatusChip status={i.status} />
                        <span className="font-mono text-2xs text-fg-3">{i.campaign_id} · {i.id}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-fg-2">{i.detail}</p>
                    </div>
                    <span className="shrink-0 text-2xs text-fg-3">{ago(i.at)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </Page>
    </>
  );
}
