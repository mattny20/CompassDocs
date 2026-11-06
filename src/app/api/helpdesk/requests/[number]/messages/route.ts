// POST /api/helpdesk/requests/[number]/messages  { body, attachments? }
//   The requester's reply on their own request (public). A request waiting
//   on them, or solved, opens again. → 201 { message, status }
// Helpdesk 1.19.0 (helpdesk.request). Only the requester posts here
// (approvers ask through /api/helpdesk/approvals/[id]/question). 30 a minute.

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, readJson, requesterMessages, tooMany } from "@/lib/helpdesk/access";
import { addMessage, MESSAGE_LIMITS } from "@/lib/helpdesk/messages";
import { attachToMessage, pendingAttachments } from "@/lib/helpdesk/attachments";
import { badRequest, loadTicketFor, notFound, originOf, textField } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const { number } = await params;
  const found = await loadTicketFor(gate, number, "see");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  if (t.requester_id !== gate.id) return notFound();
  if (t.status === "closed") return NextResponse.json({ error: "This request is closed. Send a new one." }, { status: 409 });
  const b = await readJson(req, 128 * 1024);
  if (!b) return badRequest("Send the reply as JSON.");
  const body = textField(b.body, MESSAGE_LIMITS.body);
  if (body === null) return badRequest("The reply is too long.");
  const attachments = await pendingAttachments(b.attachments, { userId: gate.id, ticketId: t.id });
  if (!attachments) return badRequest("One of the files is not available. Upload it again.");
  if (!body && !attachments.length) return badRequest("Write a reply.");
  const res = await addMessage(
    t.id,
    {
      kind: "public",
      body,
      author: { id: gate.id, name: gate.name || gate.username, email: gate.email },
      via: "portal",
      asRequester: true,
      attachments,
    },
    { origin: originOf(req) }
  );
  if (!res) return notFound();
  if (attachments.length) await attachToMessage(attachments.map((a) => a.id), t.id, res.message.id, { userId: gate.id });
  return NextResponse.json({ message: requesterMessages([res.message])[0], status: res.status, reopened: res.reopened }, { status: 201 });
}
