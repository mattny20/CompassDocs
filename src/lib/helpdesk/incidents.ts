// Helpdesk 1.19.2: major incidents (agent W1). One ticket stands for an
// outage; the tickets people raise about it are linked to it, so the desk
// answers them all at once.
//
//   declare   a new ticket (the incident's own: the title as subject, the
//             team and priority chosen, assigned to the declarer when they
//             are in the team) and its hd_incidents row, plus the chosen
//             tickets linked, in one transaction. Needs incidents.manage in
//             the team, and replies that go out directly (an update is a
//             public reply; a newbie's would wait for review). Every ticket
//             to link is checked on its own first (linkRefusal); one refusal
//             refuses the whole declare, with a reason per ticket.
//   link      a ticket joins one open incident (hd_incident_links: one
//             incident per ticket). Checked per ticket: the agent works it
//             and holds incidents.link in its team; not a workflow task,
//             not merged, not closed, not an incident itself. With
//             notify_on_link, its requester hears "we know about this" (a
//             public message and hd_incident_update). Unlink is checked the
//             same way.
//   rule      while the incident is open, a new ticket whose subject or
//             opening message contains one of its words links itself
//             (events.ts afterTicketCreated → autoLinkNewTicket).
//   update    stored, then posted as a public message on every open linked
//             ticket (as the poster: first reply and new → open apply; the
//             ordinary reply notice is not sent) and sent through the
//             notification policy as hd_incident_update (bell and email,
//             never a digest) to each ticket's requester and CCs and to the
//             people who said "Me too", each person once per update. It
//             shows in the Get help banner, and on the Status page service
//             the incident is mirrored to.
//   solve     every open linked ticket, then the incident's own, each
//             through updateTicket as the agent with the PATCH route's
//             checks (canWorkTicket, Change status in its team, a workflow
//             task's hand-off, required checklist items in updateTicket), so
//             SLA, CSAT, workflow and time rules apply; a ticket that fails
//             is left open with the reason.
//   open      the incident is open while its own ticket is open (new, open,
//             waiting, on hold) and not merged: solving or closing that
//             ticket any way ends the banner and the rule.
//
// Get help: a banner per open incident for people it is shown to (banner
// 'workspace': everyone who may use Get help; 'team': people who have
// raised a request with the incident's team, plus everyone on a linked
// ticket or who said Me too). Requester-safe: the title, the latest update
// and the team, never a ticket number or an agent's name. Server-only.

import "server-only";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { agentTeamIds, canUseHelpdesk, canWorkTicket, isAgent } from "./access";
import { hdCan } from "./roles";
import { assignable, getTicketById, getTicketByNumber, getTicketRow, HdTicketError, insertTicketTx, updateTicket } from "./tickets";
import { afterTicketCreated } from "./events";
import { HD_OPEN_STATUSES } from "./types";
import type { HdTicket, HdTicketRow } from "./types";
import {
  IncidentInputError,
  cleanBanner,
  cleanMatch,
  cleanTitle,
  declaredNote,
  linkedNote,
  listTicketNumbers,
  matchesRule,
  type DeclareInput,
  type IncidentBanner,
  type IncidentBannerView,
  type IncidentChip,
  type IncidentForTicket,
  type IncidentLinkVia,
  type IncidentLinkedRow,
  type IncidentNavItem,
  type IncidentRefusal,
  type IncidentStatusPage,
  type IncidentTicketResult,
  type IncidentView,
} from "./incidents-shared";
import type { Role, SessionUser } from "../types";

export * from "./incidents-shared";

/** Who acts: a signed-in agent (the routes pass the session user). */
export type IncidentActor = Pick<SessionUser, "id" | "role" | "name" | "username"> & { email?: string };

export class HdIncidentError extends Error {
  constructor(
    message: string,
    public status = 400,
    public refusals: IncidentRefusal[] = []
  ) {
    super(message);
  }
}

export interface IncidentRow {
  id: number;
  ticket_id: number;
  title: string;
  declared_by: number | null;
  declared_by_name: string;
  declared_at: string;
  match_text: string;
  banner: IncidentBanner;
  notify_on_link: number;
  status_service_id: number | null;
  status_incident_id: number | null;
  solved_at: string | null;
  updated_at: string;
}

const OPEN_SQL = `('new', 'open', 'pending', 'on_hold')`;
const who = (u: IncidentActor) => u.name || u.username || "Someone";

/** The incident whose own ticket this is. */
export async function incidentByTicketId(ticketId: number, client?: HdQueryable): Promise<IncidentRow | undefined> {
  return hqOne<IncidentRow>("SELECT * FROM hd_incidents WHERE ticket_id = $1", [ticketId], client);
}

export async function incidentById(id: number, client?: HdQueryable): Promise<IncidentRow | undefined> {
  return hqOne<IncidentRow>("SELECT * FROM hd_incidents WHERE id = $1", [id], client);
}

interface LinkRow {
  ticket_id: number;
  incident_id: number;
  via: IncidentLinkVia;
  linked_by: number | null;
  linked_at: string;
}

async function linkOf(ticketId: number, client?: HdQueryable): Promise<LinkRow | undefined> {
  return hqOne<LinkRow>("SELECT * FROM hd_incident_links WHERE ticket_id = $1", [ticketId], client);
}

/** Is the incident open: its own ticket open and not merged. */
function ticketOpen(t: Pick<HdTicketRow, "status" | "merged_into">): boolean {
  return HD_OPEN_STATUSES.includes(t.status) && !t.merged_into;
}

/** One answer per request for "does this agent work that ticket" (agentTeamIds read once). */
async function workChecker(user: { id: number; role: Role }): Promise<(t: Pick<HdTicketRow, "team_id" | "assignee_id">) => boolean> {
  const teams = await agentTeamIds(user);
  const agent = teams === "all" || (await isAgent(user));
  return (t) => teams === "all" || (agent && (t.assignee_id === user.id || (t.team_id !== null && teams.includes(t.team_id))));
}

/**
 * Why `user` may not run incidents in `teamId` (declare, post updates,
 * change the banner, solve), or null. An update is a public reply on every
 * linked ticket, so a role whose replies wait for review can't.
 */
export async function manageRefusal(user: IncidentActor, teamId: number | null): Promise<string | null> {
  if (!(await hdCan(user, "incidents.manage", { teamId }))) return "You can't run major incidents in this team.";
  if (await hdCan(user, "tickets.reply_needs_review")) return "Your replies are reviewed before they're sent, so you can't post to everyone affected. Ask a team lead.";
  // An update is a public reply: the role must reply to requesters in the incident's team.
  if (!(await hdCan(user, "tickets.reply_public", { teamId }))) return "You can't reply to requesters in this team, so you can't post to everyone affected.";
  return null;
}

/**
 * Why ticket `t` (asked for as #number) can't be linked to `incident`, or
 * null (also when it is already linked to that incident). Access first: a
 * ticket the agent doesn't work reads "not found".
 */
