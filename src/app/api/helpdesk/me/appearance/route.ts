// GET /api/helpdesk/me/appearance → HdMyDeskView ("My desk background" in the desk's
//     user menu; mock-up t5).
// PUT /api/helpdesk/me/appearance { choice?: "workspace" | "own" | "none", level?: "solid" |
//     "subtle" | "glass" | null } → the view. 403 while the workspace doesn't let agents
//     choose. Audited (helpdesk.appearance.my_background_changed).
// Helpdesk 1.19.4 (lib/helpdesk/appearance). Anyone the desk admits.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { myDeskView, saveMyDesk } from "@/lib/helpdesk/appearance";
import { artErrorResponse, deskUserGate } from "@/lib/helpdesk/appearance-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await deskUserGate();
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await myDeskView(gate.id));
}

export async function PUT(req: Request) {
  const gate = await deskUserGate({ write: true });
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 1024);
  if (!b) return NextResponse.json({ error: "Send your choice as JSON." }, { status: 400 });
  try {
    const { view, changed } = await saveMyDesk(gate.id, b);
    if (changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.appearance.my_background_changed",
        targetType: "user",
        targetId: gate.id,
        targetLabel: gate.name || gate.username,
        details: { changed, choice: view.choice, level: view.level },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json(view);
  } catch (e) {
    return artErrorResponse(e);
  }
}
