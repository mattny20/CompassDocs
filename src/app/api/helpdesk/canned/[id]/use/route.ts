// POST /api/helpdesk/canned/[id]/use   { number }   → { body }
// Helpdesk 1.19.2 (agent W4). The composer inserts a canned response: the
// text comes back with its placeholders filled for that ticket and the
// caller, and the use is counted for the library's "Used (30 days)". It
// never changes the ticket and writes no message (the agent sends their
// reply or note as usual, under the usual rules). A ticket the caller
// doesn't work, or a response they can't see there, is a 404. Not audited:
// it is a counter, and what reaches the requester is the reply, which is.

import { NextResponse } from "next/server";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { getTicketByNumber, parseTicketNumber } from "@/lib/helpdesk/tickets";
import { CannedError, insertCanned } from "@/lib/helpdesk/canned";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-canned:${gate.id}`, 120, 60_000)) return tooMany();
  const id = Number((await ctx.params).id);
  const body = await readJson(req, 4 * 1024);
  const n = body && (typeof body.number === "number" || typeof body.number === "string") ? parseTicketNumber(body.number) : null;
  if (!Number.isInteger(id) || id <= 0 || !n) return NextResponse.json({ error: "Say which canned response and which ticket." }, { status: 400 });
  const ticket = await getTicketByNumber(n);
  if (!ticket) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  try {
    const r = await insertCanned(gate, id, ticket);
    return NextResponse.json({ body: r.body, id: r.canned.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof CannedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
