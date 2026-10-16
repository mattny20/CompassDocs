"use client";

// One place for everything that used to be a stack of colored banners on the
// doc page: read-confirmation (the reader's pointer), draft, branches in
// progress, and pending changes. A single neutral container with one compact
// row per notice, so document workflow state stops competing with the
// content.
//
// The reader's read-confirmation row (1.10.0, B1) is a pointer, not the
// control: one sentence and one action that jumps to the card after the
// article, where the confirmation is recorded. Its state comes from
// AckState, shared with that card and the sticky bar, so the three never
// disagree. The approver's progress ("14 of 20 people have confirmed") left
// this strip in 1.10.1: the shield popover (AckSettings, A5) carries the
// counts and the "View record" link, which also ends the two stacked rows an
// approver who is also a reader used to see.

import { useState } from "react";
import { Spinner } from "@/components/Spinner";
import { Button, buttonClass } from "@/components/Button";
import Link from "next/link";
import {
  ArrowDown,
  CalendarClock,
  CircleCheckBig,
  FileCheck,
  GitBranch,
  Hourglass,
  SquarePen,
} from "lucide-react";
import { useFormatDate } from "./SettingsProvider";
import { useAction } from "@/lib/use-action";
import { jumpToConfirmation, useAckState } from "@/components/AckState";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

const ROW = "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm";
const ICON = "h-4 w-4 shrink-0";

export function DocNotices({
  docId,
  ack,
  isDraft = false,
  branchCount = 0,
  pendingCount = 0,
  reviewOverdue,
}: {
  docId: number;
  /** Reader-side read confirmation (enterprise): null = not applicable.
   *  `canSubmit` is document.ack_submit in this space; the confirmed/pending
   *  state itself is read from AckState. */
  ack?: { canSubmit: boolean } | null;
  isDraft?: boolean;
  branchCount?: number;
  pendingCount?: number;
  /** Content review overdue (staff): server-formatted due date + edit rights. */
  reviewOverdue?: { dueDateLabel: string; canEdit: boolean } | null;
}) {
  const fmt = useFormatDate();
  const ackState = useAckState();
  const ackedAt = ackState?.ackedAt ?? null;
  const ackedRev = ackState?.ackedRev ?? null;

  const [reviewed, setReviewed] = useState(false);
  const { run, isBusy } = useAction();

  const hasAckRow = ack !== undefined && ack !== null;
  const hasReviewRow = Boolean(reviewOverdue) && !reviewed;
  const rows =
    (hasAckRow ? 1 : 0) +
    (isDraft ? 1 : 0) +
    (branchCount > 0 ? 1 : 0) +
    (pendingCount > 0 ? 1 : 0) +
    (hasReviewRow ? 1 : 0);
  if (rows === 0) return null;

  return (
    <div className="mb-8 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-surface print:hidden">
      {/* Reader row: tinted by the notice classes (both themes), ink
          inherited so the icon follows. One sentence and one action while
          pending (the action is w-full under sm: on a phone the row wraps
          and the link takes the second line); one sentence once confirmed;
          the permission explanation when the role cannot record one. */}
      {hasAckRow &&
        ack &&
        (ackedAt ? (
          <p className={`${ROW} notice-ok`}>
            <CircleCheckBig className={ICON} aria-hidden />
            <span className="min-w-0 flex-1">
              You confirmed {ackedRev !== null ? `version ${ackedRev}` : "reading this document"} on{" "}
              {fmt.dateTime(ackedAt)}.
            </span>
          </p>
        ) : ack.canSubmit ? (
          <div className={`${ROW} notice-warn`}>
            <FileCheck className={ICON} aria-hidden />
            <p className="min-w-0 flex-1">
              Please read this document carefully. You&apos;ll be asked to confirm at the end.
            </p>
            <Button
              variant="secondary"
              size="sm"
              href={`#${CONFIRM_SECTION_ID}`}
              icon={<ArrowDown />}
              onClick={jumpToConfirmation}
              className="w-full sm:w-auto"
            >
              Jump to confirmation
            </Button>
          </div>
        ) : (
          <p className={`${ROW} notice-warn`}>
            <FileCheck className={ICON} aria-hidden />
            <span className="min-w-0 flex-1">
              Read confirmation is required for this document, but your role can&apos;t record one.
              Ask your space approver.
            </span>
          </p>
        ))}

      {isDraft && (
        <p className={`${ROW} text-slate-600`}>
          <SquarePen className={`${ICON} text-slate-400`} />
          <span>
            This is a <strong>draft</strong>. It isn&apos;t visible to viewers yet.
          </span>
        </p>
      )}

      {branchCount > 0 && (
        <div className={`${ROW} text-slate-600`}>
          <GitBranch className={`${ICON} text-violet-600`} />
          <span className="min-w-0 flex-1">
            {branchCount} draft branch{branchCount === 1 ? "" : "es"} in progress.
          </span>
          <Link
            href={`/doc/${docId}/history`}
            className="shrink-0 font-medium text-compass-700 hover:underline"
          >
            View in history
          </Link>
        </div>
      )}

      {hasReviewRow && reviewOverdue && (
        <div className={`${ROW} text-slate-600`}>
          <CalendarClock className={`${ICON} text-amber-600`} />
          <span className="min-w-0 flex-1">
            Content review overdue: it was due {reviewOverdue.dueDateLabel}. Still accurate?
          </span>
          {reviewOverdue.canEdit && (
            <button
              onClick={async () => {
                const ok = await run(
                  "review",
                  () => fetch(`/api/documents/${docId}/review`, { method: "POST" }),
                  { fallback: "Couldn't mark the document as reviewed." }
                );
                if (ok) setReviewed(true);
              }}
              disabled={isBusy("review")}
              className={buttonClass("secondary")}
            >
              {isBusy("review") && <Spinner size="sm" />}
              Mark as reviewed
            </button>
          )}
        </div>
      )}

      {pendingCount > 0 && (
        <div className={`${ROW} text-slate-600`}>
          <Hourglass className={`${ICON} text-amber-600`} />
          <span className="min-w-0 flex-1">
            {pendingCount} pending change{pendingCount === 1 ? "" : "s"} awaiting review.
          </span>
          <Link href="/review" className="shrink-0 font-medium text-compass-700 hover:underline">
            Open review queue
          </Link>
        </div>
      )}
    </div>
  );
}
