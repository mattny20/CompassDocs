import Link from "next/link";
import { PageWidth } from "@/components/PageWidth";
import { notFound } from "next/navigation";
import {
  getDocument,
  listVersions,
  listBranches,
  listPendingForDocument,
  listAttachments,
  getApprovalMode,
} from "@/lib/db";
import { BranchBanner } from "@/components/BranchBanner";
import { ViewTracker } from "@/components/ViewTracker";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { resolveAuthorPerson } from "@/lib/directory";
import { featureEnabled } from "@/lib/ee";
import { getCurrentAck, ackStatusForDocument } from "@/lib/db";
import { DocNotices } from "@/components/DocNotices";
import { StickyDocBar } from "@/components/StickyDocBar";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime } from "@/lib/format";
import { MarkdownView } from "@/components/MarkdownView";
import { TypeBadge, StatusBadge, Tag } from "@/components/Badges";
import { DocActions } from "@/components/DocActions";
import { SuggestBox } from "@/components/SuggestBox";
import { DocComments } from "@/components/DocComments";
import { Attachments } from "@/components/Attachments";
import { RelatedDocs } from "@/components/RelatedDocs";
import { relationsFor } from "@/lib/relations";
import { roleAtLeast } from "@/lib/types";
import { timeAgo } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) notFound();
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, doc.space_id)) notFound();

  const isStaff = roleAtLeast(user.role, "editor");
  // Viewers may not see drafts.
  if (doc.status === "draft" && !isStaff) notFound();

  const versionCount = (await listVersions(doc.id)).length;
  const relations = doc.branch_of === null ? await relationsFor(doc.id, scope, isStaff) : [];
  const pending = roleAtLeast(user.role, "approver") ? await listPendingForDocument(doc.id) : [];
  const [settings, attachments, authorPerson, ackEnabled, hasEditRights] = await Promise.all([
    getAppSettings(),
    listAttachments(doc.id),
    resolveAuthorPerson(doc.author),
    featureEnabled("policy_ack"),
    canEditSpace(user, doc.space_id),
  ]);
  // Draft-branch context: the source doc for the banner, live branches for the note.
  const branchSource = doc.branch_of !== null ? await getDocument(doc.branch_of) : undefined;
  const branchCount = isStaff && doc.branch_of === null ? (await listBranches(doc.id)).length : 0;
  const mergeNeedsReview =
    branchSource?.status === "published" &&
    !roleAtLeast(user.role, "approver") &&
    (await getApprovalMode()) === "strict";
  const isApprover = roleAtLeast(user.role, "approver");
  // Reader banner state + approver progress, only when the feature is licensed.
  const myAck =
    ackEnabled && doc.ack_required === 1 && doc.status === "published"
      ? await getCurrentAck(doc.id, user.id)
      : undefined;
  const ackRows =
    ackEnabled && isApprover && doc.ack_required === 1 ? await ackStatusForDocument(doc.id) : [];

  return (
    <PageWidth>
      <ViewTracker docId={doc.id} />
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 print:hidden">
        <Link href="/" className="hover:text-slate-600">
          Home
        </Link>
        <span>/</span>
        <Link href={`/spaces/${doc.space_slug}`} className="hover:text-slate-600">
          {doc.space_icon} {doc.space_name}
        </Link>
      </nav>

      {/* Masthead: pure typography — badges, title, one meta line, summary as
          a plain lede. Workflow state lives in the single notice strip below. */}
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <TypeBadge type={doc.type} />
            <StatusBadge status={doc.status} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{doc.title}</h1>
        </div>
        <DocActions
          id={doc.id}
          spaceSlug={doc.space_slug}
          role={user.role}
          isPublished={doc.status === "published"}
          hasEditRights={hasEditRights}
          isBranch={doc.branch_of !== null}
          ack={
            ackEnabled && isApprover && doc.branch_of === null
              ? { required: doc.ack_required === 1 }
              : undefined
          }
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
        <span>
          By{" "}
          {authorPerson ? (
            <Link
              href={`/directory/${authorPerson.id}`}
              className="font-medium text-slate-700 hover:text-compass-700 hover:underline"
              title={[authorPerson.title, authorPerson.department].filter(Boolean).join(" · ") || undefined}
            >
              {doc.author}
            </Link>
          ) : (
            <span className="font-medium text-slate-700">{doc.author}</span>
          )}
        </span>
        <span>·</span>
        <span title={formatDateTime(doc.updated_at, settings)}>Updated {timeAgo(doc.updated_at)}</span>
        <span>·</span>
        <Link href={`/doc/${doc.id}/history`} className="hover:text-compass-600">
          {versionCount} version{versionCount === 1 ? "" : "s"}
        </Link>
        {doc.tags.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>·</span>
            {doc.tags.map((t) => (
              <Tag key={t} label={t} />
            ))}
          </span>
        )}
      </div>

      {doc.summary && (
        <p className="mb-5 max-w-3xl text-lg leading-relaxed text-slate-600">{doc.summary}</p>
      )}

      <hr className="mb-6 border-slate-100 print:hidden" />

      <StickyDocBar>
        <StatusBadge status={doc.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
          {doc.title}
        </span>
        <DocActions
          id={doc.id}
          spaceSlug={doc.space_slug}
          role={user.role}
          isPublished={doc.status === "published"}
          hasEditRights={hasEditRights}
          isBranch={doc.branch_of !== null}
        />
      </StickyDocBar>

      {doc.branch_of !== null && branchSource ? (
        <BranchBanner
          branchId={doc.id}
          sourceId={branchSource.id}
          sourceTitle={branchSource.title}
          canEdit={isStaff && hasEditRights}
          needsReview={Boolean(mergeNeedsReview)}
        />
      ) : (
        <DocNotices
          docId={doc.id}
          ack={
            ackEnabled && doc.ack_required === 1 && doc.status === "published"
              ? { ackedAt: myAck?.acknowledged_at ?? null }
              : undefined
          }
          ackProgress={
            ackEnabled && isApprover && doc.ack_required === 1 && doc.status === "published"
              ? {
                  ackedCount: ackRows.filter((r) => r.acknowledged_at).length,
                  requiredCount: ackRows.length,
                }
              : undefined
          }
          isDraft={doc.status === "draft" && isStaff}
          branchCount={branchCount}
          pendingCount={pending.length}
        />
      )}

      <div className="lg:flex lg:items-start lg:gap-10">
        <div className="min-w-0 flex-1">
          <article>
            <MarkdownView content={doc.content} docKey={`doc-${doc.id}`} />
          </article>

          {settings.comments_enabled && (
            <DocComments docId={doc.id} currentUserId={user.id} isAdmin={user.role === "admin"} />
          )}
        </div>

        <aside className="mt-10 space-y-8 border-t border-slate-100 pt-8 print:hidden lg:sticky lg:top-6 lg:mt-0 lg:max-h-[calc(100vh-3rem)] lg:w-72 lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
          {doc.branch_of === null && (
            <RelatedDocs docId={doc.id} initial={relations} canEdit={isStaff && hasEditRights} />
          )}
          <Attachments
            documentId={doc.id}
            attachments={attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mime_type: a.mime_type,
              size: a.size,
            }))}
            canEdit={isStaff && hasEditRights}
            maxMb={settings.max_attachment_mb}
          />
          <SuggestBox documentId={doc.id} />
        </aside>
      </div>
    </PageWidth>
  );
}
