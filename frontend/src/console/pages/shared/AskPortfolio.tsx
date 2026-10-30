/** Ask the portfolio in plain English: the question is read into query conditions,
 *  shown as chips and as the SQL they amount to, and the accounts table below is
 *  narrowed to the matches. The result can become a new strategy's target. */
import clsx from "clsx";
import { ArrowRight, ChevronRight, Code2, MessageSquareText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../lib/api";
import { money, num } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Button, useAction } from "../../ui/ui";

export interface Condition { field: string; op: string; value: unknown }
export interface Answer {
  question: string; conditions: Condition[]; labels: string[]; not_understood: string | null; sql: string;
  accounts: number; cohorts: string[]; balance: number;
}

const EXAMPLES = [
  "Consumer card accounts over 60 days past due with a balance above $5,000 who use the app",
  "Likely to respond customers between 30 and 59 days past due who reply to texts and are not in hardship",
  "Small business cards owing more than $25k with no missed payments",
];

export default function AskPortfolio({ question, onAnswer, onClear }: {
  question: string | null; onAnswer: (a: Answer) => void; onClear: () => void;
}) {
  const { can } = useSession();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [text, setText] = useState(question ?? "");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const asked = useRef<string | null>(null);

  const ask = async (q: string) => {
    const t = q.trim();
    if (t.length < 3) { setError("Type a question first."); return; }
    setError(null);
    try {
      const a = await api.post<Answer>("/customers/ask", { question: t });
      asked.current = t;
      setAnswer(a);
      setText(t);
      onAnswer(a);
    } catch (e) {
      setAnswer(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // A shared link carries the question: read it again so the chips and SQL show.
  useEffect(() => {
    if (question && question !== asked.current) void ask(question);
    if (!question) { setAnswer(null); asked.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  const target = () => answer && run("target", () => api.post<{ campaign_id: string }>("/strategies", {
    name: `Target: ${answer.question}`.slice(0, 100),
    description: `Accounts found by the question: "${answer.question}"`,
    target_cohorts: answer.cohorts,
    target_query: { question: answer.question, conditions: answer.conditions },
  }), (s) => `Draft ${s.campaign_id} created with these ${num(answer.accounts)} accounts as its target.`)
    .then((s) => s && navigate(`/builder/${s.campaign_id}`));

  return (
    <section className="rounded-xl border border-line bg-surface shadow-card">
      <form className="flex flex-wrap items-center gap-3 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-500">
          <MessageSquareText className="h-[18px] w-[18px]" /></span>
        <div className="min-w-[240px] flex-1">
          <label htmlFor="ask-portfolio" className="text-2xs font-medium text-fg-3">Ask your portfolio in plain English</label>
          <input id="ask-portfolio" value={text} onChange={(e) => { setText(e.target.value); setError(null); }}
            placeholder={EXAMPLES[0]}
            className="mt-0.5 w-full border-0 bg-transparent p-0 text-[15px] text-fg placeholder:text-fg-3 focus:outline-none focus:ring-0" />
        </div>
        {answer && <Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => { setText(""); setAnswer(null); asked.current = null; onClear(); }}>Clear</Button>}
        <Button type="submit" variant="primary">Find accounts <ArrowRight className="h-4 w-4" /></Button>
      </form>

      {error && <p role="alert" className="border-t border-line px-4 py-2.5 text-sm text-bad">{error}</p>}

      {!answer && !error && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-2xs text-fg-3">Try</span>
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => void ask(e)}
              className="cursor-pointer rounded-full border border-line px-2.5 py-1 text-xs text-fg-2 transition-colors hover:border-line-strong hover:bg-surface-hover">{e}</button>
          ))}
        </div>
      )}

      {answer && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">Understood as</span>
              {answer.labels.map((l) => (
                <span key={l} className="rounded-md border border-primary-500/30 bg-primary-50 px-2 py-0.5 text-xs font-medium text-fg">{l}</span>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <p className="text-sm text-fg-2"><span className="num font-semibold text-fg">{num(answer.accounts)}</span> accounts match ·{" "}
                <span className="num">{money(answer.balance, true)}</span> total balance</p>
              {can("create_strategy") && (
                <Button variant="primary" loading={busy === "target"} disabled={!answer.accounts} onClick={() => void target()}
                  title={answer.accounts ? "Start a strategy whose audience is these accounts" : "No accounts match"}>
                  Use as campaign target <ArrowRight className="h-4 w-4" /></Button>
              )}
            </div>
          </div>
          {answer.not_understood && (
            <p className="text-xs text-fg-2"><span className="font-medium text-fg">Not used:</span> "{answer.not_understood}". Only the conditions above were applied.</p>
          )}
          <div>
            <button type="button" onClick={() => setShowSql((v) => !v)} aria-expanded={showSql}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-primary-500 hover:underline">
              <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", showSql && "rotate-90")} /><Code2 className="h-3.5 w-3.5" />
              {showSql ? "Hide the query" : "Show the query it runs"}
            </button>
            {showSql && <pre className="mt-2 overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-[12px] leading-5 text-primary-100">{answer.sql}</pre>}
          </div>
        </div>
      )}
    </section>
  );
}
