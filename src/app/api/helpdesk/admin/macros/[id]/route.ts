// GET    /api/helpdesk/admin/macros/[id]
// PATCH  /api/helpdesk/admin/macros/[id]   any of { title, body, actions, team_id, personal }
// DELETE /api/helpdesk/admin/macros/[id]
// Helpdesk 1.19.0. The caller needs the capability of the macro's scope
// (and, when a PATCH moves it, of the new one): see ../route.ts. Someone
// else's personal macro is a 404. Audited as helpdesk.macro.updated /
// .deleted. An automation that sends a deleted macro skips that step.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import { deleteMacro, getMacro, macroManageCap, updateMacro, validateMacroInput, type HdMacroRow } from "@/lib/helpdesk/macros";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MANAGE_CAPS = ["macros.manage_personal", "macros.manage_team", "macros.manage_all"] as const;

async function load(ctx: Ctx, user: SessionUser): Promise<HdMacroRow | null> {
  const n = Number((await ctx.params).id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const m = await getMacro(n);
  if (!m || (m.owner_id && m.owner_id !== user.id)) return null;
  return m;
}

async function mayManage(user: SessionUser, m: { owner_id: number | null; team_id: number | null }): Promise<boolean> {
  const { cap, teamId } = macroManageCap(m);
  if (m.owner_id && m.owner_id !== user.id) return false;
  return hdCan(user, cap, { teamId });
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const macro = await load(ctx, gate);
  if (!macro) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  return NextResponse.json({ macro: { ...macro, can_edit: await mayManage(gate, macro) } });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const cur = await load(ctx, gate);
  if (!cur) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const input = await validateMacroInput(body, true);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { personal, ...patch } = input.value;
  const owner_id = personal === undefined ? cur.owner_id : personal ? gate.id : null;
  const next = { owner_id, team_id: owner_id ? null : patch.team_id !== undefined ? patch.team_id : cur.team_id };
  if (!(await mayManage(gate, cur)) || !(await mayManage(gate, next))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const macro = await updateMacro(cur.id, { ...patch, team_id: next.team_id, owner_id });
  if (!macro) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.updated",
    targetType: "helpdesk_macro",
    targetId: macro.id,
    targetLabel: macro.title,
    details: { changed: Object.keys(input.value), scope: owner_id ? "personal" : macro.team_id ? "team" : "everyone", team_id: macro.team_id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ macro });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const cur = await load(ctx, gate);
  if (!cur) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  if (!(await mayManage(gate, cur))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const gone = await deleteMacro(cur.id);
  if (!gone) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.deleted",
    targetType: "helpdesk_macro",
    targetId: gone.id,
    targetLabel: gone.title,
    details: { scope: gone.owner_id ? "personal" : gone.team_id ? "team" : "everyone" },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
