// PATCH  /api/helpdesk/admin/categories/[id]  { name?, archived?, move? } → { ok, … }
//          name      rename it. The new name replaces the old one on every ticket, request type, automation,
//                    saved view and report filter that carries it; timeline lines keep their words.
//                    → { ok, renamed: { from, to, tickets } }. Audited (helpdesk.category.renamed).
//          archived  true hides it from pickers and keeps it on the tickets that have it; 409 while a
//                    request type or an automation still sets it. false restores it.
//                    Audited (helpdesk.category.archived / .restored).
//          move      "up" | "down": one place within its level. Audited (helpdesk.category.moved).
//        One change per call.
// DELETE /api/helpdesk/admin/categories/[id] → { ok }. Only an entry nothing uses: 409 names what still
//          uses it (merge it into another one instead). Audited (helpdesk.category.deleted).
// Helpdesk 1.20.6: Desk settings → Categories (lib/helpdesk/categories). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { HdCategoryError, deleteCategory, moveCategory, renameCategory, setCategoryArchived } from "@/lib/helpdesk/categories";
import type { CategoryChange } from "@/lib/helpdesk/categories";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const labelOf = (c: CategoryChange) => (c.parent ? `${c.parent.name} › ${c.name}` : c.name);
const kindOf = (c: CategoryChange) => (c.parent ? "sub-category" : "category");

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const b = await readJson(req, 8 * 1024);
  if (!b) return NextResponse.json({ error: "Send the change as JSON." }, { status: 400 });
  const asked = ["name", "archived", "move"].filter((k) => b[k] !== undefined);
  if (asked.length !== 1) return NextResponse.json({ error: "Send one of name, archived or move." }, { status: 400 });
  const base = { actor: actorFrom(gate), targetType: "helpdesk_category", targetId: id, ip: ipFrom(req) };
  try {
    if (b.name !== undefined) {
      const r = await renameCategory(id, b.name);
      if (!r) return notFound();
      if (r.after.name !== r.before.name) {
        await audit({
          ...base,
          action: "helpdesk.category.renamed",
          targetLabel: labelOf(r.after),
          details: { kind: kindOf(r.after), from: r.before.name, to: r.after.name, tickets: r.tickets, ...(r.after.parent ? { category: r.after.parent.name } : {}) },
        });
      }
      return NextResponse.json({ ok: true, renamed: { from: r.before.name, to: r.after.name, tickets: r.tickets } });
    }
    if (b.archived !== undefined) {
      if (typeof b.archived !== "boolean") return NextResponse.json({ error: "archived is true or false." }, { status: 400 });
      const r = await setCategoryArchived(id, b.archived);
      if (!r) return notFound();
      if (r.changed) {
        await audit({
          ...base,
          action: b.archived ? "helpdesk.category.archived" : "helpdesk.category.restored",
          targetLabel: labelOf(r.entry),
          details: { kind: kindOf(r.entry), name: r.entry.name, ...(r.entry.parent ? { category: r.entry.parent.name } : {}) },
        });
      }
      return NextResponse.json({ ok: true, archived: b.archived });
    }
    if (b.move !== "up" && b.move !== "down") return NextResponse.json({ error: "move is up or down." }, { status: 400 });
    const r = await moveCategory(id, b.move);
    if (!r) return notFound();
    if (r.moved) {
      await audit({
        ...base,
        action: "helpdesk.category.moved",
        targetLabel: labelOf(r.entry),
        details: { kind: kindOf(r.entry), name: r.entry.name, direction: b.move, order: r.order.slice(0, 200), ...(r.entry.parent ? { category: r.entry.parent.name } : {}) },
      });
    }
    return NextResponse.json({ ok: true, moved: r.moved });
  } catch (e) {
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  try {
    const c = await deleteCategory(id);
    if (!c) return notFound();
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.category.deleted",
      targetType: "helpdesk_category",
      targetId: id,
      targetLabel: labelOf(c),
      details: { kind: kindOf(c), name: c.name, ...(c.parent ? { category: c.parent.name } : {}) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
