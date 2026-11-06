// The VIP chip (Helpdesk 1.19.0 contact cards): an amber `warn` chip with
// Crown, on the requester's card, the ticket header and queue rows. The
// reason ("VIP list: Board member") is its tooltip; agents only ever get
// one (a requester-audience card never carries VIP). Inside a row that is
// one big link pass `inLink`: plain text, no focusable tooltip (a
// focusable element cannot sit inside a link). Server-safe.

import { Crown } from "lucide-react";
import { chipClass } from "@/components/Chip";

export function VipChip({
  reason,
  size = "sm",
  inLink = false,
  className = "",
}: {
  reason?: string;
  size?: "sm" | "md";
  inLink?: boolean;
  className?: string;
}) {
  const tip = !inLink && reason ? { "data-tt": reason, tabIndex: 0, ...(reason.length > 24 ? { "data-tt-wrap": "" } : {}) } : {};
  return (
    <span className={chipClass("warn", size, className)} {...tip}>
      <Crown className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      VIP
      {reason && <span className="sr-only">: {reason}</span>}
    </span>
  );
}
