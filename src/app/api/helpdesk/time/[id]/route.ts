// PATCH  /api/helpdesk/time/[id]   { minutes?, note? } change an entry → { entry }. helpdesk.time.edited.
// DELETE /api/helpdesk/time/[id]   remove it. helpdesk.time.deleted.
// Helpdesk 1.19.1 (agent V8). Your own entries on tickets you can work; a team lead (agents.manage_team in
// the ticket's team) any of the team's. Anything else answers 404.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { auditTime, canEditTimeEntry, cleanMinutes, cleanNote, deleteTimeEntry, getTimeEntry, updateTimeEntry } from "@/lib/helpdesk/time";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await ctx.params).id);
  const e = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await getTimeEntry(id) : undefined;
  if (!e || !(await canEditTimeEntry(gate, e))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return { user: gate as SessionUser, e };
}

export async function PATCH(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  const body = (await req.json().catch(() => null)) as { minutes?: unknown; note?: unknown } | null;
  const patch: { minutes?: number; note?: string } = {};
  if (body?.minutes !== undefined) {
    const m = cleanMinutes(body.minutes);
    if (m === null) return NextResponse.json({ error: "Log between 1 minute and 24 hours." }, { status: 400 });
    patch.minutes = m;
  }
  if (body?.note !== undefined) {
    const n = cleanNote(body.note);
    if (n === null) return NextResponse.json({ error: "Keep the note under 300 characters." }, { status: 400 });
    patch.note = n;
  }
  const entry = await updateTimeEntry(l.e.id, patch);
  await auditTime(req, l.user, "helpdesk.time.edited", { type: "helpdesk_time", id: l.e.id }, {
    ticket_id: l.e.ticket_id,
    owner: l.e.user_id,
    from: { minutes: l.e.minutes, note: l.e.note },
    to: patch,
  });
  return NextResponse.json({ entry });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  await deleteTimeEntry(l.e.id);
  await auditTime(req, l.user, "helpdesk.time.deleted", { type: "helpdesk_time", id: l.e.id }, { ticket_id: l.e.ticket_id, owner: l.e.user_id, minutes: l.e.minutes });
  return NextResponse.json({ ok: true });
}
