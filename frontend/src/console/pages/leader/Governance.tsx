/** Security and governance: how personal data is protected, what ARI decides
 *  on, which decisions always wait for a person, and how every decision can
 *  be traced. Every figure is read from the live system. */
import { type ReactNode } from "react";
import { Link } from "react-router-dom";

import { dateTime, num, pct } from "../../lib/format";
import { useApi, useSession } from "../../lib/session";
import { Banner, Card, ErrorState, KV, Page, PageHeader, Progress, Spinner, Table, Td, Th, Tr } from "../../ui/ui";

interface Data {
  encryption: { algorithm: string; key_source: string; key_id: string; in_transit: string; production_note: string | null;
    fields: { table: string; column: string; holds: string; rows: number; encrypted: number }[] };
  tokenisation: { method: string; example: { identifier: string; token: string }; applied_to: string[]; note: string };
  traceability: { decisions: number; legacy: number; checks: { label: string; count: number; share: number | null; detail: string }[] };
  human_review: {
    policies: { rule: string; action: string; where: string; configurable: boolean }[];
    decisions: { pending: number; approved: number; rejected: number; cancelled: number };
    placements: { pending: number; approved: number; declined: number };
  };
  audit: { events: number; first: string | null; last: string | null; retention: string;
    by_action: { action: string; count: number }[]; by_entity: { entity: string; count: number }[] };
  fairness: { policy: string; excluded: string[]; features_used: { field: string; label: string; used_for: string }[];
    guardrail_only: { field: string; label: string }[];
    dropped: { requests: number; by_attribute: { attribute: string; count: number }[] };
    sensitive: string[]; sensitive_dropped: { requests: number; by_identifier: { identifier: string; count: number }[] } };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Label and value stacked, for values that are sentences rather than figures. */
const Facts = ({ items }: { items: { label: string; value: ReactNode }[] }) => (
  <dl className="grid gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
    {items.map((i) => (
      <div key={i.label} className="contents">
        <dt className="text-fg-3">{i.label}</dt>
        <dd className="min-w-0 break-words text-fg">{i.value}</dd>
      </div>
    ))}
  </dl>
);

export default function Governance() {
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<Data>("/governance");
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading governance" />;
  const { encryption: enc, tokenisation: tok, traceability: tr, human_review: hr, audit, fairness: fair } = data;

  return (
    <>
      <PageHeader title="Security and governance"
        subtitle="How customer data is protected, what ARI decides on, where a person decides, and how every decision can be traced" />
      <Page>
        <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
          <Card title="Encryption" subtitle="Inbound customer data is encrypted before it is stored">
            <Facts items={[
              { label: "At rest", value: `${enc.algorithm}, key ${enc.key_id}` },
              { label: "Key held in", value: cap(enc.key_source) },
              { label: "In transit", value: enc.in_transit },
            ]} />
            <div className="mt-4 space-y-3">
              {enc.fields.map((f) => (
                <div key={f.table}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-fg">{f.holds}</span>
                    <span className="num shrink-0 text-fg-2">{num(f.encrypted)} of {num(f.rows)} encrypted</span>
                  </div>
                  <Progress value={f.rows ? (f.encrypted / f.rows) * 100 : 100} className="mt-1" />
                </div>
              ))}
            </div>
            {enc.production_note && <p className="mt-3 text-2xs leading-4 text-fg-3">{enc.production_note}</p>}
          </Card>

          <Card title="Tokenisation" subtitle="Traces and logs never carry a customer's name or ID">
            <Facts items={[
              { label: "Method", value: tok.method },
              { label: "Example", value: <span className="font-mono text-xs">{tok.example.identifier} → {tok.example.token}</span> },
            ]} />
            <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-5 text-fg-2">
              {tok.applied_to.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <p className="mt-3 text-2xs leading-4 text-fg-3">{tok.note}</p>
          </Card>
        </div>

        <Card title="Fair treatment" subtitle={fair.policy}>
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <p className="label mb-2">What ARI decides on</p>
              <Table>
                <thead><tr><Th>Data</Th><Th>Used for</Th></tr></thead>
                <tbody>{fair.features_used.map((f) => (
                  <Tr key={f.field}><Td className="font-medium">{f.label}</Td><Td className="text-fg-2">{f.used_for}</Td></Tr>))}</tbody>
              </Table>
              <p className="mt-3 text-xs leading-5 text-fg-2">
                <span className="font-medium text-fg">Used only to stop or limit contact:</span>{" "}
                {fair.guardrail_only.map((g) => g.label.toLowerCase()).join("; ")}.</p>
            </div>
            <div className="space-y-4">
              <div>
                <p className="label mb-2">Never used, and dropped on arrival</p>
                <p className="text-xs leading-6 text-fg">{fair.excluded.join(" · ")}</p>
              </div>
              <div>
                <p className="label mb-2">Never kept: sensitive identifiers</p>
                <p className="text-xs leading-6 text-fg">{fair.sensitive.join(" · ")}</p>
                <p className="mt-1 text-2xs leading-4 text-fg-3">Also removed from any text field that contains a card number or a Social Security number.</p>
                <p className="mt-1.5 text-xs text-fg-2">{fair.sensitive_dropped.requests
                  ? `${num(fair.sensitive_dropped.requests)} requests contained them: ${fair.sensitive_dropped.by_identifier.map((d) => `${d.identifier} (${num(d.count)})`).join(", ")}.`
                  : "None received so far."}</p>
              </div>
              <div>
                <p className="label mb-1.5">Dropped from inbound requests</p>
                {fair.dropped.requests ? (
                  <>
                    <p className="text-xs text-fg-2">{num(fair.dropped.requests)} requests contained protected data, which was removed before anything was stored:</p>
                    <ul className="mt-1.5 space-y-1 text-xs">{fair.dropped.by_attribute.map((d) => (
                      <li key={d.attribute} className="flex justify-between"><span>{d.attribute}</span><span className="num text-fg-2">{num(d.count)}</span></li>))}</ul>
                  </>
                ) : <p className="text-xs text-fg-2">None so far. No inbound request has contained a protected attribute.</p>}
              </div>
            </div>
          </div>
        </Card>

        <Card title="Where a person decides" subtitle="Sensitive decisions are never automatic" flush>
          <Table>
            <thead><tr><Th>When</Th><Th>What happens</Th><Th>Where</Th><Th>Set by</Th></tr></thead>
            <tbody>{hr.policies.map((p) => (
              <Tr key={p.rule}>
                <Td className="font-medium">{p.rule}</Td><Td className="text-fg-2">{p.action}</Td><Td className="text-fg-2">{p.where}</Td>
                <Td className="text-fg-2">{p.configurable ? "Platform configuration" : "Fixed in ARI"}</Td>
              </Tr>))}</tbody>
          </Table>
          <div className="grid gap-4 border-t border-line px-4 py-3 text-xs text-fg-2 sm:grid-cols-2">
            <p><span className="font-medium text-fg">Decisions reviewed:</span> {num(hr.decisions.approved)} approved, {num(hr.decisions.rejected)} rejected,{" "}
              {num(hr.decisions.cancelled)} withdrawn, {num(hr.decisions.pending)} waiting</p>
            <p><span className="font-medium text-fg">Agency placements:</span> {num(hr.placements.approved)} approved, {num(hr.placements.declined)} declined,{" "}
              {num(hr.placements.pending)} waiting</p>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
          <Card title="Traceable decisions" subtitle={`Every one of ${num(tr.decisions)} decisions can be replayed: the data it saw, each rule it passed or failed, and why`}>
            <ul className="space-y-3.5">
              {tr.checks.map((c) => (
                <li key={c.label}>
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium text-fg">{c.label}</span>
                    <span className="num shrink-0 text-fg-2">{num(c.count)} · {pct(c.share, 0)}</span>
                  </div>
                  <Progress value={(c.share ?? 0) * 100} className="mt-1" />
                  <p className="mt-0.5 text-2xs text-fg-3">{c.detail}</p>
                </li>
              ))}
            </ul>
            {tr.legacy > 0 && <div className="mt-3"><Banner tone="neutral">{num(tr.legacy)} older decisions predate full recording; only their summary was kept.</Banner></div>}
          </Card>

          <Card title="Audit log" subtitle={audit.retention}
            actions={can("view_audit_log") && <Link to="/admin/audit" className="text-xs font-medium text-primary-500 hover:underline">Open the audit log</Link>}>
            <KV items={[
              { label: "Events recorded", value: num(audit.events) },
              { label: "First", value: dateTime(audit.first) },
              { label: "Latest", value: dateTime(audit.last) },
            ]} />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label mb-1.5">By action</p>
                <ul className="space-y-1 text-xs">{audit.by_action.map((a) => (
                  <li key={a.action} className="flex justify-between"><span>{cap(a.action)}</span><span className="num text-fg-2">{num(a.count)}</span></li>))}</ul>
              </div>
              <div>
                <p className="label mb-1.5">By record</p>
                <ul className="space-y-1 text-xs">{audit.by_entity.map((a) => (
                  <li key={a.entity} className="flex justify-between"><span>{cap(a.entity)}</span><span className="num text-fg-2">{num(a.count)}</span></li>))}</ul>
              </div>
            </div>
          </Card>
        </div>
      </Page>
    </>
  );
}
