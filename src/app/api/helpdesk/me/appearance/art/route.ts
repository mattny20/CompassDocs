// POST   /api/helpdesk/me/appearance/art (multipart: file) → HdMyDeskView. The agent's own
//        desk background: the same rules as the workspace's (JPG, PNG or WebP up to 8 MB,
//        at least 1920 × 1080, re-encoded, metadata dropped); it replaces their earlier one
//        and becomes their choice. Only they can see it. Audited (helpdesk.appearance.my_art_uploaded).
// DELETE /api/helpdesk/me/appearance/art → HdMyDeskView. Removes it and its files; their
//        choice goes back to the workspace's. Audited (helpdesk.appearance.my_art_removed).
//        Allowed even after the workspace stops letting agents choose, so it can always go.
// Helpdesk 1.19.4 (lib/helpdesk/appearance; mock-up t5). Anyone the desk admits.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getAppearanceSettings, myDeskView, removeOwnArt, storeOwnArt } from "@/lib/helpdesk/appearance";
import { artErrorResponse, deskUserGate, readArtUpload } from "@/lib/helpdesk/appearance-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await deskUserGate({ write: true });
  if (gate instanceof NextResponse) return gate;
  // Refused before a byte of the body is read (review C5 finding 2): readArtUpload then rate-limits, also before reading.
  if (!(await getAppearanceSettings()).agents_choose) {
    return NextResponse.json({ error: "Your admin has set the desk's background for everyone." }, { status: 403 });
  }
  const up = await readArtUpload(req, gate.id);
  if (up instanceof NextResponse) return up;
  try {
    const view = await storeOwnArt(up.buf, up.filename, { id: gate.id, name: gate.name || gate.username });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.appearance.my_art_uploaded",
      targetType: "user",
      targetId: gate.id,
      targetLabel: gate.name || gate.username,
      details: { width: view.own?.width ?? null, height: view.own?.height ?? null },
      ip: ipFrom(req),
    });
    return NextResponse.json(view, { status: 201 });
  } catch (e) {
    return artErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const gate = await deskUserGate({ write: true });
  if (gate instanceof NextResponse) return gate;
  if (await removeOwnArt(gate.id)) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.appearance.my_art_removed",
      targetType: "user",
      targetId: gate.id,
      targetLabel: gate.name || gate.username,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(await myDeskView(gate.id));
}
