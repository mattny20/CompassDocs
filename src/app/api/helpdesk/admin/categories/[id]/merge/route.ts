// POST /api/helpdesk/admin/categories/[id]/merge  { into_id } → { ok, merged: { from, into, tickets,
//        request_types, moved_subcategories } }
// Merge an entry into another and remove it. Every ticket, request type, automation, saved view and
// report filter that carried it carries the other one from here on; timeline lines keep their words.
//   - a category into another category: a sub-category both list becomes one, the others move under
//     the kept category;
//   - a sub-category into another sub-category (of any category), or into a category alone (the
//     tickets take that category and no sub-category).
// 409 when the target is archived. Audited (helpdesk.category.merged).
// Helpdesk 1.20.6: Desk settings → Categories (lib/helpdesk/categories). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { HdCategoryError, mergeCategory } from "@/lib/helpdesk/categories";
import type { CategoryChange } from "@/lib/helpdesk/categories";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const labelOf = (c: CategoryChange) => (c.parent ? `${c.parent.name} › ${c.name}` : c.name);

export async function POST(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const b = await readJson(req, 8 * 1024);
  const into = Number(b?.into_id);
  if (!b || !Number.isInteger(into) || into <= 0) return NextResponse.json({ error: "Pick what to merge it into." }, { status: 400 });
  try {
    const r = await mergeCategory(id, into);
    if (!r) return notFound();
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.category.merged",
      targetType: "helpdesk_category",
      targetId: r.into.id,
      targetLabel: labelOf(r.into),
      details: {
        kind: r.from.parent ? "sub-category" : "category",
        from: labelOf(r.from),
        into: labelOf(r.into),
        tickets: r.tickets,
        request_types: r.request_types,
        ...(r.moved_subcategories.length ? { moved_subcategories: r.moved_subcategories.slice(0, 100) } : {}),
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, merged: { from: labelOf(r.from), into: labelOf(r.into), tickets: r.tickets, request_types: r.request_types, moved_subcategories: r.moved_subcategories } });
  } catch (e) {
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