async function linkRefusal(user: IncidentActor, t: HdTicket | undefined, number: number, incident: { id: number; ticket_id: number } | null): Promise<string | null> {
  if (!t || !(await canWorkTicket(user, t))) return `#${number} wasn't found in your queues.`;
  if (!(await hdCan(user, "incidents.link", { teamId: t.team_id }))) {
    return t.team_name ? `You can't link ${t.team_name}'s tickets to an incident.` : "You can't link this ticket to an incident.";
  }
  if (incident && t.id === incident.ticket_id) return `#${number} is the incident's own ticket.`;
  if (await incidentByTicketId(t.id)) return `#${number} is a major incident itself.`;
  if (t.source === "workflow" || t.parent_ticket_id) return `#${number} is a task in a workflow, so it can't be linked.`;
  if (t.merged_into) return `#${number} was merged into another ticket. Link that one instead.`;
  if (t.status === "closed") return `#${number} is closed.`;
  const l = await linkOf(t.id);
  if (l && l.incident_id !== incident?.id) {
    const other = await hqOne<{ number: number }>("SELECT t.number FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id WHERE i.id = $1", [l.incident_id]);
    return `#${number} is already linked to major incident #${other?.number ?? "?"}. Unlink it there first.`;
  }
  return null;
}

function refusalError(refusals: IncidentRefusal[]): HdIncidentError {
  const all = (re: RegExp) => refusals.every((r) => re.test(r.reason));
  const status = all(/wasn't found/) ? 404 : all(/^You can't/) ? 403 : 409;
  const more = refusals.length > 1 ? ` (and ${refusals.length - 1} more)` : "";
  return new HdIncidentError(`${refusals[0].reason}${more}`, status, refusals);
}

async function internalLine(client: HdQueryable | undefined, ticketId: number, author: { id: number | null; name: string }, body: string): Promise<void> {
  await hq(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'internal', $4, 'system')`,
    [ticketId, author.id, author.name, body],
    client
  );
}

// --- Declare -----------------------------------------------------------------------

export interface DeclareResult {
  id: number;
  /** The incident's own ticket. */
  ticket_id: number;
  number: number;
  linked: number[];
  /** The requesters' notices, still being sent (tests await it). */
  notices: Promise<void>;
}

/** Declare a major incident. Throws HdIncidentError (403 permissions, 404 unknown tickets, 409 refusals). */
export async function declareIncident(user: IncidentActor, input: DeclareInput, ctx: { origin?: string } = {}): Promise<DeclareResult> {
  if (!input.team_id) throw new HdIncidentError("Choose the team that runs the incident.");
  const team = await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = $1", [input.team_id]);
  if (!team) throw new HdIncidentError("That team does not exist.");
  const why = await manageRefusal(user, team.id);
  if (why) throw new HdIncidentError(why, 403);

  const refusals: IncidentRefusal[] = [];
  const children: HdTicket[] = [];
  for (const n of input.numbers) {
    const t = await getTicketByNumber(n);
    const r = await linkRefusal(user, t, n, null);
    if (r) refusals.push({ number: n, reason: r });
    else if (t) children.push(t);
  }
  if (refusals.length) throw refusalError(refusals);

  const by = who(user);
  const res = await withTx(async (client) => {
    const assignee = (await assignable(user.id, team.id, client)) ? user.id : null;
    const row = await insertTicketTx(client, {
      subject: input.title,
      body: declaredNote(mdInline(by), children.map((c) => c.number)),
      first_message_kind: "internal",
      // The incident's own ticket has no requester to tell: nobody asked for it.
      requester: { id: null, name: by, email: "" },
      author: { id: user.id, name: by, email: user.email ?? "" },
      via: "desk",
      source: "desk",
      team_id: team.id,
      priority: input.priority,
      status: "open",
      assignee_id: assignee,
    });
    const inc = await hqOne<IncidentRow>(
      `INSERT INTO hd_incidents (ticket_id, title, declared_by, declared_by_name, match_text, banner, notify_on_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [row.id, input.title, user.id, by, input.match_text, input.banner, input.notify_on_link ? 1 : 0],
      client
    );
    for (const c of children) {
      const ins = await hq(
        `INSERT INTO hd_incident_links (ticket_id, incident_id, via, linked_by) VALUES ($1, $2, 'declare', $3) ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id`,
        [c.id, inc!.id, user.id],
        client
      );
      if (!ins.length) throw new HdIncidentError(`#${c.number} was linked to another incident meanwhile. Try again.`, 409, [{ number: c.number, reason: "Linked elsewhere meanwhile." }]);
      await internalLine(client, c.id, { id: user.id, name: by }, `${mdInline(by)} linked this ticket to major incident #${row.number}`);
    }
    return { row, inc: inc! };
  });
  await afterTicketCreated(res.row, { actorId: user.id, actorName: by, origin: ctx.origin });
  const notices = res.inc.notify_on_link
    ? tellLinked(res.inc, children.map((c) => c.id), user, ctx.origin)
    : Promise.resolve();
  return { id: res.inc.id, ticket_id: res.row.id, number: res.row.number, linked: children.map((c) => c.number), notices };
}

// --- Link and unlink -----------------------------------------------------------------

export interface LinkOutcome {
  /** The incident's own ticket (audit target). */
  ticket_id: number;
  results: IncidentTicketResult[];
  linked: number[];
  notices: Promise<void>;
}

/** The open incident behind its ticket's number (404 when none, 409 when solved). */
export async function openIncidentByNumber(number: number): Promise<{ inc: IncidentRow; ticket: HdTicket }> {
  const ticket = await getTicketByNumber(number);
  const inc = ticket ? await incidentByTicketId(ticket.id) : undefined;
  if (!ticket || !inc) throw new HdIncidentError(`#${number} isn't a major incident.`, 404);
  if (!ticketOpen(ticket)) throw new HdIncidentError(`Major incident #${number} is solved. Reopen its ticket to carry on.`, 409);
  return { inc, ticket };
}

/** May `user` link tickets to `inc`: they work its ticket, or its banner shows to everyone (the link picker's list). */
async function canLinkTo(user: IncidentActor, inc: Pick<IncidentRow, "banner">, parent: Pick<HdTicketRow, "id" | "requester_id" | "team_id" | "assignee_id">): Promise<boolean> {
  return inc.banner === "workspace" || (await canWorkTicket(user, parent));
}

/** Link tickets to an open incident, each checked on its own; the rest carry on. */
export async function linkTickets(user: IncidentActor, incidentNumber: number, numbers: number[], ctx: { origin?: string } = {}): Promise<LinkOutcome> {
  if (!(await hdCan(user, "incidents.link"))) throw new HdIncidentError("You can't link tickets to an incident.", 403);
  const { inc, ticket: parent } = await openIncidentByNumber(incidentNumber);
  // Only an incident the agent could pick: one whose ticket they work, or one Get help shows to everyone.
  if (!(await canLinkTo(user, inc, parent))) throw new HdIncidentError(`#${incidentNumber} isn't a major incident.`, 404);
  const by = who(user);
  const results: IncidentTicketResult[] = [];
  const fresh: { id: number; number: number }[] = [];
  for (const n of numbers) {
    const t = await getTicketByNumber(n);
    const why = await linkRefusal(user, t, n, inc);
    if (why || !t) {
      results.push({ number: n, ok: false, error: why ?? "Not found." });
      continue;
    }
    const ins = await withTx(async (client) => {
      const r = await hq(
        `INSERT INTO hd_incident_links (ticket_id, incident_id, via, linked_by) VALUES ($1, $2, 'manual', $3) ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id`,
        [t.id, inc.id, user.id],
        client
      );
      if (!r.length) return false;
      await internalLine(client, t.id, { id: user.id, name: by }, `${mdInline(by)} linked this ticket to major incident #${parent.number}`);
      await internalLine(client, parent.id, { id: user.id, name: by }, `${mdInline(by)} linked #${t.number} to this incident`);
      return true;
    });
    if (ins) fresh.push({ id: t.id, number: t.number });
    // Already linked here (a repeat, or linked meanwhile) is fine; elsewhere is a refusal.
    const now = ins ? null : await linkOf(t.id);
    if (!ins && now && now.incident_id !== inc.id) results.push({ number: n, ok: false, error: "Linked to another incident meanwhile." });
    else results.push({ number: n, ok: true });
  }
  const notices = inc.notify_on_link && fresh.length ? tellLinked(inc, fresh.map((f) => f.id), user, ctx.origin) : Promise.resolve();
  return { ticket_id: parent.id, results, linked: fresh.map((f) => f.number), notices };
}

