// POST /api/helpdesk/tickets/bulk
//   { numbers: [1047, 1049], patch: { status?, priority?, team_id?, assignee_id?, add_tags?, remove_tags? } }
//   → { results: [{ number, ok, error?, changed? }], ok, skipped }.
//   Up to 200 tickets. Each goes through the ticket PATCH route's checks and
//   updateTicket (lib/helpdesk/bulk): the agent must work it and hold
//   tickets.bulk in its team, and every field needs its own capability; a
//   ticket that fails is skipped with the reason. One audit row
//   (helpdesk.ticket.bulk_updated) with the counts; each ticket's timeline
//   records its own changes. 10 bulk edits a minute per agent.
// Helpdesk 1.19.1 (agent V2).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { bulkUpdate, HdBulkError, validateBulkInput } from "@/lib/helpdesk/bulk";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  // Held in some team here; each ticket's own team is checked per ticket.
  if (!(await hdCan(gate, "tickets.bulk"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (hdRateLimited(`hd-bulk:${gate.id}`, 10, 60_000)) return tooMany();
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the bulk edit as JSON.");
  let input;
  try {
    input = validateBulkInput(b);
  } catch (e) {
    if (e instanceof HdBulkError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const results = await bulkUpdate(gate, input, { origin: originOf(req) });
  const ok = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.ticket.bulk_updated",
    targetType: "helpdesk_ticket",
    targetLabel: `${results.length} tickets`,
    details: {
      requested: results.length,
      updated: ok.filter((r) => (r.changed?.length ?? 0) > 0).length,
      unchanged: ok.filter((r) => !(r.changed?.length ?? 0)).length,
      skipped: skipped.length,
      patch: { ...input.fields, add_tags: input.add_tags, remove_tags: input.remove_tags },
      updated_numbers: ok.filter((r) => (r.changed?.length ?? 0) > 0).map((r) => r.number),
      skipped_numbers: skipped.map((r) => r.number),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ results, ok: ok.length, skipped: skipped.length });
}
