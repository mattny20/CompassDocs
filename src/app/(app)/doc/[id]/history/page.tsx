import { History } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { PageHeader } from "@/components/PageHeader";
import { notFound } from "next/navigation";
import { getDocument, listVersions, listBranches, getApprovalMode, listAckDecisions } from "@/lib/db";
import type { AckDecision } from "@/lib/db";
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

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** A compare to open with (B3): ?from={versionId}&to={versionId|current}. */
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await cachedDocument(Number(id));
  if (!doc) notFound();
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) notFound();
  if (doc.status === "draft" && !(await canSeeDrafts(user, doc.space_id))) notFound();

  const [versions, branches, settings, canEdit, canPublishDirect, decisions] = await Promise.all([
    listVersions(doc.id),
    listBranches(doc.id),
    getAppSettings(),
    canEditSpace(user, doc.space_id),
    canPublishDirectly(user, doc.space_id),
    // The read-confirmation ledger (C1): which versions asked everyone again
    // and which were kept. Only a document that requires confirmation has one.
    doc.ack_required === 1 ? listAckDecisions(doc.id) : Promise.resolve([] as AckDecision[]),
  ]);

  // The compare the link asked for (the card's "Open in version history",
  // B3). Only this document's own version ids are honoured, "current" is
  // the newest, and anything else (another document's id, a typo, the same
  // version on both sides) falls back to the default compare, so the link
  // can never show a version the three checks above did not admit.
  const sp = await searchParams;
  const resolve = (raw: string | undefined): number | null => {
    if (!raw) return null;
    if (raw === "current") return versions[0]?.id ?? null;
    const n = Number(raw);
    return Number.isInteger(n) && versions.some((v) => v.id === n) ? n : null;
  };
  let initialOld = resolve(sp.from);
  let initialNew = resolve(sp.to);
  if (initialOld !== null && initialOld === initialNew) {
    initialOld = null;
    initialNew = null;
  }

  // Oldest = v1; the list arrives newest-first.
  const items = versions.map((v, i) => ({
    id: v.id,
    rev: versions.length - i,
    title: v.title,
    content: v.content,
    author: v.author,
    note: v.note,
    restored_from: v.restored_from,
    approved_by_name: v.approved_by_name ?? "",
    when: timeAgo(v.created_at),
    whenExact: formatDateTime(v.created_at, settingsForUser(settings, user)),
    createdAt: v.created_at,
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
              <span className={chipClass("label", "md", "ml-2")}>
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
        decisions={decisions.map((d) => ({
          version_id: d.version_id,
          outcome: d.outcome,
          decided_by_name: d.decided_by_name,
          submitted_by_name: d.submitted_by_name,
          submitted_policy: d.submitted_policy,
        }))}
        initialOld={initialOld}
        initialNew={initialNew}
        ackRequired={doc.ack_required === 1}
      />
    </PageContainer>
  );
}
