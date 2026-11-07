// GET /api/helpdesk/analytics/options → what the filter bar and the pickers offer the
// caller: { teams, agents, request_types, workflows, tags, categories, can: { export,
// share_everyone, set_default, manage_shared }, timezone, scope }
// Helpdesk 1.19.0 reports (agent K). Teams and agents are those of the
// caller's report scope; tags and categories those seen on its tickets in
// the last year.

import { NextResponse } from "next/server";
import { hq } from "@/lib/helpdesk/db-core";
import { reportScope } from "@/lib/helpdesk/analytics/engine";
import { reportTimezone } from "@/lib/helpdesk/analytics/hours";
import { dashboardRights } from "@/lib/helpdesk/analytics/store";
import { NO_STORE, canExport, errorResponse, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  try {
    const [scope, rights, exp, timezone] = await Promise.all([reportScope(gate), dashboardRights(gate), canExport(gate), reportTimezone()]);
    if (!scope) return NextResponse.json({ error: "You don't have permission to read reports." }, { status: 403 });
    const teamIds = scope.kind === "all" ? null : scope.kind === "teams" ? scope.teams : rights.teams;
    const ticketScope =
      scope.kind === "all" ? "TRUE" : scope.kind === "own" ? "t.assignee_id = $2" : scope.own ? "(t.team_id = ANY($1::int[]) OR t.assignee_id = $2)" : "t.team_id = ANY($1::int[])";
    const p = [teamIds ?? [], gate.id];
    const [teams, agents, types, workflows, tags, categories] = await Promise.all([
      hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY position, name", [teamIds]),
      scope.kind === "own"
        ? hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1", [gate.id])
        : hq<{ id: number; name: string }>(
            `SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS name FROM hd_team_members m JOIN users u ON u.id = m.user_id
              WHERE ($1::int[] IS NULL OR m.team_id = ANY($1::int[])) ORDER BY 2 LIMIT 500`,
            [teamIds]
          ),
      hq<{ id: number; name: string }>("SELECT id, title AS name FROM hd_request_types ORDER BY position, title LIMIT 500"),
      hq<{ id: number; name: string }>("SELECT id, title AS name FROM hd_workflows ORDER BY title LIMIT 500"),
      hq<{ v: string }>(
        `SELECT DISTINCT tg AS v FROM hd_tickets t CROSS JOIN LATERAL unnest(t.tags) tg
          WHERE t.created_at > now() - interval '365 days' AND t.deleted_at IS NULL AND ${ticketScope} AND $1::int[] IS NOT NULL AND $2::int IS NOT NULL ORDER BY 1 LIMIT 200`,
        p
      ),
      hq<{ v: string }>(
        `SELECT DISTINCT t.category AS v FROM hd_tickets t
          WHERE t.category <> '' AND t.created_at > now() - interval '365 days' AND t.deleted_at IS NULL AND ${ticketScope} AND $1::int[] IS NOT NULL AND $2::int IS NOT NULL ORDER BY 1 LIMIT 200`,
        p
      ),
    ]);
    // Automated tickets (alerts, API: agent P's hd_tickets.automated) offer the "Include alerts" toggle.
    const auto = await hq<{ yes: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hd_tickets' AND column_name = 'automated') AS yes"
    );
    const hasAutomated = auto[0]?.yes ? Boolean((await hq<{ yes: boolean }>("SELECT EXISTS (SELECT 1 FROM hd_tickets WHERE automated = 1) AS yes"))[0]?.yes) : false;
    return NextResponse.json(
      {
        has_automated: hasAutomated,
        teams,
        agents,
        request_types: types,
        workflows,
        tags: tags.map((r) => r.v),
        categories: categories.map((r) => r.v),
        can: { export: exp, share_everyone: rights.all || rights.team, set_default: rights.all, manage_shared: rights.all || rights.manager },
        scope: scope.kind,
        timezone,
        me: gate.id,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    return errorResponse(e);
  }
}
