// GET /api/helpdesk/requests/[number]   the requester's (or an approver's) view
//   of a request: HdRequestDetail, never internal notes or internal fields.
// Helpdesk 1.19.0 (helpdesk.request). 404 for a request the caller cannot see.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { requestDetail } from "@/lib/helpdesk/detail";
import { loadTicketFor } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const { number } = await params;
  const found = await loadTicketFor(gate, number, "see");
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ request: await requestDetail(gate, found.ticket, found.relation) });
}
