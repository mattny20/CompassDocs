// GET  /api/helpdesk/calendar/feeds[?all=1] → { feeds: HdCalendarFeedView[], teams: [{ id, name }], can_manage }
//        The caller's own calendar feed links and the teams they may make one for; all=1 (settings.manage) lists
//        everyone's. A row never carries its token, only a hint.
// POST /api/helpdesk/calendar/feeds  { team_id: <id> | null } → 201 { url, feed, replaced }
//        Make the caller's link for a team they work, or for every team they work (null). It replaces the link
//        they had for that scope, whose address stops working. `url` is shown this once: only its hash is kept.
//        Audited (helpdesk.calendar_feed.created / .regenerated), never with the address.
// 1.20.6 (lib/helpdesk/desk-calendar-feed). Agents (helpdesk.agent).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { publicOrigin } from "@/lib/oauth";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { createFeed, FeedError, feedTeams, listFeeds } from "@/lib/helpdesk/desk-calendar-feed";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const all = new URL(req.url).searchParams.get("all") === "1";
  const manage = await hdCan(gate, "settings.manage");
  if (all && !manage) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const [feeds, teams] = await Promise.all([listFeeds(gate, { all }), feedTeams(gate)]);
  return NextResponse.json({ feeds, teams, can_manage: manage });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 1024);
  if (!b || (b.team_id !== null && typeof b.team_id !== "number")) return badRequest("Send { team_id } with a team's id, or null for all your teams.");
  try {
    const r = await createFeed(gate, b.team_id as number | null, ipFrom(req));
    const origin = await publicOrigin(req);
    return NextResponse.json(
      { url: `${origin}/api/helpdesk/calendar/feed/${r.token}.ics`, feed: r.view, replaced: r.replaced },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof FeedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
