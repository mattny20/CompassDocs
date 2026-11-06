// GET /api/helpdesk/tickets/[number]/drafts   the ticket's pending reply drafts
//   (saved by the Claude connector's hd_draft_reply), newest first
//   → { drafts: HdReplyDraft[] }. The desk shows them above the composer as
//   "Draft from Claude". Drafts are never sent, emailed or shown to the
//   requester (lib/helpdesk/drafts).
// Helpdesk 1.19.1 (helpdesk.agent, agents who work the ticket). 404 for a
// ticket outside the caller's queues.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { listPendingDrafts } from "@/lib/helpdesk/drafts";
import { loadTicketFor } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ drafts: await listPendingDrafts(found.ticket.id) }, { headers: { "Cache-Control": "no-store" } });
}
