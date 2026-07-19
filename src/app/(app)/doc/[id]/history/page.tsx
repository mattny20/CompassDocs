import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocument, listVersions, listBranches, getApprovalMode } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime } from "@/lib/format";
import { roleAtLeast } from "@/lib/types";
import { timeAgo } from "@/lib/ui";
import { PageContainer } from "@/components/PageWidth";
import { VersionHistory } from "@/components/VersionHistory";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) notFound();
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) notFound();
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) notFound();

  const [versions, branches, settings, hasEditRights, approvalMode] = await Promise.all([
    listVersions(doc.id),
    listBranches(doc.id),
    getAppSettings(),
    canEditSpace(user, doc.space_id),
    getApprovalMode(),
  ]);
  const canEdit = roleAtLeast(user.role, "editor") && hasEditRights;
  const canPublishDirect = roleAtLeast(user.role, "approver") || approvalMode === "open";

  // Oldest = v1; the list arrives newest-first.
  const items = versions.map((v, i) => ({
    id: v.id,
    rev: versions.length - i,
    title: v.title,
    content: v.content,
    author: v.author,
    note: v.note,
    restored_from: v.restored_from,
    when: timeAgo(v.created_at),
    whenExact: formatDateTime(v.created_at, settings),
  }));

  return (
    <PageContainer>
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-slate-400">
        <Link href={`/doc/${doc.id}`} className="hover:text-slate-600">
          ← Back to document
        </Link>
      </nav>
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Version history</h1>
      <p className="mb-6 text-slate-500">
        {doc.title}
        {doc.branch_of !== null && (
          <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-900/50">
            Draft branch
          </span>
        )}
      </p>

      <VersionHistory
        docId={doc.id}
        docStatus={doc.status}
        isBranch={doc.branch_of !== null}
        canEdit={canEdit}
        canPublishDirect={canPublishDirect}
        versions={items}
        branches={branches.map((b) => ({
          id: b.id,
          title: b.title,
          author: b.author,
          when: timeAgo(b.updated_at),
        }))}
      />
    </PageContainer>
  );
}
