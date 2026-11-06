// POST /api/helpdesk/tickets/[number]/messages  { kind: 'public'|'internal', body, attachments?, then_status? }
//   An agent's reply (public: the requester sees it, by email too) or
//   internal note, optionally changing the status in the same step ("Send and
//   mark solved"). → 201 { message, status, held }. A Newbie's public reply
//   is held for a lead's review (held: true; lib/helpdesk/review).
// Helpdesk 1.19.0 (helpdesk.agent). 30 a minute per person.

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { addMessage, MESSAGE_LIMITS } from "@/lib/helpdesk/messages";
import { isStatus } from "@/lib/helpdesk/tickets";
import { attachToMessage, pendingAttachments } from "@/lib/helpdesk/attachments";
import { badRequest, loadTicketFor, notFound, originOf, textField } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
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
  const attachments = await pendingAttachments(b.attachments, { userId: gate.id, ticketId: t.id });
  if (!attachments) return badRequest("One of the files is not available. Upload it again.");
  if (!body && !attachments.length) return badRequest("Write a message.");
  const res = await addMessage(
    t.id,
    {
      kind: b.kind,
      body,
      author: { id: gate.id, name: gate.name || gate.username, email: gate.email },
      via: "desk",
      asRequester: false,
      attachments,
      then_status: b.then_status as never,
    },
    { origin: originOf(req) }
  );
  if (!res) return notFound();
  if (attachments.length) await attachToMessage(attachments.map((a) => a.id), t.id, res.message.id, { userId: gate.id });
  return NextResponse.json({ message: res.message, status: res.status, held: res.held }, { status: 201 });
}
