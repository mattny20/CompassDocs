import { History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { notFound } from "next/navigation";
import { getDocument, listVersions, listBranches, getApprovalMode } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canPublishDirectly, canSeeDrafts, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { timeAgo } from "@/lib/ui";
import { PageContainer } from "@/components/PageWidth";
import { VersionHistory } from "@/components/VersionHistory";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `History · ${doc.title}` : "Version history" };
}

export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await cachedDocument(Number(id));
  if (!doc) notFound();
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) notFound();
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) notFound();

  const [versions, branches, settings, canEdit, canPublishDirect] = await Promise.all([
    listVersions(doc.id),
    listBranches(doc.id),
    getAppSettings(),
    canEditSpace(user, doc.space_id),
    canPublishDirectly(user, doc.space_id),
  ]);

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
    whenExact: formatDateTime(v.created_at, settingsForUser(settings, user)),
  }));

  return (
    <PageContainer>
      <PageHeader
        back={{ href: `/doc/${doc.id}`, label: doc.title }}
        icon={<History />}
        title="Version history"
        subtitle={
          <>
            {doc.title}
            {doc.branch_of !== null && (
              <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-900/50">
                Draft branch
              </span>
            )}
          </>
        }
      />

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
