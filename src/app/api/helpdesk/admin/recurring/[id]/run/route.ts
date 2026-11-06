// POST /api/helpdesk/admin/recurring/[id]/run   "Open one now": a ticket from the schedule straight away
//                                                (assignment rules and automations run as usual); the
//                                                scheduled runs are unchanged → { ticket: { number } }.
//                                                Body { request_id? } makes a retried click one ticket.
// Helpdesk 1.19.1 (agent V8). Same gate as the schedule. Audited helpdesk.recurring.run.

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { auditRecurring, canManageRecurringTeam, getRecurring, openRecurringNow } from "@/lib/helpdesk/recurring";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await hdAnyCapGate(["settings.manage", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const id = Number((await ctx.params).id);
  const s = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await getRecurring(id) : undefined;
  if (!s || !(await canManageRecurringTeam(gate, s.team_id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { request_id?: unknown };
  const row = await openRecurringNow(s.id, { id: gate.id, name: gate.name || gate.username }, typeof body.request_id === "string" ? body.request_id : undefined);
  if (!row) return NextResponse.json({ error: "That ticket was already opened." }, { status: 409 });
  await auditRecurring(req, gate, "helpdesk.recurring.run", s.id, row.subject, { ticket: row.number, via: "open_now" });
  return NextResponse.json({ ticket: { number: row.number, subject: row.subject } }, { status: 201 });
}
