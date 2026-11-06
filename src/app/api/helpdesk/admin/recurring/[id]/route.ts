// GET    /api/helpdesk/admin/recurring/[id]   one schedule.
// PATCH  /api/helpdesk/admin/recurring/[id]   change it (any fields; the next run is recomputed). helpdesk.recurring.updated.
// DELETE /api/helpdesk/admin/recurring/[id]   delete it (tickets it opened stay). helpdesk.recurring.deleted.
// Helpdesk 1.19.1 (agent V8). settings.manage, or agents.manage_team in the schedule's team (and in the
// team it moves to). A schedule of a team the caller doesn't manage answers 404.

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import {
  auditRecurring,
  canManageRecurringTeam,
  deleteRecurring,
  getRecurring,
  inputOf,
  updateRecurring,
  validateRecurringInput,
} from "@/lib/helpdesk/recurring";
import { scheduleTitle } from "@/lib/helpdesk/recurring-shared";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const gate = await hdAnyCapGate(["settings.manage", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const id = Number((await ctx.params).id);
  const s = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await getRecurring(id) : undefined;
  if (!s || !(await canManageRecurringTeam(gate, s.team_id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return { user: gate as SessionUser, s };
}

export async function GET(_req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  return NextResponse.json({ schedule: l.s });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  if (typeof body.team_id === "number" && body.team_id !== l.s.team_id && !(await canManageRecurringTeam(l.user, body.team_id))) {
    return NextResponse.json({ error: "You can only schedule tickets for teams you lead." }, { status: 403 });
  }
  const v = await validateRecurringInput(body, inputOf(l.s));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const schedule = await updateRecurring(l.s.id, v.value);
  if (!schedule) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const changed = Object.keys(body).filter((k) => JSON.stringify((l.s as unknown as Record<string, unknown>)[k]) !== JSON.stringify(body[k]));
  await auditRecurring(req, l.user, "helpdesk.recurring.updated", schedule.id, scheduleTitle(schedule.subject), { changed });
  return NextResponse.json({ schedule });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  await deleteRecurring(l.s.id);
  await auditRecurring(req, l.user, "helpdesk.recurring.deleted", l.s.id, scheduleTitle(l.s.subject), { team_id: l.s.team_id });
  return NextResponse.json({ ok: true });
}
