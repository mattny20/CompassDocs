// GET  /api/helpdesk/admin/custom-fields → { fields: (HdCustomField & { tickets: number })[], teams, limit }
//        Every field in the settings page's order, archived ones included; `tickets` is how many tickets hold a
//        value for it.
// POST /api/helpdesk/admin/custom-fields  { label, type?, help?, options?, visibility?, all_teams?, team_ids?, key? }
//        → { field } (201). The key is made from the label unless one is sent, and never changes.
//        Audited (helpdesk.custom_field.created).
// Helpdesk 1.20.6: Desk settings → Custom fields (lib/helpdesk/custom-fields). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import { createCustomField, customFieldUse, listCustomFields, CustomFieldError, CUSTOM_FIELD_LIMITS } from "@/lib/helpdesk/custom-fields";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [fields, use, teams] = await Promise.all([
    listCustomFields(),
    customFieldUse(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, lower(name), id"),
  ]);
  return NextResponse.json({ fields: fields.map((f) => ({ ...f, tickets: use.get(f.id) ?? 0 })), teams, limit: CUSTOM_FIELD_LIMITS.fields });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the field as JSON." }, { status: 400 });
  try {
    const f = await createCustomField(b, { id: gate.id });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.custom_field.created",
      targetType: "helpdesk_custom_field",
      targetId: f.id,
      targetLabel: f.label,
      details: { key: f.key, type: f.type, visibility: f.visibility, all_teams: f.all_teams, team_ids: f.team_ids, options: f.options.map((o) => o.label) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ field: f }, { status: 201 });
  } catch (e) {
    if (e instanceof CustomFieldError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
