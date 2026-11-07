// Helpdesk 1.19.4 (area C6): share a ticket with another agent, and the
// printed ticket. Server-only; the words and limits are share-shared.
//
// Share
//   shareCandidates  every desk agent but the caller, each marked whether
//                    they work the ticket, decided in one pass (canWorkMany:
//                    the desk roles, the role matrix and the agent_all floor
//                    in three queries, whatever the desk's size). It is a
//                    hint for the dialog: shareTicket decides.
//   shareTicket      re-checks every recipient with canWorkTicket (sharing
//                    never grants access: a recipient who can't work the
//                    ticket refuses the whole share). Then, in one
//                    transaction holding the ticket's row lock (a ticket
//                    binned meanwhile answers 409 and nothing is written):
//                    the follows (an earlier unfollow of theirs is
//                    respected) and one internal timeline line "X shared
//                    this with Y" (kind internal, via system, event 'share':
//                    agents only, never the requester, the portal or a
//                    follower notice). After commit: the audits
//                    (helpdesk.ticket.shared, follower_added) and the desk
//                    event shared_with_me (bell, email hd_shared, push). The
//                    hd_shared email is an agent-only notice (lib/helpdesk/
//                    email HD_AGENT_ONLY_TEMPLATES): a reply to it becomes an
//                    internal note, never a reply to the requester.
//
// Print
//   ticketPrintView  what /desk/tickets/[number]/print renders, for an agent
//                    who works the ticket: the conversation (public replies;
//                    never a newbie's reply held or returned in review, never
//                    a Claude draft, which are not messages), and on request
//                    the details, internal notes, checklists and linked
//                    assets, time logged and attachment names.
//   recordPrintView  helpdesk.ticket.printed, written by the print page as it
//                    renders, with the parts it rendered (parsed on the
//                    server, never a list the browser reports); the same
//                    agent, ticket and parts within a minute are one print.

import "server-only";
import { audit } from "../audit";
import { legacyAuthzEnforcement } from "../authz";
import { getAppSettings } from "../settings-store";
import { formatDateTime, settingsForUser } from "../format";
import type { Role } from "../types";
import { hq, hqOne, withTx } from "./db-core";
import { mdInline } from "./md-inline";
import { canWorkTicket } from "./access";
import { listDeskAgents } from "./roles-agents";
import { getRoleMatrix } from "./roles";
import type { HdDeskAgent } from "./roles-shared";
import { getTicketRow, parseTicketNumber } from "./tickets";
import { listTeams } from "./teams";
import { listMessages } from "./messages";
import { listCcs, listFollowers } from "./ccs";
import { othersPresent } from "./presence";
import { deliverAgentNotification } from "./notify-prefs";
import { HD_PRIORITY_LABEL, HD_SOURCE_LABEL, HD_STATUS_LABEL, type HdTicket } from "./types";
import {
  HD_SHARE_BINNED,
  HD_SHARE_EVENT,
  HD_SHARE_RECIPIENTS_MAX,
  cleanShareMessage,
  printFooter,
  shareLine,
  shareRefusalReason,
  sharedBody,
  sharedTitle,
  type HdPrintOptions,
  type HdShareCandidate,
  type HdShareResult,
} from "./share-shared";

type Actor = { id: number; role: Role; name: string };

export class HdShareError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Workspace roles by id, for the access checks (canWorkTicket reads keys through the workspace role). */
async function workspaceRoles(ids: number[]): Promise<Map<number, Role>> {
  if (!ids.length) return new Map();
  const rows = await hq<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [ids]);
  return new Map(rows.map((r) => [Number(r.id), r.role]));
}

