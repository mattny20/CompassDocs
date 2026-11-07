// GET    /api/helpdesk/tickets/[number]   HdTicketDetail (agents who work it)
// PATCH  /api/helpdesk/tickets/[number]   { status?, priority?, team_id?, assignee_id?, category?, tags?, subject? }
//          → { ticket, changed }. Each change leaves a timeline line; solving
//          runs the workflow's and the survey's hooks after commit.
// DELETE /api/helpdesk/tickets/[number]   desk capability tickets.delete: moves it to the recycle bin
//          (1.19.4, lib/helpdesk/recycle-bin; audited helpdesk.ticket.binned). 409 on legal hold or an
//          open major incident's own ticket. A binned ticket: GET answers 410 { binned: true } to an
//          agent who works it (the desk then reads GET /api/helpdesk/recycle-bin/[number]); 404 otherwise.
// Each PATCH field needs its desk capability (lib/helpdesk/patch-caps patchRefusal).
// 1.20.0: `via: "claude_desk"` in the body marks a change applied from a Claude in the desk
// card; it is audited (helpdesk.ticket.updated, via "claude_desk") and changes no rule.
// Helpdesk 1.19.0 (helpdesk.agent). 404 for a ticket outside the caller's queues.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { ticketDetail } from "@/lib/helpdesk/detail";
import { HdTicketError, parseTicketNumber, updateTicket, validateTicketPatch } from "@/lib/helpdesk/tickets";
import { badRequest, loadTicketFor, notFound, originOf } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { patchRefusal } from "@/lib/helpdesk/patch-caps";
import { mergedLock } from "@/lib/helpdesk/merge";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).number;
  const found = await loadTicketFor(gate, raw, "work");
  if (found instanceof NextResponse) {
    // 1.19.4 (C7): a ticket in the recycle bin that this agent works answers 410 (the pane shows the bin banner).
    const n = parseTicketNumber(raw);
    if (found.status === 404 && n && (await (await import("@/lib/helpdesk/recycle-bin")).binnedTicketFor(gate, n))) {
      return NextResponse.json({ error: "This ticket is in the recycle bin.", binned: true }, { status: 410 });
    }
    return found;
  }
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
    // 1.20.0: Apply on a Claude in the desk card sends via "claude_desk": the same checks, the
    // timeline says "via Claude in the desk", and the change is audited with that via.
    const viaClaude = b.via === "claude_desk";
    const r = await updateTicket(
      found.ticket.id,
      patch,
      { id: gate.id, name: gate.name || gate.username, role: gate.role, ...(viaClaude ? { via: "claude_desk" as const } : {}) },
      { origin: originOf(req) }
    );
    if (!r) return notFound();
    if (viaClaude && r.changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.ticket.updated",
        targetType: "helpdesk_ticket",
        targetId: r.ticket.id,
        targetLabel: `#${r.ticket.number} ${r.ticket.subject}`.slice(0, 200),
        details: { number: r.ticket.number, changed: r.changed, via: "claude_desk", via_label: "via Claude in the desk" },
        ip: ipFrom(req),
      });
    }
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
  // 1.19.4 (C7): deleting moves the ticket to the recycle bin (lib/helpdesk/recycle-bin),
  // restorable for 30 days; the purge sweep or "Delete for good" removes it and its files.
  const { binTickets } = await import("@/lib/helpdesk/recycle-bin");
  const [r] = await binTickets(gate, [found.ticket.number], { ip: ipFrom(req), origin: originOf(req) });
  if (!r?.ok) return NextResponse.json({ error: r?.error ?? "Couldn't delete the ticket." }, { status: 409 });
  return NextResponse.json({ ok: true, binned: true });
}
