// GET /api/helpdesk/admin/shortcuts → { shortcuts, types, automatic }
// PUT /api/helpdesk/admin/shortcuts   { doc?, handbook?, space_access?, link? }: a request type id,
//     "hidden" or null (automatic) each → { shortcuts }. Audited (helpdesk.shortcuts.updated,
//     changed keys with before and after).
// Helpdesk 1.19.1 (desk capability settings.manage; mock-up #7): which request type each
// CompassDocs shortcut opens (lib/helpdesk/shortcuts). `automatic` names, per shortcut, the type
// the 1.19.0 rule picks today (for everyone who may use it), so "Automatic" says what it means.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { listRequestTypes } from "@/lib/helpdesk/request-types";
import { getShortcuts, saveShortcuts, shortcutTypeOptions, ShortcutError } from "@/lib/helpdesk/shortcuts";
import { HD_SHORTCUT_KEYS } from "@/lib/helpdesk/shortcuts-shared";
import type { HdShortcutKey } from "@/lib/helpdesk/shortcuts-shared";
import { automaticTriggerType } from "@/components/helpdesk/help/trigger-type";

export const dynamic = "force-dynamic";

async function view() {
  const [shortcuts, types, active] = await Promise.all([getShortcuts(), shortcutTypeOptions(), listRequestTypes({ activeOnly: true })]);
  const automatic = {} as Record<HdShortcutKey, number | null>;
  for (const k of HD_SHORTCUT_KEYS) automatic[k] = (await automaticTriggerType(k, active))?.id ?? null;
  return { shortcuts, types, automatic };
}

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 8 * 1024);
  if (!body) return NextResponse.json({ error: "Send the shortcuts as JSON." }, { status: 400 });
  const before = await getShortcuts();
  let saved: Awaited<ReturnType<typeof saveShortcuts>>;
  try {
    saved = await saveShortcuts(body);
  } catch (e) {
    if (e instanceof ShortcutError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (saved.changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.shortcuts.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Shortcuts",
      details: Object.fromEntries(saved.changed.map((k) => [k, { from: before[k], to: saved.shortcuts[k] }])),
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(await view());
}
