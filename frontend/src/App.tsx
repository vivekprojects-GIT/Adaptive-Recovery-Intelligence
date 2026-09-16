import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import {
  Activity,
  GitCompare,
  LayoutDashboard,
  Lightbulb,
  Route as RouteIcon,
  Target,
  UserSearch,
  Users,
} from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Explorer from "./pages/Explorer";
import Customer360 from "./pages/Customer360";
import NudgeExplain from "./pages/NudgeExplain";
import BanditDecision from "./pages/BanditDecision";
import JourneySim from "./pages/JourneySim";
import Compare from "./pages/Compare";

const NAV = [
  { to: "/dashboard", label: "Executive Dashboard", icon: LayoutDashboard, step: "01" },
  { to: "/customers", label: "Customer Explorer", icon: Users, step: "02" },
  { to: "/customer/1", label: "Customer 360", icon: UserSearch, step: "03" },
  { to: "/nudge/1", label: "Nudge Explanation", icon: Lightbulb, step: "04" },
  { to: "/decision/1", label: "Bandit Decision", icon: Target, step: "05" },
  { to: "/journey/1", label: "Journey Simulation", icon: RouteIcon, step: "06" },
  { to: "/compare", label: "Persona Comparison", icon: GitCompare, step: "07" },
];

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[264px] shrink-0 flex-col border-r border-white/10 bg-ink-900/60 px-4 py-6 backdrop-blur lg:flex">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-emerald-500 shadow-lg shadow-brand-600/30">
            <Activity className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-sm font-bold leading-tight text-white">
              Adaptive Recovery
              <br />
              Intelligence
            </p>
            <p className="mt-0.5 font-mono text-[10px] tracking-widest text-brand-400">ARI · PoC</p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, step }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors " +
                (isActive
                  ? "bg-brand-500/15 text-white ring-1 ring-inset ring-brand-500/30"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200")
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              <span className="font-mono text-[10px] text-slate-600 group-hover:text-slate-500">
                {step}
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="label">Model stack</p>
          <ul className="mt-2 space-y-1.5 text-[11px] text-slate-400">
            <li>· Delinquency Risk (logistic)</li>
            <li>· Nudge Propensity (uplift)</li>
            <li>· Contextual Thompson Sampling</li>
          </ul>
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
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium " +
                  (isActive
                    ? "bg-brand-500/15 text-white ring-1 ring-inset ring-brand-500/30"
                    : "bg-white/5 text-slate-400")
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/customers" element={<Explorer />} />
          <Route path="/customer/:id" element={<Customer360 />} />
          <Route path="/nudge/:id" element={<NudgeExplain />} />
          <Route path="/decision/:id" element={<BanditDecision />} />
          <Route path="/journey/:id" element={<JourneySim />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  blurb,
  right,
}: {
  eyebrow: string;
  title: string;
  blurb?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand-400">{eyebrow}</p>
        <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-white">{title}</h1>
        {blurb && <p className="mt-1.5 max-w-3xl text-sm text-slate-400">{blurb}</p>}
      </div>
      {right}
    </header>
  );
}
