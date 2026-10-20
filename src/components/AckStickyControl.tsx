"use client";

// Read-confirmation state in the sticky document bar (B2, 1.10.0). Rendered
// as the bar's first child, before the title, so it survives truncation.
// While pending it is a jump link to the card at the end — "Confirmation
// pending", or "Re-confirm needed" when an earlier confirmation lapsed (B3,
// 1.11.0), or "Confirm now" once the end of the article has been on screen
// (B5's latch changes the cue, never the control). Once confirmed it is a
// status chip, not a link: chips show status (the reader's own record page,
// My policies, arrives in 1.11.1). Under sm it collapses to the icon and one
// word.
//
// A deadline (E1, 1.13.0) adds one chip beside the link: "Due in 2 days"
// (neutral beyond three days, warn at three or fewer) or "Overdue" (error),
// the page formatting it from the reader's own row. Under sm only "Overdue"
// stays, so the phone bar keeps the control and the title. Once confirmed
// the chip goes with the link.

import { CircleCheckBig, FileCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { useFormatDate } from "@/components/SettingsProvider";
import { jumpToConfirmation, useAckState } from "@/components/AckState";
import type { DueTone } from "@/lib/ack-due";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

export function AckStickyControl({
  due = null,
}: {
  /** The reader's deadline (E1): dueStickyLabel's words with dueChip's tone; null without a deadline. */
  due?: { tone: DueTone; label: string } | null;
}) {
  const ack = useAckState();
  const fmt = useFormatDate();
  if (!ack || !ack.canSubmit) return null;

  if (ack.ackedAt) {
    return (
      <span className={chipClass("ok", "sm")}>
        <CircleCheckBig className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">Confirmed {fmt.date(ack.ackedAt)}</span>
        <span className="sm:hidden">Confirmed</span>
      </span>
    );
  }

  const again = Boolean(ack.prior);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        href={`#${CONFIRM_SECTION_ID}`}
        icon={<FileCheck />}
        onClick={jumpToConfirmation}
        data-tt="Jump to the confirmation at the end"
        data-tt-pos="bottom"
      >
        <span className="hidden sm:inline">
          {ack.reachedEnd ? "Confirm now" : again ? "Re-confirm needed" : "Confirmation pending"}
        </span>
        <span className="text-2xs sm:hidden">{again ? "Re-confirm" : "Pending"}</span>
      </Button>
      {due && (
        <span className={due.tone === "error" ? "contents" : "hidden sm:contents"}>
          <span className={chipClass(due.tone, "sm")}>{due.label}</span>
        </span>
      )}
    </>
  );
}
