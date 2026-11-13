// PUT    /api/helpdesk/admin/custom-fields/[id]  { label?, type?, help?, options?, visibility?, all_teams?, team_ids?, archived? }
//        → { field }. What is left out keeps its value. The key never changes. `archived: true` archives the field
//        (its values are kept; it is no longer shown or edited), false restores it. The kind changes only to one
//        whose values read the same while tickets hold a value (409 otherwise).
//        Audited: helpdesk.custom_field.updated (what changed), or .archived / .restored.
// DELETE /api/helpdesk/admin/custom-fields/[id] → { ok, tickets }. Removes the field and every ticket's value for it
//        (`tickets`: how many held one). Audited (helpdesk.custom_field.deleted).
// Helpdesk 1.20.6: Desk settings → Custom fields (lib/helpdesk/custom-fields). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { deleteCustomField, updateCustomField, CustomFieldError } from "@/lib/helpdesk/custom-fields";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the field as JSON." }, { status: 400 });
  try {
    const r = await updateCustomField(id, b);
    if (!r) return notFound();
    const changed = (["label", "type", "help", "options", "visibility", "all_teams", "team_ids"] as const).filter((k) => JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]));
    const base = { actor: actorFrom(gate), targetType: "helpdesk_custom_field", targetId: id, targetLabel: r.after.label, ip: ipFrom(req) };
    if (r.before.archived !== r.after.archived) {
      await audit({ ...base, action: r.after.archived ? "helpdesk.custom_field.archived" : "helpdesk.custom_field.restored", details: { key: r.after.key } });
    }
    if (changed.length) {
      await audit({
        ...base,
        action: "helpdesk.custom_field.updated",
        details: {
          key: r.after.key,
          changed,
          ...(changed.includes("label") ? { label_before: r.before.label } : {}),
          ...(changed.includes("visibility") ? { visibility_before: r.before.visibility } : {}),
          type: r.after.type,
          visibility: r.after.visibility,
          all_teams: r.after.all_teams,
          team_ids: r.after.team_ids,
          options: r.after.options.map((o) => o.label),
        },
      });
    }
    return NextResponse.json({ field: r.after });
  } catch (e) {
    if (e instanceof CustomFieldError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const r = await deleteCustomField(id);
  if (!r) return notFound();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.custom_field.deleted",
    targetType: "helpdesk_custom_field",
    targetId: id,
    targetLabel: r.field.label,
    details: { key: r.field.key, type: r.field.type, visibility: r.field.visibility, tickets_with_a_value: r.tickets },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, tickets: r.tickets });
}
