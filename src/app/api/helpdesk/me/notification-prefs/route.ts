// GET /api/helpdesk/me/notification-prefs   the agent's preferences, the
//     matrix as it applies (workspace locks and defaults included), time
//     zone, teams, devices and whether a pause holds now
// PUT /api/helpdesk/me/notification-prefs   change part of them:
//     { matrix?, teams?, quiet?, preview?, sound?, pause?: "1h"|"tomorrow"|"indefinite"|"off" }
//     A matrix cell the workspace locks is refused.
// Agents only, licence-gated, same-origin (Helpdesk 1.19.0).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import {
  effectiveDeskMatrix,
  NotifyPrefsError,
  notifyView,
  saveNotifyPrefs,
  HD_NOTIFY_EVENT_INFO,
  type HdNotifyChannel,
  type HdNotifyEvent,
} from "@/lib/helpdesk/notify-prefs";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await notifyView(gate.id));
}

export async function PUT(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ matrix?: unknown }>(req, 16 * 1024);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (body.matrix && typeof body.matrix === "object") {
    const effective = await effectiveDeskMatrix(gate.id);
    for (const [ev, row] of Object.entries(body.matrix as Record<string, Record<string, unknown>>)) {
      for (const ch of Object.keys(row ?? {})) {
        const cell = effective[ev as HdNotifyEvent]?.[ch as HdNotifyChannel];
        if (cell?.locked) {
          const label = HD_NOTIFY_EVENT_INFO[ev as HdNotifyEvent]?.label ?? ev;
          return NextResponse.json({ error: `Your workspace sets ${label} by ${ch} for everyone.` }, { status: 400 });
        }
      }
    }
  }
  try {
    const prefs = await saveNotifyPrefs(gate.id, body);
    return NextResponse.json(await notifyView(gate.id, prefs));
  } catch (e) {
    if (e instanceof NotifyPrefsError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