/** Desk agents who hold helpdesk.agent_all (every queue), in one query: the floor roles.ts adds to any desk role. */
async function agentAllHolders(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  // The break-glass keeps every desk key at admin (lib/helpdesk/roles holds()).
  const rows = legacyAuthzEnforcement()
    ? await hq<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active' AND role = 'admin'", [ids])
    : await hq<{ id: number }>(
        `SELECT DISTINCT u.id FROM users u
           JOIN role_assignments ra
             ON ra.scope_type = 'global'
            AND (ra.user_id = u.id OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id))
           JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission = 'helpdesk.agent_all'
          WHERE u.id = ANY($1::int[]) AND u.status = 'active'`,
        [ids]
      );
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * canWorkTicket for many desk agents at once (lib/helpdesk/access): every
 * queue (tickets.view_all, or the helpdesk.agent_all floor), assigned to
 * them, or their team's queue with tickets.view_team. From listDeskAgents'
 * roles and teams, the role matrix and one agent_all query, so the share
 * dialog costs the same for 5 agents as for 500. The dialog's hint only;
 * shareTicket re-checks each recipient with canWorkTicket itself.
 */
export async function canWorkMany(agents: Pick<HdDeskAgent, "user_id" | "role" | "team_ids">[], ticket: Pick<HdTicket, "team_id" | "assignee_id">): Promise<Map<number, boolean>> {
  const [matrix, all] = await Promise.all([getRoleMatrix(), agentAllHolders(agents.map((a) => a.user_id))]);
  const out = new Map<number, boolean>();
  for (const a of agents) {
    const caps = new Set(matrix[a.role] ?? []);
    if (all.has(a.user_id)) caps.add("tickets.view_all");
    out.set(
      a.user_id,
      caps.has("tickets.view_all") ||
        ticket.assignee_id === a.user_id ||
        (caps.has("tickets.view_team") && ticket.team_id !== null && a.team_ids.includes(ticket.team_id))
    );
  }
  return out;
}

/**
 * Is `rawNumber` a ticket in the recycle bin that this agent could work?
 * The routes answer 409 for it, where loadTicketFor (which skips binned
 * tickets) answers 404; anyone who couldn't work it still gets the 404.
 */
export async function binnedTicketFor(user: { id: number; role: Role }, rawNumber: string): Promise<boolean> {
  const n = parseTicketNumber(rawNumber);
  if (!n) return false;
  const row = await hqOne<Pick<HdTicket, "id" | "requester_id" | "team_id" | "assignee_id">>(
    "SELECT id, requester_id, team_id, assignee_id FROM hd_tickets WHERE number = $1 AND deleted_at IS NOT NULL",
    [n]
  );
  return !!row && (await canWorkTicket(user, row));
}

/** The share dialog's list: every desk agent but the caller. */
export async function shareCandidates(user: { id: number }, ticket: HdTicket): Promise<HdShareCandidate[]> {
  const [agents, teams, present, followers] = await Promise.all([
    listDeskAgents(),
    listTeams(),
    othersPresent(ticket.id, user.id).catch(() => []),
    listFollowers(ticket.id),
  ]);
  const others = agents.filter((a) => a.user_id !== user.id);
  const work = await canWorkMany(others, ticket);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const viewing = new Set(present.map((p) => p.user_id));
  const following = new Set(followers.map((f) => f.userId));
  const reason = shareRefusalReason(ticket.team_name);
  const out: (HdShareCandidate & { rank: number })[] = [];
  for (const a of others) {
    const can = work.get(a.user_id) ?? false;
    out.push({
      user_id: a.user_id,
      name: a.name,
      teams: a.team_ids.map((id) => teamName.get(id)).filter(Boolean).join(", "),
      can_see: can,
      reason: can ? null : reason,
      viewing: viewing.has(a.user_id),
      following: following.has(a.user_id),
      // Most likely first: has it open, then the ticket's own team, then anyone else who can see it.
      rank: !can ? 3 : viewing.has(a.user_id) ? 0 : ticket.team_id !== null && a.team_ids.includes(ticket.team_id) ? 1 : 2,
    });
  }
  // A stable sort keeps listDeskAgents' name order within each rank; those who can't see it come last.
  return out.sort((x, y) => x.rank - y.rank).map(({ rank: _rank, ...c }) => c);
}

export interface ShareInput {
  user_ids: number[];
  message: string;
  follow: boolean;
}

/** Validate a share body: 1 to 10 distinct agent ids, a message of at most 500 characters, follow (default on). */
export function parseShareInput(b: Record<string, unknown>): ShareInput {
  const raw = b.user_ids;
  if (!Array.isArray(raw) || raw.length === 0) throw new HdShareError("Pick at least one agent to share it with.");
  const ids = Array.from(new Set(raw));
  if (!ids.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0)) throw new HdShareError("Pick agents from the list.");
  if (ids.length > HD_SHARE_RECIPIENTS_MAX) throw new HdShareError(`Share with at most ${HD_SHARE_RECIPIENTS_MAX} agents at a time.`);
  const message = cleanShareMessage(b.message);
  if (message === null) throw new HdShareError("Keep the message to 500 characters.");
  if (b.follow !== undefined && typeof b.follow !== "boolean") throw new HdShareError("follow must be true or false.");
  return { user_ids: ids as number[], message, follow: b.follow !== false };
}

