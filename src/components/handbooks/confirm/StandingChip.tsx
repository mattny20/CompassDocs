// Where one policy in a handbook stands for the reader (1.18.0): a status
// chip, never a link or a picker (STYLEGUIDE §Status chips). Four words in
// a closed set, shared by the confirm page and anything else that lists a
// handbook's policies for a reader: Confirmed (ok, with the check),
// To confirm (accent), Updated since you confirmed (warn), For information
// (neutral). Server-safe.

import { Check } from "lucide-react";
import { Chip } from "@/components/Chip";
import type { HandbookStanding } from "@/lib/handbook-confirm-shared";

export const STANDING_LABEL: Record<HandbookStanding, string> = {
  confirmed: "Confirmed",
  to_confirm: "To confirm",
  updated: "Updated since you confirmed",
  info: "For information",
};

const TONE = { confirmed: "ok", to_confirm: "accent", updated: "warn", info: "neutral" } as const;

export function StandingChip({ standing, className = "" }: { standing: HandbookStanding; className?: string }) {
  return (
    <Chip tone={TONE[standing]} size="sm" className={className}>
      {standing === "confirmed" && <Check className="h-3 w-3" aria-hidden />}
      {STANDING_LABEL[standing]}
    </Chip>
  );
}
