// PUT /api/helpdesk/admin/import/settings { max_upload_mb } → { settings }
//
// Helpdesk 1.19.1, Desk settings → Import: the largest export an admin may
// upload (1 to 2048 MB, default 200). Desk capability settings.manage.
// Audited as helpdesk.settings.updated { section: "import" }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { getImportSettings, saveImportSettings } from "@/lib/helpdesk/import";
import { importErrorResponse, importGate } from "@/lib/helpdesk/import-routes";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const gate = await importGate();
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ max_upload_mb?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  try {
    const before = await getImportSettings();
    const settings = await saveImportSettings({ max_upload_mb: Number(body.max_upload_mb) });
    if (before.max_upload_mb !== settings.max_upload_mb) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.settings.updated",
        targetType: "helpdesk_settings",
        targetLabel: "Helpdesk import",
        details: { section: "import", changed: ["max_upload_mb"], from: before.max_upload_mb, to: settings.max_upload_mb },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ settings });
  } catch (e) {
    return importErrorResponse(e);
  }
}
