// POST /api/helpdesk/tickets/[number]/messages  { kind: 'public'|'internal', body, attachments?, then_status?,
//        expect_last_message_id?, force? }
//   expect_last_message_id (1.19.1): the newest message the composer knew of
//   when typing started; a newer one by someone else answers 409 { newer }
//   and nothing is posted (force: true sends anyway).
//   An agent's reply (public: the requester sees it, by email too) or
//   internal note, optionally changing the status in the same step ("Send and
//   mark solved"). → 201 { message, status, held }. A Newbie's public reply
//   is held for a lead's review (held: true; lib/helpdesk/review).
//   1.20.5 ("Before you solve", lib/helpdesk/solve-requirements): with a then_status that solves,
//   `solve_answers` (closing answers by field key) and `solve_fields` ({ assignee_id?, team_id?,
//   category?, tags? }, each needing its desk capability) are applied in the same transaction as the
//   status. A ticket that would still need something answers 409 { error, code:
//   "solve_requirements", missing } before anything is posted. A reply held for review changes no
//   status, so it is never asked.
// Helpdesk 1.19.0 (helpdesk.agent). 30 a minute per person.

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { addMessage, MESSAGE_LIMITS } from "@/lib/helpdesk/messages";
import { HdTicketError, isStatus } from "@/lib/helpdesk/tickets";
import { attachToMessage, pendingAttachments } from "@/lib/helpdesk/attachments";
import { badRequest, loadTicketFor, notFound, originOf, textField } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { collisionRefusal } from "@/lib/helpdesk/presence";
import { mergedLock } from "@/lib/helpdesk/merge";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  // 1.19.1: a merged ticket's conversation is read-only (lib/helpdesk/merge mergedLock).
  const locked = await mergedLock(t);
  if (locked) return NextResponse.json({ error: locked }, { status: 409 });
  const b = await readJson(req, 128 * 1024);
  if (!b) return badRequest("Send the message as JSON.");
  if (b.kind !== "public" && b.kind !== "internal") return badRequest("A message is public or internal.");
  const body = textField(b.body, MESSAGE_LIMITS.body);
  if (body === null) return badRequest("The message is too long.");
  if (b.then_status !== undefined && !isStatus(b.then_status)) return badRequest("Unknown status.");
  // Desk roles (lib/helpdesk/roles): notes, replies (sent or held for review), status.
  const teamId = t.team_id;
  const may =
    b.kind === "internal"
      ? await hdCan(gate, "tickets.internal_note", { teamId })
      : (await hdCan(gate, "tickets.reply_public", { teamId })) || (await hdCan(gate, "tickets.reply_needs_review", { teamId }));
  if (!may || (b.then_status !== undefined && !(await hdCan(gate, "tickets.change_status", { teamId })))) {
    return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }
  // A workflow task asks for its required hand-off before "Send and mark
  // solved" (as PATCH does; the core refuses it too): nothing is posted.
  if (t.source === "workflow" && (b.then_status === "solved" || b.then_status === "closed") && b.then_status !== t.status) {
    const { validateTaskSolve } = await import("@/lib/helpdesk/engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return NextResponse.json(missing, { status: 409 });
  }
  // 1.19.2: required checklist items block "Send and set Solved" before anything is posted (lib/helpdesk/checklists, agent W3).
  // (The same test as updateTicket: solved → closed never asks; addMessage re-checks under the ticket's lock.)
  const checklists = await import("@/lib/helpdesk/checklists");
  if (checklists.solvesForChecklists(t.status, b.then_status as string | undefined)) {
    const held = await checklists.checklistSolveRefusal(t.id);
    if (held) return NextResponse.json(held, { status: 409 });
  }
  // 1.20.5: "Before you solve" requirement sets block it too, before anything is posted. The ticket fields the dialog
  // set are checked as PATCH checks them; a public reply counts as the reply a set may require. A newbie's reply is
  // held for review and changes no status, so nothing is asked of it.
  let solve: { answers?: unknown; fields?: import("@/lib/helpdesk/solve-requirements").SolveFieldPatch } | undefined;
  const solveReqs = await import("@/lib/helpdesk/solve-requirements");
  if (solveReqs.solvesForRequirements(t.status, b.then_status as string | undefined)) {
    let fields: import("@/lib/helpdesk/solve-requirements").SolveFieldPatch | undefined;
    if (b.solve_fields !== undefined && b.solve_fields !== null) {
      if (typeof b.solve_fields !== "object" || Array.isArray(b.solve_fields)) return badRequest("Send solve_fields as an object.");
      const raw = b.solve_fields as Record<string, unknown>;
      try {
        const { validateTicketPatch } = await import("@/lib/helpdesk/tickets");
        const p = validateTicketPatch({ assignee_id: raw.assignee_id, team_id: raw.team_id, category: raw.category, tags: raw.tags });
        if (Object.keys(p).length) {
          const { patchRefusal } = await import("@/lib/helpdesk/patch-caps");
          const refused = await patchRefusal(gate, t, p);
          if (refused) return NextResponse.json({ error: refused }, { status: 403 });
          fields = p;
        }
      } catch (e) {
        if (e instanceof HdTicketError) return badRequest(e.message);
        throw e;
      }
    }
    solve = { answers: b.solve_answers, fields };
    const { prepareReply } = await import("@/lib/helpdesk/review");
    const willHold = b.kind === "public" && (await prepareReply({ id: gate.id }, t, { kind: "public", asRequester: false })).review_state === "pending";
    if (!willHold) {
      const needs = await solveReqs.solveRequirementRefusal(t.id, { answers: solve.answers, patch: fields, replyPending: b.kind === "public" });
      if (needs) return NextResponse.json({ error: needs.error, code: needs.code, missing: needs.missing }, { status: needs.status });
    }
  }
  // 1.19.1 collision warning (lib/helpdesk/presence): someone else's newer
  // message since expect_last_message_id → 409 { newer }, unless force.
  const collided = await collisionRefusal(t.id, gate.id, b);
  if (collided) return collided;
  const attachments = await pendingAttachments(b.attachments, { userId: gate.id, ticketId: t.id });
  if (!attachments) return badRequest("One of the files is not available. Upload it again.");
  if (!body && !attachments.length) return badRequest("Write a message.");
  let res: Awaited<ReturnType<typeof addMessage>>;
  try {
    res = await addMessage(
      t.id,
      {
        kind: b.kind,
        body,
        author: { id: gate.id, name: gate.name || gate.username, email: gate.email },
        via: "desk",
        asRequester: false,
        attachments,
        then_status: b.then_status as never,
        solve,
      },
      { origin: originOf(req) }
    );
  } catch (e) {
    // A merge committed meanwhile (re-checked under its lock): 409 naming the kept ticket.
    if (e instanceof HdTicketError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
    throw e;
  }
  if (!res) return notFound();
  if (attachments.length) await attachToMessage(attachments.map((a) => a.id), t.id, res.message.id, { userId: gate.id });
  return NextResponse.json(
    { message: res.message, status: res.status, held: res.held, ...(res.status_unchanged ? { status_unchanged: res.status_unchanged } : {}) },
    { status: 201 }
  );
}
