"use client";

// The desk role ladder's shared UI pieces (agent J): one icon and chip tone
// per role, the role chip, and the review-state chip D shows on a held
// reply in the conversation. Lucide icons only; chips are the house Chip.

import { BriefcaseBusiness, Flag, Headset, Hourglass, Lock, ShieldCheck, Sprout, Undo2, type LucideIcon } from "lucide-react";
import { Chip, type ChipTone } from "@/components/Chip";
import { HD_ROLE_LABEL, type HdRole, type HdReviewState } from "@/lib/helpdesk/roles-shared";

export const ROLE_ICON: Record<HdRole, LucideIcon> = {
  newbie: Sprout,
  agent: Headset,
  team_lead: Flag,
  manager: BriefcaseBusiness,
  admin: ShieldCheck,
};

/** Newbie stands out (their replies wait); the rest climb from neutral to the accent. */
export const ROLE_TONE: Record<HdRole, ChipTone> = {
  newbie: "info",
  agent: "neutral",
  team_lead: "accent",
  manager: "accent",
  admin: "accent",
};

/** A person's desk role. A role from the workspace shows a lock and says why. */
export function RoleChip({ role, fromWorkspace = false, size = "md" }: { role: HdRole; fromWorkspace?: boolean; size?: "sm" | "md" }) {
  const Icon = fromWorkspace ? Lock : ROLE_ICON[role];
  if (fromWorkspace) {
    return (
      <Chip
        tone={ROLE_TONE[role]}
        size={size}
        tabIndex={0}
        data-tt="Set by their workspace role (Configure the helpdesk). Change it in CompassDocs, Settings, People."
        data-tt-wrap=""
      >
        <Icon className="h-3 w-3" aria-hidden />
        {HD_ROLE_LABEL[role]} (from workspace role)
      </Chip>
    );
  }
  return (
    <Chip tone={ROLE_TONE[role]} size={size}>
      <Icon className="h-3 w-3" aria-hidden />
      {HD_ROLE_LABEL[role]}
    </Chip>
  );
}

/**
 * On a newbie's held reply in the conversation (agent D mounts it beside
 * the message's author line): "Waiting for review" (warn) or "Returned"
 * (neutral, with the reviewer's note under it). Approved and unreviewed
 * replies show nothing.
 */
export function ReviewStateChip({ state, note }: { state: HdReviewState | null | undefined; note?: string | null }) {
  if (state === "pending") {
    return (
      <Chip tone="warn" size="sm">
        <Hourglass className="h-3 w-3" aria-hidden />
        Waiting for review
      </Chip>
    );
  }
  if (state === "returned") {
    return (
      <span className="inline-flex flex-col gap-1">
        <Chip tone="neutral" size="sm">
          <Undo2 className="h-3 w-3" aria-hidden />
          Returned
        </Chip>
        {note ? <span className="text-xs text-slate-600">{note}</span> : null}
      </span>
    );
  }
  return null;
}
