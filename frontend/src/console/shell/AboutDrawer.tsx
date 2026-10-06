/** About this environment: environment, delivery, service status, how results are reported. */
import { useSession } from "../lib/session";
import { num } from "../lib/format";
import { Drawer, KV } from "../ui/ui";
import { ServiceStatus } from "./ServiceStatus";

export function AboutDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  if (!me) return null;
  return (
    <Drawer open={open} onClose={onClose} title="About this environment" subtitle="ARI Console · Capgemini" width="max-w-md">
      <div className="space-y-5 text-[13px] leading-5 text-fg-2">
        <KV items={[
          { label: "Environment", value: me.agent.shadow_mode ? "Pilot" : "Production" },
          { label: "Channel delivery", value: me.agent.shadow_mode ? "Not connected" : "Connected" },
          { label: "Decision model", value: me.agent.model_version },
          { label: "Decisions logged", value: num(me.agent.decisions_total) },
          { label: "Signed in as", value: `${me.user.name} · ${me.user.role_label}` },
        ]} />
        <ServiceStatus onNavigate={onClose} />
        {me.agent.shadow_mode && (
          <div>
            <p className="mb-1 font-medium text-fg">Pilot environment</p>
            <p>Customer records, balances and contact histories are test data, and customer responses are generated for testing. Channel delivery is not connected: decisions, approvals, compliance checks and the audit trail are recorded as in production, and no message is sent to a customer.</p>
          </div>
        )}
        <div>
          <p className="mb-1 font-medium text-fg">How results are reported</p>
          <p>As uplift over each strategy's own randomised control group, with a 95% interval and the smallest effect the sample can detect. Raw recovery rates include customers who would have paid anyway.</p>
        </div>
      </div>
    </Drawer>
  );
}
