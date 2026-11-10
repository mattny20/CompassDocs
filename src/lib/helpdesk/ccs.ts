// Helpdesk 1.19.1: CCs and followers (agent V3). Schema in
// lib/helpdesk/cc-schema (HD_CC_SCHEMA).
//
//   CCs        people copied on a request, by the requester (Get help: the
//              request page and the new-request form), by an agent (the
//              desk's CC row) or by inbound email (the Cc of a new ticket's
//              mail). A workspace account, or an outside address only when
//              Desk -> Settings -> Email allows outside senders. A CC reads
//              the request in Get help as the requester does (public
//              conversation only, never internal notes or held replies:
//              lib/helpdesk/access ticketRelation "cc"), replies in public,
//              and gets the public replies (bell and email as the requester's
//              events through lib/notify-policy; the requester's reply mail
//              carries them on Cc).
//   Followers  agents who may work the ticket and want its updates: new
//              public or internal messages and status changes, as
//              desk_followed_update through agent F's
//              deliverAgentNotification. "Follow" / "Unfollow" in the ticket
//              header; an agent who replies follows automatically unless
//              they turned "Follow tickets I reply to" off, or unfollowed
//              that ticket before (muted rows).
//
// Merge (agent V2) moves both inside its own transaction: every export that
// takes `client` runs all its queries on it, and with a client addCcs has no
// after-commit side effects (no audit, timeline line or notice; the merge
// audits). Server-only.

import "server-only";
import { audit } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne } from "./db-core";
import type { HdQueryable } from "./db-core";
import type { HdStatus } from "./types";
import { HD_CC_LIMIT } from "./ccs-shared";
import type { HdCcView, HdRequestPeople, HdTicketPeople } from "./ccs-shared";

/** At most this many CCs on one ticket. */
export const HD_CC_MAX = HD_CC_LIMIT;

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/** A plausible single address (no display name, no list). */
export function validCcEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

export interface TicketCc {
  id: number;
  ticketId: number;
  /** A workspace account, or null for an outside address. */
  userId: number | null;
  /** The account's current address, or the outside address. */
  email: string;
  name: string;
  addedBy: number | null;
  addedAt: string;
}

export interface CcInput {
  userId?: number | null;
  email?: string;
  name?: string;
}

export interface CcActor {
  userId: number | null;
  name?: string;
  role?: string | null;
  /** "desk" | "portal" | "email" | "merge" | "mcp" …: recorded in the audit. */
  via?: string;
  /** Inbound email passes the outside-senders answer it already holds; otherwise the setting is read. */
  outsideAllowed?: boolean;
}

export type CcSkipReason = "not_found" | "invalid_email" | "outside_not_allowed" | "blocked" | "requester" | "already" | "limit" | "own_address";

export interface AddCcsResult {
  added: TicketCc[];
  skipped: { input: CcInput; reason: CcSkipReason }[];
}

interface CcRow {
  id: number;
  ticket_id: number;
  user_id: number | null;
  email: string;
  name: string;
  added_by: number | null;
  added_at: string;
}

const toCc = (r: CcRow): TicketCc => ({
  id: r.id,
  ticketId: r.ticket_id,
  userId: r.user_id,
  email: r.email,
  name: r.name,
  addedBy: r.added_by,
  addedAt: r.added_at,
});

/**
 * The CCs of a ticket, oldest first. An account's name and address are its
 * current ones. Never a removed account's row kept for a legal hold
 * (account_removed: a record, not a CC; see keepHeldCcRowsTx).
 */
export async function listCcs(ticketId: number, client?: HdQueryable): Promise<TicketCc[]> {
  const rows = await hq<CcRow>(
    `SELECT c.id, c.ticket_id, c.user_id,
            CASE WHEN c.user_id IS NULL THEN c.email ELSE COALESCE(u.email, c.email) END AS email,
            CASE WHEN c.user_id IS NULL THEN c.name ELSE COALESCE(NULLIF(u.name, ''), u.username, c.name) END AS name,
            c.added_by, c.added_at
       FROM hd_ticket_ccs c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.ticket_id = $1 AND NOT c.account_removed
      ORDER BY c.added_at, c.id`,
    [ticketId],
    client
  );
  return rows.map(toCc);
}

/** Is this account a CC of the ticket? */
export async function isCcOf(userId: number, ticketId: number): Promise<boolean> {
  return !!(await hqOne("SELECT 1 FROM hd_ticket_ccs WHERE ticket_id = $1 AND user_id = $2 AND NOT account_removed", [ticketId, userId]));
}

