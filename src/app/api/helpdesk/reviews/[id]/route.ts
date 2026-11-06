// POST /api/helpdesk/reviews/[id]  { decision: 'approve'|'return', edited_body?, note? } → { review }
//   Approve a held reply (optionally edited; it is sent now) or return it
//   to its author with a note. Helpdesk 1.19.0 desk roles (agent J);
//   replies.review for the ticket's team. Audited helpdesk.reply.reviewed.

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { decideReview, parseDecision, ReviewError } from "@/lib/helpdesk/review";
import { originOf } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("replies.review");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const b = await readJson(req, 128 * 1024);
  if (!b) return NextResponse.json({ error: "Send the decision as JSON." }, { status: 400 });
  const parsed = parseDecision(b);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const review = await decideReview(gate, id, parsed.value, { origin: originOf(req), ip: ipFrom(req) });
    return NextResponse.json({ review });
  } catch (e) {
    if (e instanceof ReviewError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
