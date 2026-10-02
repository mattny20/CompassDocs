import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageWidth } from "@/components/PageWidth";
import { notFound } from "next/navigation";
import {
  getDocument,
  listVersions,
  listBranches,
  listPendingForDocument,
  listAttachments,
  listDmsLinks,
  getApprovalMode,
  isTrainingDeckDoc,
} from "@/lib/db";
import { BranchBanner } from "@/components/BranchBanner";
import { ViewTracker } from "@/components/ViewTracker";
import { requireUser } from "@/lib/auth";
import { userHolds, canPublishDirectly, canSeeDrafts, spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { resolveAuthorPerson } from "@/lib/directory";
import { featureEnabled } from "@/lib/ee";
import { getCurrentAck, ackStatusForDocument } from "@/lib/db";
import { DocNotices } from "@/components/DocNotices";
import { StickyDocBar } from "@/components/StickyDocBar";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate, formatDateTime, settingsForUser } from "@/lib/format";
import { MarkdownView } from "@/components/MarkdownView";
import { DocToc } from "@/components/DocToc";
import { DocLayout } from "@/components/DocLayout";
import { TypeBadge, StatusBadge, Tag } from "@/components/Badges";
import { DocActions } from "@/components/DocActions";
import { SuggestBox } from "@/components/SuggestBox";
import { DocComments } from "@/components/DocComments";
import { DocFeedback } from "@/components/DocFeedback";
import { Attachments } from "@/components/Attachments";
import { RelatedDocs } from "@/components/RelatedDocs";
import { relationsFor } from "@/lib/relations";
import { SubPages } from "@/components/SubPages";
import { ancestorsOf, childrenOf, MAX_DEPTH } from "@/lib/doc-tree";
import { backlinksFor } from "@/lib/backlinks";
import { ReviewSchedule } from "@/components/ReviewSchedule";
import { REVIEW_INTERVALS } from "@/lib/reviews";
import { ShareCard } from "@/components/ShareCard";
import { shareLinksEnabled, getActiveShare } from "@/lib/shares";
import { Link2 } from "lucide-react";
import { timeAgo } from "@/lib/ui";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `${doc.title}` : "Document" };
}

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await cachedDocument(Number(id));
  if (!doc) notFound();
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, doc.space_id)) notFound();

  // Two scopes of the same question: drafts of THIS document's space, and
  // drafts anywhere — relations and backlinks reach into other spaces, and a
  // grant on this space says nothing about those.
  const [isStaff, seeDraftsAnywhere] = await Promise.all([
    canSeeDrafts(user, doc.space_id),
    canSeeDrafts(user),
  ]);
  if (doc.status === "draft" && !isStaff) notFound();

  const versionCount = (await listVersions(doc.id)).length;
  const relations =
    doc.branch_of === null ? await relationsFor(doc.id, scope, seeDraftsAnywhere) : [];
  const pending = (await userHolds(user, "change_request.read", {
    spaceId: doc.space_id,
    legacyMin: "approver",
  }))
    ? await listPendingForDocument(doc.id)
    : [];
  const [settings, attachments, dmsLinks, authorPerson, ackEnabled, hasEditRights] =
    await Promise.all([
      getAppSettings(),
      listAttachments(doc.id),
      listDmsLinks(doc.id),
      resolveAuthorPerson(doc.author),
      featureEnabled("policy_ack"),
      canEditSpace(user, doc.space_id),
    ]);
  // Content review state (staff-facing; readers never see review chrome).
  const reviewDueAt = doc.review_due_at ?? null;
  const reviewOverdue =
    reviewDueAt !== null && new Date(reviewDueAt).getTime() <= Date.now() && doc.status === "published";
  const reviewDueLabel = reviewDueAt ? formatDate(reviewDueAt, settingsForUser(settings, user)) : "";
  const lastReviewedLabel = doc.last_reviewed_at
    ? `Last reviewed ${formatDate(doc.last_reviewed_at, settingsForUser(settings, user))}${doc.last_reviewed_by ? ` by ${doc.last_reviewed_by}` : ""}.`
    : "";

  // Public share links (admin-gated; staff with edit rights manage them).
  const sharesOn = isStaff && hasEditRights && doc.branch_of === null && (await shareLinksEnabled());
  const activeShare = sharesOn ? await getActiveShare(doc.id) : undefined;

  // Nested pages + backlinks (both admin-gated, and never on draft branches).
  const nestedOn = settings.nested_pages_enabled && doc.branch_of === null;
  const [ancestors, children, backlinks] = await Promise.all([
    nestedOn ? ancestorsOf(doc.id) : Promise.resolve([]),
    nestedOn ? childrenOf(doc.id, { includeDrafts: isStaff }) : Promise.resolve([]),
    settings.backlinks_enabled && doc.branch_of === null
      ? backlinksFor(doc.id, scope, seeDraftsAnywhere)
      : Promise.resolve([]),
  ]);
  // Draft-branch context: the source doc for the banner, live branches for the note.
  const branchSource = doc.branch_of !== null ? await getDocument(doc.branch_of) : undefined;
  const branchCount = isStaff && doc.branch_of === null ? (await listBranches(doc.id)).length : 0;
  const mergeNeedsReview =
    branchSource?.status === "published" && !(await canPublishDirectly(user, doc.space_id));
  // The toolbar's two main decisions, resolved here rather than in the client
  // component that renders them. canEditSpace already answers "may they author
  // in this space" from permissions, so edit rights ARE the answer; deleting
  // asks the same pair of permissions the DELETE route enforces, so the button
  // and the request agree.
  const canEdit = hasEditRights;
  const canDelete =
    hasEditRights &&
    (await userHolds(
      user,
      doc.status === "published" ? "document.delete_published" : "document.delete_draft",
      { spaceId: doc.space_id, legacyMin: doc.status === "published" ? "approver" : "editor" }
    ));
  // Three separate rights that were one rung before 1.0: seeing who has read a
  // policy, deciding that one must be read, and minting a template.
  const [canReadAckRoster, canRequireAck, canSaveAsTemplate] = await Promise.all([
    userHolds(user, "document.ack_roster_read", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "template.manage", { legacyMin: "admin" }),
  ]);
  // Reader banner state + approver progress, only when the feature is licensed.
  const myAck =
    ackEnabled && doc.ack_required === 1 && doc.status === "published"
      ? await getCurrentAck(doc.id, user.id)
      : undefined;
  const ackRows =
    ackEnabled && canReadAckRoster && doc.ack_required === 1
      ? await ackStatusForDocument(doc.id)
      : [];

  return (
    <PageWidth>
      <ViewTracker docId={doc.id} />
      <Breadcrumbs
        items={[
          { href: "/", label: "Home" },
          { href: `/spaces/${doc.space_slug}`, label: `${doc.space_icon} ${doc.space_name}` },
          // Ancestor pages, outermost first (nested pages).
          ...[...ancestors].reverse().map((a) => ({ href: `/doc/${a.id}`, label: a.title, title: a.title })),
        ]}
      />

      {/* Masthead: pure typography — badges, title, one meta line, summary as
          a plain lede. Workflow state lives in the single notice strip below. */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <TypeBadge type={doc.type} />
            <StatusBadge status={doc.status} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{doc.title}</h1>
        </div>
        <DocActions
          id={doc.id}
          spaceSlug={doc.space_slug}
          canEdit={canEdit}
          canDelete={canDelete}
          canSaveAsTemplate={canSaveAsTemplate}
          isPublished={doc.status === "published"}
          isBranch={doc.branch_of !== null}
          ack={
            ackEnabled && canRequireAck && doc.branch_of === null
              ? { required: doc.ack_required === 1 }
              : undefined
          }
          sharePanel={
            sharesOn ? (
              <ShareCard
                docId={doc.id}
                initial={
                  activeShare
                    ? {
                        token: activeShare.token,
                        url: `/share/${activeShare.token}`,
                        expires_at: activeShare.expires_at,
                        view_count: activeShare.view_count,
                      }
                    : null
                }
                isPublished={doc.status === "published"}
              />
            ) : undefined
          }
          reviewPanel={
            isStaff && hasEditRights && doc.branch_of === null ? (
              <ReviewSchedule
                docId={doc.id}
                intervals={REVIEW_INTERVALS}
                interval={doc.review_interval_days ?? null}
                overdue={reviewOverdue}
                dueDateLabel={reviewDueLabel}
                lastReviewedLabel={lastReviewedLabel}
                isPublished={doc.status === "published"}
              />
            ) : undefined
          }
          reviewOverdue={reviewOverdue}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
        <span>
          By{" "}
          {authorPerson ? (
            <Link
              href={`/directory/${authorPerson.id}`}
              className="font-medium text-slate-700 hover:text-compass-700 hover:underline"
              data-tt={[authorPerson.title, authorPerson.department].filter(Boolean).join(" · ") || undefined} aria-label={[authorPerson.title, authorPerson.department].filter(Boolean).join(" · ") || undefined}
            >
              {doc.author}
            </Link>
          ) : (
            <span className="font-medium text-slate-700">{doc.author}</span>
          )}
        </span>
        <span>·</span>
        <span title={formatDateTime(doc.updated_at, settingsForUser(settings, user))}>Updated {timeAgo(doc.updated_at)}</span>
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
          canEdit={canEdit}
          canDelete={canDelete}
          canSaveAsTemplate={canSaveAsTemplate}
          isPublished={doc.status === "published"}
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
            ackEnabled && canReadAckRoster && doc.ack_required === 1 && doc.status === "published"
              ? {
                  ackedCount: ackRows.filter((r) => r.acknowledged_at).length,
                  requiredCount: ackRows.length,
                }
              : undefined
          }
          isDraft={doc.status === "draft" && isStaff}
          branchCount={branchCount}
          pendingCount={pending.length}
          reviewOverdue={
            reviewOverdue && isStaff
              ? { dueDateLabel: reviewDueLabel, canEdit: hasEditRights }
              : undefined
          }
        />
      )}

      {/* Rail beside the article at Wide/Full, under it at Normal; the table
          of contents rides in the rail when there is one. */}
      <DocLayout
        toc={<DocToc title={doc.title} />}
        aside={
          <>
            {nestedOn && (
              <SubPages
                parentId={doc.id}
                spaceSlug={doc.space_slug}
                initial={children.map((c) => ({ id: c.id, title: c.title, status: c.status }))}
                canEdit={isStaff && hasEditRights}
                canAddChild={ancestors.length + 1 < MAX_DEPTH}
              />
            )}
            {doc.branch_of === null && (
              <RelatedDocs docId={doc.id} initial={relations} canEdit={isStaff && hasEditRights} />
            )}
            {settings.backlinks_enabled && doc.branch_of === null && backlinks.length > 0 && (
              <section>
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <Link2 className="h-3.5 w-3.5" aria-hidden /> Linked from
                </h2>
                <ul className="space-y-1">
                  {backlinks.map((b) => (
                    <li key={b.id} className="min-w-0">
                      <Link
                        href={`/doc/${b.id}`}
                        className="block truncate text-sm font-medium text-slate-700 hover:text-compass-600"
                        data-tt={b.title} aria-label={b.title}
                      >
                        {b.title}
                      </Link>
                      <span className="block truncate text-xs text-slate-500">
                        {b.space_icon} {b.space_name}
                        {b.status === "draft" ? " · draft" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <Attachments
              documentId={doc.id}
              attachments={attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mime_type: a.mime_type,
                size: a.size,
              }))}
              dmsLinks={dmsLinks.map((l) => ({
                id: l.id,
                system: l.system,
                title: l.title,
                url: l.url,
              }))}
              canEdit={isStaff && hasEditRights}
              maxMb={settings.max_attachment_mb}
            />
            <SuggestBox documentId={doc.id} />
          </>
        }
      >
        <>
          {/* doc-read scopes the reading measure to the document body only —
              the masthead, rail, notices and sticky bar above keep the full
              width preference. */}
          <article className="doc-read">
            <MarkdownView
              content={doc.content}
              docKey={`doc-${doc.id}`}
              dropTitle={doc.title}
              // Training decks use --- as slide breaks: invisible when the doc
              // is read as a page, meaningful only in the deck player.
              slideBreaks={(await isTrainingDeckDoc(doc.id)) ? "hidden" : undefined}
            />
          </article>

          <DocFeedback docId={doc.id} />

          {settings.comments_enabled && (
            <DocComments docId={doc.id} currentUserId={user.id} isAdmin={user.role === "admin"} />
          )}
        </>
      </DocLayout>
    </PageWidth>
  );
}
