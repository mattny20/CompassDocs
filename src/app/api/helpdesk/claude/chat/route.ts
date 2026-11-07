// POST /api/helpdesk/claude/chat   { ticket: number | null, text, intent?, chat_id?, new_chat?, include_notes? }
//        → text/event-stream: one `data: {ClaudeStreamEvent}` per event (start, text, activity,
//          card, sources, notice, refusal, done). Refusals that come first (licence 402,
//          not an agent 403, switched off / no key 409, ticket outside the agent's queues
//          404, a turn already running in this chat 409, rate, in-flight or monthly
//          limit 429) answer as JSON { error } instead. The turn's cost is reserved
//          before streaming starts and settled when it ends, however it ends.
// GET  /api/helpdesk/claude/chat?ticket=N[&chat=ID]  → ClaudeChatHistory (the agent's own only)
//
// Helpdesk 1.20.0, Claude in the desk (lib/helpdesk/claude). The turn runs as
// the signed-in agent; nothing it returns is written until the agent applies
// it through the desk's own routes. Each turn is audited (helpdesk.claude.chat).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { getUserById } from "@/lib/db";
import { canWorkTicket, helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, originOf } from "@/lib/helpdesk/routes";
import { getTicketByNumber, parseTicketNumber } from "@/lib/helpdesk/tickets";
import { chatHistory } from "@/lib/helpdesk/claude/chats";
import { prepareTurn, runTurn } from "@/lib/helpdesk/claude/turn";
import type { ClaudeIntent, ClaudeStreamEvent } from "@/lib/helpdesk/claude/shared";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const INTENTS: ClaudeIntent[] = ["summary", "draft", "research"];

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const raw = url.searchParams.get("ticket");
  let ticketId: number | null = null;
  if (raw) {
    const n = parseTicketNumber(raw);
    const t = n ? await getTicketByNumber(n) : undefined;
    if (!t || !(await canWorkTicket(gate, t))) return NextResponse.json({ error: `No ticket #${raw} that you can see.` }, { status: 404 });
    ticketId = t.id;
  }
  const chat = Number(url.searchParams.get("chat")) || null;
  return NextResponse.json(await chatHistory(gate.id, ticketId, chat), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 32 * 1024);
  if (!b) return badRequest("Send the question as JSON.");
  const user = await getUserById(gate.id);
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const ticket = b.ticket === null || b.ticket === undefined || b.ticket === "" ? null : Number(b.ticket);
  if (ticket !== null && (!Number.isInteger(ticket) || ticket <= 0)) return badRequest("ticket is a ticket number or null.");
  const prepared = await prepareTurn({
    user,
    session: gate,
    origin: originOf(req),
    ip: ipFrom(req),
    ticketNumber: ticket,
    chatId: Number.isInteger(b.chat_id) && (b.chat_id as number) > 0 ? (b.chat_id as number) : null,
    fresh: b.new_chat === true,
    text: typeof b.text === "string" ? b.text : "",
    intent: INTENTS.includes(b.intent as ClaudeIntent) ? (b.intent as ClaudeIntent) : null,
    // The panel's "May quote internal notes" switch: the agent's explicit say-so for this question only.
    includeNotes: b.include_notes === true,
  });
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: ClaudeStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      await runTurn(prepared.turn, emit, abort.signal);
      open = false;
      try {
        controller.close();
      } catch {
        /* the reader went away */
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
