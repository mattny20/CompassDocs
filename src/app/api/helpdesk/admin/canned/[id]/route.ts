// PATCH  /api/helpdesk/admin/canned/[id]   any of { title, body, folder, share }
// DELETE /api/helpdesk/admin/canned/[id]
// Helpdesk 1.19.2 (agent W4). The caller needs the capability of the
// response's sharing and, when a PATCH changes it, of the new one too (see
// ../route.ts). Someone else's personal response, or one the caller can't
// see, is a 404. A PATCH writes only the fields sent, and only while the
// sharing is still the one checked (a concurrent move is a 409). Audited as
// helpdesk.canned.updated (the fields that really changed) / .deleted.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { agentTeamIds, readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  CANNED_MANAGE_CAPS,
  CannedError,
  changedFields,
  cannedScope,
  cannedVisibleTo,
  deleteCanned,
  getCanned,
  mayManageCanned,
  updateCanned,
  validateCannedInput,
} from "@/lib/helpdesk/canned";
import type { HdCanned } from "@/lib/helpdesk/canned-shared";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx, user: SessionUser): Promise<HdCanned | null> {
  const c = await getCanned(Number((await ctx.params).id));
  if (!c) return null;
  const teams = (await hdCan(user, "macros.manage_all")) ? "all" : await agentTeamIds(user);
  return cannedVisibleTo(c, user.id, teams) ? c : null;
}

const NOT_FOUND = () => NextResponse.json({ error: "Canned response not found." }, { status: 404 });

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const cur = await load(ctx, gate);
  if (!cur) return NOT_FOUND();
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    const patch = await validateCannedInput(body, gate.id, true);
    // Moving a personal response keeps its owner only when it stays personal.
    const next = {
      owner_id: patch.owner_id !== undefined ? patch.owner_id : cur.owner_id,
      team_id: patch.team_id !== undefined ? patch.team_id : cur.team_id,
    };
    if (!(await mayManageCanned(gate, cur)) || !(await mayManageCanned(gate, next))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    const c = await updateCanned(cur.id, patch, { owner_id: cur.owner_id, team_id: cur.team_id });
    if (!c) return NOT_FOUND();
    const changed = changedFields(cur, c);
    if (!changed.length) return NextResponse.json({ canned: { ...c, can_edit: await mayManageCanned(gate, c) } });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.canned.updated",
      targetType: "helpdesk_canned",
      targetId: c.id,
      targetLabel: c.title,
      details: {
        changed,
        scope: cannedScope(c),
        team_id: c.team_id,
        ...(cannedScope(cur) !== cannedScope(c) || cur.team_id !== c.team_id ? { from_scope: cannedScope(cur), from_team_id: cur.team_id } : {}),
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ canned: { ...c, can_edit: await mayManageCanned(gate, c) } });
  } catch (e) {
    if (e instanceof CannedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const cur = await load(ctx, gate);
  if (!cur) return NOT_FOUND();
  if (!(await mayManageCanned(gate, cur))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const gone = await deleteCanned(cur.id);
  if (!gone) return NOT_FOUND();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.canned.deleted",
    targetType: "helpdesk_canned",
    targetId: gone.id,
    targetLabel: gone.title,
    details: { scope: cannedScope(gone), team_id: gone.team_id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
