// POST /api/helpdesk/tickets/[number]/macro/[macroId]   { preview?: boolean }
// Helpdesk 1.19.0 (macros.use in the ticket's team, agent J's capability,
// and the caller must work the ticket).
// preview: the macro's reply filled for this ticket and the field changes
// it would make, nothing written (the composer inserts it for editing).
// Otherwise the reply is posted as the agent and the changes are made,
// checked first as the reply and PATCH routes check them: the reply needs
// reply_public or reply_needs_review (a Newbie's is held for review, and
// its status change waits with it), each field change its own capability
// (lib/helpdesk/patch-caps), and solving a workflow task its required
// hand-off (409 with `missing`, as PATCH answers). A refusal writes nothing.

import { NextResponse } from "next/server";
import { agentTeamIds, canWorkTicket, readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdCan, hdCapGate } from "@/lib/helpdesk/roles";
import { applyMacroToTicket, getMacro, macroVisibleTo } from "@/lib/helpdesk/macros";
import { hqOne } from "@/lib/helpdesk/db-core";
import { patchRefusal } from "@/lib/helpdesk/patch-caps";
import { HdTicketError } from "@/lib/helpdesk/tickets";
import { requestOrigin } from "@/lib/oauth";
import type { HdTicketRow } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; macroId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("macros.use");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const number = Number(String(p.number).replace(/^#/, ""));
  const macroId = Number(p.macroId);
  if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(macroId) || macroId <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const ticket = await hqOne<Pick<HdTicketRow, "id" | "requester_id" | "team_id" | "assignee_id" | "status" | "priority" | "source">>(
    "SELECT id, requester_id, team_id, assignee_id, status, priority, source FROM hd_tickets WHERE number = $1",
    [number]
  );
  if (!ticket || !(await canWorkTicket(gate, ticket))) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  if (!(await hdCan(gate, "macros.use", { teamId: ticket.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const macro = await getMacro(macroId);
  if (!macro || !macroVisibleTo(macro, await agentTeamIds(gate), gate.id)) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  const body = (await readJson<{ preview?: unknown }>(req, 4 * 1024)) ?? {};
  const preview = body.preview === true;
  if (!preview && ticket.status === "closed") return NextResponse.json({ error: "This ticket is closed." }, { status: 409 });
  const teamId = ticket.team_id;
  let result;
  try {
    result = await applyMacroToTicket(
      ticket.id,
      macroId,
      { id: gate.id, name: gate.name || gate.username, email: gate.email },
      {
        preview,
        origin: requestOrigin(req),
        authorize: async ({ body: reply, patch }) => {
          if (reply && !(await hdCan(gate, "tickets.reply_public", { teamId })) && !(await hdCan(gate, "tickets.reply_needs_review", { teamId }))) {
            return { status: 403, error: HD_FORBIDDEN };
          }
          const refused = await patchRefusal(gate, ticket, patch);
          if (refused) return { status: 403, error: refused };
          if (ticket.source === "workflow" && (patch.status === "solved" || patch.status === "closed")) {
            const { validateTaskSolve } = await import("@/lib/helpdesk/engine");
            const missing = await validateTaskSolve(ticket.id);
            if (missing) return { status: 409, error: missing.error, missing: missing.missing_keys };
          }
          return null;
        },
      }
    );
  } catch (e) {
    if (e instanceof HdTicketError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.missing ? { missing: result.missing } : {}) }, { status: result.status });
  return NextResponse.json(result);
}
