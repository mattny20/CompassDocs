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
import {
  getCurrentAck,
  getLatestAck,
  getAckVersionInfo,
  getAttestedVersion,
  ackSummary,
  lastAckDecision,
  getUserByUsername,
  hasOpenAssignment,
} from "@/lib/db";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { askedClause } from "./acknowledgements/ack-sentence";
import { recertStatusLine } from "@/lib/ack-recert";
import { DocNotices } from "@/components/DocNotices";
import { StickyDocBar } from "@/components/StickyDocBar";
import { AckProvider } from "@/components/AckState";
import type { AckReason, PriorConfirmation } from "@/components/AckState";
import { AckCard } from "@/components/AckCard";
import { AckStickyControl } from "@/components/AckStickyControl";
import { RelativeTime } from "@/components/RelativeTime";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate, formatDay, settingsForUser } from "@/lib/format";
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

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `${doc.title}` : "Document" };
}

/** Whole calendar months from one moment to another, at least one ("It has been 12 months since…"). */
function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(1, months);
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

  const versions = await listVersions(doc.id);
  const versionCount = versions.length;
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
  const fmtSettings = settingsForUser(settings, user);
  // Content review state (staff-facing; readers never see review chrome).
  const reviewDueAt = doc.review_due_at ?? null;
  const reviewOverdue =
    reviewDueAt !== null && new Date(reviewDueAt).getTime() <= Date.now() && doc.status === "published";
  const reviewDueLabel = reviewDueAt ? formatDate(reviewDueAt, fmtSettings) : "";
  const lastReviewedLabel = doc.last_reviewed_at
    ? `Last reviewed ${formatDate(doc.last_reviewed_at, fmtSettings)}${doc.last_reviewed_by ? ` by ${doc.last_reviewed_by}` : ""}.`
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
  // A retired policy (G3, 1.12.0): the notices strip shows one neutral row
  // for everyone, with the replacement as a link when this reader may open
  // it (its space scope, and the draft rule); the card and the sticky chip
  // are gone on their own, since the requirement is off.
  const replacement =
    ackEnabled && doc.ack_retired_at && doc.ack_superseded_by ? await getDocument(doc.ack_superseded_by) : undefined;
  const retired =
    ackEnabled && doc.ack_retired_at
      ? {
          at: doc.ack_retired_at,
          replacedBy:
            replacement &&
            scopeAllows(scope, replacement.space_id) &&
            (replacement.status === "published" || seeDraftsAnywhere)
              ? { id: replacement.id, title: replacement.title }
              : null,
        }
      : null;
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
  // Four separate rights that were one rung before 1.0: seeing who has read a
  // policy, deciding that one must be read, recording that you have read it,
  // and minting a template. The reader check mirrors the POST /ack guard, so
  // a role without it sees an explanation instead of a 403.
  const [canReadAckRoster, canRequireAck, canSubmitAck, canSaveAsTemplate] = await Promise.all([
    userHolds(user, "document.ack_roster_read", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "document.ack_submit", { spaceId: doc.space_id, legacyMin: "viewer" }),
    userHolds(user, "template.manage", { legacyMin: "admin" }),
  ]);
  // Read confirmation applies to a published, required, non-branch document
  // when the feature is licensed, and never to a retired one (G3): retiring
  // switches the requirement off in the same UPDATE, but a row re-required
  // by a 1.11.2 binary while rolled back comes back as both, and the card
  // must not sit under the "Retired …" notice. The reader's own record and
  // the version they are asked to confirm (A1) seed the shared AckState.
  const ackActive =
    ackEnabled &&
    doc.ack_required === 1 &&
    doc.status === "published" &&
    doc.branch_of === null &&
    doc.ack_retired_at === null;
  // The audience (D1, 1.13.0): the card, the sticky control and the notice
  // row appear only for a person the policy asks (an open assignment row:
  // not removed from the audience, not exempt). Everyone else reads the
  // document as any other; POST /ack answers them 400 as well.
  const [myAck, ackVersion, ackAssigned] = ackActive
    ? await Promise.all([getCurrentAck(doc.id, user.id), getAckVersionInfo(doc.id), hasOpenAssignment(doc.id, user.id)])
    : [undefined, null, false];
  const showAckCard = ackActive && canSubmitAck && ackAssigned;
  // The re-confirmation view (B3): when no confirmation counts but the
  // reader has one that lapsed, the page works out what they confirmed
  // (getLatestAck, the version inferred for rows from before 1.10.0),
  // which versions came since, the text they confirmed (getAttestedVersion,
  // C5) and why they are asked again: the newest reset since they
  // confirmed, from the ledger, or the newest version's note when the
  // ledger has no row for it (a reset from before 1.10.0 left none). The
  // texts travel to the card as props, so no endpoint serves them.
  const priorAck = ackActive && !myAck ? await getLatestAck(doc.id, user.id) : undefined;
  const confirmedVersionId = priorAck?.version_id ?? null;
  const revOf = new Map(versions.map((v, i) => [v.id, versions.length - i]));
  const changesSince = confirmedVersionId !== null ? versions.filter((v) => v.id > confirmedVersionId) : [];
  const [baselineVersion, lapseDecision] = priorAck
    ? await Promise.all([
        confirmedVersionId !== null ? getAttestedVersion(confirmedVersionId) : Promise.resolve(undefined),
        lastAckDecision(doc.id, { outcome: "reset" }),
      ])
    : [undefined, null];
  const baseline =
    baselineVersion && baselineVersion.document_id === doc.id
      ? { title: baselineVersion.title, content: baselineVersion.content }
      : null;
  const newestSince = changesSince[0];
  // Only a reset taken after the person confirmed can be why they are asked
  // again; an older row belongs to a lapse they already dealt with.
  const lapseRow =
    priorAck && lapseDecision && new Date(lapseDecision.decided_at).getTime() >= new Date(priorAck.acknowledged_at).getTime()
      ? lapseDecision
      : null;
  const ackReason: AckReason | null =
    priorAck && lapseRow
      ? lapseRow.source === "recurrence"
        ? { kind: "recurrence", months: monthsBetween(priorAck.acknowledged_at, lapseRow.decided_at) }
        : {
            kind: lapseRow.scope === "users" ? "person" : lapseRow.source === "manual" ? "manual" : "edit",
            at: lapseRow.decided_at,
            by: lapseRow.decided_by_name || newestSince?.author || "",
            note: lapseRow.reason,
          }
      : newestSince
        ? { kind: "edit", at: newestSince.created_at, by: newestSince.author, note: newestSince.note }
        : null;
  const prior: PriorConfirmation | null = priorAck
    ? {
        ackedAt: priorAck.acknowledged_at,
        versionId: confirmedVersionId,
        rev: priorAck.rev,
        inferred: priorAck.version_inferred,
        changed: changesSince.length > 0,
        reason: ackReason,
      }
    : null;
  // The workspace defaults (E4): the statement readers agree to on the card,
  // and the edit default the shield popover marks "(workspace default)".
  const complianceSettings = ackEnabled ? await getComplianceSettings() : null;
  // The shield popover (A5) for holders of document.ack_require: the counts
  // (never names) for its question and status line, the per-document edit
  // default, and the one sentence "42 of 50 confirmed · v12 · asked 3 Mar
  // 2026 by Matt" (the roster's own clause, minus the reason). The approver
  // progress row left the notice strip for this popover (B1).
  const showAckSettings = ackEnabled && canRequireAck && doc.branch_of === null;
  // scope 'all' (D4, 1.13.0): a per-person re-ask writes a 'reset' row of
  // scope 'users'; the popover's "asked {date} by {name}" is the document's
  // last ask, never one person's.
  const [ackSum, lastReset] = showAckSettings
    ? await Promise.all([ackSummary(doc.id), ackActive ? lastAckDecision(doc.id, { outcome: "reset", scope: "all" }) : null])
    : [null, null];
  // While nobody has been told, which is the state a quiet switch-on leaves
  // (no reset decision, no reminder stamp), the line says so: askedClause
  // would otherwise date the ask from ack_revision_at, the last text change,
  // naming a day on which nobody was asked.
  const nobodyAskedYet = !lastReset && !doc.ack_last_reminded_at;
  const ackStatusLine =
    ackSum && ackActive
      ? `${ackSum.current} of ${ackSum.eligible} confirmed · ${ackSum.rev ? `v${ackSum.rev}` : "current version"} · ${
          nobodyAskedYet
            ? "no notice sent yet"
            : askedClause({
                asked: lastReset ? { ...lastReset, reason: "" } : null,
                author: ackVersion?.author ?? "",
                resetAt: doc.ack_revision_at,
                formatDate: (iso) => formatDate(iso, fmtSettings),
              })
        }`
      : null;
  const ackSettings =
    ackSum && complianceSettings
      ? {
          title: doc.title,
          required: doc.ack_required === 1,
          editDefault: ackSum.edit_default,
          workspaceDefault: complianceSettings.ack_defaults.edit_default,
          summary: { eligible: ackSum.eligible, current: ackSum.current, rev: ackSum.rev },
          statusLine: ackStatusLine,
          // The cycle (G1): "Re-confirm yearly · next 1 Jan 2027", or nothing.
          // The next date is the day the manager chose (midnight UTC), so
          // the day formatter, never the zone-shifting instant one.
          recertLine: recertStatusLine(ackSum, (iso) => formatDay(iso, fmtSettings)),
          canViewRecord: canReadAckRoster,
          viewerName: user.name || user.username,
          // A retired policy (G3): the popover points at the Settings tab
          // instead of offering a switch PATCH /ack would refuse with 409.
          // Whoever sees the popover holds document.ack_require on the
          // space, which is the tab's own gate.
          retired: doc.ack_retired_at ? { at: doc.ack_retired_at, canOpenSettings: canRequireAck } : null,
        }
      : undefined;
  // The reader confirms the text on screen, which is the newest version:
  // POST /ack must cite it (409 otherwise). It is the marker's version too
  // except after a kept edit (A2), when the marker stays behind.
  const ackSeed = ackActive
    ? {
        ackedAt: myAck?.acknowledged_at ?? null,
        ackedVersionId: myAck?.version_id ?? null,
        ackedRev: myAck?.rev ?? null,
        versionId: ackVersion?.latest_version_id ?? ackVersion?.version_id ?? doc.ack_version_id,
        rev: ackVersion?.latest_rev ?? ackVersion?.rev ?? null,
        canSubmit: canSubmitAck,
        prior,
      }
    : null;
  const ackPublishedLabel = ackActive
    ? formatDate(ackVersion?.latest_created_at ?? ackVersion?.created_at ?? doc.updated_at, fmtSettings)
    : null;
  // The typed signature (C2): whether this document asks for one, and
  // whether the reader's account has a password to re-enter (a local
  // account); an SSO account signs with its name and is identified by its
  // session. Read only when the card will ask, never echoed to the client
  // beyond the yes/no.
  const ackSignature = showAckCard && doc.ack_signature === 1;
  const ackLocalAccount = ackSignature ? Boolean((await getUserByUsername(user.username))?.password_hash) : false;

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
          ack={ackSettings}
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
        <span>
          Updated <RelativeTime value={doc.updated_at} />
        </span>
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

      {/* Read-confirmation state shared by the notice strip, the sticky bar
          and the card after the article (siblings below this point). */}
      <AckProvider seed={ackSeed}>
      <StickyDocBar>
        {/* The confirmation control comes first so it survives truncation;
            under sm the bar is the control and the title only. */}
        {showAckCard && <AckStickyControl />}
        <span className={showAckCard ? "hidden sm:contents" : "contents"}>
          <StatusBadge status={doc.status} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
          {doc.title}
        </span>
        <div className="hidden min-w-0 sm:flex">
          <DocActions
            id={doc.id}
            spaceSlug={doc.space_slug}
            canEdit={canEdit}
            canDelete={canDelete}
            canSaveAsTemplate={canSaveAsTemplate}
            isPublished={doc.status === "published"}
            isBranch={doc.branch_of !== null}
          />
        </div>
      </StickyDocBar>

      {doc.branch_of !== null && branchSource ? (
        <BranchBanner
          branchId={doc.id}
          sourceId={branchSource.id}
          sourceTitle={branchSource.title}
          sourceUpdatedAt={branchSource.updated_at}
          sourceAckRequired={ackEnabled && branchSource.ack_required === 1}
          branchTitle={doc.title}
          branchContent={doc.content}
          canEdit={isStaff && hasEditRights}
          needsReview={Boolean(mergeNeedsReview)}
        />
      ) : (
        <DocNotices
          docId={doc.id}
          ack={ackActive && ackAssigned ? { canSubmit: canSubmitAck } : undefined}
          isDraft={doc.status === "draft" && isStaff}
          branchCount={branchCount}
          pendingCount={pending.length}
          retired={retired}
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

          {/* The reading comes first: the confirmation card sits after the
              article and before the feedback row (B1). */}
          {showAckCard && (
            <AckCard
              docId={doc.id}
              // The name a signature must match (lib/attestation compares
              // against the same fallback) and the printed line's subject.
              readerName={user.name || user.username}
              // The policy's own confirmation statement (C2), else the
              // workspace default (E4).
              statement={doc.ack_statement ?? complianceSettings?.compliance_statement_default}
              // The typed signature (C2): the Sign to confirm block, the
              // password field for a local account, and the name on the
              // reader's current confirmation for the done state.
              signature={ackSignature}
              localAccount={ackLocalAccount}
              signedName={myAck?.signed_name ?? null}
              // The policy's dates (G1): "Effective 1 Jan 2026 · re-confirm
              // yearly" under the version line.
              effectiveAt={doc.ack_effective_at}
              recertMonths={doc.ack_recert_months}
              // The newest version's provenance (C6), the one the reader
              // confirms: the stamped publisher over the byline, and the
              // approver when a change request carried it. A document with
              // no versions has every field blank, so the line still
              // renders without the clause.
              meta={{
                rev: ackSeed?.rev ?? null,
                publishedLabel: ackPublishedLabel,
                author:
                  ackVersion?.latest_published_by_name ||
                  ackVersion?.latest_author ||
                  ackVersion?.author ||
                  doc.author,
                approvedBy: ackVersion?.latest_approved_by_name || undefined,
              }}
              // The re-confirmation view (B3): the text on screen, the text
              // the reader confirmed and the versions in between.
              current={{ title: doc.title, content: doc.content }}
              baseline={baseline}
              changesSince={changesSince.map((v) => ({
                id: v.id,
                rev: revOf.get(v.id) ?? 0,
                note: v.note,
                author: v.author,
                createdAt: v.created_at,
              }))}
            />
          )}

          <DocFeedback docId={doc.id} />

          {settings.comments_enabled && (
            <DocComments docId={doc.id} currentUserId={user.id} isAdmin={user.role === "admin"} />
          )}
        </>
      </DocLayout>
      </AckProvider>
    </PageWidth>
  );
}
