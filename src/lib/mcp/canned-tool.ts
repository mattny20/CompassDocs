// hd_canned_responses in the Claude connector (1.19.2, agent W4): the
// canned responses an agent may insert, read only. Listed and dispatched by
// lib/mcp/helpdesk-tools (agent side; no workspace level, it writes
// nothing). With a ticket number the agent works, each comes back filled
// for that ticket and them as well, so Claude can quote one in an
// hd_draft_reply. Reading here never counts as a use (only an insert in the
// desk does), and someone else's personal responses are never listed.

import { getTicketByNumber, parseTicketNumber } from "../helpdesk/tickets";
import { canWorkTicket } from "../helpdesk/access";
import { cannedMatches, sharedWithLabel } from "../helpdesk/canned-shared";
import { pickerCanned, renderCannedFor } from "../helpdesk/canned";
import type { User } from "../types";

export const CANNED_TOOL_DEF = {
  name: "hd_canned_responses",
  side: "agent" as const,
  description:
    "Helpdesk desk: the canned responses the person may insert in a reply or note (their teams', the workspace's and their own), read only. Text-only snippets: they never change a ticket. Filter with query. With a ticket number the person works, each also comes back filled for that ticket (requester's name, ticket number, team, the person's name) as `filled`, ready to use in hd_draft_reply. Inserting one in the desk is done there (type ;).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words in the name, folder or text." },
      number: { type: "number", description: "A ticket number (#1047 → 1047) to fill the placeholders for." },
      limit: { type: "number", description: "1 to 50 (default 20)." },
    },
    additionalProperties: false,
  },
};

type Answer = { ok: true; value: unknown } | { ok: false; error: string };

export async function cannedResponsesTool(user: User, a: Record<string, unknown>): Promise<Answer> {
  let ticket = null;
  if (a.number !== undefined && a.number !== null && a.number !== "") {
    const n = parseTicketNumber(typeof a.number === "number" || typeof a.number === "string" ? a.number : "");
    const t = n ? await getTicketByNumber(n) : undefined;
    if (!t || !(await canWorkTicket(user, t))) return { ok: false, error: `No ticket #${String(a.number)} that you can see.` };
    ticket = t;
  }
  const query = typeof a.query === "string" ? a.query.slice(0, 200) : "";
  const limit = Math.min(50, Math.max(1, Number.isFinite(Number(a.limit)) ? Math.floor(Number(a.limit)) : 20));
  const { items } = await pickerCanned(user, ticket);
  const hits = items
    .filter((c) => cannedMatches(c, query))
    .sort((x, y) => y.uses_30d - x.uses_30d || x.title.localeCompare(y.title))
    .slice(0, limit);
  const out = [];
  for (const c of hits) {
    out.push({
      id: c.id,
      name: c.title,
      shared_with: sharedWithLabel(c),
      folder: c.folder || null,
      used_30_days: c.uses_30d,
      text: c.body,
      ...(ticket ? { filled: await renderCannedFor(c, ticket, user) } : {}),
    });
  }
  return {
    ok: true,
    value: {
      ...(ticket ? { ticket: ticket.number } : {}),
      count: out.length,
      canned_responses: out,
      note: "Text only: inserting one never changes the ticket. Placeholders: {{requester.first_name}}, {{requester.name}}, {{ticket.number}}, {{team.name}}, {{agent.first_name}}, {{agent.name}}.",
    },
  };
}
