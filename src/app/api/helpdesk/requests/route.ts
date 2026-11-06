// GET  /api/helpdesk/requests?status=open|solved   the caller's own requests
// POST /api/helpdesk/requests  { request_type_id?, subject, body, answers?, source?, source_ref?, attachments? }
//        → 201 { ticket } (requester-safe)
// Helpdesk 1.19.0 (helpdesk.request). A request of a type with a published
// workflow starts its run once the ticket has committed (lib/helpdesk/events).
// Rate-limited: 10 a minute, 60 an hour per person.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson, requestCreateLimited, requesterSafe, tooMany } from "@/lib/helpdesk/access";
import { getRequestType, mayUseRequestType, validateAnswers } from "@/lib/helpdesk/request-types";
import { createTicket, listMyRequests, TICKET_LIMITS } from "@/lib/helpdesk/tickets";
import { attachToMessage, pendingAttachments } from "@/lib/helpdesk/attachments";
import { badRequest, cleanSourceRef, originOf, textField } from "@/lib/helpdesk/routes";
import { hq } from "@/lib/helpdesk/db-core";
import { checkRequesterSource } from "@/lib/helpdesk/space-access";
import type { HdFormAnswers, HdSource } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

/** Where a requester's request may say it came from (desk, email and workflow are not theirs to claim). */
const REQUESTER_SOURCES: HdSource[] = ["portal", "doc", "handbook", "space_access", "link"];

export async function GET(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const s = new URL(req.url).searchParams.get("status");
  const status = s === "open" || s === "solved" ? s : undefined;
  const [requests, counts] = await Promise.all([
    listMyRequests(gate.id, { status, limit: 100 }),
    hq<{ open: number; solved: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('new', 'open', 'pending', 'on_hold'))::int AS open,
              count(*) FILTER (WHERE status IN ('solved', 'closed'))::int AS solved
         FROM hd_tickets WHERE requester_id = $1 AND parent_ticket_id IS NULL`,
      [gate.id]
    ),
  ]);
  return NextResponse.json({ requests, counts: counts[0] ?? { open: 0, solved: 0 } });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (requestCreateLimited(gate.id)) return tooMany();
  const b = await readJson(req, 256 * 1024);
  if (!b) return badRequest("Send the request as JSON.");

  let subject = textField(b.subject, TICKET_LIMITS.subject);
  if (subject === null) return badRequest(`Keep the subject under ${TICKET_LIMITS.subject} characters.`);
  const body = textField(b.body, TICKET_LIMITS.body);
  if (body === null) return badRequest("The description is too long.");
  const source = (b.source ?? "portal") as HdSource;
  if (!REQUESTER_SOURCES.includes(source)) return badRequest("Unknown source.");
  const sourceRef = await cleanSourceRef(b.source_ref);
  if (!sourceRef) return badRequest("Unknown source reference.");

  let requestTypeId: number | null = null;
  let answers: HdFormAnswers = {};
  if (b.request_type_id !== undefined && b.request_type_id !== null) {
    requestTypeId = Number(b.request_type_id);
    if (!Number.isInteger(requestTypeId) || requestTypeId <= 0 || !(await mayUseRequestType(gate, requestTypeId))) {
      return badRequest("That request type is not available.");
    }
    const rt = (await getRequestType(requestTypeId))!;
    const checked = await validateAnswers(rt.form, b.answers ?? {});
    if (!checked.ok) return badRequest(checked.error);
    answers = checked.value;
    if (!subject) subject = rt.title;
  }
  if (!subject) return badRequest("Say in a few words what you need.");
  if (!requestTypeId && !body) return badRequest("Describe what you need.");
  // A space is named only by a "Request access" request, for a private
  // space the requester cannot read; anything else is dropped silently.
  const origin = await checkRequesterSource(gate, source, sourceRef, requestTypeId);

  const attachments = await pendingAttachments(b.attachments, { userId: gate.id, ticketId: 0 });
  if (!attachments) return badRequest("One of the files is not available. Upload it again.");

  const ticket = await createTicket(
    {
      subject,
      body: body ?? "",
      requester: { id: gate.id, name: gate.name || gate.username, email: gate.email },
      via: "portal",
      source: origin.source,
      source_ref: origin.source_ref,
      request_type_id: requestTypeId,
      answers,
      attachments,
    },
    { actorId: gate.id, actorName: gate.name, origin: originOf(req) }
  );
  if (attachments.length) {
    const first = (await hq<{ id: number }>("SELECT id FROM hd_messages WHERE ticket_id = $1 ORDER BY id LIMIT 1", [ticket.id]))[0];
    if (first) await attachToMessage(attachments.map((a) => a.id), ticket.id, first.id, { userId: gate.id });
  }
  return NextResponse.json({ ticket: requesterSafe(ticket, []).summary }, { status: 201 });
}
