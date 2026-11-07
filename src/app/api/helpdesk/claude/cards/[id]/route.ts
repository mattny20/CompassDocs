// POST /api/helpdesk/claude/cards/[id]   { state: "applied" | "skipped" } → { ok: true }
//
// Helpdesk 1.20.0, Claude in the desk: record what the agent did with one of
// their cards (a draft or a proposed change). It writes nothing to the
// ticket: Apply has already gone through the desk's own route (PATCH
// /api/helpdesk/tickets/[number] or its checklists, with via "claude_desk",
// which audits the change "via Claude in the desk"); a draft went into the
// agent's own reply box. Only the agent's own offered cards change, never one
// on a ticket in the recycle bin (404 otherwise). Audited as
// helpdesk.claude.card { card_id, kind, state, number }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { decideCard } from "@/lib/helpdesk/claude/chats";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "No such card." }, { status: 404 });
  const b = await readJson(req, 1024);
  const state = b?.state === "applied" || b?.state === "skipped" ? b.state : null;
  if (!state) return badRequest('Send { "state": "applied" | "skipped" }.');
  const card = await decideCard(gate.id, id, state);
  if (!card) return NextResponse.json({ error: "No such card, or it was already decided." }, { status: 404 });
  const number = Number((card.payload as { number?: unknown }).number) || null;
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.claude.card",
    targetType: card.ticket_id ? "helpdesk_ticket" : "helpdesk_claude",
    targetId: card.ticket_id,
    targetLabel: number ? `#${number}` : "Claude in the desk",
    details: { card_id: card.id, kind: card.kind, state, number, via: "claude_desk" },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
