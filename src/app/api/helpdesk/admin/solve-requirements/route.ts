// GET  /api/helpdesk/admin/solve-requirements → { sets: (HdSolveRequirementSet & { answered: number })[], teams,
//        request_types, ticket_fields, custom_fields } (ticket_fields: the ones this install can require; an asset
//        only while an asset source is connected. 1.20.6: custom_fields, the custom fields a set may require)
// POST /api/helpdesk/admin/solve-requirements  { name, enabled?, team_ids?, request_type_ids?, ticket_fields?, custom_field_ids?, fields? }
//        → { set } (201). Audited (helpdesk.solve_requirements.created).
// Helpdesk 1.20.5: Desk settings → Before you solve (lib/helpdesk/solve-requirements). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import { availableTicketFields, createSolveSet, listSolveSets, solveSetUse, SolveRequirementError } from "@/lib/helpdesk/solve-requirements";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [sets, use, teams, types, ticketFields, customFields] = await Promise.all([
    listSolveSets(),
    solveSetUse(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, lower(name), id"),
    hq<{ id: number; title: string; active: number }>("SELECT id, title, active FROM hd_request_types ORDER BY position, lower(title), id"),
    availableTicketFields(),
    // 1.20.6: the custom fields a set may require (lib/helpdesk/custom-fields).
    import("@/lib/helpdesk/custom-fields").then((m) => m.listCustomFields()),
  ]);
  return NextResponse.json({
    sets: sets.map((s) => ({ ...s, answered: use.get(s.id) ?? 0 })),
    teams,
    request_types: types,
    ticket_fields: ticketFields,
    custom_fields: customFields.map((f) => ({ id: f.id, key: f.key, label: f.label, all_teams: f.all_teams, team_ids: f.team_ids, archived: f.archived })),
  });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 128 * 1024);
  if (!b) return NextResponse.json({ error: "Send the requirement set as JSON." }, { status: 400 });
  try {
    const s = await createSolveSet(b, { id: gate.id });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.solve_requirements.created",
      targetType: "helpdesk_solve_requirements",
      targetId: s.id,
      targetLabel: s.name,
      details: { enabled: s.enabled, team_ids: s.team_ids, request_type_ids: s.request_type_ids, ticket_fields: s.ticket_fields, custom_field_ids: s.custom_field_ids, closing_fields: s.fields.map((f) => f.label) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ set: s }, { status: 201 });
  } catch (e) {
    if (e instanceof SolveRequirementError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
