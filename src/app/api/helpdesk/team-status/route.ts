// GET  /api/helpdesk/team-status   → TeamStatusView: the Status page services
//        the agent's teams follow (the union, never every service), the
//        pop-ups due (one per person per episode, plus recovery notes),
//        the queue banners per team and the solve asks. The desk polls it
//        every minute while visible; it also runs the throttled sync, so a
//        service set down by hand reaches the desk within the minute.
// POST /api/helpdesk/team-status   { action: "dismiss" | "dismiss_recovery"
//        | "hide_banner", episode_id, until? } | { action: "dismiss_ask",
//        incident_id } → { ok }. Per-person marks (a pop-up's dismissal,
//        "Hide for today", "Not now" on a solve ask), not audited: they
//        change nothing anyone else sees.
// Helpdesk 1.19.2 (agent W6, lib/helpdesk/status-teams). Agents only.

import { NextResponse } from "next/server";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { markSeen, statusForAgent, StatusTeamsError, type SeenAction } from "@/lib/helpdesk/status-teams";

export const dynamic = "force-dynamic";

const ACTIONS: SeenAction[] = ["dismiss", "dismiss_recovery", "hide_banner", "dismiss_ask"];

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await statusForAgent(gate));
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-team-status-seen:${gate.id}`, 60, 60_000)) return tooMany();
  const b = await readJson<{ action?: unknown; episode_id?: unknown; incident_id?: unknown; until?: unknown }>(req, 4 * 1024);
  if (!b) return badRequest("Send the action as JSON.");
  const action = b.action as SeenAction;
  if (!ACTIONS.includes(action)) return badRequest("Unknown action.");
  try {
    await markSeen(gate, action, {
      episode_id: b.episode_id === undefined ? undefined : Number(b.episode_id),
      incident_id: b.incident_id === undefined ? undefined : Number(b.incident_id),
      until: typeof b.until === "string" ? b.until.slice(0, 40) : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StatusTeamsError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