/** Unlink one ticket from its incident: checked on the ticket (incidents.link in its team). */
export async function unlinkTicket(user: IncidentActor, number: number): Promise<{ incident_number: number; ticket_number: number; ticket_id: number }> {
  const t = await getTicketByNumber(number);
  if (!t || !(await canWorkTicket(user, t))) throw new HdIncidentError(`#${number} wasn't found in your queues.`, 404);
  if (!(await hdCan(user, "incidents.link", { teamId: t.team_id }))) throw new HdIncidentError("You can't unlink this ticket.", 403);
  const by = who(user);
  const out = await withTx(async (client) => {
    const l = await hqOne<LinkRow & { parent_id: number; parent_number: number }>(
      `DELETE FROM hd_incident_links l USING hd_incidents i, hd_tickets p
        WHERE l.ticket_id = $1 AND i.id = l.incident_id AND p.id = i.ticket_id
        RETURNING l.*, p.id AS parent_id, p.number AS parent_number`,
      [t.id],
      client
    );
    if (!l) return null;
    await internalLine(client, t.id, { id: user.id, name: by }, `${mdInline(by)} unlinked this ticket from major incident #${l.parent_number}`);
    await internalLine(client, l.parent_id, { id: user.id, name: by }, `${mdInline(by)} unlinked #${t.number} from this incident`);
    return l;
  });
  if (!out) throw new HdIncidentError(`#${number} isn't linked to a major incident.`, 404);
  return { incident_number: out.parent_number, ticket_number: t.number, ticket_id: t.id };
}

// --- The auto-link rule ----------------------------------------------------------------

/**
 * A new ticket links itself to the newest open incident whose rule matches
 * its subject or opening message (events.ts afterTicketCreated). Not a
 * workflow task, an incident's own ticket, or an already-linked ticket.
 * Answers the incident's ticket number, or null.
 */
export async function autoLinkNewTicket(ticketId: number, ctx: { origin?: string } = {}): Promise<number | null> {
  const t = await getTicketRow(ticketId);
  if (!t || t.source === "workflow" || t.parent_ticket_id || t.merged_into || !HD_OPEN_STATUSES.includes(t.status)) return null;
  const incs = await hq<IncidentRow & { parent_number: number; parent_team_id: number | null; team_name: string | null }>(
    `SELECT i.*, p.number AS parent_number, p.team_id AS parent_team_id, tm.name AS team_name FROM hd_incidents i
       JOIN hd_tickets p ON p.id = i.ticket_id LEFT JOIN hd_teams tm ON tm.id = p.team_id
      WHERE i.match_text <> '' AND p.status IN ${OPEN_SQL} AND p.merged_into IS NULL AND p.id <> $1
      ORDER BY i.declared_at DESC, i.id DESC LIMIT 50`,
    [ticketId]
  );
  if (!incs.length || (await incidentByTicketId(t.id))) return null;
  const first = await hqOne<{ body: string }>("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY created_at, id LIMIT 1", [t.id]);
  const text = `${t.subject}\n${first?.body ?? ""}`;
  // Only a ticket the incident's side could link by hand: one in the incident's
  // own team, or one its declarer works and may link in its team. Another
  // team's confidential tickets never join (and never get its updates).
  let inc: (typeof incs)[number] | undefined;
  for (const i of incs) {
    if (!matchesRule(text, i.match_text)) continue;
    if (await ruleMayLink(i, t)) {
      inc = i;
      break;
    }
  }
  if (!inc) return null;
  const linked = await withTx(async (client) => {
    const r = await hq(
      `INSERT INTO hd_incident_links (ticket_id, incident_id, via) VALUES ($1, $2, 'rule') ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id`,
      [t.id, inc.id],
      client
    );
    if (!r.length) return false;
    await internalLine(client, t.id, { id: null, name: "" }, `Linked to major incident #${inc.parent_number} by its rule (matches "${mdInline(inc.match_text)}")`);
    await internalLine(client, inc.ticket_id, { id: null, name: "" }, `#${t.number} linked itself by the rule`);
    return true;
  });
  if (!linked) return null;
  const { audit } = await import("../audit");
  await audit({
    actor: { name: "system" },
    action: "helpdesk.incident.auto_linked",
    targetType: "helpdesk_ticket",
    targetId: t.id,
    targetLabel: `#${t.number}`,
    details: { incident: inc.parent_number, ticket: t.number, match: inc.match_text },
  });
  if (inc.notify_on_link) await tellLinked(inc, [t.id], null, ctx.origin);
  return inc.parent_number;
}

/** The rule may link `t` to `inc`: same team, or the declarer (still active) works it and holds incidents.link in its team. */
async function ruleMayLink(inc: IncidentRow & { parent_team_id: number | null }, t: HdTicketRow): Promise<boolean> {
  if (inc.parent_team_id !== null && inc.parent_team_id === t.team_id) return true;
  if (!inc.declared_by) return false;
  const d = await hqOne<{ id: number; role: Role }>("SELECT id, role FROM users WHERE id = $1 AND status = 'active'", [inc.declared_by]);
  if (!d) return false;
  return (await canWorkTicket(d, t)) && (await hdCan(d, "incidents.link", { teamId: t.team_id }));
}

// --- Telling people -------------------------------------------------------------------

/** Test hook: each person told of an update (they are still told). */
let tellSpy: ((who: { userId: number | null; email: string; ticketNumber: number | null }) => void) | null = null;
export function setIncidentNoticeSpyForTests(spy: typeof tellSpy): void {
  tellSpy = spy;
}

/**
 * Post `message` on each of `ticketIds` that is still open, then tell their
 * people, each once. A person (`author`) writes a public reply as
 * themselves, only on tickets they work and may reply on in that ticket's
 * team; the others are skipped with the reason. With no author (the
 * rule's link notice) the message is a requester-visible system line: it
 * is not a reply, so it never meets the first-reply target or moves a
 * ticket from New to Open. Answers the tickets reached and skipped, and
 * the notices' promise.
 */
