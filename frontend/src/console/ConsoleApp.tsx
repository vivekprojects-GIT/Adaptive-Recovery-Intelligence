import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { SessionProvider, useSession } from "./lib/session";
import { Spinner, ToastProvider } from "./ui/ui";
import SignIn from "./pages/SignIn";
import { HOME } from "./shell/nav";
import { ShellBar } from "./shell/ShellBar";
import { Sidebar } from "./shell/Sidebar";
import { RequirePerm, ROUTES } from "./routes";

function Shell() {
  const { me, signedOut } = useSession();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // The content pane is its own scroll area, so the router cannot reset it:
  // without this, a new page opens wherever the last one was scrolled to.
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [pathname]);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("ari.console.nav") === "collapsed"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ari.console.nav", collapsed ? "collapsed" : "open"); } catch { /* storage blocked */ }
  }, [collapsed]);

  if (signedOut && !me) return <SignIn />;
  if (!me) return <Spinner label="Signing in" />;
  return (
    <div className="flex h-full flex-col">
      <ShellBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Navigate to={HOME[me.user.role]} replace />} />
              {ROUTES.map((r) => <Route key={r.path} path={r.path} element={<RequirePerm perm={r.perm}>{r.el}</RequirePerm>} />)}
              <Route path="*" element={<Navigate to={HOME[me.user.role]} replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </div>
  );
}

export default function ConsoleApp() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionProvider>
  );
}