/**
 * Share the ticket. Every recipient must be a desk agent who works the
 * ticket; otherwise nothing happens and the refusal names them (403).
 */
export async function shareTicket(actor: Actor, ticket: HdTicket, input: ShareInput, ctx: { origin?: string; ip?: string | null } = {}): Promise<HdShareResult> {
  if (input.user_ids.includes(actor.id)) throw new HdShareError("You already have this ticket. Pick someone else.");
  const agents = await listDeskAgents({ userIds: input.user_ids });
  const byId = new Map(agents.map((a) => [a.user_id, a]));
  const roles = await workspaceRoles(input.user_ids);
  const recipients: { user_id: number; name: string }[] = [];
  for (const id of input.user_ids) {
    const a = byId.get(id);
    const role = roles.get(id);
    if (!a || !role) throw new HdShareError("One of those people isn't on the desk any more.", 404);
    if (!(await canWorkTicket({ id, role }, ticket))) {
      throw new HdShareError(`${a.name} ${shareRefusalReason(ticket.team_name).replace(/^Can't/, "can't")}, so it can't be shared with them.`, 403);
    }
    recipients.push({ user_id: id, name: a.name });
  }

  const names = recipients.map((r) => r.name);
  // One transaction under the ticket's row lock: a ticket moved to the
  // recycle bin before the lock refuses (getTicketRow skips binned rows);
  // one binned after it waits for the commit. Nothing is half-written.
  const followed = await withTx(async (client) => {
    if (!(await getTicketRow(ticket.id, client, true))) {
      const binned = await hqOne<{ x: number }>("SELECT 1 AS x FROM hd_tickets WHERE id = $1 AND deleted_at IS NOT NULL", [ticket.id], client);
      throw binned ? new HdShareError(HD_SHARE_BINNED, 409) : new HdShareError("There's no such ticket any more.", 404);
    }
    const added: number[] = [];
    if (input.follow) {
      for (const r of recipients) {
        // As followTicket's auto follow: never overrides someone's own earlier unfollow.
        const row = await hqOne<{ user_id: number }>(
          `INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`,
          [ticket.id, r.user_id, actor.id],
          client
        );
        if (row) added.push(r.user_id);
      }
    }
    await client.query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, event) VALUES ($1, $2, $3, 'internal', $4, 'system', $5)`,
      // Names Markdown-escaped: the stored body is Markdown to every reader (the desk's share
      // line and the print view render it as Markdown too; emails undo the escapes).
      [ticket.id, actor.id, actor.name, shareLine(mdInline(actor.name), names.map(mdInline)), HD_SHARE_EVENT]
    );
    await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [ticket.id]);
    return added;
  });

  // The follows' audit rows, as followTicket writes them (details carry via "share").
  for (const uid of followed) {
    await audit({
      actor: { id: actor.id, name: actor.name, role: actor.role },
      action: "helpdesk.ticket.follower_added",
      targetType: "helpdesk_ticket",
      targetId: ticket.id,
      targetLabel: `#${ticket.number}`,
      details: { user_id: uid, auto: true, via: "share" },
      ip: ctx.ip,
    });
  }

  await audit({
    actor: { id: actor.id, name: actor.name, role: actor.role },
    action: "helpdesk.ticket.shared",
    targetType: "helpdesk_ticket",
    targetId: ticket.id,
    targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
    // The message is the agents' own words to each other: its length is recorded, not its text.
    details: { number: ticket.number, recipients: recipients.map((r) => r.user_id), names, follow: input.follow, followed, message_chars: input.message.length },
    ip: ctx.ip,
  });

  const url = `/desk/tickets/${ticket.number}`;
  for (const r of recipients) {
    const now = followed.includes(r.user_id);
    void deliverAgentNotification(r.user_id, "shared_with_me", {
      ticketNumber: ticket.number,
      title: sharedTitle(actor.name, ticket.number),
      body: sharedBody(ticket.subject, input.message, now),
      url,
      teamId: ticket.team_id,
      actorName: actor.name,
      origin: ctx.origin,
      email: {
        template: "hd_shared",
        vars: {
          ticket_number: String(ticket.number),
          subject: ticket.subject,
          sharer_name: actor.name,
          message: input.message,
          follow_line: now ? "You now follow it, so you'll hear about its new replies and notes." : "",
          ticket_url: url,
        },
      },
    });
  }
  return { shared: recipients, followed };
}

