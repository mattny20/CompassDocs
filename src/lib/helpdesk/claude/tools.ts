// Helpdesk 1.20.0: the tools Claude in the desk calls, run AS THE AGENT.
// The rules are the desk's and the Claude connector's own: canWorkTicket for
// every ticket (a ticket outside the agent's queues answers like one that
// does not exist), listTickets with the agent's scope for search, the
// connector's canned responses and asset tools (lib/mcp/helpdesk-tools
// callHelpdeskTool), the knowledge base's answer retrieval with the agent's
// own space scope, and the checklist view. On top, a team Claude is switched
// off for is never read or listed.
//
// Every result is quoted data (prompt.dataBlock / ticketBlock): escaped, with
// trust="untrusted" and who wrote each part, so text a requester or anyone
// else wrote can never pass for an instruction.
//
// Nothing here writes: a draft or a proposed change comes back as a card for
// the agent, who applies it through the desk's own routes with their own
// session (newbie review, required checklists, legal hold and every other
// rule apply there). Proposals are checked with the same permission
// functions the desk's PATCH uses, so Claude is told at once when the agent
// could not apply them. Server-only.

import "server-only";
import type { SessionUser, User } from "../../types";
import { callHelpdeskTool } from "../../mcp/helpdesk-tools";
import { canWorkTicket } from "../access";
import { hdCan } from "../roles";
import { getTicketByNumber, HdTicketError, listTickets, parseTicketNumber, validateTicketPatch } from "../tickets";
import { HD_PRIORITY_LABEL, HD_STATUS_LABEL, type HdTicket } from "../types";
import { DRAFT_LIMITS } from "../drafts";
import { teamAllowed } from "./config";
import { ticketForClaude } from "./context";
import { dataBlock, quote, quoteJson, ticketBlock } from "./prompt";
import type { ClaudeCard, ClaudeDeskConfig, ClaudeSource, ClaudeStreamEvent } from "./shared";

export interface ToolCtx {
  user: User;
  session: SessionUser;
  origin: string;
  ip: string | null;
  cfg: ClaudeDeskConfig;
  /** The chat this turn belongs to (its linked tickets feed the internal-note check). */
  chatId: number;
  /** The ticket open in the desk, when the agent works it. */
  ticket: HdTicket | null;
  /** The agent's explicit say-so (the panel's "May quote internal notes" switch) for this turn. */
  includeNotes: boolean;
  /** Ticket ids this turn touched (read, listed, a card's target): linked to the chat for erasure. */
  touched: Set<number>;
  /** Internal notes Claude has seen this turn. */
  notesSeen: string[];
}

type Activity = Extract<ClaudeStreamEvent, { type: "activity" }>;

export interface ToolOutcome {
  /** The tool_result content Claude reads. */
  content: string;
  isError: boolean;
  activity?: Omit<Activity, "type">;
  /** Candidate source chips (the turn keeps those the answer names). */
  sources?: ClaudeSource[];
  /** A card for the agent (created and numbered by the turn). */
  card?: { kind: ClaudeCard["kind"]; ticketId: number; payload: Record<string, unknown> };
}

const ok = (content: string, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content, isError: false, ...extra });
const done = (value: unknown, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content: JSON.stringify(value), isError: false, ...extra });
const fail = (text: string, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content: text, isError: true, ...extra });

const notFound = (n: unknown) => `No ticket #${String(n)} that you can see.`;
const teamOff = (n: number) => `Claude is switched off for #${n}'s team (Desk settings → Claude in the desk). Work on it without Claude.`;

/** Unwrap a connector tool's answer: its text, and whether it refused. */
async function viaConnector(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; out: any }> {
  const r = (await callHelpdeskTool(ctx.user, name, args, { origin: ctx.origin, ip: ctx.ip })) as { content: { text: string }[]; isError: boolean };
  const text = r.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: r.isError === true, text, out };
}

/** A ticket the agent works and Claude may touch (its team switched on); else the refusal sentence. */
async function workTicket(ctx: ToolCtx, raw: unknown): Promise<HdTicket | string> {
  const n = parseTicketNumber(typeof raw === "number" || typeof raw === "string" ? raw : "");
  if (!n) return notFound(raw);
  const t = await getTicketByNumber(n);
  if (!t || !(await canWorkTicket(ctx.user, t))) return notFound(raw);
  if (!teamAllowed(ctx.cfg, t.team_id)) return teamOff(t.number);
  ctx.touched.add(t.id);
  return t;
}

