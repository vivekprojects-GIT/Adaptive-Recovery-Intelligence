/** Suggested strategies: complete strategies ARI proposes from the decision log. */
import { Check, FilePenLine } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api, type Strategy } from "../../../lib/api";
import { num, pct } from "../../../lib/format";
import { useApi, useSession } from "../../../lib/session";
import { Banner, Button, Card, Chip, Spinner, useAction } from "../../../ui/ui";

interface Suggestion {
  key: string; kind: "new" | "revision"; title: string; summary: string; accounts: number; based_on: string | null;
  confidence: "Strong evidence" | "Some evidence" | "Little evidence"; why: string[]; caveats: string[];
  treatments: { code: string; name: string; channel: string | null; reach: number; human_review: boolean; kept_for_support: boolean;
    evidence: { paid: number; n: number; rate: number | null; source: string; playbook_rate: number | null } }[];
}
interface Suggestions {
  suggestions: Suggestion[]; considered: number;
  left_out: { segment: string; label: string; reason: string; control: { paid: number; n: number; rate: number } | null }[];
}
const CONFIDENCE_TONE = { "Strong evidence": "good", "Some evidence": "info", "Little evidence": "neutral" } as const;

export default function Suggested() {
  const { data, error, reload } = useApi<Suggestions>("/strategies/suggestions");
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const { can } = useSession();
  if (error) return <Banner tone="bad" title="Suggestions could not be loaded">{error}</Banner>;
  if (!data) return <Spinner label="Reading the decision log" />;
  const choose = (sg: Suggestion) =>
    run(sg.key, () => api.post<Strategy>(`/strategies/suggestions/${sg.key}/draft`, {}),
      (r) => sg.kind === "new" ? `Created ${r.campaign_id} as a draft.` : `Created ${r.campaign_id}, the next version of ${sg.based_on}, as a draft.`)
      .then((r) => { if (r) navigate(`/builder/${r.campaign_id}`); else reload(); });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <p className="max-w-3xl text-[13px] leading-5 text-fg-2">
        Strategies ARI suggests from the decision log: audiences no live strategy covers, and new versions of strategies that are
        behind target or not beating their control group. Each suggestion shows the evidence behind it. Choosing one creates a draft
        you can change; it goes through approval like any other strategy.
      </p>
      {!data.suggestions.length && (
        <Card><p className="py-6 text-center text-xs text-fg-3">Nothing to suggest right now: every audience that can be helped is covered, and every live strategy is on target.</p></Card>
      )}
      {data.suggestions.map((sg) => (
        <Card key={sg.key}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="primary">{sg.kind === "new" ? "New strategy" : `New version of ${sg.based_on}`}</Chip>
                <Chip tone={CONFIDENCE_TONE[sg.confidence]}>{sg.confidence}</Chip>
                <span className="text-xs text-fg-3">{num(sg.accounts)} accounts in its audience</span>
              </div>
              <p className="mt-2 text-[15px] font-semibold">{sg.title}</p>
              <p className="mt-0.5 text-[13px] leading-5 text-fg-2">{sg.summary}</p>
            </div>
            {can(sg.kind === "new" ? "create_strategy" : "edit_strategy") && (
              <Button variant="primary" loading={busy === sg.key} icon={<FilePenLine className="h-3.5 w-3.5" />} onClick={() => choose(sg)}>
                {sg.kind === "new" ? "Create draft" : "Create draft version"}
              </Button>
            )}
          </div>
          <div className="mt-3 overflow-x-auto rounded-md border border-line">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-sunken text-2xs uppercase tracking-[0.06em] text-fg-3">
                <tr><th className="px-3 py-2 font-medium">Treatment</th><th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Evidence</th><th className="px-3 py-2 text-right font-medium">Open to</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sg.treatments.map((t) => (
                  <tr key={t.code}>
                    <td className="px-3 py-2 font-medium text-fg">{t.name}
                      {t.human_review && <span className="ml-1.5 text-2xs font-normal text-fg-3">· needs approval per offer</span>}
                      {t.kept_for_support && <span className="ml-1.5 text-2xs font-normal text-fg-3">· kept for customers who need support</span>}</td>
                    <td className="px-3 py-2 text-fg-2">{t.channel}</td>
                    <td className="px-3 py-2 text-fg-2">
                      {t.evidence.n ? <>{t.evidence.paid} of {t.evidence.n} paid ({pct(t.evidence.rate, 0)}) <span className="text-fg-3">· {t.evidence.source}</span></>
                        : <span className="text-fg-3">No results yet · playbook history {pct(t.evidence.playbook_rate, 0)}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(t.reach, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <p className="label mb-1.5">Why</p>
              <ul className="space-y-1.5">
                {sg.why.map((w) => <li key={w} className="flex gap-2 text-xs leading-5 text-fg-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" />{w}</li>)}
              </ul>
            </div>
            <div>
              <p className="label mb-1.5">Before you choose</p>
              <ul className="list-disc space-y-1.5 pl-4 text-xs leading-5 text-fg-2">
                {sg.caveats.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
          </div>
        </Card>
      ))}
      {data.left_out.length > 0 && (
        <p className="text-xs leading-5 text-fg-3">
          Left out on purpose: {data.left_out.map((l) => `customers ${l.label} (${l.reason}${l.control ? `: ${l.control.paid} of ${l.control.n} control customers paid without treatment` : ""})`).join("; ")}.
          {data.considered > data.suggestions.length && ` ${data.considered - data.suggestions.length} more ideas ranked lower.`}
        </p>
      )}
    </div>
  );
}
