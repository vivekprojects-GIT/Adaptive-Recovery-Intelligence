import { Link } from "react-router-dom";
import { ChevronRight, User, Users } from "lucide-react";
import clsx from "clsx";

const STEPS = [
  { label: "Client dashboard & risk model", client: true },
  { label: "Cohort / customer handoff" },
  { label: "Strategy sheet" },
  { label: "Experiment" },
  { label: "Outcome tracking" },
];

/** The end-to-end flow, with the client-owned part shown as upstream context. */
export function FlowBar({ current }: { current: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 text-[11px]">
      {STEPS.map((s, i) => (
        <div key={s.label} className="flex items-center gap-1.5">
          <span
            className={clsx(
              "rounded-md px-2 py-1 font-medium",
              s.client
                ? "border border-dashed border-slate-600 text-slate-500"
                : i === current
                  ? "bg-brand-500/20 text-white ring-1 ring-inset ring-brand-500/40"
                  : i < current
                    ? "bg-white/5 text-slate-300"
                    : "text-slate-500",
            )}
          >
            {s.client && <span className="mr-1 font-mono text-[9px] uppercase tracking-wider">client ·</span>}
            {s.label}
          </span>
          {i < STEPS.length - 1 && (
            <ChevronRight className={clsx("h-3 w-3", i === 0 ? "text-brand-400" : "text-slate-600")} />
          )}
        </div>
      ))}
    </div>
  );
}

/** Switch between the group-level and the customer-level view of the same step. */
export function ScopeToggle({
  scope,
  cohortHref,
  customerHref,
}: {
  scope: "cohort" | "customer";
  cohortHref: string;
  customerHref: string | null;
}) {
  const base = "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors";
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5">
      <Link
        to={cohortHref}
        className={clsx(base, scope === "cohort" ? "bg-brand-600 text-white" : "text-slate-400 hover:text-white")}
      >
        <Users className="h-3.5 w-3.5" /> Group view
      </Link>
      {customerHref ? (
        <Link
          to={customerHref}
          className={clsx(base, scope === "customer" ? "bg-brand-600 text-white" : "text-slate-400 hover:text-white")}
        >
          <User className="h-3.5 w-3.5" /> Customer view
        </Link>
      ) : (
        <span className={clsx(base, "cursor-not-allowed text-slate-600")} title="Pick a customer from the cohort first">
          <User className="h-3.5 w-3.5" /> Customer view
        </span>
      )}
    </div>
  );
}

/** A cohort's upstream attributes, labelled as coming from the client. */
export function CohortChip({
  dpd,
  band,
  expected,
  customers,
}: {
  dpd: string;
  band: string;
  expected: string;
  customers?: number;
}) {
  const items = [dpd, `${band} risk`, `Expected payment ${expected}`];
  if (customers !== undefined) items.push(`${customers.toLocaleString()} customers`);
  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">From client system</span>
      {items.map((t) => (
        <span key={t} className="rounded-md border border-dashed border-slate-600 px-2 py-0.5 text-[11px] text-slate-300">
          {t}
        </span>
      ))}
    </div>
  );
}
