// GET /api/helpdesk/admin/retention → { settings }
// PUT /api/helpdesk/admin/retention   any of { auto_close_enabled, auto_close_days, retention_enabled,
//     keep_amount, keep_unit, action, anonymise_on_account_removal, include_in_export }
//     → { settings }. Both rules (auto-close, anonymise or delete) are off by default. Audited
//     (helpdesk.retention.updated, the changed keys with before and after).
// Helpdesk 1.19.1 (desk capability settings.manage; mock-up #6): how long tickets are
// kept (lib/helpdesk/retention). The nightly sweep applies the saved settings; the
// preview (…/retention/preview) shows what the next run would do.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { getRetentionSettings, saveRetentionSettings } from "@/lib/helpdesk/retention";
import { retentionPatchError } from "@/lib/helpdesk/retention-shared";
import type { HdRetentionSettings } from "@/lib/helpdesk/retention-shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ settings: await getRetentionSettings() });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 8 * 1024);
  if (!body) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  const err = retentionPatchError(body);
  if (err) return NextResponse.json({ error: err }, { status: 400 });
  const before = await getRetentionSettings();
  const { settings, changed } = await saveRetentionSettings(body as Partial<HdRetentionSettings>);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.retention.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Retention and privacy",
      details: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: settings[k] }])),
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ settings });
}
