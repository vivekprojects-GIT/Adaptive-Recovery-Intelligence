import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, CircleDot, Play, RotateCcw, TriangleAlert } from "lucide-react";
import { PageHeader } from "../App";
import { CustomerPicker } from "../components/CustomerPicker";
import { Button, Card, ErrorBox, Loading, SegmentBadge } from "../components/ui";
import { api, type JourneyStep } from "../lib/api";
import { useAsync } from "../lib/hooks";

const KIND_STYLE: Record<JourneyStep["kind"], { color: string; icon: typeof Check }> = {
  trigger: { color: "#f43f5e", icon: TriangleAlert },
  action: { color: "#6366f1", icon: Play },
  positive: { color: "#38bdf8", icon: CircleDot },
  neutral: { color: "#64748b", icon: CircleDot },
  success: { color: "#10b981", icon: Check },
};

export default function JourneySim() {
  const id = Number(useParams().id ?? 1);
  const { data: c } = useAsync(() => api.customer(id), [id]);
  const { data, error, loading } = useAsync(() => api.journeySimulation(id), [id]);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setShown(0);
    setPlaying(false);
  }, [id]);

  useEffect(() => {
    if (!playing || !data) return;
    if (shown >= data.steps.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setShown((s) => s + 1), 750);
    return () => clearTimeout(t);
  }, [playing, shown, data]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !data || !c) return <Loading what="journey" />;

  const done = shown >= data.steps.length;

  return (
    <>
      <PageHeader
        eyebrow="Step 06 · Outcome"
        title="Interactive Journey Simulation"
        blurb="The treatment ARI selected, played out day by day — and fed back into the model at the end."
        right={<CustomerPicker current={c} basePath="/journey" />}
      />

      <Card
        title={`${data.name} · ${data.segment} pathway`}
        subtitle="Press play to step through the 90-day recovery timeline."
        action={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => (setShown(0), setPlaying(false))}>
              <span className="flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Reset
              </span>
            </Button>
            <Button onClick={() => (done ? (setShown(0), setPlaying(true)) : setPlaying(!playing))}>
              <span className="flex items-center gap-1.5">
                <Play className="h-3.5 w-3.5" />
                {done ? "Replay" : playing ? "Pause" : "Play timeline"}
              </span>
            </Button>
          </div>
        }
      >
        <ol className="relative ml-3 border-l border-white/10 pl-8">
          {data.steps.map((s, i) => {
            const style = KIND_STYLE[s.kind];
            const Icon = style.icon;
            const visible = i < shown;
            return (
              <li
                key={i}
                className="relative pb-7 last:pb-0 transition-all duration-500"
                style={{
                  opacity: visible ? 1 : 0.2,
                  transform: visible ? "translateY(0)" : "translateY(6px)",
                }}
              >
                <span
                  className="absolute -left-[45px] grid h-8 w-8 place-items-center rounded-full border-2 transition-colors duration-500"
                  style={{
                    background: visible ? `${style.color}22` : "#0b1120",
                    borderColor: visible ? style.color : "rgba(255,255,255,0.12)",
                  }}
                >
                  <Icon
                    className="h-3.5 w-3.5"
                    style={{ color: visible ? style.color : "#334155" }}
                    strokeWidth={2.5}
                  />
                </span>
                <p className="font-mono text-[11px] uppercase tracking-widest text-slate-500">
                  {s.day}
                </p>
                <p className="mt-0.5 text-sm font-semibold text-white">{s.title}</p>
                <p className="mt-0.5 text-xs text-slate-400">{s.detail}</p>
              </li>
            );
          })}
        </ol>

        {done && (
          <div className="mt-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
              <Check className="h-4 w-4" /> Outcome: {c.outcome}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
              The result is written back to the bandit's Beta posterior for{" "}
              <span className="font-semibold text-white">{c.treatment}</span>. Every account that
              completes a journey makes the next treatment decision slightly better — that is the
              continuous-learning loop, and it runs without a model retrain.
            </p>
          </div>
        )}
      </Card>

      <Card className="mt-5" title="What the loop updates">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Bandit posterior", "Beta(successes, failures) for the played arm moves by one."],
            ["Journey ranking", "Tomorrow's sample for this arm shifts toward the observed truth."],
            ["Segment policy", "Persistent under-performance in a segment retires that treatment."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
              <p className="text-xs font-semibold text-slate-100">{t}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{d}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-5 flex items-center gap-2 text-xs text-slate-500">
        <SegmentBadge segment={c.segment} />
        <span>
          Different segment, different pathway — switch personas above to see the Sure Thing and Lost
          Cause routes.
        </span>
      </div>
    </>
  );
}
