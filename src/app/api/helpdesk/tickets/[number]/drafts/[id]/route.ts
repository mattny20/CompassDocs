// PATCH  /api/helpdesk/tickets/[number]/drafts/[id]  { state: "used" }
//          "Use as reply": the agent moved the draft into the composer. The
//          text is sent (or not) by the agent's own reply, under the normal
//          rules; this only closes the draft. → { draft }
// DELETE /api/helpdesk/tickets/[number]/drafts/[id]   "Discard" → { ok: true }
// Helpdesk 1.19.1 (helpdesk.agent, agents who work the ticket). 404 for a
// ticket outside the caller's queues or a draft not of this ticket; 409 when
// the draft was already used or discarded. Audited as
// helpdesk.reply_draft.used / helpdesk.reply_draft.discarded.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { closeReplyDraft, getReplyDraft } from "@/lib/helpdesk/drafts";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import type { SessionUser } from "@/lib/types";
import type { HdTicket } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; id: string }> };

async function close(gate: SessionUser, req: Request, ctx: Ctx, how: "used" | "discarded") {
  const { number, id: rawId } = await ctx.params;
  const found = await loadTicketFor(gate, number, "work");
  if (found instanceof NextResponse) return found;
  const id = /^\d{1,9}$/.test(rawId) ? Number(rawId) : 0;
  const existing = id ? await getReplyDraft(id) : undefined;
  if (!existing || existing.ticket_id !== found.ticket.id) return notFound();
  const draft = await closeReplyDraft(found.ticket.id, id, how);
  if (!draft) return NextResponse.json({ error: "Someone already used or discarded this draft." }, { status: 409 });
  await auditDraft(gate, found.ticket, draft.id, how, req);
  return draft;
}

async function auditDraft(user: SessionUser, t: HdTicket, draftId: number, how: "used" | "discarded", req: Request) {
  await audit({
    actor: actorFrom(user),
    action: how === "used" ? "helpdesk.reply_draft.used" : "helpdesk.reply_draft.discarded",
    targetType: "helpdesk_ticket",
    targetId: t.id,
    targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
    details: { number: t.number, draft_id: draftId },
    ip: ipFrom(req),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b || b.state !== "used") return badRequest('Send { "state": "used" }.');
  const r = await close(gate, req, ctx, "used");
  if (r instanceof NextResponse) return r;
  return NextResponse.json({ draft: r });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const r = await close(gate, req, ctx, "discarded");
  if (r instanceof NextResponse) return r;
  return NextResponse.json({ ok: true });
}