// --- Print -------------------------------------------------------------------------

export interface HdPrintMessage {
  id: number;
  /** "Daniel Okafor", "Ana Kowalski (IT Service Desk)". */
  author: string;
  /** "6 Nov 2026, 12:51 · by email". */
  meta: string;
  internal: boolean;
  /** An internal event line (assignment, share, rule): one muted line on paper, not a card. */
  system: boolean;
  /** Markdown. */
  body: string;
}

export interface HdTicketPrint {
  number: number;
  subject: string;
  workspace: string;
  team: string;
  options: HdPrintOptions;
  details: [string, string][] | null;
  messages: HdPrintMessage[];
  checklists: { name: string; done: number; total: number; items: { title: string; done: boolean }[] }[] | null;
  assets: string[] | null;
  time: { total: string; entries: { who: string; when: string; minutes: string; note: string }[] } | null;
  attachments: string[] | null;
  printedBy: string;
  printedOn: string;
  footer: string;
  paper: "a4" | "letter";
}

const VIA_LABEL: Record<string, string> = { email: "by email", portal: "in Get help", mcp: "via Claude", customer_portal: "in the customer portal" };

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function minutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}

/**
 * The printed ticket for an agent who works it (the caller checks that).
 * Internal notes are printed only when asked for; held and returned newbie
 * replies never are.
 */