async function fanOut(
  inc: IncidentRow,
  ticketIds: number[],
  message: string,
  author: IncidentActor | null,
  origin: string | undefined,
  meToo: boolean
): Promise<{ reached: number[]; skipped: IncidentTicketResult[]; notices: Promise<void> }> {
  const team = await hqOne<{ name: string | null }>("SELECT tm.name FROM hd_tickets p LEFT JOIN hd_teams tm ON tm.id = p.team_id WHERE p.id = $1", [inc.ticket_id]);
  const teamName = team?.name ?? null;
  const from = author ? { id: author.id, name: who(author), email: author.email ?? "" } : { id: null, name: teamName || "The helpdesk", email: "" };
  const { addMessage, addSystemMessage } = await import("./messages");
  const reached: number[] = [];
  const skipped: IncidentTicketResult[] = [];
  for (const id of ticketIds) {
    const t = await getTicketRow(id);
    if (!t || !ticketOpen(t)) continue;
    if (!author) {
      await addSystemMessage(id, message, { author: { id: null, name: from.name } });
      reached.push(id);
      continue;
    }
    if (!(await canWorkTicket(author, t))) {
      skipped.push({ number: t.number, ok: false, error: "Not in your queues, so you can't reply on it." });
      continue;
    }
    if (!(await hdCan(author, "tickets.reply_public", { teamId: t.team_id }))) {
      skipped.push({ number: t.number, ok: false, error: "You can't reply to requesters in this ticket's team." });
      continue;
    }
    try {
      // silent: the incident's own notice below replaces the ordinary reply
      // notice; noAutoFollow: an update doesn't make the poster follow every linked ticket.
      const r = await addMessage(id, { kind: "public", body: message, author: from, via: "desk" }, { silent: true, noAutoFollow: true, actorId: from.id, actorName: from.name, origin });
      if (r && !r.held) reached.push(id);
      else if (r?.held) skipped.push({ number: t.number, ok: false, error: "Your reply is waiting for review." });
    } catch (e) {
      if (e instanceof HdTicketError) skipped.push({ number: t.number, ok: false, error: e.message });
      else console.error("[helpdesk] incident update on a linked ticket:", e);
    }
  }
  const notices = tellPeople(inc, reached, message, teamName, from, origin, meToo).catch((e) => console.error("[helpdesk] incident notices:", e));
  return { reached, skipped, notices };
}

async function tellLinked(inc: IncidentRow, ticketIds: number[], author: IncidentActor | null, origin: string | undefined): Promise<void> {
  const r = await fanOut(inc, ticketIds, linkedNote(inc.title), author, origin, false);
  await r.notices;
}

/**
 * Tell the people on `ticketIds` (requesters and CCs) and, with `meToo`,
 * those who said Me too, each person once for this update: a person is
 * known by their account and by their address, so an account requester
 * who is an outside CC elsewhere, or an outside CC on several tickets,
 * hears once. Me too people hear only while the banner shows and they may
 * still use Get help.
 */
async function tellPeople(
  inc: IncidentRow,
  ticketIds: number[],
  message: string,
  teamName: string | null,
  from: { id: number | null; name: string },
  origin: string | undefined,
  meToo: boolean
): Promise<void> {
  const { notifyIncidentUpdate } = await import("./notify");
  const toldUsers = new Set<number>();
  const toldEmails = new Set<string>();
  const told = (userId: number | null, email: string | null | undefined) => {
    if (userId) toldUsers.add(userId);
    const e = (email ?? "").trim().toLowerCase();
    if (e) toldEmails.add(e);
  };
  const isTold = (userId: number | null, email: string | null | undefined) =>
    (!!userId && toldUsers.has(userId)) || (!!(email ?? "").trim() && toldEmails.has((email ?? "").trim().toLowerCase()));
  if (from.id) told(from.id, (await hqOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [from.id]))?.email);
  for (const id of ticketIds) {
    const t = await hqOne<{ number: number; requester_id: number | null; requester_email: string; account_email: string | null }>(
      "SELECT t.number, t.requester_id, t.requester_email, u.email AS account_email FROM hd_tickets t LEFT JOIN users u ON u.id = t.requester_id WHERE t.id = $1 AND t.deleted_at IS NULL",
      [id]
    );
    if (!t) continue;
    const reqEmail = t.requester_id ? t.account_email : t.requester_email;
    const skipRequester = isTold(t.requester_id, reqEmail) || isTold(null, t.requester_email);
    const ccs = await hq<{ user_id: number | null; email: string | null }>(
      `SELECT c.user_id, CASE WHEN c.user_id IS NULL THEN c.email ELSE u.email END AS email
         FROM hd_ticket_ccs c LEFT JOIN users u ON u.id = c.user_id WHERE c.ticket_id = $1 AND NOT c.account_removed`,
      [id]
    );
    const excludeUserIds = [...toldUsers, ...ccs.filter((c) => c.user_id && isTold(null, c.email)).map((c) => c.user_id!)];
    if (!skipRequester) tellSpy?.({ userId: t.requester_id, email: (reqEmail ?? "").toLowerCase(), ticketNumber: t.number });
    await notifyIncidentUpdate(id, { incidentTitle: inc.title, message, teamName }, {
      origin,
      actorId: from.id,
      actorName: from.name,
      skipRequester,
      excludeUserIds,
      excludeEmails: [...toldEmails],
    });
    told(t.requester_id, reqEmail);
    told(null, t.requester_email);
    // The people copied on it heard with it (or chose not to): once is enough.
    for (const c of ccs) told(c.user_id, c.email);
  }
  if (!meToo) return;
  const fresh = await incidentById(inc.id);
  if (!fresh || fresh.banner === "off") return;
  const affected = await hq<{ user_id: number; email: string; role: Role }>(
    `SELECT a.user_id, u.email, u.role FROM hd_incident_affected a JOIN users u ON u.id = a.user_id AND u.status = 'active'
      WHERE a.incident_id = $1 ORDER BY a.created_at`,
    [inc.id]
  );
  const rest: typeof affected = [];
  for (const a of affected) {
    if (isTold(a.user_id, a.email)) continue;
    if (!(await canUseHelpdesk({ id: a.user_id, role: a.role }))) continue;
    told(a.user_id, a.email);
    rest.push(a);
  }
  if (!rest.length) return;
  const { shouldNotifyMany, routeEmail } = await import("../notify-policy");
  const { notify } = await import("../notifications");
  const { sendHelpdeskTemplate, helpdeskOrigin } = await import("./email");
  const base = await helpdeskOrigin(origin);
  const title = `Update: ${inc.title}`;
  const body = message.length > 280 ? `${message.slice(0, 279)}…` : message;
  const bells = await shouldNotifyMany(rest.map((a) => a.user_id), "hd_incident_update", "bell");
  const bellIds = rest.filter((a) => bells.get(a.user_id)?.send).map((a) => a.user_id);
  if (bellIds.length) {
    await notify(bellIds, { kind: "hd_request", event: "hd_incident_update", title, body, link: "/help", actorName: from.name, origin: base }).catch((e) =>
      console.error("[helpdesk] incident bell:", e)
    );
  }
  for (const a of rest) {
    tellSpy?.({ userId: a.user_id, email: a.email, ticketNumber: null });
    await routeEmail(a.user_id, "hd_incident_update", { title, body, link: "/help" }, () =>
      sendHelpdeskTemplate(
        a.email,
        "hd_incident_update",
        {
          incident_title: inc.title,
          message,
          team_name: teamName || "The helpdesk",
          request_line: "",
          link_label: "See it in Get help",
          reply_line: ".",
          ticket_number: "",
          ticket_url: "/help",
        },
        null,
        base
      )
    ).catch((e) => console.error("[helpdesk] incident email:", e));
  }
}

// --- Updates and solving -------------------------------------------------------------