/** The outside-address CC row of a ticket for this address, if any (never a removed account's kept record). */
export async function outsideCcByEmail(ticketId: number, email: string): Promise<TicketCc | undefined> {
  const r = await hqOne<CcRow>(
    "SELECT id, ticket_id, user_id, email, name, added_by, added_at FROM hd_ticket_ccs WHERE ticket_id = $1 AND user_id IS NULL AND lower(email) = lower($2) AND NOT account_removed",
    [ticketId, email.trim()]
  );
  return r ? toCc(r) : undefined;
}

/** Tests: answer the outside-senders setting for this process (null reads the workspace's again). */
let outsideSendersOverride: boolean | null = null;
export function setOutsideSendersForTests(v: boolean | null): void {
  outsideSendersOverride = v;
}

async function outsideSendersAllowed(): Promise<boolean> {
  if (outsideSendersOverride !== null) return outsideSendersOverride;
  const { getHelpdeskSettings } = await import("./settings");
  return (await getHelpdeskSettings()).outside_senders === true;
}

async function actorName(actor: CcActor, client?: HdQueryable): Promise<string> {
  if (actor.name) return actor.name;
  if (!actor.userId) return "Someone";
  const u = await hqOne<{ name: string }>("SELECT COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1", [actor.userId], client);
  return u?.name ?? "Someone";
}

const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Add people as CCs. An account by id (active only) or an address: an
 * address that belongs to an active account becomes that account; any
 * other address is an outside CC, allowed only while outside senders are
 * on (a merge carries existing rows over whatever the setting; planCcNotice
 * mails none of them while the setting is off) and never a blocked
 * customer-portal contact. The requester, people already copied and
 * anything past HD_CC_MAX are skipped, with the reason (an address kept on
 * the ticket as a removed account's record is "already": an erased person
 * is not copied back in as an outside address). Without `client`: audited
 * (helpdesk.ticket.cc_added), a requester-visible timeline line, and the
 * newly copied accounts are told (hd_cc_added). With `client`: the inserts
 * only, on that client.
 */
