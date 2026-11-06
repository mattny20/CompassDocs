// "Outside customer": the chip a customer-portal ticket carries in the desk
// (Helpdesk 1.19.1, agent V6): someone outside the organisation raised it
// at /support, without a CompassDocs account. A neutral chip with Globe,
// in the ticket header and on queue rows. Reads the ticket's source, so it
// needs no fetch; renders nothing for any other ticket. Inside a row that
// is one big link pass `inLink` (plain text, no focusable tooltip).
// Server-safe.

import { Globe } from "lucide-react";
import { chipClass } from "@/components/Chip";

export function isPortalTicket(t: { source?: string | null }): boolean {
  return t.source === "portal_external";
}

export function OutsideCustomerChip({ ticket, size = "sm", inLink = false }: { ticket: { source?: string | null }; size?: "sm" | "md"; inLink?: boolean }) {
  if (!isPortalTicket(ticket)) return null;
  return (
    <span
      className={chipClass("neutral", size)}
      {...(inLink ? {} : { "data-tt": "Raised in the customer portal by someone outside your organisation. They see public replies only.", "data-tt-wrap": "", tabIndex: 0 })}
    >
      <Globe className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      Outside customer
    </span>
  );
}
