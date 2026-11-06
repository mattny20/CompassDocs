// GET    /api/helpdesk/tickets/[number]   HdTicketDetail (agents who work it)
// PATCH  /api/helpdesk/tickets/[number]   { status?, priority?, team_id?, assignee_id?, category?, tags?, subject? }
//          → { ticket, changed }. Each change leaves a timeline line; solving
//          runs the workflow's and the survey's hooks after commit.
// DELETE /api/helpdesk/tickets/[number]   desk capability tickets.delete; audited (helpdesk.ticket.deleted)
// Each PATCH field needs its desk capability (lib/helpdesk/patch-caps patchRefusal).
// Helpdesk 1.19.0 (helpdesk.agent). 404 for a ticket outside the caller's queues.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { ticketDetail } from "@/lib/helpdesk/detail";
import { deleteTicket, HdTicketError, updateTicket, validateTicketPatch } from "@/lib/helpdesk/tickets";
import { deleteTicketFiles } from "@/lib/helpdesk/attachments";
import { badRequest, loadTicketFor, notFound, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { patchRefusal } from "@/lib/helpdesk/patch-caps";
import { mergedLock } from "@/lib/helpdesk/merge";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json(await ticketDetail(gate, found.ticket, true));
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  let patch;
  try {
    patch = validateTicketPatch(b);
  } catch (e) {
    if (e instanceof HdTicketError) return badRequest(e.message);
    throw e;
  }
  const refused = await patchRefusal(gate, found.ticket, patch);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  // 1.19.1: a merged ticket's status is locked (closed into the kept ticket; lib/helpdesk/merge mergedLock).
  if (patch.status !== undefined && patch.status !== found.ticket.status) {
    const locked = await mergedLock(found.ticket);
    if (locked) return NextResponse.json({ error: locked }, { status: 409 });
  }
  // A workflow task asks for its outcome before it is solved (B's engine): 409 opens the outcome form.
  if (
    found.ticket.source === "workflow" &&
    (patch.status === "solved" || patch.status === "closed") &&
    patch.status !== found.ticket.status
  ) {
    const { validateTaskSolve } = await import("@/lib/helpdesk/engine");
    const missing = await validateTaskSolve(found.ticket.id);
    if (missing) return NextResponse.json(missing, { status: 409 });
  }
  try {
    const r = await updateTicket(found.ticket.id, patch, { id: gate.id, name: gate.name || gate.username, role: gate.role }, { origin: originOf(req) });
    if (!r) return notFound();
    if (r.changed.includes("assignee_id")) {
      const { recordManualAssignment } = await import("@/lib/helpdesk/assignment/engine");
      void recordManualAssignment(r.ticket.id, {
        fromUserId: r.before.assignee_id,
        toUserId: r.ticket.assignee_id,
        teamId: r.ticket.team_id,
        actorId: gate.id,
      });
    }
    return NextResponse.json({ ticket: r.ticket, changed: r.changed });
  } catch (e) {
    if (e instanceof HdTicketError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  if (!(await hdCan(gate, "tickets.delete", { teamId: found.ticket.team_id }))) {
    return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }
  // 1.19.1: a ticket on legal hold (lib/helpdesk/retention) is never deleted, by hand either.
  if (Number((found.ticket as { legal_hold?: number }).legal_hold ?? 0) === 1) {
    return NextResponse.json({ error: `#${found.ticket.number} is on legal hold. Take it off hold before deleting it.` }, { status: 409 });
  }
  // 1.19.2: a major incident's own ticket ends the incident (its Status page incident too) before it goes (agent W1).
  await (await import("@/lib/helpdesk/incidents")).onIncidentTicketEnded(found.ticket.id, gate.name || gate.username);
  await deleteTicketFiles(found.ticket.id);
  const row = await deleteTicket(found.ticket.id);
  if (!row) return notFound();
  // A workflow task's ticket: its run moves on now (the sweep would within a minute).
  if (row.source === "workflow") {
    const { onTaskTicketDeleted } = await import("@/lib/helpdesk/engine");
    await onTaskTicketDeleted(row.source_ref).catch((e) => console.error("[helpdesk] advancing a run after a task ticket was deleted:", e));
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.ticket.deleted",
    targetType: "helpdesk_ticket",
    targetId: row.id,
    targetLabel: `#${row.number} ${row.subject}`.slice(0, 200),
    details: { number: row.number, requester_id: row.requester_id, team_id: row.team_id, status: row.status },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
