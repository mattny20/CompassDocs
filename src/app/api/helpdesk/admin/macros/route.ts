// GET  /api/helpdesk/admin/macros   the macros the caller may manage, each with can_edit, and the placeholders
// POST /api/helpdesk/admin/macros   { title, body, actions?, team_id?, personal? }
// Helpdesk 1.19.0. Who writes which scope is agent J's capability matrix:
// personal (the caller's own) macros.manage_personal, a team's
// macros.manage_team in that team, everyone's macros.manage_all. A
// personal macro is never listed to anyone but its owner. Audited as
// helpdesk.macro.created.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { memberTeamIds, readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  MACRO_PLACEHOLDERS,
  MacroLimitError,
  createMacro,
  listMacros,
  macroManageCap,
  validateMacroInput,
  type MacroInput,
} from "@/lib/helpdesk/macros";

export const dynamic = "force-dynamic";

const MANAGE_CAPS = ["macros.manage_personal", "macros.manage_team", "macros.manage_all"] as const;

export async function GET() {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const all = await hdCan(gate, "macros.manage_all");
  const list = await listMacros(all ? "all" : await memberTeamIds(gate.id), gate.id);
  const macros = [];
  for (const m of list) {
    const { cap, teamId } = macroManageCap(m);
    macros.push({ ...m, can_edit: m.owner_id ? m.owner_id === gate.id && (await hdCan(gate, cap)) : await hdCan(gate, cap, { teamId }) });
  }
  return NextResponse.json({ macros, placeholders: MACRO_PLACEHOLDERS });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the macro as JSON." }, { status: 400 });
  const input = await validateMacroInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const value = input.value as MacroInput;
  const owner_id = value.personal ? gate.id : null;
  const { cap, teamId } = macroManageCap({ owner_id, team_id: value.team_id });
  if (!(await hdCan(gate, cap, { teamId }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  let macro;
  try {
    macro = await createMacro({ ...value, owner_id }, gate.id);
  } catch (e) {
    if (e instanceof MacroLimitError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.created",
    targetType: "helpdesk_macro",
    targetId: macro.id,
    targetLabel: macro.title,
    details: { scope: owner_id ? "personal" : macro.team_id ? "team" : "everyone", team_id: macro.team_id, actions: Object.keys(macro.actions ?? {}) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ macro }, { status: 201 });
}
