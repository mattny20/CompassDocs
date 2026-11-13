// GET /api/helpdesk/calendar/feed/<token>.ics
// Helpdesk 1.20.6: a private iCal feed of the desk's event calendar, for a calendar app to subscribe to.
// No session is read: the token in the path is the only credential (lib/helpdesk/desk-calendar-feed serveFeed
// has the rules). It is long and random, stored only as a hash, compared in constant time; every address that
// is not a working link answers the same 404, so an address reveals nothing. Unlicensed: 402 for every address.
// Read-only, never cached by a shared cache, never indexed. The Duo desk rule is about sessions and does not
// apply here, as for API tokens.

import { ipFrom } from "@/lib/audit";
import { publicOrigin } from "@/lib/oauth";
import { serveFeed } from "@/lib/helpdesk/desk-calendar-feed";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await serveFeed(String(token ?? "").slice(0, 200), { origin: await publicOrigin(req), ip: ipFrom(req) });
  return new Response(r.body, { status: r.status, headers: r.headers });
}
