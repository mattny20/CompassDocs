// DELETE /api/helpdesk/admin/canned/inactive   { owner_id }
// Helpdesk 1.19.2 (agent W4). A Manager (macros.manage_all) deletes the
// personal canned responses of someone who is deactivated, without reading
// them (the library lists only who and how many, as inactive_owners). An
// active person's are refused: they are theirs alone. Audited as
// helpdesk.canned.purged with the count.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { hqOne } from "@/lib/helpdesk/db-core";
import { deleteInactiveOwnersCanned } from "@/lib/helpdesk/canned";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request) {
  const gate = await hdCapGate("macros.manage_all");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 4 * 1024);
  const ownerId = Number(body?.owner_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return NextResponse.json({ error: "Say whose canned responses to delete." }, { status: 400 });
  const owner = await hqOne<{ name: string; status: string }>("SELECT COALESCE(NULLIF(name, ''), username) AS name, status FROM users WHERE id = $1", [ownerId]);
  if (!owner) return NextResponse.json({ error: "Person not found." }, { status: 404 });
  if (owner.status === "active") {
    return NextResponse.json({ error: `${owner.name} is active: their personal canned responses are theirs to manage.` }, { status: 409 });
  }
  const count = await deleteInactiveOwnersCanned(ownerId);
  if (count) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.canned.purged",
      targetType: "user",
      targetId: ownerId,
      targetLabel: owner.name,
      details: { count },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ok: true, deleted: count });
}
