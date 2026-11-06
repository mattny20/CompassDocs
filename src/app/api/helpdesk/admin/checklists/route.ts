// GET  /api/helpdesk/admin/checklists → { templates: HdChecklistTemplateRow[], teams, request_types }
// POST /api/helpdesk/admin/checklists   { name, items, request_type_ids } → { template } (201).
//      Audited (helpdesk.checklist_template.created).
// Helpdesk 1.19.2 (agent W3; mock-up c2): Desk settings → Checklists. Desk capability
// settings.manage, request_types.manage or workflows.manage (lib/helpdesk/checklists-caps).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import { ChecklistError, createTemplate, listTemplateRows } from "@/lib/helpdesk/checklists";
import { CHECKLIST_MANAGE_CAPS } from "@/lib/helpdesk/checklists-caps";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate([...CHECKLIST_MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const [templates, teams, types] = await Promise.all([
    listTemplateRows(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, lower(name), id"),
    hq<{ id: number; title: string; active: number }>("SELECT id, title, active FROM hd_request_types ORDER BY position, lower(title), id"),
  ]);
  return NextResponse.json({ templates, teams, request_types: types });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate([...CHECKLIST_MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the checklist as JSON." }, { status: 400 });
  try {
    const t = await createTemplate(b, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.checklist_template.created",
      targetType: "helpdesk_checklist",
      targetId: t.id,
      targetLabel: t.name,
      details: { items: t.items.length, required: t.items.filter((i) => i.required).length, request_type_ids: t.request_type_ids },
      ip: ipFrom(req),
    });
    return NextResponse.json({ template: t }, { status: 201 });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