/** The incident behind a ticket number for someone who runs it (works its ticket, manageRefusal clear). */
async function managedIncident(user: IncidentActor, number: number): Promise<{ inc: IncidentRow; ticket: HdTicket }> {
  const ticket = await getTicketByNumber(number);
  if (!ticket || !(await canWorkTicket(user, ticket))) throw new HdIncidentError("Not found.", 404);
  const inc = await incidentByTicketId(ticket.id);
  if (!inc) throw new HdIncidentError(`#${number} isn't a major incident.`, 404);
  const why = await manageRefusal(user, ticket.team_id);
  if (why) throw new HdIncidentError(why, 403);
  return { inc, ticket };
}

async function openLinkedIds(incidentId: number): Promise<number[]> {
  const rows = await hq<{ id: number }>(
    `SELECT t.id FROM hd_incident_links l JOIN hd_tickets t ON t.id = l.ticket_id
      WHERE l.incident_id = $1 AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL AND t.deleted_at IS NULL ORDER BY l.linked_at, t.id`,
    [incidentId]
  );
  return rows.map((r) => r.id);
}

export interface PostUpdateResult {
  /** The incident's own ticket (audit target). */
  ticket_id: number;
  update: { id: number; sent_count: number } | null;
  /** Open linked tickets the update didn't reach, with the reason (not the poster's to reply on). */
  skipped: IncidentTicketResult[];
  solve: SolveResult | null;
  notices: Promise<void>;
}

/** Post an update to everyone affected and, when asked, solve the incident and its linked tickets. */
export async function postUpdate(user: IncidentActor, number: number, input: { body: string; solve: boolean }, ctx: { origin?: string } = {}): Promise<PostUpdateResult> {
  const { inc, ticket } = await managedIncident(user, number);
  if (!ticketOpen(ticket)) throw new HdIncidentError(`Major incident #${number} is solved. Reopen its ticket to post again.`, 409);
  if (!input.body && !input.solve) throw new HdIncidentError("Write the update first.");
  // Solving starts with the incident's own ticket: refused there, nothing is posted or solved.
  if (input.solve) {
    const why = await solveRefusal(user, ticket);
    if (why) throw new HdIncidentError(`#${number} can't be solved: ${why}`, 409);
  }
  let update: PostUpdateResult["update"] = null;
  let skipped: IncidentTicketResult[] = [];
  let notices: Promise<void> = Promise.resolve();
  const by = who(user);
  if (input.body) {
    const row = await hqOne<{ id: number }>(
      "INSERT INTO hd_incident_updates (incident_id, body, author_id, author_name) VALUES ($1, $2, $3, $4) RETURNING id",
      [inc.id, input.body, user.id, by]
    );
    const out = await fanOut(inc, await openLinkedIds(inc.id), input.body, user, ctx.origin, true);
    await hq("UPDATE hd_incident_updates SET sent_count = $2 WHERE id = $1", [row!.id, out.reached.length]);
    await hq("UPDATE hd_incidents SET updated_at = now() WHERE id = $1", [inc.id]);
    await internalLine(undefined, ticket.id, { id: user.id, name: by }, `${mdInline(by)} posted an update to ${out.reached.length} linked ${out.reached.length === 1 ? "ticket" : "tickets"}`);
    await statusPageUpdate(inc, input.body, by);
    update = { id: row!.id, sent_count: out.reached.length };
    skipped = out.skipped;
    notices = out.notices;
  }
  const solve = input.solve ? await solveIncident(user, inc, ticket, ctx) : null;
  return { ticket_id: ticket.id, update, skipped, solve, notices };
}

export interface SolveResult {
  /** The linked tickets, each solved or left open with the reason. */
  results: IncidentTicketResult[];
  /** The incident's own ticket. */
  incident: IncidentTicketResult;
}

/**
 * Why `user` can't solve `t` the way the PATCH route would (access, the
 * merged lock, Change status in its team, a workflow task's hand-off,
 * required checklist items), or null. Asked before any write.
 */