const ticketSource = (n: number): ClaudeSource => ({ kind: "ticket", label: `#${n}`, href: `/desk/tickets/${n}` });

// --- The tools -----------------------------------------------------------------------------

export async function runDeskTool(name: string, input: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "read_ticket":
        return await readTicket(input, ctx);
      case "search_tickets":
        return await searchTickets(input, ctx);
      case "search_articles":
        return await searchArticles(input, ctx);
      case "asset_lookup":
        return await assetLookup(input, ctx);
      case "list_canned_responses":
        return await cannedResponses(input, ctx);
      case "list_checklists":
        return await listChecklists(input, ctx);
      case "suggest_checklist":
        return await suggestChecklist(input, ctx);
      case "propose_ticket_change":
        return await proposeChange(input, ctx);
      case "draft_reply":
        return await draft("reply", input, ctx);
      case "draft_internal_note":
        return await draft("note", input, ctx);
    }
  } catch (e) {
    if (e instanceof HdTicketError) return fail(e.message);
    throw e;
  }
  return fail(`Unknown tool: ${name}`);
}

async function readTicket(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { ticket, notes } = await ticketForClaude(ctx.user, t);
  ctx.notesSeen.push(...notes);
  return ok(ticketBlock(ticket), {
    activity: { label: ctx.ticket && ctx.ticket.id === t.id ? `Read #${t.number} again` : `Read #${t.number}`, icon: "ticket" },
    sources: [ticketSource(t.number)],
  });
}

async function searchTickets(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 200);
  if (!query) return fail("Say what to search for (query).");
  // The desk's own queue search with the agent's scope (their teams' tickets and those assigned to them).
  const { rows } = await listTickets(ctx.user, { view: "all", q: query, limit: 40, sort: "updated" });
  const want = a.status === "solved" ? ["solved", "closed"] : a.status === "open" ? ["new", "open", "pending", "on_hold"] : null;
  const found = rows
    .filter((t) => !ctx.ticket || t.id !== ctx.ticket.id)
    .filter((t) => !want || want.includes(t.status))
    // The per-team switch by team id: a team Claude is off for is never listed, assigned or not.
    .filter((t) => teamAllowed(ctx.cfg, t.team_id))
    .slice(0, 12);
  for (const t of found) ctx.touched.add(t.id);
  const body = found.length
    ? found
        .map(
          (t) =>
            `<result number="${t.number}" status="${t.status}" team="${quote(t.team_name ?? "none")}" updated="${t.updated_at}">\n<subject written_by="requester">${quote(t.subject)}</subject>\n<requester>${quote(t.requester_name ?? "")}</requester>${t.tags?.length ? `\n<tags>${quote(t.tags.join(", "))}</tags>` : ""}\n</result>`
        )
        .join("\n")
    : "No matching tickets in the agent's queues.";
  return ok(dataBlock("search_results", { query, note: found.length ? "Read a ticket with read_ticket before relying on it." : "" }, body), {
    activity: { label: a.status === "solved" ? "Searched solved tickets" : "Searched tickets", icon: "search" },
    sources: found.map((t) => ticketSource(t.number)),
  });
}

async function searchArticles(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 300);
  if (!query) return fail("Say what to look for (query).");
  // The knowledge base's own answer retrieval, with the agent's reading scope: published documents they can read.
  const [{ hybridRetrieveForAnswer }, { spaceScopeFor }, { findScopeFor }] = await Promise.all([
    import("../../embeddings"),
    import("../../access"),
    import("../../handbook-visibility"),
  ]);
  const docs = await hybridRetrieveForAnswer(query, 4, false, await spaceScopeFor(ctx.user), await findScopeFor(ctx.user));
  const body = docs.length
    ? docs.map((d) => `<article id="${d.id}" title="${quote(d.title).replace(/"/g, "&quot;")}" written_by="knowledge base author" url="${ctx.origin}/doc/${d.id}">\n${quote(d.content.slice(0, 2500))}\n</article>`).join("\n")
    : "No article the agent can read matches.";
  return ok(dataBlock("articles", { query }, body), {
    activity: { label: docs.length === 1 ? "Read 1 article" : `Read ${docs.length} articles`, icon: "book" },
    sources: docs.map((d) => ({ kind: "article" as const, label: d.title, href: `/doc/${d.id}` })),
  });
}

