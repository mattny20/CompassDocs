// Helpdesk 1.20.0: a ticket as Claude in the desk sees it, for the open
// ticket's context and for read_ticket alike: the desk's own read of the
// ticket (ticketDetail, as the agent; the directory's visibility applies),
// each message marked with who wrote it (requester, someone copied or
// another sender, agent, internal note, system), then framed as quoted data
// by prompt.ticketBlock. Returns the internal notes too, for the check that
// keeps them out of requester drafts. The caller has checked that the agent
// works the ticket and that Claude is on for its team. Server-only.

import "server-only";
import type { User } from "../../types";
import type { HdTicket } from "../types";
import type { ContextMessage, ContextTicket } from "./prompt";

export async function ticketForClaude(user: User, t: HdTicket): Promise<{ ticket: ContextTicket; notes: string[] }> {
  const [{ ticketDetail }, { answerRows }, { checklistsForMcp }, { assignableAgents }] = await Promise.all([
    import("../detail"),
    import("../request-types"),
    import("../checklists"),
    import("../teams"),
  ]);
  const d = await ticketDetail(user, t, true);
  const answers = d.form.length ? await answerRows(d.form, t.form_answers ?? {}) : [];
  let assets: unknown = [];
  try {
    assets = await (await import("../assets")).assetsForMcp(t.id);
  } catch {
    /* assets not set up */
  }
  const reqEmail = (t.requester_email ?? "").toLowerCase();
  const side = (m: (typeof d.messages)[number]): string => {
    if (m.kind === "internal") return "agent (internal note, agents only)";
    if (m.kind === "system") return "system";
    if (m.author_team_name || m.via === "desk" || m.via === "mcp") return "agent";
    if ((m.author_id && m.author_id === t.requester_id) || (reqEmail && (m.author_email ?? "").toLowerCase() === reqEmail)) return "requester";
    return "someone copied on the ticket or another sender";
  };
  const messages: ContextMessage[] = d.messages.map((m) => ({
    side: side(m),
    author: m.author_name || m.author_email || "",
    kind: m.kind,
    at: m.created_at,
    body: m.body + (m.attachments?.length ? `\n[attachments: ${m.attachments.map((a) => a.name).join(", ")}]` : ""),
    review_state: m.review_state ?? null,
    via: m.via,
  }));
  const agents = await assignableAgents(t.team_id).catch(() => []);
  return {
    ticket: {
      number: t.number,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      team: t.team_name ?? null,
      team_id: t.team_id,
      assignee: t.assignee_name ?? null,
      requester: t.requester_name,
      tags: t.tags ?? [],
      created_at: t.created_at,
      messages,
      answers: answers.map((a) => ({ question: a.label, answer: a.value })),
      checklists: await checklistsForMcp(t.id),
      assets,
      assignable: agents.map((g) => ({ id: g.user_id, name: g.name })),
    },
    notes: d.messages.filter((m) => m.kind === "internal").map((m) => m.body),
  };
}