export async function ticketPrintView(
  user: { id: number; role: Role; name?: string; username?: string; timezone?: string; date_format?: string },
  ticket: HdTicket,
  options: HdPrintOptions,
  now = new Date()
): Promise<HdTicketPrint> {
  const settings = settingsForUser(await getAppSettings(), user);
  const at = (iso: string | null | undefined) => (iso ? formatDateTime(iso, settings) : "");
  const all = await listMessages(ticket.id);
  const printable = all.filter((m) => {
    const held = m.review_state === "pending" || m.review_state === "returned";
    if (held) return false;
    if (m.kind === "public") return true;
    return options.notes && m.kind === "internal";
  });
  const messages: HdPrintMessage[] = printable.map((m) => {
    const fromAgent = m.kind !== "public" || (m.author_id !== null && m.author_id !== ticket.requester_id);
    const name = m.author_name || m.author_email || "Unknown";
    const via = VIA_LABEL[m.via] ?? "";
    return {
      id: m.id,
      author: fromAgent && m.author_team_name ? `${name} (${m.author_team_name})` : name,
      meta: [at(m.created_at), via, m.kind === "internal" ? "internal note" : ""].filter(Boolean).join(" · "),
      internal: m.kind === "internal",
      system: m.kind === "internal" && m.via === "system",
      body: m.body,
    };
  });

  let details: HdTicketPrint["details"] = null;
  if (options.details) {
    const ccs = await listCcs(ticket.id);
    const requester = ticket.requester_email && ticket.requester_name ? `${ticket.requester_name} (${ticket.requester_email})` : ticket.requester_name || ticket.requester_email || "";
    const open = !["solved", "closed"].includes(ticket.status);
    details = [
      ["Status", HD_STATUS_LABEL[ticket.status] ?? ticket.status],
      ["Requester", requester],
      ["Priority", HD_PRIORITY_LABEL[ticket.priority] ?? ticket.priority],
      ["CC", ccs.map((c) => c.name || c.email).join(", ") || "None"],
      ["Team", ticket.team_name ?? "No team"],
      ["Owner", ticket.assignee_name ?? "Unassigned"],
      ["Opened", `${at(ticket.created_at)} · ${HD_SOURCE_LABEL[ticket.source] ?? ticket.source}`],
    ];
    if (open && ticket.first_reply_due && !ticket.first_replied_at) details.push(["Reply due", at(ticket.first_reply_due)]);
    else if (open && ticket.resolve_due) details.push(["Resolve due", at(ticket.resolve_due)]);
    else if (ticket.solved_at) details.push(["Solved", at(ticket.solved_at)]);
    if (ticket.tags?.length) details.push(["Tags", ticket.tags.join(", ")]);
  }

  let checklists: HdTicketPrint["checklists"] = null;
  let assets: HdTicketPrint["assets"] = null;
  if (options.checklists) {
    const [{ ticketChecklists }, { linkedAssets }] = await Promise.all([import("./checklists"), import("./assets")]);
    const [lists, linked] = await Promise.all([ticketChecklists(ticket.id), linkedAssets(ticket.id)]);
    checklists = lists.map((c) => ({ name: c.name, done: c.done, total: c.total, items: c.items.map((i) => ({ title: i.title, done: i.done })) }));
    assets = linked.map((a) => [a.name, a.tag, a.serial ? `serial ${a.serial}` : ""].filter(Boolean).join(" · "));
  }

  let time: HdTicketPrint["time"] = null;
  if (options.time) {
    const rows = await hq<{ user_name: string; minutes: number; note: string; logged_at: string }>(
      `SELECT COALESCE(NULLIF(u.name, ''), u.username, '') AS user_name, e.minutes, e.note, e.logged_at
         FROM hd_time_entries e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.ticket_id = $1 ORDER BY e.logged_at, e.id`,
      [ticket.id]
    );
    time = {
      total: minutes(rows.reduce((s, r) => s + Number(r.minutes), 0)),
      entries: rows.map((r) => ({ who: r.user_name || "Unknown", when: at(r.logged_at), minutes: minutes(Number(r.minutes)), note: r.note ?? "" })),
    };
  }

  const attachments = options.attachments
    ? printable.flatMap((m) => m.attachments.map((a) => `${a.name} (${kb(a.size)})`))
    : null;

  const printedBy = user.name || user.username || "";
  const printedOn = formatDateTime(now.toISOString(), settings);
  return {
    number: ticket.number,
    subject: ticket.subject,
    workspace: settings.company_name || "CompassDocs",
    team: ticket.team_name ?? "",
    options,
    details,
    messages,
    checklists,
    assets,
    time,
    attachments,
    printedBy,
    printedOn,
    footer: printFooter(printedBy, printedOn, options.notes),
    paper: settings.date_format === "us" ? "letter" : "a4",
  };
}

/**
 * helpdesk.ticket.printed, written by the print page as it renders, with the
 * parts it rendered. The server can't see a real print, so opening the print
 * view is the record (Save page, a fetch of the HTML and Print alike). The
 * same agent, ticket and parts within a minute (a reload, the browser's own
 * re-request) count once. Answers whether a row was written.
 */
export async function recordPrintView(actor: Actor, ticket: HdTicket, options: HdPrintOptions, ip?: string | null): Promise<boolean> {
  const details = { number: ticket.number, ...options };
  const recent = await hqOne<{ x: number }>(
    `SELECT 1 AS x FROM audit_log
      WHERE action = 'helpdesk.ticket.printed' AND actor_id = $1 AND target_type = 'helpdesk_ticket' AND target_id = $2
        AND details = $3::jsonb AND at > now() - interval '1 minute'
      LIMIT 1`,
    [actor.id, String(ticket.id), JSON.stringify(details)]
  );
  if (recent) return false;
  await audit({
    actor: { id: actor.id, name: actor.name, role: actor.role },
    action: "helpdesk.ticket.printed",
    targetType: "helpdesk_ticket",
    targetId: ticket.id,
    targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
    details,
    ip,
  });
  return true;
}

