"use client";

// A queue row's major incident chip (1.19.2, agent W1; mock-up a1): the
// incident's own ticket reads "Major incident" (red, Siren); a linked
// ticket reads its incident's number (neutral, Link2). Inside the row's
// link, so it is text, not a link of its own.

import { Link2, Siren } from "lucide-react";
import { chipClass } from "@/components/Chip";
import type { IncidentChip as Chip } from "@/lib/helpdesk/incidents-shared";

export function IncidentChip({ chip }: { chip: Chip | undefined }) {
  if (!chip) return null;
  if (chip.kind === "incident") {
    return (
      <span className={chipClass("error", "sm")} data-tt={`${chip.linked} linked ${chip.linked === 1 ? "ticket" : "tickets"}`}>
        <Siren className="h-3 w-3" aria-hidden />
        Major incident
      </span>
    );
  }
  return (
    <span className={chipClass("neutral", "sm")} data-tt={`Linked to major incident #${chip.number}`}>
      <Link2 className="h-3 w-3" aria-hidden />
      <span className="sr-only">Linked to major incident </span>#{chip.number}
    </span>
  );
}
