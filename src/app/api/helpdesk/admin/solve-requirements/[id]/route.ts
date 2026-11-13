// PUT    /api/helpdesk/admin/solve-requirements/[id]  { name?, enabled?, team_ids?, request_type_ids?, ticket_fields?, custom_field_ids?, fields? }
//        → { set }. What is left out keeps its value. Tickets keep the answers they have.
//        Audited (helpdesk.solve_requirements.updated, what changed; switching it on or off is in `changed`).
// DELETE /api/helpdesk/admin/solve-requirements/[id] → { ok }. Tickets keep their answers.
//        Audited (helpdesk.solve_requirements.deleted).
// Helpdesk 1.20.5: Desk settings → Before you solve (lib/helpdesk/solve-requirements). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { deleteSolveSet, updateSolveSet, SolveRequirementError } from "@/lib/helpdesk/solve-requirements";

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
  const b = await readJson(req, 128 * 1024);
  if (!b) return NextResponse.json({ error: "Send the requirement set as JSON." }, { status: 400 });
  try {
    const r = await updateSolveSet(id, b);
    if (!r) return notFound();
    const changed = (["name", "enabled", "team_ids", "request_type_ids", "ticket_fields", "custom_field_ids", "fields"] as const).filter((k) => JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]));
    if (changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.solve_requirements.updated",
        targetType: "helpdesk_solve_requirements",
        targetId: id,
        targetLabel: r.after.name,
        details: {
          changed,
          ...(changed.includes("name") ? { name_before: r.before.name } : {}),
          enabled: r.after.enabled,
          team_ids: r.after.team_ids,
          request_type_ids: r.after.request_type_ids,
          ticket_fields: r.after.ticket_fields,
          custom_field_ids: r.after.custom_field_ids,
          closing_fields: r.after.fields.map((f) => f.label),
        },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ set: r.after });
  } catch (e) {
    if (e instanceof SolveRequirementError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const s = await deleteSolveSet(id);
  if (!s) return notFound();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.solve_requirements.deleted",
    targetType: "helpdesk_solve_requirements",
    targetId: id,
    targetLabel: s.name,
    details: { enabled: s.enabled, ticket_fields: s.ticket_fields, closing_fields: s.fields.map((f) => f.label) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
