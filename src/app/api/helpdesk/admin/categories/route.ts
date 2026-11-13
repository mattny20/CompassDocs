// GET  /api/helpdesk/admin/categories → { categories: [{ id, name, archived, use: { tickets, request_types,
//        automations }, subcategories: [{ id, name, archived, use }] }], limits }
//        Every entry with what uses it. Reading it also takes in any category typed on a ticket, a request
//        type or an automation that is not on the list yet (an older version on the same database).
// POST /api/helpdesk/admin/categories  { name, parent_id? } → { category: { id, name, parent } } (201).
//        `parent_id` makes it a sub-category of that category. 409 for a name its level already has
//        (whatever its case) and at the limit. Audited (helpdesk.category.created).
// Helpdesk 1.20.6: Desk settings → Categories (lib/helpdesk/categories). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { HdCategoryError, createCategory, listCategoriesAdmin } from "@/lib/helpdesk/categories";
import { CATEGORY_LIMITS } from "@/lib/helpdesk/categories-shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ categories: await listCategoriesAdmin(), limits: CATEGORY_LIMITS });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 8 * 1024);
  if (!b) return NextResponse.json({ error: "Send the category as JSON." }, { status: 400 });
  try {
    const c = await createCategory({ name: b.name, parent_id: b.parent_id }, { id: gate.id });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.category.created",
      targetType: "helpdesk_category",
      targetId: c.id,
      targetLabel: c.parent ? `${c.parent.name} › ${c.name}` : c.name,
      details: { name: c.name, kind: c.parent ? "sub-category" : "category", ...(c.parent ? { category: c.parent.name } : {}) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ category: c }, { status: 201 });
  } catch (e) {
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
