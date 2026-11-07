// GET /api/helpdesk/tickets/[number]/legal-hold → { legal_hold, by_name, at }
// PUT /api/helpdesk/tickets/[number]/legal-hold   { on: boolean } → the same. Audited
//     (helpdesk.ticket.legal_hold_set / helpdesk.ticket.legal_hold_cleared).
// Helpdesk 1.19.1 (lib/helpdesk/retention): a ticket on legal hold is never closed,
// anonymised or deleted by retention or account removal. Agents who work the ticket
// read it; desk capability settings.manage sets it. 1.19.4 (C7): a ticket in the
// recycle bin is reachable here too, for an agent who works it.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { getLegalHold, setLegalHold } from "@/lib/helpdesk/retention";
import { binnedTicketFor } from "@/lib/helpdesk/recycle-bin";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";
import type { HdTicket } from "@/lib/helpdesk/types";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

/**
 * The ticket, as loadTicketFor "work" finds it, or (1.19.4, C7) one in the
 * recycle bin that the caller works: a hold placed on a binned ticket stops
 * the bin's purge (lib/helpdesk/recycle-bin purgeExpired), so it must be
 * reachable here without restoring the ticket first.
 */
async function holdTicketFor(gate: SessionUser, raw: string): Promise<{ ticket: HdTicket } | NextResponse> {
  const found = await loadTicketFor(gate, raw, "work");
  if (!(found instanceof NextResponse) || found.status !== 404) return found;
  const n = parseTicketNumber(raw);
  const binned = n ? await binnedTicketFor(gate, n) : undefined;
  return binned ? { ticket: binned.ticket } : found;
}

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await holdTicketFor(gate, (await params).number);
  if (found instanceof NextResponse) return found;
  const hold = await getLegalHold(found.ticket.id);
  return NextResponse.json({ ...hold, can_change: await hdCan(gate, "settings.manage") });
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await holdTicketFor(gate, (await params).number);
  if (found instanceof NextResponse) return found;
  if (!(await hdCan(gate, "settings.manage"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const body = await readJson(req, 1024);
  if (!body || typeof body.on !== "boolean") return NextResponse.json({ error: "Send { on: true } or { on: false }." }, { status: 400 });
  const changed = await setLegalHold(found.ticket.id, body.on, gate.id);
  if (changed) {
    await audit({
      actor: actorFrom(gate),
      action: body.on ? "helpdesk.ticket.legal_hold_set" : "helpdesk.ticket.legal_hold_cleared",
      targetType: "helpdesk_ticket",
      targetId: found.ticket.id,
      targetLabel: `#${found.ticket.number}`,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ...(await getLegalHold(found.ticket.id)), can_change: true });
}