async function solveRefusal(user: IncidentActor, t: HdTicket): Promise<string | null> {
  if (!(await canWorkTicket(user, t))) return "Not in your queues.";
  if (t.merged_into) return "Merged into another ticket.";
  if (!HD_OPEN_STATUSES.includes(t.status)) return null;
  const { patchRefusal } = await import("./patch-caps");
  if (await patchRefusal(user as SessionUser, t, { status: "solved" })) return "You can't change the status of this ticket.";
  if (t.source === "workflow") {
    const { validateTaskSolve } = await import("./engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return missing.error;
  }
  const { checklistSolveRefusal } = await import("./checklists");
  const blocked = await checklistSolveRefusal(t.id);
  if (blocked) return blocked.error;
  return null;
}

/** One ticket solved as the PATCH route would (its checks, then updateTicket and the solve hooks). */
async function solveOne(user: IncidentActor, t: HdTicket, origin: string | undefined): Promise<IncidentTicketResult> {
  const number = t.number;
  const why = await solveRefusal(user, t);
  if (why) return { number, ok: false, error: why };
  if (!HD_OPEN_STATUSES.includes(t.status)) return { number, ok: true };
  try {
    const r = await updateTicket(t.id, { status: "solved" }, { id: user.id, name: who(user), role: user.role }, { origin });
    return r ? { number, ok: true } : { number, ok: false, error: "Not found." };
  } catch (e) {
    if (e instanceof HdTicketError) return { number, ok: false, error: e.message };
    console.error("[helpdesk] solving a linked ticket:", e);
    return { number, ok: false, error: "Couldn't solve this ticket. Try again." };
  }
}

/** Test hook: runs after each pass over the linked tickets (a test links one meanwhile). */
let solvePassHook: (() => Promise<void>) | null = null;
export function setIncidentSolvePassHookForTests(fn: typeof solvePassHook): void {
  solvePassHook = fn;
}

/**
 * Solve the linked tickets, then the incident's own (whose solve ends the
 * incident: events.ts afterTicketSolved → onIncidentTicketEnded). Tickets
 * linked while this runs (by hand or by the rule) are picked up on the
 * next read and solved too, before and after the incident's own ticket.
 */
async function solveIncident(user: IncidentActor, inc: IncidentRow, ticket: HdTicket, ctx: { origin?: string }): Promise<SolveResult> {
  const results: IncidentTicketResult[] = [];
  const tried = new Set<number>();
  const solveLinked = async () => {
    for (let pass = 0; pass < 5; pass++) {
      const ids = (await openLinkedIds(inc.id)).filter((id) => !tried.has(id));
      if (!ids.length) return;
      for (const id of ids) {
        tried.add(id);
        const full = await getTicketById(id);
        if (full) results.push(await solveOne(user, full, ctx.origin));
      }
      await solvePassHook?.();
    }
  };
  await solveLinked();
  const own = await solveOne(user, (await getTicketByNumber(ticket.number))!, ctx.origin);
  if (own.ok) await solveLinked();
  return { results, incident: own };
}

/** Solve without an update ("Solve incident" with an empty composer). */
export async function solveIncidentByNumber(user: IncidentActor, number: number, ctx: { origin?: string } = {}): Promise<SolveResult> {
  const { inc, ticket } = await managedIncident(user, number);
  if (!ticketOpen(ticket)) throw new HdIncidentError(`Major incident #${number} is already solved.`, 409);
  const why = await solveRefusal(user, ticket);
  if (why) throw new HdIncidentError(`#${number} can't be solved: ${why}`, 409);
  return solveIncident(user, inc, ticket, ctx);
}

/**
 * The incident's own ticket was solved or closed (events.ts
 * afterTicketSolved), merged (lib/helpdesk/merge) or is about to be deleted
 * (the ticket DELETE route): the incident ends, whatever ended it. Its
 * Status page incident is resolved. Never throws.
 */
export async function onIncidentTicketEnded(ticketId: number, by = ""): Promise<void> {
  try {
    const inc = await incidentByTicketId(ticketId);
    if (!inc) return;
    await hq("UPDATE hd_incidents SET solved_at = COALESCE(solved_at, now()), updated_at = now() WHERE id = $1", [inc.id]);
    await statusPageResolve(inc, by || "Helpdesk");
  } catch (e) {
    console.error("[helpdesk] incident ended:", e);
  }
}

/** The incident's own ticket was reopened (events.ts afterTicketUpdated): the incident is open again, with a new Status page incident when mirrored. Never throws. */
export async function onIncidentTicketReopened(ticketId: number, by = ""): Promise<void> {
  try {
    const inc = await incidentByTicketId(ticketId);
    if (!inc) return;
    await hq("UPDATE hd_incidents SET solved_at = NULL, status_incident_id = NULL, updated_at = now() WHERE id = $1", [inc.id]);
    if (inc.status_service_id) await statusPageOpen({ ...inc, status_incident_id: null }, by || "Helpdesk");
  } catch (e) {
    console.error("[helpdesk] incident reopened:", e);
  }
}

// --- Settings --------------------------------------------------------------------------

export interface IncidentSettingsPatch {
  title?: string;
  match_text?: string;
  banner?: IncidentBanner;
  notify_on_link?: boolean;
  /** A Status page (manual) service, or null to stop mirroring. */
  status_service_id?: number | null;
}

/** Validate a PATCH body. Throws an IncidentInputError (from incidents-shared). */
export function validateSettings(raw: Record<string, unknown>): IncidentSettingsPatch {
  const out: IncidentSettingsPatch = {};
  if (raw.title !== undefined) out.title = cleanTitle(raw.title);
  if (raw.match_text !== undefined) out.match_text = cleanMatch(raw.match_text);
  if (raw.banner !== undefined) out.banner = cleanBanner(raw.banner);
  if (raw.notify_on_link !== undefined) {
    if (typeof raw.notify_on_link !== "boolean") throw new HdIncidentError("notify_on_link must be true or false.");
    out.notify_on_link = raw.notify_on_link;
  }
  if (raw.status_service_id !== undefined) {
    if (raw.status_service_id === null) out.status_service_id = null;
    else {
      const n = Number(raw.status_service_id);
      if (!Number.isInteger(n) || n <= 0) throw new HdIncidentError("status_service_id must be an id or null.");
      out.status_service_id = n;
    }
  }
  if (!Object.keys(out).length) throw new HdIncidentError("Nothing to change.");
  return out;
}

/** Change an incident's title, rule, banner, link notice or Status page service. Answers the fields that changed. */
export async function updateIncidentSettings(
  user: IncidentActor,
  number: number,
  patch: IncidentSettingsPatch,
  ctx: { origin?: string } = {}
): Promise<{ changed: string[]; before: Partial<IncidentRow>; ticket_id: number }> {
  const { inc, ticket } = await managedIncident(user, number);
  const changed: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [inc.id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
    changed.push(col);
  };
  if (patch.title !== undefined && patch.title !== inc.title) set("title", patch.title);
  if (patch.match_text !== undefined && patch.match_text !== inc.match_text) set("match_text", patch.match_text);
  if (patch.banner !== undefined && patch.banner !== inc.banner) set("banner", patch.banner);
  if (patch.notify_on_link !== undefined && (patch.notify_on_link ? 1 : 0) !== inc.notify_on_link) set("notify_on_link", patch.notify_on_link ? 1 : 0);
  if (patch.status_service_id !== undefined && patch.status_service_id !== inc.status_service_id) {
    if (patch.status_service_id !== null) {
      const sp = await statusPageFor(user, true);
      if (!sp?.can_manage) throw new HdIncidentError("You can't post on the Status page.", 403);
      if (!sp.services.some((s) => s.id === patch.status_service_id)) throw new HdIncidentError("Choose one of the Status page's own services.", 400);
    }
    set("status_service_id", patch.status_service_id);
  }
  if (!sets.length) return { changed: [], before: {}, ticket_id: ticket.id };
  await hq(`UPDATE hd_incidents SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  if (changed.includes("status_service_id")) {
    // Switched or stopped: the board's incident there is resolved (its service reads healthy again
    // when nothing else is open on it); a new service starts its own while the incident is open.
    await statusPageResolve(inc, who(user));
    await hq("UPDATE hd_incidents SET status_incident_id = NULL WHERE id = $1", [inc.id]);
    if (patch.status_service_id && ticketOpen(ticket)) await statusPageOpen((await incidentById(inc.id))!, who(user));
  }
  const before: Partial<IncidentRow> = {};
  for (const c of changed) (before as Record<string, unknown>)[c] = (inc as unknown as Record<string, unknown>)[c];
  return { changed, before, ticket_id: ticket.id };
}

// --- The Status page (the workspace's own status board, lib/status) ------------------

/**
 * The Status page card: the board's internal (manual) services, when it has
 * any. Mirroring needs the board's own permission (status.incident_manage)
 * on top of running the incident.
 */
async function statusPageFor(user: IncidentActor, canManage: boolean, inc?: IncidentRow): Promise<IncidentStatusPage | null> {
  const { listStatusServices } = await import("../db");
  const services = (await listStatusServices()).filter((s) => s.provider === "manual").map((s) => ({ id: s.id, name: s.name }));
  if (!services.length) return null;
  const { userHolds } = await import("../access");
  const holds = canManage && (await userHolds(user, "status.incident_manage", { legacyMin: "approver" }));
  const current = inc?.status_service_id ?? null;
  return { services, service_id: current, service_name: services.find((s) => s.id === current)?.name ?? null, can_manage: holds };
}

/**
 * Mirror the incident onto its Status page service: a board incident (its
 * updates follow), and the internal service shown as down. No workspace-wide
 * alert: the people affected already hear through the incident itself.
 */
async function statusPageOpen(inc: IncidentRow, by: string): Promise<void> {
  if (!inc.status_service_id || inc.status_incident_id) return;
  try {
    const db = await import("../db");
    const service = (await db.listStatusServices()).find((s) => s.id === inc.status_service_id && s.provider === "manual");
    if (!service) return;
    const latest = await hqOne<{ body: string }>("SELECT body FROM hd_incident_updates WHERE incident_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [inc.id]);
    const id = await db.createStatusIncident({ serviceId: service.id, title: inc.title, severity: "outage", body: latest?.body ?? "", author: by });
    await db.setServiceStatus(service.id, { status: "outage", detail: inc.title, url: "" });
    await hq("UPDATE hd_incidents SET status_incident_id = $2 WHERE id = $1", [inc.id, id]);
  } catch (e) {
    console.error("[helpdesk] status page:", e);
  }
}

async function statusPageUpdate(inc: IncidentRow, body: string, by: string): Promise<void> {
  const fresh = await incidentById(inc.id);
  if (!fresh?.status_incident_id) return;
  try {
    const { addStatusIncidentUpdate } = await import("../db");
    await addStatusIncidentUpdate(fresh.status_incident_id, body, by);
  } catch (e) {
    console.error("[helpdesk] status page update:", e);
  }
}

async function statusPageResolve(inc: IncidentRow, by: string): Promise<void> {
  const fresh = await incidentById(inc.id);
  if (!fresh?.status_incident_id) return;
  try {
    const db = await import("../db");
    const resolved = await db.resolveStatusIncident(fresh.status_incident_id, by);
    if (!resolved) return;
    const service = (await db.listStatusServices()).find((s) => s.id === resolved.service_id);
    if (service?.provider === "manual") {
      const stillOpen = (await db.listStatusIncidents()).some((i) => i.state === "open" && i.service_id === service.id);
      if (!stillOpen) await db.setServiceStatus(service.id, { status: "operational", detail: "", url: "" });
    }
  } catch (e) {
    console.error("[helpdesk] status page resolve:", e);
  }
}

// --- Get help: the banner and "Me too" -----------------------------------------------

async function affectedCount(incidentId: number): Promise<number> {
  const r = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT a.user_id::text AS k FROM hd_incident_affected a WHERE a.incident_id = $1
       UNION
       SELECT COALESCE(t.requester_id::text, lower(t.requester_email)) FROM hd_incident_links l JOIN hd_tickets t ON t.id = l.ticket_id
        WHERE l.incident_id = $1 AND COALESCE(t.automated, 0) = 0 AND (t.requester_id IS NOT NULL OR t.requester_email <> '') AND t.deleted_at IS NULL
     ) x`,
    [incidentId]
  );
  return r?.n ?? 0;
}

/** The incidents shown to this person in Get help (newest first, at most five). */
export async function bannersFor(user: { id: number; role: Role }): Promise<IncidentBannerView[]> {
  if (!(await canUseHelpdesk(user))) return [];
  const rows = await hq<{ id: number; title: string; declared_at: string; team_name: string | null; message: string | null; last_at: string | null; me_too: boolean }>(
    `SELECT i.id, i.title, i.declared_at, tm.name AS team_name, u.body AS message, u.created_at AS last_at,
            EXISTS (SELECT 1 FROM hd_incident_affected a WHERE a.incident_id = i.id AND a.user_id = $1) AS me_too
       FROM hd_incidents i
       JOIN hd_tickets p ON p.id = i.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = p.team_id
       LEFT JOIN LATERAL (SELECT body, created_at FROM hd_incident_updates WHERE incident_id = i.id ORDER BY created_at DESC, id DESC LIMIT 1) u ON true
      WHERE p.status IN ${OPEN_SQL} AND p.merged_into IS NULL AND p.deleted_at IS NULL AND i.banner <> 'off'
        AND (i.banner = 'workspace'
             OR EXISTS (SELECT 1 FROM hd_tickets r WHERE r.requester_id = $1 AND r.team_id = p.team_id AND r.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM hd_incident_links l JOIN hd_tickets lt ON lt.id = l.ticket_id
                         WHERE l.incident_id = i.id AND lt.deleted_at IS NULL AND (lt.requester_id = $1
                               OR EXISTS (SELECT 1 FROM hd_ticket_ccs c WHERE c.ticket_id = lt.id AND c.user_id = $1 AND NOT c.account_removed)))
             OR EXISTS (SELECT 1 FROM hd_incident_affected a WHERE a.incident_id = i.id AND a.user_id = $1))
      ORDER BY i.declared_at DESC, i.id DESC LIMIT 5`,
    [user.id]
  );
  const out: IncidentBannerView[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      title: r.title,
      message: r.message ?? "We know about this and we're working on it. You'll hear from us here.",
      team_name: r.team_name,
      last_update_at: r.last_at ?? r.declared_at,
      affected: await affectedCount(r.id),
      me_too: !!r.me_too,
    });
  }
  return out;
}

