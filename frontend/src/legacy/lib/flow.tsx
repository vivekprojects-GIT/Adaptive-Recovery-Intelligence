import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** Where the user is in the intervention flow, so the nav can link back to it. */
export interface FlowState {
  cohortId: string;
  customerId: number | null;
  strategies: string[] | null; // null = use the sheet's recommendations
  experimentId: string | null;
}

const DEFAULT: FlowState = { cohortId: "C2", customerId: null, strategies: null, experimentId: null };
const KEY = "ari.flow.v2";

function load(): FlowState {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const Ctx = createContext<{ flow: FlowState; update: (p: Partial<FlowState>) => void }>({
  flow: DEFAULT,
  update: () => {},
});

export function FlowProvider({ children }: { children: ReactNode }) {
  const [flow, setFlow] = useState<FlowState>(load);
  const update = useCallback((p: Partial<FlowState>) => {
    setFlow((prev) => {
      const next = { ...prev, ...p };
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable - the flow still works for this page load */
      }
      return next;
    });
  }, []);
  return <Ctx.Provider value={{ flow, update }}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useFlow = () => useContext(Ctx);
