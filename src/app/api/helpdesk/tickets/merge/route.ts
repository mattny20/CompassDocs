// POST /api/helpdesk/tickets/merge   { keep: 1049, merge: [1051, 1052], notify: true }
//   → { keep, merged, already, moved }. Every ticket must be one the agent
//   works, in a team where they hold tickets.merge (lib/helpdesk/merge).
//   Refusals: 400 bad body, 404 unknown or outside the agent's queues, 403
//   no tickets.merge there, 409 a workflow, an earlier merge, a held reply;
//   each with `refusals: [{ number, reason }]`. Audited once
//   (helpdesk.ticket.merged). 20 merges a minute per agent.
// Helpdesk 1.19.1 (agent V2).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { HdMergeError, mergeTickets, validateMergeInput } from "@/lib/helpdesk/merge";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  // Held in some team here; each ticket's own team is checked in mergeTickets.
  if (!(await hdCan(gate, "tickets.merge"))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (hdRateLimited(`hd-merge:${gate.id}`, 20, 60_000)) return tooMany();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the merge as JSON.");
  try {
    const input = validateMergeInput(b);
    const r = await mergeTickets({ id: gate.id, role: gate.role, name: gate.name || gate.username }, input, { origin: originOf(req) });
    if (!r.already) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.ticket.merged",
        targetType: "helpdesk_ticket",
        targetId: r.keep.id,
        targetLabel: `#${r.keep.number} ${r.keep.subject}`.slice(0, 200),
        details: {
          keep: r.keep.number,
          merged: r.merged.map((m) => m.number),
          notify: input.notify,
          moved: r.moved,
          // Undo by hand: the moved messages carry merged_from; these files moved too.
          attachment_ids: r.attachment_ids.slice(0, 500),
        },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ keep: r.keep.number, merged: r.merged.map((m) => m.number), already: r.already, moved: r.moved });
  } catch (e) {
    if (e instanceof HdMergeError) return NextResponse.json({ error: e.message, refusals: e.refusals }, { status: e.status });
    throw e;
  }
}
