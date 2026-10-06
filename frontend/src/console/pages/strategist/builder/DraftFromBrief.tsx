/** Draft from a brief: a strategy drafted from a written description. */
import { Check, FilePenLine } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type Strategy } from "../../../lib/api";
import { num } from "../../../lib/format";
import { useApi } from "../../../lib/session";
import { Button, Card, Chip, Field, Kpi, Select, Spinner, inputCls, useAction } from "../../../ui/ui";

export default function DraftFromBrief() {
  const presets = useApi<{ presets: { label: string; brief: string; risk: string; goal: string }[]; goals: string[]; risks: string[] }>("/ai/presets").data;
  const [brief, setBrief] = useState("");
  const [risk, setRisk] = useState("Medium");
  const [goal, setGoal] = useState("Payment plan");
  const [result, setResult] = useState<Strategy | null>(null);
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (!presets) return <Spinner />;
  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_1fr]">
      <Card title="Describe the recovery campaign"
        subtitle="ARI drafts a complete strategy from your brief. Every setting is explained and you review it before it is submitted.">
        <p className="label mb-1.5">Quick presets</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {presets.presets.map((p) => (
            <button key={p.label} onClick={() => { setBrief(p.brief); setRisk(p.risk); setGoal(p.goal); }}
              className="rounded-full border border-line-strong px-3 py-1 text-xs text-fg-2 hover:border-primary-500 hover:bg-primary-50 hover:text-primary-600">{p.label}</button>
          ))}
        </div>
        <textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. Build a recovery campaign for medium-risk 30 DPD card accounts with balances between $2k-$10k. Offer flexible payment plans and avoid aggressive escalation in the first 14 days."
          className={`${inputCls} h-auto py-2 leading-5`} />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Risk profile"><Select value={risk} onChange={setRisk} options={presets.risks.map((r) => ({ value: r, label: r }))} /></Field>
          <Field label="Campaign goal"><Select value={goal} onChange={setGoal} options={presets.goals.map((g) => ({ value: g, label: g }))} /></Field>
        </div>
        <div className="mt-4">
          <Button variant="primary" disabled={brief.trim().length < 10} loading={busy === "gen"} icon={<FilePenLine className="h-4 w-4" />}
            onClick={() => run("gen", () => api.post<Strategy>("/strategies/ai-draft", { brief, risk, goal }), (r) => `Drafted ${r.campaign_id}.`).then((r) => r && setResult(r))}>
            Draft the strategy
          </Button>
        </div>
        <p className="mt-3 text-2xs leading-4 text-fg-3">
          Drafting reads your brief for audience, balance range, tone, touches and escalation timing. It only picks from approved treatments, and the result is a Draft that someone else must approve.
        </p>
      </Card>

      <Card title="Draft" subtitle={result ? `${result.campaign_id} · ${result.status}` : "The drafted strategy appears here"}>
        {!result ? (
          <div className="flex h-64 flex-col items-center justify-center text-center text-xs text-fg-3">
            <FilePenLine className="mb-2 h-6 w-6 text-fg-3/60" />Choose a preset or write a brief, then draft it.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-[15px] font-semibold">{result.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">{result.treatments.map((t) => <Chip key={t.code} tone="info">{t.name}</Chip>)}</div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Kpi label="Eligible" value={num(result.population?.eligible)} />
              <Kpi label="Control" value={num(result.population?.control)} />
              <Kpi label="Treated" value={num(result.population?.treatment)} />
            </div>
            <div>
              <p className="label mb-1.5">Why these settings</p>
              <ul className="space-y-1.5">
                {result.rationale?.map((r) => (
                  <li key={r} className="flex gap-2 text-xs leading-5 text-fg-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{r}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="primary" onClick={() => navigate(`/builder/${result.campaign_id}`)}>Review in guided build</Button>
              <Button variant="ghost" onClick={() => setResult(null)}>Discard view</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
