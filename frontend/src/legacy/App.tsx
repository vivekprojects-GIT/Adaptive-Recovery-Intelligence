import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  Activity,
  ClipboardList,
  Database,
  FlaskConical,
  LineChart,
  Users,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { useFlow } from "./lib/flow";
import Upstream from "./pages/Upstream";
import CohortView from "./pages/CohortView";
import CustomerView from "./pages/CustomerView";
import StrategySheet from "./pages/StrategySheet";
import ExperimentSetup from "./pages/ExperimentSetup";
import ExperimentRun from "./pages/ExperimentRun";
import Outcomes from "./pages/Outcomes";
import CustomerAssignment from "./pages/CustomerAssignment";

interface NavItem {
  to: string | null;
  label: string;
  icon: LucideIcon;
  step: string;
  client?: boolean;
  active: (path: string) => boolean;
}

function useNav(): NavItem[] {
  const { flow } = useFlow();
  const exp = flow.experimentId;
  return [
    {
      to: "/",
      label: "Client upstream",
      icon: Database,
      step: "00",
      client: true,
      active: (p) => p === "/",
    },
    {
      to: `/cohort/${flow.cohortId}`,
      label: "Cohort / customer",
      icon: Users,
      step: "01",
      active: (p) => p.startsWith("/cohort") || (/^\/customer\/\d+$/.test(p)),
    },
    {
      to: `/strategies/cohort/${flow.cohortId}`,
      label: "Strategy sheet",
      icon: ClipboardList,
      step: "02",
      active: (p) => p.startsWith("/strategies"),
    },
    {
      to: exp ? `/experiment/${exp}` : `/experiment/new/${flow.cohortId}`,
      label: "Experiment",
      icon: FlaskConical,
      step: "03",
      active: (p) => (p.startsWith("/experiment") && !p.endsWith("/outcomes")) || p.endsWith("/assignment"),
    },
    {
      to: exp ? `/experiment/${exp}/outcomes` : null,
      label: "Outcome tracking",
      icon: LineChart,
      step: "04",
      active: (p) => p.endsWith("/outcomes"),
    },
  ];
}

function NavEntry({ item, compact }: { item: NavItem; compact?: boolean }) {
  const { pathname } = useLocation();
  const isActive = item.active(pathname);
  const Icon = item.icon;
  const cls = clsx(
    compact
      ? "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium"
      : "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors",
    !item.to && "cursor-not-allowed opacity-40",
    isActive
      ? "bg-brand-500/15 text-white ring-1 ring-inset ring-brand-500/30"
      : item.client
        ? "text-slate-500 hover:bg-white/5"
        : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
    compact && !isActive && "bg-white/5",
  );
  const body = (
    <>
      <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4 shrink-0"} />
      <span className="flex-1">{item.label}</span>
      {!compact && (
        <span className="font-mono text-[10px] text-slate-600 group-hover:text-slate-500">
          {item.client ? "client" : item.step}
        </span>
      )}
    </>
  );
  return item.to ? (
    <Link to={item.to} className={cls}>
      {body}
    </Link>
  ) : (
    <span className={cls} title="Create an experiment first">
      {body}
    </span>
  );
}

export default function App() {
  const nav = useNav();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 flex-col border-r border-white/10 bg-ink-900/60 px-4 py-6 backdrop-blur lg:flex">
        <Link to="/" className="mb-8 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-emerald-500 shadow-lg shadow-brand-600/30">
            <Activity className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-sm font-bold leading-tight text-white">
              Adaptive Recovery
              <br />
              Intelligence
            </p>
            <p className="mt-0.5 font-mono text-[10px] tracking-widest text-brand-400">ARI · PROTOTYPE</p>
          </div>
        </Link>

        <nav className="flex flex-1 flex-col gap-1">
          <NavEntry item={nav[0]} />
          <div className="mx-3 my-2 flex items-center gap-2">
            <div className="h-px flex-1 bg-brand-500/30" />
            <span className="font-mono text-[9px] uppercase tracking-widest text-brand-400">ARI starts here</span>
            <div className="h-px flex-1 bg-brand-500/30" />
          </div>
          {nav.slice(1).map((n) => (
            <NavEntry key={n.label} item={n} />
          ))}
        </nav>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="label">Scope</p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            Collections dashboards, DPD buckets and risk models stay with the client. ARI takes over at
            the point of intervention.
          </p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 sm:px-5 sm:py-6 lg:px-9 lg:py-8">
        <div className="sticky top-0 z-30 -mx-4 mb-5 border-b border-white/10 bg-ink-950/90 px-4 pb-3 pt-3 backdrop-blur sm:-mx-5 sm:px-5 lg:hidden">
          <div className="mb-2.5 flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-emerald-500">
              <Activity className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
            </div>
            <p className="text-sm font-bold text-white">
              ARI <span className="font-normal text-slate-400">· Adaptive Recovery Intelligence</span>
            </p>
          </div>
          <nav className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {nav.map((n) => (
              <NavEntry key={n.label} item={n} compact />
            ))}
          </nav>
        </div>

        <Routes>
          <Route path="/" element={<Upstream />} />
          <Route path="/cohort/:cohortId" element={<CohortView />} />
          <Route path="/customer/:id" element={<CustomerView />} />
          <Route path="/customer/:id/assignment" element={<CustomerAssignment />} />
          <Route path="/strategies/cohort/:cohortId" element={<StrategySheet scope="cohort" />} />
          <Route path="/strategies/customer/:id" element={<StrategySheet scope="customer" />} />
          <Route path="/experiment/new/:cohortId" element={<ExperimentSetup />} />
          <Route path="/experiment/:expId" element={<ExperimentRun />} />
          <Route path="/experiment/:expId/outcomes" element={<Outcomes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
