// GET   /api/helpdesk/tickets/[number]/language   → { language, name, source, source_label }
// PATCH /api/helpdesk/tickets/[number]/language   { language: "fr" | null } → the same, after the change
// The ticket's language (from the requester's directory entry, detected from the first message, or set
// by an agent). Agents who can work the ticket; a change writes an internal line on the timeline (never
// seen by the requester) and is audited as helpdesk.ticket.language_changed.
// Helpdesk 1.19.2 (agent W2).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { auditSkills, badRequest, skillsErrorResponse } from "@/lib/helpdesk/skills/routes";
import { getTicketLanguage, setTicketLanguage } from "@/lib/helpdesk/skills/store";
import { HD_LANGUAGE_SOURCE_LABEL, isLanguageCode, languageName, type HdLanguageSource } from "@/lib/helpdesk/skills/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

async function view(ticketId: number) {
  const l = await getTicketLanguage(ticketId);
  return {
    language: l.language,
    name: languageName(l.language),
    source: l.source,
    source_label: l.source ? HD_LANGUAGE_SOURCE_LABEL[l.source as HdLanguageSource] ?? "" : "",
  };
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  return NextResponse.json(await view(loaded.ticket.id));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const loaded = await loadTicketFor(gate, (await ctx.params).number, "work");
  if (loaded instanceof NextResponse) return loaded;
  const body = await readJson(req, 2 * 1024);
  if (!body || !("language" in body)) return badRequest("Send { language } as JSON.");
  const code = body.language === null || body.language === "" ? null : body.language;
  if (code !== null && !isLanguageCode(code)) return badRequest("Choose a language.");
  try {
    const changed = await setTicketLanguage(loaded.ticket.id, code, { id: gate.id, name: gate.name });
    if (changed) {
      await auditSkills(req, gate, "helpdesk.ticket.language_changed", { type: "helpdesk_ticket", id: loaded.ticket.id, label: `#${loaded.ticket.number}` }, {
        from: changed.before,
        to: changed.after,
      });
    }
  } catch (e) {
    const r = skillsErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return NextResponse.json(await view(loaded.ticket.id));
}
