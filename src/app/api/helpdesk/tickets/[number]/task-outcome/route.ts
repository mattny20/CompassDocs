// POST /api/helpdesk/tickets/[number]/task-outcome
//   { outcome: 'done' | 'cant_do', note?, outputs?, handoff_note? }
// A workflow task team records how its task went: done, with the task's
// hand-off fields (required ones must be filled: 400 {error, missing:
// [{key, label}], missing_keys}), or can't be done (a note is required).
// The workflow moves on, carries on without it, or goes on hold for the
// coordinating team; the task ticket is solved with the outcome on it.
// Only someone who may work the task ticket.
// Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { canWorkTicket, helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { recordTaskOutcome } from "@/lib/helpdesk/engine";
import { getTicketByNumber, parseTicketNumber } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  const ticket = number === null ? undefined : await getTicketByNumber(number);
  if (!ticket || !(await canWorkTicket(gate, ticket))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the outcome as JSON." }, { status: 400 });
  const result = await recordTaskOutcome(gate, ticket.id, body);
  // `missing`: [{key, label}] of the hand-off fields still empty; `missing_keys`: the same keys (the earlier contract).
  if (!result.ok)
    return NextResponse.json(
      { error: result.error, ...(result.missing ? { missing: result.missing, missing_keys: result.missing_keys ?? result.missing.map((m) => m.key) } : {}) },
      { status: result.status }
    );
  return NextResponse.json({ ok: true, run_state: result.run_state, step_state: result.step_state });
}