async function assetLookup(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 120);
  const r = await viaConnector(ctx, "hd_asset_lookup", { query });
  if (r.isError) return fail(r.text);
  return ok(dataBlock("assets", { query, written_by: "the asset source (Snipe-IT)" }, quoteJson(r.out ?? r.text)), { activity: { label: `Checked ${query}`, icon: "package" } });
}

async function cannedResponses(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const args: Record<string, unknown> = { limit: 10 };
  if (typeof a.query === "string" && a.query.trim()) args.query = a.query.trim().slice(0, 200);
  if (ctx.ticket) args.number = ctx.ticket.number;
  const r = await viaConnector(ctx, "hd_canned_responses", args);
  if (r.isError) return fail(r.text);
  return ok(dataBlock("canned_responses", { written_by: "agents of this workspace (snippets to reuse)" }, quoteJson(r.out ?? r.text)), {
    activity: { label: "Looked at canned responses", icon: "message" },
  });
}

async function listChecklists(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { ticketChecklistView } = await import("../checklists");
  const v = await ticketChecklistView(ctx.session, t);
  const value = {
    checklists: v.checklists.map((c) => ({ name: c.name, done: c.done, total: c.total, required_open: c.required_open, items: c.items.map((i) => ({ title: i.title, done: i.done, required: !!i.required })) })),
    templates_that_can_be_added: v.can_edit ? v.templates : [],
    solve_blocked_by: v.solve_block,
  };
  return ok(dataBlock("checklists", { number: t.number, written_by: "agents and checklist templates" }, quoteJson(value)), {
    activity: { label: `Checked #${t.number}'s checklists`, icon: "list" },
  });
}

async function suggestChecklist(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { checklistsEditable, templateOptions, ticketChecklists } = await import("../checklists");
  if (!checklistsEditable(t)) return fail(t.merged_into ? "That ticket was merged; checklists go on the ticket it joined." : "That ticket is closed.");
  const tpl = (await templateOptions()).find((x) => x.id === Number(a.template_id));
  if (!tpl) return fail("No checklist template with that id. Call list_checklists for the ones that can be added.");
  if ((await ticketChecklists(t.id)).some((c) => c.name === tpl.name)) return fail(`#${t.number} already has the "${tpl.name}" checklist.`);
  return done(
    { suggested: true, applied: false, note: "The agent sees a card with Apply and Skip. Nothing was added." },
    {
      card: {
        kind: "checklist",
        ticketId: t.id,
        payload: { number: t.number, template_id: tpl.id, title: `Add the checklist "${tpl.name}"`, hint: String(a.reason ?? "").slice(0, 300) },
      },
    }
  );
}

/** "Set status to Waiting on requester", "Set priority to High and add the tag vpn", … */
async function describeChange(t: HdTicket, p: ReturnType<typeof validateTicketPatch>): Promise<string> {
  const parts: string[] = [];
  if (p.status !== undefined) parts.push(`status to ${HD_STATUS_LABEL[p.status]}`);
  if (p.priority !== undefined) parts.push(`priority to ${HD_PRIORITY_LABEL[p.priority]}`);
  if (p.team_id !== undefined) {
    const { listTeams } = await import("../teams");
    const team = (await listTeams()).find((x) => x.id === p.team_id);
    parts.push(`team to ${team?.name ?? "none"}`);
  }
  if (p.assignee_id !== undefined) {
    const { hqOne } = await import("../db-core");
    const u = p.assignee_id ? await hqOne<{ name: string }>("SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = $1", [p.assignee_id]) : undefined;
    parts.push(`owner to ${u?.name ?? "nobody"}`);
  }
  let text = parts.length ? `Set ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "";
  if (p.tags !== undefined) {
    const added = p.tags.filter((x) => !t.tags.includes(x));
    const removed = t.tags.filter((x) => !p.tags!.includes(x));
    const tagText = [added.length ? `add ${added.length === 1 ? "the tag" : "the tags"} ${added.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join(" and ");
    if (tagText) text = text ? `${text}, and ${tagText}` : tagText.charAt(0).toUpperCase() + tagText.slice(1);
  }
  return text || "No change";
}

