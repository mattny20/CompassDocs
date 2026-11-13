// PUT /api/helpdesk/admin/custom-fields/order  { ids: number[] } → { fields }
//       The order fields are listed in, on the settings page and on a ticket. The listed fields come first, in
//       that order; a field left out keeps its place after them. Audited (helpdesk.custom_field.reordered).
// Helpdesk 1.20.6: Desk settings → Custom fields (lib/helpdesk/custom-fields). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { reorderCustomFields, CustomFieldError } from "@/lib/helpdesk/custom-fields";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the order as { ids: [field ids] }." }, { status: 400 });
  try {
    const fields = await reorderCustomFields(b.ids);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.custom_field.reordered",
      targetType: "helpdesk_custom_field",
      targetLabel: "Custom fields",
      details: { order: fields.filter((f) => !f.archived).map((f) => f.key) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ fields });
  } catch (e) {
    if (e instanceof CustomFieldError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
