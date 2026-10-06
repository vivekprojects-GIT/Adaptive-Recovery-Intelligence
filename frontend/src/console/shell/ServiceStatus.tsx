import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { ago } from "../lib/format";
import { StatusChip } from "../ui/ui";

export interface PlatformStatus {
  overall: "Operational" | "Degraded"; mode: "shadow" | "live"; model_version: string;
  components: { name: string; status: string; detail: string; at: string | null }[];
}

/** Service status: each part of the platform, its state and when it last did something. */
export function ServiceStatus({ onNavigate }: { onNavigate: () => void }) {
  const { can } = useSession();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  useEffect(() => {
    api.get<PlatformStatus>("/status").then(setStatus).catch(() => setStatus(null));
  }, []);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="font-medium text-fg">Service status</p>
        {can("view_system_health") && (
          <Link to="/admin/health" onClick={onNavigate} className="text-xs font-medium text-azure hover:underline">System health</Link>
        )}
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {status ? status.components.map((c) => (
          <li key={c.name} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg">{c.name}</p>
              <p className="text-2xs leading-4 text-fg-3">{c.detail}{c.at ? ` ${ago(c.at)}` : ""}</p>
            </div>
            <StatusChip status={c.status} />
          </li>
        )) : <li className="px-3 py-4 text-center text-xs text-fg-3">Checking status</li>}
      </ul>
    </div>
  );
}
