// GET  /api/helpdesk/views[?counts=0]   the saved views the caller sees, each
//        with can_edit and its ticket count in the caller's scope, and the
//        teams they may share a view with → HdSavedViewsList
// POST /api/helpdesk/views   { name, filters, team_id? }   → 201 { view }
//        personal (no team_id) or shared with a team (agents.manage_team on
//        that team: a team lead and up). Filters are the tickets API's queue
//        parameters (lib/helpdesk/ticket-filters). Audited helpdesk.view.created.
// Helpdesk 1.19.1 saved views (agent V4, lib/helpdesk/saved-views).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { hqOne } from "@/lib/helpdesk/db-core";
import {
  cleanViewFilters,
  cleanViewName,
  createView,
  listVisibleViews,
  SavedViewError,
  shareTeams,
  withCounts,
} from "@/lib/helpdesk/saved-views";
import type { HdSavedViewsList } from "@/lib/helpdesk/saved-views-shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const counts = new URL(req.url).searchParams.get("counts") !== "0";
  const views = await listVisibleViews(gate);
  const out: HdSavedViewsList = { views: counts ? await withCounts(gate, views) : views, share_teams: await shareTeams(gate) };
  return NextResponse.json(out);
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-views:${gate.id}`, 30, 60_000)) return tooMany();
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the view as JSON." }, { status: 400 });
  let teamId: number | null = null;
  if (b.team_id !== undefined && b.team_id !== null) {
    teamId = Number(b.team_id);
    if (!Number.isSafeInteger(teamId) || teamId <= 0 || !(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [teamId]))) {
      return NextResponse.json({ error: "Unknown team." }, { status: 400 });
    }
    if (!(await hdCan(gate, "agents.manage_team", { teamId }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }
  try {
    const name = cleanViewName(b.name);
    const filters = await cleanViewFilters(b.filters);
    const view = await createView(gate, { name, filters, teamId });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.view.created",
      targetType: "helpdesk_view",
      targetId: view.id,
      targetLabel: view.name,
      details: { scope: teamId ? "team" : "personal", team_id: teamId, filters },
      ip: ipFrom(req),
    });
    return NextResponse.json({ view }, { status: 201 });
  } catch (e) {
    if (e instanceof SavedViewError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
