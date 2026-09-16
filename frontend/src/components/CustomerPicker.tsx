import { useNavigate } from "react-router-dom";
import { api, type Customer } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { SegmentBadge } from "./ui";

/** Persona switcher shown at the top of every per-customer screen. */
export function CustomerPicker({ current, basePath }: { current: Customer; basePath: string }) {
  const nav = useNavigate();
  const { data: personas } = useAsync(() => api.personas(), []);
  const options = personas ?? [];
  const inList = options.some((p) => p.customer_id === current.customer_id);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="label mr-1">Customer</span>
      {options.map((p) => (
        <button
          key={p.customer_id}
          onClick={() => nav(`${basePath}/${p.customer_id}`)}
          className={
            "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors " +
            (p.customer_id === current.customer_id
              ? "border-brand-500/60 bg-brand-500/15 text-white"
              : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10")
          }
        >
          {p.name.split(" ")[0]}
        </button>
      ))}
      {!inList && (
        <span className="rounded-lg border border-brand-500/60 bg-brand-500/15 px-3 py-1.5 text-xs font-semibold text-white">
          {current.name}
        </span>
      )}
      <SegmentBadge segment={current.segment} className="ml-1" />
    </div>
  );
}
