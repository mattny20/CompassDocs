// GET  /api/helpdesk/tickets/[number]/solve-requirements[?reply=1] → HdSolveCheck
//        What a solve of this ticket needs now ("Before you solve", lib/helpdesk/solve-requirements): the requirement
//        sets that match it, each ticket field met or not, the closing fields with the answers kept so far, what is
//        missing and the refusal sentence. reply=1: asked for "Send and set Solved" on a public reply, which counts as
//        the reply a set may require.
// POST /api/helpdesk/tickets/[number]/solve-requirements  { solve_answers?, solve_fields?, reply? } → HdSolveCheck
//        The dialog's check before it submits: the same read with these answers and ticket fields applied. Nothing is
//        stored; a bad answer is 400 with its sentence. The solve itself (PATCH, or the messages POST) checks again
//        and stores the answers in its own transaction.
// Helpdesk 1.20.5 (helpdesk.agent, an agent who works the ticket). Agents only.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";
import { HdTicketError, validateTicketPatch } from "@/lib/helpdesk/tickets";
import { solveCheckFor, type SolveFieldPatch } from "@/lib/helpdesk/solve-requirements";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const reply = new URL(req.url).searchParams.get("reply") === "1";
  const { invalid: _none, ...check } = await solveCheckFor(found.ticket, { replyPending: reply });
  return NextResponse.json(check);
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the answers as JSON.");
  let patch: SolveFieldPatch | undefined;
  if (b.solve_fields !== undefined && b.solve_fields !== null) {
    if (typeof b.solve_fields !== "object" || Array.isArray(b.solve_fields)) return badRequest("Send solve_fields as an object.");
    const raw = b.solve_fields as Record<string, unknown>;
    try {
      patch = validateTicketPatch({ assignee_id: raw.assignee_id, team_id: raw.team_id, category: raw.category, tags: raw.tags });
    } catch (e) {
      if (e instanceof HdTicketError) return badRequest(e.message);
      throw e;
    }
  }
  const { invalid, ...check } = await solveCheckFor(found.ticket, { answers: b.solve_answers, patch, replyPending: b.reply === true });
  if (invalid) return badRequest(invalid);
  return NextResponse.json(check);
}
