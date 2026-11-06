// "Automated · Grafana": the chip an automated ticket carries in the desk
// (agent P; D mounts it in the ticket header and queue rows). Reads the
// ticket's automated flag and source_ref.integration_kind, so it needs no
// fetch. Renders nothing for a ticket a person opened. Server-safe.

import { Activity } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { automatedChipLabel } from "@/lib/helpdesk/intake/shared";

export interface AutomatedTicketLike {
  automated?: number | boolean | null;
  source?: string;
  source_ref?: Record<string, unknown> | null;
}

/** The flag when the row carries it; otherwise source 'alert' (monitoring tickets are always automated). */
export function isAutomatedTicket(t: AutomatedTicketLike): boolean {
  if (t.automated !== undefined && t.automated !== null) return t.automated === 1 || t.automated === true;
  return t.source === "alert";
}

export function AutomatedChip({ ticket, size = "sm", inLink = false }: { ticket: AutomatedTicketLike; size?: "sm" | "md"; inLink?: boolean }) {
  if (!isAutomatedTicket(ticket)) return null;
  const kind = typeof ticket.source_ref?.integration_kind === "string" ? ticket.source_ref.integration_kind : null;
  const name = typeof ticket.source_ref?.integration_name === "string" ? ticket.source_ref.integration_name : "";
  const tip = name ? `Opened by the ${name} integration. No person to reply to.` : "Opened by an integration. No person to reply to.";
  return (
    <span
      className={chipClass("info", size)}
      {...(inLink ? {} : { "data-tt": tip, "data-tt-wrap": "", tabIndex: 0 })}
    >
      <Activity className="h-3 w-3" aria-hidden />
      {automatedChipLabel(kind)}
    </span>
  );
}
