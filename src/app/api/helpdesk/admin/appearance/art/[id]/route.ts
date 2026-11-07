// DELETE /api/helpdesk/admin/appearance/art/[id] → the admin view. Removes a library upload
//     and its files; a mode that showed it goes back to none. Audited
//     (helpdesk.appearance.art_removed) with the modes it cleared.
// Helpdesk 1.19.4 (lib/helpdesk/appearance). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { appearanceAdminView, removeWorkspaceArt } from "@/lib/helpdesk/appearance";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  const gone = Number.isInteger(id) && id > 0 ? await removeWorkspaceArt(id) : null;
  if (!gone) return NextResponse.json({ error: "That artwork isn't in the library." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.appearance.art_removed",
    targetType: "helpdesk_desk_art",
    targetId: id,
    targetLabel: gone.label,
    details: { cleared: gone.cleared },
    ip: ipFrom(req),
  });
  return NextResponse.json(await appearanceAdminView());
}
