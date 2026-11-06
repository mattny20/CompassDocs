// GET /api/helpdesk/admin/claude  → { level, activity }
// PUT /api/helpdesk/admin/claude  { level: "read" | "notes" | "update" } → { level }
//
// Helpdesk 1.19.1, Desk settings → Claude connector (agent V1): what the
// Claude connector's helpdesk tools may do in this workspace, on top of each
// person's own desk role (lib/helpdesk/claude-connector). Sending replies,
// deciding approvals and publishing are never a level. `activity` is the
// latest helpdesk writes made through the connector (audit rows with via
// "mcp"). Desk capability settings.manage. Audited as
// helpdesk.settings.updated with { section: "claude_connector", from, to }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { getClaudeLevel, isClaudeLevel, recentClaudeActivity, saveClaudeLevel } from "@/lib/helpdesk/claude-connector";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [level, activity] = await Promise.all([getClaudeLevel(), recentClaudeActivity(20)]);
  return NextResponse.json({ level, activity }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 4 * 1024);
  if (!body || !isClaudeLevel(body.level)) return badRequest('Send { "level": "read" | "notes" | "update" }.');
  const before = await saveClaudeLevel(body.level);
  if (before !== body.level) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.settings.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Helpdesk Claude connector",
      details: { section: "claude_connector", from: before, to: body.level },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ level: body.level });
}