/** "Me too" (or taking it back). Only for an incident this person is shown. Answers the banner as it now reads. */
export async function setAffected(user: { id: number; role: Role }, incidentId: number, affected: boolean): Promise<{ banner: IncidentBannerView; changed: boolean }> {
  // Taking it back is always allowed while the row exists, banner or not.
  if (!affected) {
    const gone = await hq("DELETE FROM hd_incident_affected WHERE incident_id = $1 AND user_id = $2 RETURNING user_id", [incidentId, user.id]);
    if (gone.length) {
      const now = (await bannersFor(user)).find((b) => b.id === incidentId);
      const inc = now ? null : await incidentById(incidentId);
      const banner = now ?? { id: incidentId, title: inc?.title ?? "", message: "", team_name: null, last_update_at: inc?.updated_at ?? new Date().toISOString(), affected: await affectedCount(incidentId), me_too: false };
      return { banner, changed: true };
    }
  }
  const shown = (await bannersFor(user)).find((b) => b.id === incidentId);
  if (!shown) throw new HdIncidentError("Not found.", 404);
  const r = affected
    ? await hq("INSERT INTO hd_incident_affected (incident_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id", [incidentId, user.id])
    : await hq("DELETE FROM hd_incident_affected WHERE incident_id = $1 AND user_id = $2 RETURNING user_id", [incidentId, user.id]);
  const banner = (await bannersFor(user)).find((b) => b.id === incidentId) ?? { ...shown, me_too: affected };
  return { banner, changed: r.length > 0 };
}

// --- Reads for the desk ---------------------------------------------------------------

/** What the ticket pane shows: the incident (its own ticket), its link (a linked ticket), or nothing. The caller has checked canWorkTicket. */
export async function incidentForTicket(user: IncidentActor, ticket: HdTicket): Promise<IncidentForTicket> {
  const inc = await incidentByTicketId(ticket.id);
  if (inc) return { role: "incident", incident: await incidentView(user, ticket, inc) };
  const l = await linkOf(ticket.id);
  if (!l) return { role: null };
  const p = await hqOne<HdTicketRow & { team_name: string | null; title: string; linked_by_name: string | null }>(
    `SELECT p.*, tm.name AS team_name, i.title, u.name AS linked_by_name FROM hd_incidents i JOIN hd_tickets p ON p.id = i.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = p.team_id LEFT JOIN users u ON u.id = $2 WHERE i.id = $1`,
    [l.incident_id, l.linked_by]
  );
  if (!p) return { role: null };
  return {
    role: "linked",
    link: {
      incident: { id: l.incident_id, number: p.number, title: p.title, open: ticketOpen(p), team_name: p.team_name },
      via: l.via,
      linked_at: l.linked_at,
      linked_by_name: p.linked_by_name,
      can_unlink: await hdCan(user, "incidents.link", { teamId: ticket.team_id }),
      can_open: await canWorkTicket(user, p),
    },
  };
}

