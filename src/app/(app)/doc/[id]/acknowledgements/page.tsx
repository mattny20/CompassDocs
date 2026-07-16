import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { getDocument, ackStatusForDocument } from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

export default async function AcknowledgementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireRole("approver");
  if (!(await featureEnabled("policy_ack"))) notFound();

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) notFound();

  const [rows, settings] = await Promise.all([ackStatusForDocument(doc.id), getAppSettings()]);
  const acked = rows.filter((r) => r.acknowledged_at);
  const pending = rows.filter((r) => !r.acknowledged_at);

  return (
    <PageContainer>
      <Link
        href={`/doc/${doc.id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {doc.title}
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Read confirmations</h1>
          <p className="mt-1 text-sm text-slate-500">
            {acked.length} of {rows.length} people have confirmed the current revision
            (as of {formatDateTime(doc.updated_at, settings)}). Editing the document asks
            everyone again.
          </p>
        </div>
        <a
          href={`/api/documents/${doc.id}/acknowledgements?format=csv`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          <Download className="h-4 w-4" /> Export CSV
        </a>
      </div>

      <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-compass-500"
          style={{ width: `${rows.length ? Math.round((acked.length / rows.length) * 100) : 0}%` }}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5">Person</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {[...pending, ...acked].map((r) => (
              <tr key={r.id} className="border-b border-slate-50">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-slate-800">{r.name || r.username}</span>
                  {r.email && <span className="ml-2 text-xs text-slate-400">{r.email}</span>}
                </td>
                <td className="px-4 py-2.5 text-slate-500">{r.role}</td>
                <td className="px-4 py-2.5">
                  {r.acknowledged_at ? (
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                      Acknowledged
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Pending
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-500">
                  {r.acknowledged_at ? formatDateTime(r.acknowledged_at, settings) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageContainer>
  );
}
