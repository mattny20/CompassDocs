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
// approver who is also a reader used to see. When an earlier confirmation
// lapsed (B3, 1.11.0) the sentence says so, honestly: "changed since you
// confirmed it on 3 Mar" only when the text did change, and the re-ask's
// own shape otherwise. The change notes and the diff stay in the card.
// A deadline (E1, 1.13.0) adds " by 29 Oct 2026" to that one sentence and
// nothing else: the row keeps one sentence and one action; the chips and
// the overdue copy are the sticky bar's and the card's.

import { useState } from "react";
import { Spinner } from "@/components/Spinner";
import { Button, buttonClass } from "@/components/Button";
import Link from "next/link";
import {
  Archive,
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
import { jumpToConfirmation, monthsLabel, useAckState } from "@/components/AckState";
import type { PriorConfirmation } from "@/components/AckState";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

const ROW = "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm";
const ICON = "h-4 w-4 shrink-0";

const FIRST_REQUEST = "Please read this document carefully. You'll be asked to confirm at the end.";

/**
 * The one sentence for a reader whose confirmation lapsed. A text change
 * says so whatever caused the reset; without one the sentence takes the
 * shape of the re-ask (manual, annual, per-person) so nobody is told a
 * document changed when it did not. The last line covers a marker that
 * moved with neither a version nor a ledger row (a reset from before
 * 1.10.0).
 */
export function reconfirmSentence(prior: PriorConfirmation, date: (iso: string) => string): string {
  if (prior.changed) {
    return `This document changed since you confirmed it on ${date(prior.ackedAt)}. Please read the changes and confirm again.`;
  }
  const r = prior.reason;
  if (r?.kind === "recurrence") {
    return `It has been ${monthsLabel(r.months)} since you confirmed this document. Please read it again and confirm.`;
  }
  if (r?.kind === "manual") {
    return `Everyone was asked to confirm this document again on ${date(r.at)}. Please read it and confirm again.`;
  }
  if (r?.kind === "person") {
    // The same fallback as the card's reason line: a row with no name never
    // opens with a bare "asked you".
    return `${r.by || "A manager"} asked you to confirm this document again on ${date(r.at)}. Please read it and confirm again.`;
  }
  return "You were asked to confirm this document again. Please read it and confirm again.";
}

/**
 * The pending sentence with the reader's deadline (E1): "… You'll be asked
 * to confirm at the end by 29 Oct 2026." / "… Please read it and confirm
 * again by 29 Oct 2026." `dueBy` is the server-formatted date, or nothing.
 */
export function withDueBy(sentence: string, dueBy: string | null | undefined): string {
  if (!dueBy) return sentence;
  return `${sentence.replace(/\.$/, "")} by ${dueBy}.`;
}

export function DocNotices({
  docId,
  ack,
  isDraft = false,
  branchCount = 0,
  pendingCount = 0,
  reviewOverdue,
  retired,
}: {
  docId: number;
  /** Reader-side read confirmation (enterprise): null = not applicable.
   *  `canSubmit` is document.ack_submit in this space; the confirmed/pending
   *  state itself is read from AckState. `dueBy` is the reader's deadline
   *  (E1), formatted by the page, appended to the pending sentence. */
  ack?: { canSubmit: boolean; dueBy?: string | null } | null;
  isDraft?: boolean;
  branchCount?: number;
  pendingCount?: number;
  /** Content review overdue (staff): server-formatted due date + edit rights. */
  reviewOverdue?: { dueDateLabel: string; canEdit: boolean } | null;
  /**
   * A retired policy (G3, 1.12.0): when, and the policy that replaced it
   * when the reader may open it. One neutral row for everyone; the card
   * and the sticky chip are gone because the policy asks nobody.
   */
  retired?: { at: string; replacedBy: { id: number; title: string } | null } | null;
}) {
  const fmt = useFormatDate();
  const ackState = useAckState();
  const ackedAt = ackState?.ackedAt ?? null;
  const ackedRev = ackState?.ackedRev ?? null;
  const prior = ackState?.prior ?? null;

  const [reviewed, setReviewed] = useState(false);
  const { run, isBusy } = useAction();

  const hasAckRow = ack !== undefined && ack !== null;
  const hasReviewRow = Boolean(reviewOverdue) && !reviewed;
  const hasRetiredRow = Boolean(retired);
  const rows =
    (hasAckRow ? 1 : 0) +
    (hasRetiredRow ? 1 : 0) +
    (isDraft ? 1 : 0) +
    (branchCount > 0 ? 1 : 0) +
    (pendingCount > 0 ? 1 : 0) +
    (hasReviewRow ? 1 : 0);
  if (rows === 0) return null;

  return (
    <div className="mb-8 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-surface print:hidden">
      {/* Retired policy: a neutral statement of fact, no action. The
          replacement is a link only when the server found one the reader
          may open; otherwise the date stands alone. */}
      {retired && (
        <p className={`${ROW} text-slate-600`}>
          <Archive className={`${ICON} text-slate-400`} aria-hidden />
          <span className="min-w-0 flex-1">
            Retired {fmt.date(retired.at)}
            {retired.replacedBy && (
              <>
                {" · replaced by "}
                <Link
                  href={`/doc/${retired.replacedBy.id}`}
                  className="font-medium text-compass-700 hover:underline"
                >
                  {retired.replacedBy.title}
                </Link>
              </>
            )}
          </span>
        </p>
      )}

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
            <p className="min-w-0 flex-1">{withDueBy(prior ? reconfirmSentence(prior, fmt.date) : FIRST_REQUEST, ack.dueBy)}</p>
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