async function proposeChange(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const raw: Record<string, unknown> = {};
  for (const k of ["status", "priority", "tags", "team_id", "assignee_id"] as const) if (a[k] !== null && a[k] !== undefined) raw[k] = a[k];
  const patch = validateTicketPatch(raw);
  // Leave out what would not change.
  if (patch.status === t.status) delete patch.status;
  if (patch.priority === t.priority) delete patch.priority;
  if (patch.team_id === t.team_id) delete patch.team_id;
  if (patch.assignee_id === t.assignee_id) delete patch.assignee_id;
  if (patch.tags && JSON.stringify([...patch.tags].sort()) === JSON.stringify([...t.tags].sort())) delete patch.tags;
  if (!Object.keys(patch).length) return fail(`That is how #${t.number} already is. Nothing to propose.`);
  // Solving goes through the desk's solve flow (time, maintenance, required checklists), which runs in the open ticket.
  if ((patch.status === "solved" || patch.status === "closed") && (!ctx.ticket || ctx.ticket.id !== t.id)) {
    return fail(`Solving or closing #${t.number} is done with the ticket open in the desk. Tell the agent to open #${t.number} to solve it there.`);
  }
  // The desk PATCH's own checks, so a proposal the agent could not apply is refused now.
  const { patchRefusal } = await import("../patch-caps");
  const refused = await patchRefusal(ctx.session, t, patch);
  if (refused) return fail(`The agent can't make that change: ${refused}`);
  if (patch.status !== undefined) {
    const { mergedLock } = await import("../merge");
    const locked = await mergedLock(t);
    if (locked) return fail(locked);
  }
  const title = await describeChange(t, patch);
  const hint = typeof a.when === "string" && a.when.trim() ? a.when.trim().slice(0, 200) : "";
  return done(
    { proposed: true, applied: false, change: title, note: "The agent sees a card with Apply and Skip. Nothing changed." },
    { card: { kind: "change", ticketId: t.id, payload: { number: t.number, patch, title, hint } } }
  );
}

/** Sentences of a text, normalised, long enough to count as quoting. */
export function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?;]+$/, ""))
    .filter((s) => s.length >= 24);
}

/** Does `draft` quote any of `notes` (a sentence of 24 characters or more, word for word)? */
export function quotesNotes(draft: string, notes: readonly string[]): boolean {
  const d = draft.toLowerCase().replace(/\s+/g, " ");
  return notes.some((n) => sentences(n).some((s) => d.includes(s)));
}

async function draft(kind: "reply" | "note", a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const teamId = t.team_id;
  if (kind === "reply") {
    // A draft is a reply in waiting: the agent must be able to reply at all (sent or held for review), as for the connector.
    if (!(await hdCan(ctx.user, "tickets.reply_public", { teamId })) && !(await hdCan(ctx.user, "tickets.reply_needs_review", { teamId }))) {
      return fail("The agent can't reply to the requester on this ticket (desk role).");
    }
  } else if (!(await hdCan(ctx.user, "tickets.internal_note", { teamId }))) {
    return fail("The agent can't add internal notes on this ticket (desk role).");
  }
  const { mergedLock } = await import("../merge");
  const locked = await mergedLock(t);
  if (locked) return fail(locked);
  const body = String(a.body ?? "").trim();
  if (!body) return fail("Write the draft (body).");
  if (body.length > DRAFT_LIMITS.body) return fail("The draft is too long.");
  if (kind === "reply" && !ctx.includeNotes) {
    // Internal notes stay out of a requester's reply unless the agent switched on "May quote internal notes":
    // the notes of every ticket this chat has touched, this turn's included, and of the target.
    const notes = [...ctx.notesSeen, ...(await (await import("./chats")).linkedInternalNotes(ctx.chatId, [...ctx.touched, t.id]))];
    if (quotesNotes(body, notes)) {
      return fail(
        "This reply quotes an internal note, which the requester must not see. Rewrite it without the note's text. If the agent wants the note in the reply, they switch on \"May quote internal notes\" and ask again."
      );
    }
  }
  // A draft written while other tickets were in view, or that names one, is not put in the box without a click.
  const others = [...ctx.touched].filter((id) => id !== t.id && (!ctx.ticket || id !== ctx.ticket.id));
  const namesOther = [...body.matchAll(/#0*(\d+)\b/g)].some((m) => Number(m[1]) !== t.number);
  const first = (t.requester_name || "").trim().split(/\s+/)[0];
  const title = kind === "reply" ? (first ? `Reply draft for ${first}` : "Reply draft") : "Internal note draft";
  return done(
    { drafted: true, sent: false, where: kind === "reply" ? "the agent's reply box" : "the agent's internal note box", note: "Nothing was sent or saved. The agent edits it and sends it themselves." },
    { card: { kind, ticketId: t.id, payload: { number: t.number, title, body, ...(others.length || namesOther ? { cites_other: true } : {}) } } }
  );
}
