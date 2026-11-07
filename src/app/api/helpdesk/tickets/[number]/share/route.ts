// GET  /api/helpdesk/tickets/[number]/share   who the ticket can be shared with:
//        → { candidates: HdShareCandidate[] } (every desk agent but the caller;
//        those who don't work the ticket come disabled, with the reason).
// POST /api/helpdesk/tickets/[number]/share   { user_ids: number[], message?: string (≤ 500), follow?: boolean (default true) }
//        → 200 HdShareResult. Every recipient must work the ticket (sharing never
//        grants access): otherwise 403 and nothing happens. Leaves an internal
//        timeline line (agents only), notifies each recipient (desk event
//        shared_with_me) and is audited (helpdesk.ticket.shared).
//        Rate limit: 10 shares a minute and 60 an hour per agent (429); the
//        GET 30 a minute.
// Both answer 409 for a ticket in the recycle bin that the caller could
// work (restore it first); the POST also when it is binned mid-share (the
// writes run under the ticket's row lock, so nothing is half-written).
// Helpdesk 1.19.4, area C6 (helpdesk.agent, agents who work the ticket; 404 otherwise).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, originOf } from "@/lib/helpdesk/routes";
import { binnedTicketFor, HdShareError, parseShareInput, shareCandidates, shareTicket } from "@/lib/helpdesk/share";
import { HD_SHARE_BINNED, type HdShareOptions } from "@/lib/helpdesk/share-shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

/** loadTicketFor's 404, or 409 for a ticket in the recycle bin the caller could work. */
async function notFoundOrBinned(user: { id: number; role: import("@/lib/types").Role }, raw: string, res: NextResponse): Promise<NextResponse> {
  if (res.status === 404 && (await binnedTicketFor(user, raw))) return NextResponse.json({ error: HD_SHARE_BINNED }, { status: 409 });
  return res;
}

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-share-list:${gate.id}`, 30, 60_000)) return tooMany();
  const raw = (await params).number;
  const found = await loadTicketFor(gate, raw, "work");
  if (found instanceof NextResponse) return notFoundOrBinned(gate, raw, found);
  const body: HdShareOptions = { candidates: await shareCandidates(gate, found.ticket) };
  return NextResponse.json(body);
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).number;
  const found = await loadTicketFor(gate, raw, "work");
  if (found instanceof NextResponse) return notFoundOrBinned(gate, raw, found);
  if (hdRateLimited(`hd-share-m:${gate.id}`, 10, 60_000) || hdRateLimited(`hd-share-h:${gate.id}`, 60, 3_600_000)) return tooMany();
  const b = await readJson(req, 8 * 1024);
  if (!b) return badRequest("Send the share as JSON.");
  try {
    const input = parseShareInput(b);
    const actor = { id: gate.id, role: gate.role, name: gate.name || gate.username };
    return NextResponse.json(await shareTicket(actor, found.ticket, input, { origin: originOf(req), ip: ipFrom(req) }));
  } catch (e) {
    if (e instanceof HdShareError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
