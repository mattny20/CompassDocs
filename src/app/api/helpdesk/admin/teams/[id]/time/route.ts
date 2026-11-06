// GET   /api/helpdesk/admin/teams/[id]/time   → { ask_time_on_solve }
// PATCH /api/helpdesk/admin/teams/[id]/time   { ask_time_on_solve: boolean } the team's "Ask for time when
//                                             solving" setting. Audited helpdesk.team.time_setting_changed.
// Helpdesk 1.19.1 (agent V8). agents.manage_team in that team (its leads; teams.manage for every team).

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { getAskTimeOnSolve, setAskTimeOnSolve } from "@/lib/helpdesk/time";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function teamId(ctx: Ctx): Promise<number | null> {
  const id = Number((await ctx.params).id);
  return Number.isInteger(id) && id > 0 && id < 2 ** 31 ? id : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const id = await teamId(ctx);
  if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const gate = await hdCapGate("agents.manage_team", { teamId: id });
  if (gate instanceof NextResponse) return gate;
  const v = await getAskTimeOnSolve(id);
  if (v === undefined) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ask_time_on_solve: v });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const id = await teamId(ctx);
  if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const gate = await hdCapGate("agents.manage_team", { teamId: id });
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as { ask_time_on_solve?: unknown } | null;
  if (typeof body?.ask_time_on_solve !== "boolean") return NextResponse.json({ error: "Say on or off." }, { status: 400 });
  if (!(await setAskTimeOnSolve(id, body.ask_time_on_solve))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.team.time_setting_changed",
    targetType: "helpdesk_team",
    targetId: id,
    details: { ask_time_on_solve: body.ask_time_on_solve },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ask_time_on_solve: body.ask_time_on_solve });
}
