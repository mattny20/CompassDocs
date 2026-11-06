// GET /api/helpdesk/admin/assets → HdAssetSettingsView (the API key is never in it: key_set only).
// PUT /api/helpdesk/admin/assets   { url?, api_key?, on_solve?, agents_search_all?, disconnect? }
//     → the view. A new address needs the key again, and is a new source: the old cached
//     assets are retired (linked ones kept as gone for the tickets' history, the rest deleted). Audited (helpdesk.assets.settings_changed /
//     helpdesk.assets.disconnected) with the names of what changed, never the key.
// Helpdesk 1.19.3 (lib/helpdesk/assets; mock-up i3): Desk settings → Assets. Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { AssetError, assetSettingsView, saveAssetSettings } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await assetSettingsView());
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  try {
    const { changed, retired } = await saveAssetSettings(b);
    if (changed.length) {
      const view = await assetSettingsView();
      await audit({
        actor: actorFrom(gate),
        action: changed.includes("disconnected") ? "helpdesk.assets.disconnected" : "helpdesk.assets.settings_changed",
        targetType: "helpdesk_settings",
        targetId: "assets",
        targetLabel: "Assets: Snipe-IT",
        details: { changed, url: view.snipeit.url || null, on_solve: view.snipeit.on_solve, agents_search_all: view.agents_search_all, ...(changed.includes("source_changed") ? { linked_assets_retired: retired } : {}) },
        ip: ipFrom(req),
      });
      return NextResponse.json(view);
    }
    return NextResponse.json(await assetSettingsView());
  } catch (e) {
    if (e instanceof AssetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
