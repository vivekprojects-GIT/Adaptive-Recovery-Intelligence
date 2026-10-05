import { Download, FileSpreadsheet } from "lucide-react";

import { api } from "../../lib/api";
import { useApi, useSession } from "../../lib/session";
import { Banner, Button, Card, ErrorState, Page, PageHeader, Spinner, useAction } from "../../ui/ui";

export default function Reports() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ id: string; name: string; description: string }[]>("/reports");
  const { run, busy } = useAction();
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;
  return (
    <>
      <PageHeader title="Reports" subtitle="CSV exports for model risk, compliance and management reporting" role={me?.user.role_label} />
      <Page>
        <Banner tone="neutral">Every export is recorded in the audit log with who ran it and when.</Banner>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-500"><FileSpreadsheet className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">{r.name}</p>
                  <p className="mt-0.5 text-xs leading-5 text-fg-2">{r.description}</p>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button variant="primary" size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === r.id}
                  onClick={() => run(r.id, () => api.download(`/reports/${r.id}.csv`, `ari-${r.id}.csv`), `${r.name} downloaded.`)}>Download CSV</Button>
              </div>
            </Card>
          ))}
        </div>
      </Page>
    </>
  );
}
