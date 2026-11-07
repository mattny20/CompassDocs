// GET /api/helpdesk/admin/appearance → HdAppearanceAdminView: the workspace's choice and
//     the library (its uploads, newest first, then the built-ins).
// PUT /api/helpdesk/admin/appearance { light?, dark?, level?, agents_choose? } → the view.
//     light / dark: "none", "builtin:<key>" or "upload:<id>" (a library upload). Audited
//     (helpdesk.appearance.changed) with what changed.
// Helpdesk 1.19.4 (lib/helpdesk/appearance; mock-up t4): Desk settings → Appearance.
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { appearanceAdminView, saveAppearanceSettings } from "@/lib/helpdesk/appearance";
import { artErrorResponse } from "@/lib/helpdesk/appearance-http";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await appearanceAdminView());
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  try {
    const { settings, changed } = await saveAppearanceSettings(b);
    if (changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.appearance.changed",
        targetType: "helpdesk_settings",
        targetId: "appearance",
        targetLabel: "Desk appearance",
        details: { changed, ...settings },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json(await appearanceAdminView());
  } catch (e) {
    return artErrorResponse(e);
  }
}
