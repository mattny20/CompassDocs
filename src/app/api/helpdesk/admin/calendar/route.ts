// GET /api/helpdesk/admin/calendar → { settings: HdCalendarSettings, chat_connected, overdue: [...] }
//       Desk settings → Event calendar (1.20.6, lib/helpdesk/desk-calendar): the reminder settings, whether a
//       chat app is connected (the "also message agents" choice needs one), and the events in the past whose
//       setup was never marked complete (they still hold their tickets open).
// PUT /api/helpdesk/admin/calendar  { reminder_minutes?, late_reminder?, recipients?, chat?, default_setup_minutes? }
//       → { settings }. Audited (helpdesk.calendar.settings_updated) with what changed.
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditCalendarSettings, EventError, getCalendarSettings, saveCalendarSettings, setupOverdueList } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

async function chatConnected(): Promise<boolean> {
  try {
    const { appConnected, getChatSettings } = await import("@/lib/helpdesk/chat/settings");
    const s = await getChatSettings();
    return appConnected(s, "teams") || appConnected(s, "slack");
  } catch {
    return false;
  }
}

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [settings, chat_connected, overdue] = await Promise.all([getCalendarSettings(), chatConnected(), setupOverdueList()]);
  return NextResponse.json({ settings, chat_connected, overdue });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  try {
    const r = await saveCalendarSettings(b);
    if (r.changed.length) await auditCalendarSettings(actorFrom(gate), r.changed, r.settings, ipFrom(req));
    return NextResponse.json({ settings: r.settings });
  } catch (e) {
    if (e instanceof EventError) return badRequest(e.message);
    throw e;
  }
}
