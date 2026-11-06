// POST /api/helpdesk/approvals/[id]/question  { body }
// The approver's "Ask a question": a public message on the request, from
// them, which the requester is told about and answers in the conversation.
// Only while the approval waits for them. Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { approvalRateLimited, askQuestion } from "@/lib/helpdesk/approvals";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const raw = (await ctx.params).id;
  if (!/^\d{1,9}$/.test(raw)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (approvalRateLimited("question", gate.id)) {
    return NextResponse.json({ error: "Too many questions at once. Try again in a few minutes." }, { status: 429 });
  }
  const body = await readJson<{ body?: unknown }>(req, 32 * 1024);
  if (!body) return NextResponse.json({ error: "Send the question as JSON." }, { status: 400 });
  const result = await askQuestion(gate, Number(raw), body.body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  // The requester hears it the way they hear an agent's reply (after the write, never inside it).
  try {
    const { notifyReply } = await import("@/lib/helpdesk/notify");
    await notifyReply(result.ticket_id, result.message_id, {
      actorId: gate.id,
      actorName: gate.name || gate.username,
    });
  } catch (e) {
    console.error("[helpdesk] question notice failed:", e);
  }
  return NextResponse.json({ ok: true, message_id: result.message_id }, { status: 201 });
}
