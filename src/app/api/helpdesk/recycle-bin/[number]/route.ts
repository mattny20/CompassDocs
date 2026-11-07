// GET /api/helpdesk/recycle-bin/[number]
//       → { detail: HdTicketDetail, bin: HdBinnedInfo } for a ticket in the
//       recycle bin that the caller works (v3: the red banner, Restore, the
//       ticket read-only). 404 when it is not binned or not theirs; a
//       requester, approver or CC never reaches it (their own routes 404).
// Helpdesk 1.19.4 (area C7).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { ticketDetail } from "@/lib/helpdesk/detail";
import { binnedTicketFor } from "@/lib/helpdesk/recycle-bin";
import { notFound } from "@/lib/helpdesk/routes";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const n = parseTicketNumber((await params).number);
  if (!n) return notFound();
  const found = await binnedTicketFor(gate, n);
  if (!found) return notFound();
  // Read-only: the pane renders no composer or controls, and every write route 404s for a binned ticket.
  const detail = await ticketDetail(gate, found.ticket, false);
  return NextResponse.json({ detail, bin: found.info });
}