async function incidentView(user: IncidentActor, ticket: HdTicket, inc: IncidentRow): Promise<IncidentView> {
  const works = await workChecker(user);
  const linkedRows = await hq<HdTicketRow & { via: IncidentLinkVia; linked_at: string; team_name: string | null }>(
    `SELECT t.*, l.via, l.linked_at, tm.name AS team_name FROM hd_incident_links l JOIN hd_tickets t ON t.id = l.ticket_id
       LEFT JOIN hd_teams tm ON tm.id = t.team_id WHERE l.incident_id = $1 AND t.deleted_at IS NULL ORDER BY l.linked_at DESC, t.id DESC LIMIT 1000`,
    [inc.id]
  );
  const linked: IncidentLinkedRow[] = [];
  let hidden = 0;
  for (const r of linkedRows) {
    if (!works(r)) {
      hidden++;
      continue;
    }
    linked.push({
      number: r.number,
      subject: r.subject,
      requester_name: r.requester_name || r.requester_email,
      status: r.status,
      team_name: r.team_name,
      via: r.via,
      linked_at: r.linked_at,
      can_work: true,
    });
  }
  const updates = await hq<{ id: number; body: string; author_name: string; sent_count: number; created_at: string }>(
    "SELECT id, body, author_name, sent_count, created_at FROM hd_incident_updates WHERE incident_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
    [inc.id]
  );
  const meToo = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_incident_affected WHERE incident_id = $1", [inc.id]);
  const holdsManage = await hdCan(user, "incidents.manage", { teamId: ticket.team_id });
  const why = holdsManage ? await manageRefusal(user, ticket.team_id) : null;
  const canManage = holdsManage && !why;
  return {
    id: inc.id,
    number: ticket.number,
    title: inc.title,
    subject: ticket.subject,
    team_id: ticket.team_id,
    team_name: ticket.team_name,
    priority: ticket.priority,
    open: ticketOpen(ticket),
    declared_by_name: inc.declared_by_name,
    declared_at: inc.declared_at,
    match_text: inc.match_text,
    banner: inc.banner,
    notify_on_link: inc.notify_on_link === 1,
    linked_total: linkedRows.length,
    linked_open: linkedRows.filter((r) => ticketOpen(r)).length,
    linked,
    hidden,
    updates,
    me_too: meToo?.n ?? 0,
    affected: await affectedCount(inc.id),
    can_manage: canManage,
    manage_note: why,
    can_link: await hdCan(user, "incidents.link"),
    status_page: await statusPageFor(user, canManage, inc),
  };
}

/**
 * Open incidents for the desk: `nav` lists those whose ticket the agent
 * works (the queue's "Major incidents" group); `link` lists every open one
 * (the link picker; their titles are in Get help anyway).
 */
export async function listOpenIncidents(user: IncidentActor, scope: "nav" | "link"): Promise<IncidentNavItem[]> {
  const rows = await hq<HdTicketRow & { incident_id: number; title: string; banner: IncidentBanner; team_name: string | null; linked_open: number }>(
    `SELECT p.*, i.id AS incident_id, i.title, i.banner, tm.name AS team_name,
            (SELECT count(*)::int FROM hd_incident_links l JOIN hd_tickets t ON t.id = l.ticket_id
              WHERE l.incident_id = i.id AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL AND t.deleted_at IS NULL) AS linked_open
       FROM hd_incidents i JOIN hd_tickets p ON p.id = i.ticket_id LEFT JOIN hd_teams tm ON tm.id = p.team_id
      WHERE p.status IN ${OPEN_SQL} AND p.merged_into IS NULL AND p.deleted_at IS NULL
      ORDER BY i.declared_at DESC, i.id DESC LIMIT 50`
  );
  const works = await workChecker(user);
  const out: IncidentNavItem[] = [];
  for (const r of rows) {
    const can = works(r);
    if (scope === "nav" && !can) continue;
    // The picker: incidents the agent works, and those Get help shows to everyone (canLinkTo).
    if (scope === "link" && !can && r.banner !== "workspace") continue;
    out.push({ id: r.incident_id, number: r.number, title: r.title, team_name: r.team_name, linked_open: Number(r.linked_open), can_open: can });
  }
  return out;
}

/** The queue rows' chips (lib/helpdesk/tickets listTickets): an incident's own ticket, or a linked one. Never throws. */
export async function incidentChips(ids: number[]): Promise<Map<number, IncidentChip>> {
  const out = new Map<number, IncidentChip>();
  if (!ids.length) return out;
  const own = await hq<{ ticket_id: number; linked: number }>(
    `SELECT i.ticket_id, (SELECT count(*)::int FROM hd_incident_links l JOIN hd_tickets lt ON lt.id = l.ticket_id WHERE l.incident_id = i.id AND lt.deleted_at IS NULL) AS linked
       FROM hd_incidents i WHERE i.ticket_id = ANY($1::int[])`,
    [ids]
  );
  for (const r of own) out.set(r.ticket_id, { kind: "incident", linked: Number(r.linked) });
  const links = await hq<{ ticket_id: number; number: number }>(
    `SELECT l.ticket_id, p.number FROM hd_incident_links l JOIN hd_incidents i ON i.id = l.incident_id JOIN hd_tickets p ON p.id = i.ticket_id
      WHERE l.ticket_id = ANY($1::int[])`,
    [ids]
  );
  for (const r of links) out.set(r.ticket_id, { kind: "linked", number: r.number });
  return out;
}

/** The numbers a list of ids stands for, for messages. */
export { listTicketNumbers };

// --- Retention and the personal data export -----------------------------------------

/**
 * Anonymising an incident's own ticket (lib/helpdesk/retention
 * anonymiseTicketTx, inside its transaction): its updates' text and
 * authors, its title and rule, and the text its audit rows copied (title,
 * update, rule) go. Linked tickets are anonymised on their own.
 */
export async function anonymiseIncidentTx(client: HdQueryable, ticketId: number, subject: string): Promise<void> {
  const inc = await hqOne<{ id: number }>("SELECT id FROM hd_incidents WHERE ticket_id = $1", [ticketId], client);
  if (!inc) return;
  await hq("UPDATE hd_incident_updates SET body = '', author_name = '' WHERE incident_id = $1", [inc.id], client);
  await hq("UPDATE hd_incidents SET title = $2, match_text = '', declared_by_name = '' WHERE id = $1", [inc.id, subject], client);
  const audits = await hq<{ id: number; details: Record<string, unknown> | null }>(
    "SELECT id, details FROM audit_log WHERE action LIKE 'helpdesk.incident.%' AND target_type = 'helpdesk_ticket' AND target_id = $1",
    [String(ticketId)],
    client
  );
  const strip = (d: unknown): unknown => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return d;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (k === "title" || k === "body" || k === "match_text" || k === "match") continue;
      out[k] = k === "before" || k === "after" ? strip(v) : v;
    }
    return out;
  };
  for (const a of audits) {
    if (!a.details) continue;
    const next = strip(a.details);
    if (JSON.stringify(next) !== JSON.stringify(a.details)) await hq("UPDATE audit_log SET details = $2 WHERE id = $1", [a.id, JSON.stringify(next)], client);
  }
}

/** The person's "Me too" records for their personal data export (lib/helpdesk/retention personalHelpdeskExport). */
export async function incidentsAffectedFor(userId: number): Promise<{ incident: string; at: string }[]> {
  const rows = await hq<{ title: string; created_at: string }>(
    "SELECT i.title, a.created_at FROM hd_incident_affected a JOIN hd_incidents i ON i.id = a.incident_id WHERE a.user_id = $1 ORDER BY a.created_at",
    [userId]
  );
  return rows.map((r) => ({ incident: r.title, at: r.created_at }));
}

/** A route's answer for an incident error (input or refusal), or null for anything else. */
export function incidentErrorBody(e: unknown): { status: number; body: { error: string; refusals?: IncidentRefusal[] } } | null {
  if (e instanceof HdIncidentError) return { status: e.status, body: e.refusals.length ? { error: e.message, refusals: e.refusals } : { error: e.message } };
  if (e instanceof IncidentInputError) return { status: 400, body: { error: e.message } };
  return null;
}
