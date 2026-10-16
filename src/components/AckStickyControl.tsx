"use client";

// Read-confirmation state in the sticky document bar (B2, 1.10.0). Rendered
// as the bar's first child, before the title, so it survives truncation.
// While pending it is a jump link to the card at the end — "Confirmation
// pending", or "Confirm now" once the end of the article has been on screen
// (B5's latch changes the cue, never the control). Once confirmed it is a
// status chip, not a link: chips show status, and the "View your record"
// link lives in the card. Under sm it collapses to the icon and one word.

import { CircleCheckBig, FileCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { useFormatDate } from "@/components/SettingsProvider";
import { jumpToConfirmation, useAckState } from "@/components/AckState";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

export function AckStickyControl() {
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

  return (
    <Button
      variant="secondary"
      size="sm"
      href={`#${CONFIRM_SECTION_ID}`}
      icon={<FileCheck />}
      onClick={jumpToConfirmation}
      data-tt="Jump to the confirmation at the end"
      data-tt-pos="bottom"
    >
      <span className="hidden sm:inline">{ack.reachedEnd ? "Confirm now" : "Confirmation pending"}</span>
      <span className="text-2xs sm:hidden">Pending</span>
    </Button>
  );
}
