// POST /api/helpdesk/admin/appearance/art (multipart: file) → { art: HdArtView, view }
//     Adds a picture to the workspace's library: JPG, PNG or WebP up to 8 MB, at least
//     1920 × 1080, re-encoded to WebP (metadata dropped) and stored in the uploads volume
//     (lib/helpdesk/appearance-upload). It acts at once, like the sign-in artwork; choosing
//     it for a mode is the page's Save. Audited (helpdesk.appearance.art_uploaded).
// Helpdesk 1.19.4 (lib/helpdesk/appearance; mock-up t4). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { appearanceAdminView, storeWorkspaceArt } from "@/lib/helpdesk/appearance";
import { artErrorResponse, readArtUpload } from "@/lib/helpdesk/appearance-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const up = await readArtUpload(req, gate.id);
  if (up instanceof NextResponse) return up;
  try {
    const art = await storeWorkspaceArt(up.buf, up.filename, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.appearance.art_uploaded",
      targetType: "helpdesk_desk_art",
      targetId: art.ref.slice("upload:".length),
      targetLabel: art.label,
      details: { width: art.width, height: art.height, need: art.need },
      ip: ipFrom(req),
    });
    return NextResponse.json({ art, view: await appearanceAdminView() }, { status: 201 });
  } catch (e) {
    return artErrorResponse(e);
  }
}