export async function addCcs(ticketId: number, people: CcInput[], actor: CcActor, client?: HdQueryable): Promise<AddCcsResult> {
  const out: AddCcsResult = { added: [], skipped: [] };
  const t = await hqOne<{ id: number; number: number; requester_id: number | null; requester_email: string }>(
    "SELECT id, number, requester_id, requester_email FROM hd_tickets WHERE id = $1",
    [ticketId],
    client
  );
  if (!t) {
    for (const p of people) out.skipped.push({ input: p, reason: "not_found" });
    return out;
  }
  const merge = actor.via === "merge";
  let allowOutside: boolean | null = merge ? true : (actor.outsideAllowed ?? null);
  const existing = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_ticket_ccs WHERE ticket_id = $1 AND NOT account_removed", [ticketId], client);
  let count = existing?.n ?? 0;
  for (const p of people.slice(0, 100)) {
    let userId: number | null = null;
    let email = "";
    let name = (p.name ?? "").replace(/[\r\n<>"]/g, " ").trim().slice(0, 200);
    if (p.userId != null) {
      const u = await hqOne<{ id: number; email: string; name: string }>(
        "SELECT id, email, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1 AND status = 'active'",
        [Number(p.userId)],
        client
      );
      if (!u) {
        out.skipped.push({ input: p, reason: "not_found" });
        continue;
      }
      userId = u.id;
      email = u.email ?? "";
      name = u.name;
    } else {
      email = (p.email ?? "").trim().toLowerCase();
      if (!validCcEmail(email)) {
        out.skipped.push({ input: p, reason: "invalid_email" });
        continue;
      }
      const u = await hqOne<{ id: number; name: string }>(
        "SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE lower(email) = $1 AND status = 'active' ORDER BY id LIMIT 1",
        [email],
        client
      );
      if (u) {
        userId = u.id;
        name = u.name;
      } else {
        // 1.20.2: one of the desk's own addresses is never a CC (its mail would come straight back in).
        if (!merge && (await (await import("./mailboxes")).isOwnAddress(email))) {
          out.skipped.push({ input: p, reason: "own_address" });
          continue;
        }
        if (allowOutside === null) allowOutside = await outsideSendersAllowed();
        if (!allowOutside) {
          out.skipped.push({ input: p, reason: "outside_not_allowed" });
          continue;
        }
        if (await (await import("./portal-hooks")).portalContactBlocked(email)) {
          out.skipped.push({ input: p, reason: "blocked" });
          continue;
        }
        name ||= email;
      }
    }
    const isRequester =
      (userId !== null && userId === t.requester_id) || (userId === null && !!t.requester_email && email === t.requester_email.toLowerCase());
    if (isRequester) {
      out.skipped.push({ input: p, reason: "requester" });
      continue;
    }
    if (count >= HD_CC_MAX) {
      out.skipped.push({ input: p, reason: "limit" });
      continue;
    }
    const row = await hqOne<CcRow>(
      `INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name, added_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id, ticket_id, user_id, email, name, added_by, added_at`,
      [ticketId, userId, email.slice(0, 320), name, actor.userId],
      client
    );
    if (!row) {
      out.skipped.push({ input: p, reason: "already" });
      continue;
    }
    count++;
    out.added.push(toCc(row));
  }
  if (client || !out.added.length) return out;

  const by = await actorName(actor);
  await audit({
    actor: { id: actor.userId, name: by, role: actor.role ?? null },
    action: "helpdesk.ticket.cc_added",
    targetType: "helpdesk_ticket",
    targetId: t.id,
    targetLabel: `#${t.number}`,
    details: {
      ccs: out.added.map((c) => (c.userId ? { user_id: c.userId, name: c.name } : { email: c.email })),
      ...(actor.via ? { via: actor.via } : {}),
    },
  });
  try {
    const { addSystemMessage } = await import("./messages");
    const { escapeInline } = await import("./macros");
    await addSystemMessage(ticketId, `${escapeInline(by)} added ${escapeInline(list(out.added.map((c) => c.name || c.email)))} as CC.`, {
      author: { id: actor.userId, name: by },
    });
  } catch (e) {
    logEvent("error", "helpdesk.cc_timeline_failed", { ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
  }
  await notifyCopied(t.number, out.added.filter((c) => c.userId).map((c) => c.userId!), by, actor.userId);
  return out;
}

/**
 * The Cc of a new ticket's mail (lib/helpdesk/inbound, verified senders
 * only): every address but the sender's and the helpdesk's own (the inbound
 * address, team aliases, reply addresses) is offered to addCcs, so
 * directory accounts are copied, and outside addresses only while outside
 * senders are on.
 */
export async function ccsFromInbound(
  ticketId: number,
  email: { from: { email: string }; cc: { email: string; name?: string }[] },
  actor: { userId: number | null; name: string },
  opts: { outsideSenders?: boolean } = {}
): Promise<AddCcsResult | null> {
  if (!email.cc.length) return null;
  const aliases = (await hq<{ email_alias: string }>("SELECT email_alias FROM hd_teams")).map((r) => r.email_alias.trim().toLowerCase()).filter(Boolean);
  // 1.20.2 (lib/helpdesk/mailboxes): every listed address counts as ours, plus-tagged forms and reply addresses included.
  const ownMailbox = await (await import("./mailboxes")).ownAddressMatcher();
  const local = (a: string) => a.split("@")[0].split("+")[0];
  const ours = (a: string) => ownMailbox(a) || aliases.some((al) => (al.includes("@") ? a === al : local(a) === al));
  const from = email.from.email.trim().toLowerCase();
  const people: CcInput[] = [];
  const seen = new Set<string>();
  for (const c of email.cc) {
    const a = (c.email ?? "").trim().toLowerCase();
    if (!a || a === from || seen.has(a) || ours(a)) continue;
    seen.add(a);
    people.push({ email: a, name: c.name });
    if (people.length >= HD_CC_MAX) break;
  }
  if (!people.length) return null;
  return addCcs(ticketId, people, { userId: actor.userId, name: actor.name, via: "email", outsideAllowed: opts.outsideSenders });
}

/** Tell newly copied accounts (bell, hd_cc_added). Never throws. */
async function notifyCopied(number: number, userIds: number[], by: string, actorId: number | null): Promise<void> {
  const ids = userIds.filter((id) => id !== actorId);
  if (!ids.length) return;
  try {
    const subject = (await hqOne<{ subject: string }>("SELECT subject FROM hd_tickets WHERE number = $1", [number]))?.subject ?? "";
    const { notify } = await import("../notifications");
    const { hdLinks, helpdeskOrigin } = await import("./email");
    await notify(ids, {
      kind: "hd_request",
      event: "hd_cc_added",
      title: `${by} added you as CC on #${number}`.slice(0, 300),
      body: subject.slice(0, 500) || undefined,
      link: hdLinks.request(number),
      actorName: by,
      origin: await helpdeskOrigin(),
    });
  } catch (e) {
    logEvent("error", "helpdesk.notify_failed", { event: "cc_added", error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Remove one CC (by its row id). Audited (helpdesk.ticket.cc_removed) with a
 * timeline line. A removed account's row kept for a legal hold is not a CC
 * and is not removed here (the hold keeps it).
 */
export async function removeCc(ticketId: number, ccId: number, actor: CcActor): Promise<TicketCc | undefined> {
  const row = await hqOne<CcRow>(
    `DELETE FROM hd_ticket_ccs WHERE id = $2 AND ticket_id = $1 AND NOT account_removed
      RETURNING id, ticket_id, user_id, email, name, added_by, added_at`,
    [ticketId, ccId]
  );
  if (!row) return undefined;
  const cc = toCc(row);
  const by = await actorName(actor);
  const number = (await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [ticketId]))?.number;
  await audit({
    actor: { id: actor.userId, name: by, role: actor.role ?? null },
    action: "helpdesk.ticket.cc_removed",
    targetType: "helpdesk_ticket",
    targetId: ticketId,
    targetLabel: number ? `#${number}` : null,
    details: { ...(cc.userId ? { user_id: cc.userId, name: cc.name } : { email: cc.email }), ...(actor.via ? { via: actor.via } : {}) },
  });
  try {
    const { addSystemMessage } = await import("./messages");
    const { escapeInline } = await import("./macros");
    const self = cc.userId !== null && cc.userId === actor.userId;
    await addSystemMessage(
      ticketId,
      self ? `${escapeInline(by)} left the CC list.` : `${escapeInline(by)} removed ${escapeInline(cc.name || cc.email)} from CC.`,
      { author: { id: actor.userId, name: by } }
    );
  } catch (e) {
    logEvent("error", "helpdesk.cc_timeline_failed", { ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
  }
  return cc;
}

/**
 * Merge (agent V2): move every CC of `fromTicketId` onto `toTicketId`,
 * de-duplicated (a person already copied there keeps that row) and never
 * copying the target's own requester. The source keeps none. Returns the
 * rows added to the target. No audit: the merge's covers it. A removed
 * account's kept record stays a record (account_removed) on the target.
 */
export async function moveCcs(fromTicketId: number, toTicketId: number, client?: HdQueryable): Promise<number> {
  if (fromTicketId === toTicketId) return 0;
  const rows = await hq<{ id: number }>(
    `WITH moved AS (
       DELETE FROM hd_ticket_ccs WHERE ticket_id = $1
       RETURNING user_id, email, name, added_by, added_at, account_removed
     ), target AS (
       SELECT requester_id, lower(requester_email) AS requester_email FROM hd_tickets WHERE id = $2
     )
     INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name, added_by, added_at, account_removed)
     SELECT $2, m.user_id, m.email, m.name, m.added_by, m.added_at, m.account_removed
       FROM moved m, target t
      WHERE (m.user_id IS NOT NULL AND m.user_id IS DISTINCT FROM t.requester_id)
         OR (m.user_id IS NULL AND (t.requester_email = '' OR lower(m.email) <> t.requester_email))
      ORDER BY m.added_at
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [fromTicketId, toTicketId],
    client
  );
  return rows.length;
}

/**
 * People from a request body: `[{ user_id }, { email, name? }]`, at most
 * HD_CC_MAX. Null when malformed (the route answers 400).
 */
export function parseCcInput(raw: unknown): CcInput[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > HD_CC_MAX) return null;
  const out: CcInput[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (o.user_id !== undefined && o.user_id !== null) {
      const id = Number(o.user_id);
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      out.push({ userId: id });
    } else if (typeof o.email === "string" && o.email.length <= 254) {
      out.push({ email: o.email, name: typeof o.name === "string" ? o.name.slice(0, 200) : undefined });
    } else return null;
  }
  return out;
}

/** The page shape of the CCs: agents see every address; requesters and CCs outside addresses only. */
export function ccViews(ccs: TicketCc[], audience: "agent" | "requester"): HdCcView[] {
  return ccs.map((c) => ({
    id: c.id,
    user_id: c.userId,
    name: c.name || c.email,
    email: audience === "agent" || c.userId === null ? c.email : "",
    outside: c.userId === null,
  }));
}

/** The desk's CC and Following rows for one agent. */
export async function ticketPeopleView(ticketId: number, viewerId: number): Promise<HdTicketPeople> {
  const [ccs, followers, outside] = await Promise.all([listCcs(ticketId), listFollowers(ticketId), outsideSendersAllowed()]);
  return {
    ccs: ccViews(ccs, "agent"),
    followers: followers.map((f) => ({ user_id: f.userId, name: f.name })),
    following: followers.some((f) => f.userId === viewerId),
    outside_allowed: outside,
  };
}

/** Get help's people list for the requester or a CC (null for anyone else). */
export async function requestPeopleView(
  t: { id: number; requester_id: number | null; status: string },
  viewerId: number,
  relation: string
): Promise<HdRequestPeople | null> {
  const isRequester = t.requester_id === viewerId;
  if (!isRequester && relation !== "cc") return null;
  const [ccs, outside] = await Promise.all([listCcs(t.id), outsideSendersAllowed()]);
  return {
    ccs: ccViews(ccs, "requester"),
    can_add: isRequester && t.status !== "closed",
    outside_allowed: outside,
    viewer_is_cc: !isRequester,
  };
}

// --- Followers ---------------------------------------------------------------------

export interface TicketFollower {
  userId: number;
  name: string;
  addedAt: string;
}

/** The agents following a ticket (not those who unfollowed), active accounts, oldest first. */
export async function listFollowers(ticketId: number, client?: HdQueryable): Promise<TicketFollower[]> {
  return hq<TicketFollower>(
    `SELECT f.user_id AS "userId", COALESCE(NULLIF(u.name, ''), u.username) AS name, f.added_at AS "addedAt"
       FROM hd_ticket_followers f JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE f.ticket_id = $1 AND f.muted = 0
      ORDER BY f.added_at, f.user_id`,
    [ticketId],
    client
  );
}

/** Is this agent following the ticket? */
export async function isFollowing(ticketId: number, userId: number): Promise<boolean> {
  return !!(await hqOne("SELECT 1 FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = $2 AND muted = 0", [ticketId, userId]));
}

/**
 * Merge (agent V2): move the followers of `fromTicketId` onto `toTicketId`.
 * Someone with a row on the target keeps it (including an unfollow).
 * Returns the rows added to the target.
 */
export async function moveFollowers(fromTicketId: number, toTicketId: number, client?: HdQueryable): Promise<number> {
  if (fromTicketId === toTicketId) return 0;
  const rows = await hq<{ user_id: number }>(
    `WITH moved AS (
       DELETE FROM hd_ticket_followers WHERE ticket_id = $1
       RETURNING user_id, added_by, added_at, muted
     )
     INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by, added_at, muted)
     SELECT $2, user_id, added_by, added_at, muted FROM moved
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [fromTicketId, toTicketId],
    client
  );
  return rows.length;
}

/**
 * Follow a ticket. `auto` (an agent's reply) never overrides an earlier
 * unfollow; a deliberate Follow does. Answers whether the person is now
 * newly following. Audited (helpdesk.ticket.follower_added) when it is.
 */
export async function followTicket(ticketId: number, userId: number, actor: CcActor, opts: { auto?: boolean } = {}): Promise<boolean> {
  const row = opts.auto
    ? await hqOne<{ user_id: number }>(
        `INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [ticketId, userId, actor.userId]
      )
    : await hqOne<{ user_id: number }>(
        `INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT (ticket_id, user_id) DO UPDATE SET muted = 0, added_by = EXCLUDED.added_by, added_at = now()
           WHERE hd_ticket_followers.muted = 1
         RETURNING user_id`,
        [ticketId, userId, actor.userId]
      );
  if (!row) return false;
  await followAudit("helpdesk.ticket.follower_added", ticketId, userId, actor, opts.auto ? { auto: true } : {});
  return true;
}

/** Unfollow a ticket (kept as a muted row, so a later reply does not follow again). Audited when it changed anything. */
export async function unfollowTicket(ticketId: number, userId: number, actor: CcActor): Promise<boolean> {
  const row = await hqOne<{ user_id: number }>(
    `INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by, muted) VALUES ($1, $2, $3, 1)
     ON CONFLICT (ticket_id, user_id) DO UPDATE SET muted = 1 WHERE hd_ticket_followers.muted = 0
     RETURNING user_id, (xmax = 0) AS inserted`,
    [ticketId, userId, actor.userId]
  );
  if (!row || (row as { inserted?: boolean }).inserted) return false;
  await followAudit("helpdesk.ticket.follower_removed", ticketId, userId, actor, {});
  return true;
}

async function followAudit(
  action: "helpdesk.ticket.follower_added" | "helpdesk.ticket.follower_removed",
  ticketId: number,
  userId: number,
  actor: CcActor,
  extra: Record<string, unknown>
): Promise<void> {
  const number = (await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [ticketId]))?.number;
  const by = await actorName(actor);
  await audit({
    actor: { id: actor.userId, name: by, role: actor.role ?? null },
    action,
    targetType: "helpdesk_ticket",
    targetId: ticketId,
    targetLabel: number ? `#${number}` : null,
    details: { user_id: userId, ...extra, ...(actor.via ? { via: actor.via } : {}) },
  });
}

// --- Notices -----------------------------------------------------------------------

/**
 * The CC side of one requester notice (lib/helpdesk/notify toRequester):
 * which addresses ride on the requester's mail as Cc, and the accounts'
 * bells. Each account CC goes through the notification policy for `event`
 * (bell and email; a digest choice queues the item instead of the Cc).
 * Outside CCs are mailed only while outside senders are on (their rows are
 * kept: turning it back on resumes them; with it off their answers would be
 * refused), and never a blocked customer-portal contact, nor a removed
 * account's row kept for a legal hold (account_removed). `excludeUserId`
 * (the author) is left out, and so are `opts.excludeUserIds` (agents the
 * caller already told through the desk notice: one notice per person).
 */
export interface CcNoticePlan {
  /** Addresses for the Cc header (instant email). */
  cc: string[];
  /** Account CCs whose bell is on for the event. */
  bellIds: number[];
  /** Account CCs whose email waits for their digest. */
  digestIds: number[];
}

export async function planCcNotice(
  ticketId: number,
  event: string,
  excludeUserId: number | null,
  excludeEmail = "",
  /** alreadyMailed (1.19.2, agent W5): addresses an inbound email already reached; they keep the bell, no mail or digest. */
  opts: { excludeUserIds?: Iterable<number>; alreadyMailed?: Set<string> } = {}
): Promise<CcNoticePlan> {
  const plan: CcNoticePlan = { cc: [], bellIds: [], digestIds: [] };
  const ccs = await hq<{ user_id: number | null; email: string; active: boolean | null }>(
    `SELECT c.user_id, CASE WHEN c.user_id IS NULL THEN c.email ELSE u.email END AS email, (u.status = 'active') AS active
       FROM hd_ticket_ccs c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.ticket_id = $1 AND NOT c.account_removed ORDER BY c.added_at, c.id`,
    [ticketId]
  );
  const ex = excludeEmail.trim().toLowerCase();
  const told = new Set(opts.excludeUserIds ?? []);
  const accountIds = ccs.filter((c) => c.user_id !== null && c.active && c.user_id !== excludeUserId && !told.has(c.user_id)).map((c) => c.user_id!);
  if (accountIds.length) {
    const { shouldNotifyMany, emailGate } = await import("../notify-policy");
    const [bells, gate] = await Promise.all([shouldNotifyMany(accountIds, event, "bell"), emailGate(accountIds, event)]);
    for (const id of accountIds) {
      if (bells.get(id)?.send) plan.bellIds.push(id);
      const d = gate.decision(id);
      if (!d.send) continue;
      if (opts.alreadyMailed?.has((ccs.find((c) => c.user_id === id)?.email ?? "").toLowerCase())) continue;
      if (d.mode === "instant") {
        const addr = ccs.find((c) => c.user_id === id)?.email ?? "";
        if (addr && validCcEmail(addr.toLowerCase())) plan.cc.push(addr);
      } else plan.digestIds.push(id);
    }
  }
  const outside = ccs.filter((c) => c.user_id === null && c.email && c.email.toLowerCase() !== ex && !opts.alreadyMailed?.has(c.email.toLowerCase()) && validCcEmail(c.email.toLowerCase()));
  if (outside.length && (await outsideSendersAllowed())) {
    const { portalContactBlocked } = await import("./portal-hooks");
    for (const c of outside) if (!(await portalContactBlocked(c.email))) plan.cc.push(c.email);
  }
  plan.cc = [...new Set(plan.cc.map((a) => a.toLowerCase()))].filter((a) => a !== ex);
  return plan;
}

/** Did someone copied on the ticket write this (an account CC, or an outside CC's address)? */
export async function isCcAuthor(ticketId: number, authorId: number | null, authorEmail: string): Promise<boolean> {
  if (authorId) return isCcOf(authorId, ticketId);
  return !!authorEmail && !!(await outsideCcByEmail(ticketId, authorEmail));
}

/**
 * The rest of a requester notice's CC side, after the requester's own mail:
 * the CCs' bells, their digest items, and, when no requester mail went out
 * to carry the Cc (the requester wrote it, opted out or chose a digest), one
 * mail to the CCs themselves.
 */
export async function finishCcNotice(
  plan: CcNoticePlan,
  n: {
    event: string;
    title: string;
    body: string;
    link: string;
    template: string;
    vars: Record<string, string>;
    thread: { ticketId: number; number: number; teamId?: number | null };
    mailedWithRequester: boolean;
    ctx: { actorId?: number | null; actorName?: string; origin?: string };
  }
): Promise<void> {
  try {
    const bellIds = plan.bellIds.filter((id) => id !== n.ctx.actorId);
    if (bellIds.length) {
      const { notify } = await import("../notifications");
      await notify(bellIds, {
        kind: "hd_request",
        event: n.event,
        title: n.title.slice(0, 300),
        body: n.body ? n.body.slice(0, 500) : undefined,
        link: n.link,
        actorName: n.ctx.actorName,
        origin: n.ctx.origin,
      });
    }
    await queueCcDigests(plan, n.event, { title: n.title, body: n.body, link: n.link });
    if (!n.mailedWithRequester && plan.cc.length) {
      const { sendHelpdeskTemplate } = await import("./email");
      await sendHelpdeskTemplate(plan.cc[0], n.template, n.vars, n.thread, n.ctx.origin, { cc: plan.cc.slice(1) });
    }
  } catch (e) {
    logEvent("error", "helpdesk.notify_failed", { event: "cc_notice", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Queue the digest items of a plan (the CCs who chose a digest for this event). */
export async function queueCcDigests(plan: CcNoticePlan, event: string, item: { title: string; body: string; link: string }): Promise<void> {
  if (!plan.digestIds.length) return;
  const { emailGate } = await import("../notify-policy");
  const gate = await emailGate(plan.digestIds, event);
  for (const id of plan.digestIds) await gate.route(id, item, async () => undefined).catch(() => undefined);
}

// --- Followers' notices and auto-follow ------------------------------------------

/** Test hook: the follower deliveries (they are still delivered). */
let followerSpy: ((userId: number, title: string) => void) | null = null;
export function setFollowerSpyForTests(spy: typeof followerSpy): void {
  followerSpy = spy;
}

type FollowedChange = { kind: "message"; messageId: number } | { kind: "status"; from?: HdStatus | null };

/**
 * Tell a ticket's followers about an update (events.ts calls this after a
 * message or a ticket change commits): desk_followed_update through agent
 * F's deliverAgentNotification (their matrix, quiet hours and pause). Only
 * followers who may still work the ticket; never its author; and not the
 * people the existing notice already reached (the assignee for an internal
 * note or the requester's reply; the team for an unassigned requester
 * reply; the requester and the account CCs for any public message). A held
 * reply (newbie review) tells nobody yet: lib/helpdesk/review calls this
 * again when a lead approves it.
 */
export async function notifyFollowers(ticketId: number, change: FollowedChange, ctx: { actorId?: number | null; actorName?: string; origin?: string } = {}): Promise<void> {
  const followers = await hq<{ user_id: number; role: import("../types").Role }>(
    `SELECT f.user_id, u.role FROM hd_ticket_followers f JOIN users u ON u.id = f.user_id AND u.status = 'active'
      WHERE f.ticket_id = $1 AND f.muted = 0`,
    [ticketId]
  );
  if (!followers.length) return;
  const { getTicketRow } = await import("./tickets");
  const t = await getTicketRow(ticketId);
  if (!t) return;
  const skip = new Set<number>();
  if (ctx.actorId) skip.add(ctx.actorId);
  let title = "";
  let body = "";
  let email: { template: "hd_reply" | "hd_internal_note"; vars: Record<string, string> } | undefined;
  const { hdLinks } = await import("./email");
  const url = hdLinks.ticket(t.number);
  if (change.kind === "message") {
    const m = await hqOne<{ author_id: number | null; author_name: string; author_email: string; kind: string; body: string; review_state: string | null }>(
      `SELECT author_id, author_name, author_email, kind, body, to_jsonb(m) ->> 'review_state' AS review_state FROM hd_messages m WHERE id = $1 AND ticket_id = $2`,
      [change.messageId, ticketId]
    );
    if (!m || m.kind === "system") return;
    if (m.review_state === "pending" || m.review_state === "returned") return;
    if (m.author_id) skip.add(m.author_id);
    const fromRequesterSide =
      (t.requester_id !== null && m.author_id === t.requester_id) ||
      (m.author_id !== null && (await isCcOf(m.author_id, ticketId))) ||
      (m.author_id === null && !!m.author_email);
    if (m.kind === "internal" && t.assignee_id) skip.add(t.assignee_id);
    if (m.kind === "public") {
      // The requester and the account CCs hear a public reply through the
      // requester notice (lib/helpdesk/notify toRequester): not twice.
      if (t.requester_id) skip.add(t.requester_id);
      for (const c of await hq<{ user_id: number }>("SELECT user_id FROM hd_ticket_ccs WHERE ticket_id = $1 AND user_id IS NOT NULL AND NOT account_removed", [ticketId])) skip.add(c.user_id);
    }
    if (m.kind === "public" && fromRequesterSide) {
      if (t.assignee_id) skip.add(t.assignee_id);
      else {
        const { teamMemberIds } = await import("./notify");
        for (const id of await teamMemberIds(t.team_id)) skip.add(id);
      }
    }
    const author = m.author_name || "Someone";
    const { markdownToPlain } = await import("./inbound-parse");
    const plain = markdownToPlain(m.body).replace(/\s+/g, " ").trim();
    title = m.kind === "internal" ? `${author} added a note on #${t.number} (following)` : `${author} replied on #${t.number} (following)`;
    body = plain.length > 280 ? `${plain.slice(0, 279)}…` : plain;
    const vars = { ticket_number: String(t.number), subject: t.subject, author_name: author, message: markdownToPlain(m.body).slice(0, 8000), ticket_url: url };
    email = { template: m.kind === "internal" ? "hd_internal_note" : "hd_reply", vars };
  } else {
    // The requester's (or a CC's) reply reopening it: the message notice says so.
    if (ctx.actorId && (ctx.actorId === t.requester_id || (await isCcOf(ctx.actorId, ticketId)))) return;
    const { HD_STATUS_LABEL } = await import("./types");
    title = `#${t.number} is now ${HD_STATUS_LABEL[t.status] ?? t.status} (following)`;
    body = ctx.actorName ? `${ctx.actorName} changed the status of ${t.subject}` : t.subject;
  }
  const { canWorkTicket } = await import("./access");
  const { deliverToAgent } = await import("./notify");
  for (const f of followers) {
    if (skip.has(f.user_id)) continue;
    if (!(await canWorkTicket({ id: f.user_id, role: f.role }, t).catch(() => false))) continue;
    followerSpy?.(f.user_id, title);
    await deliverToAgent(
      f.user_id,
      "followed_update",
      { ticketNumber: t.number, title: title.slice(0, 300), body, urgent: false, url, teamId: t.team_id, email },
      { actorId: ctx.actorId ?? null, actorName: ctx.actorName, origin: ctx.origin }
    );
  }
}

/**
 * An agent wrote on a ticket (a public reply or an internal note): they
 * follow it, unless their desk preference "Follow tickets I reply to" is off
 * or they unfollowed it before. Requesters and CCs never follow.
 */
export async function autoFollowOnReply(ticketId: number, messageId: number): Promise<void> {
  const m = await hqOne<{ author_id: number | null; kind: string; via: string }>(
    "SELECT author_id, kind, via FROM hd_messages WHERE id = $1 AND ticket_id = $2",
    [messageId, ticketId]
  );
  if (!m?.author_id || m.kind === "system" || m.via === "system") return;
  const [{ getTicketRow }, { canWorkTicket }, { getNotifyPrefs }] = await Promise.all([import("./tickets"), import("./access"), import("./notify-prefs")]);
  const t = await getTicketRow(ticketId);
  if (!t || t.requester_id === m.author_id || (await isCcOf(m.author_id, ticketId))) return;
  const u = await hqOne<{ id: number; role: import("../types").Role; name: string }>(
    "SELECT id, role, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1 AND status = 'active'",
    [m.author_id]
  );
  if (!u || !(await canWorkTicket(u, t))) return;
  const prefs = await getNotifyPrefs(u.id);
  if (prefs.auto_follow === false) return;
  await followTicket(ticketId, u.id, { userId: u.id, name: u.name, role: u.role, via: "auto" }, { auto: true });
}
