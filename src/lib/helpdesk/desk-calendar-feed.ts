// Helpdesk 1.20.6: private iCal feeds of the desk's event calendar
// (lib/helpdesk/desk-calendar), so Outlook, Google Calendar or Apple Calendar
// can subscribe to a team's events.
//
//   a link    belongs to one person and one scope: a team they work, or
//             "all my teams". GET /api/helpdesk/calendar/feed/<token>.ics
//             answers the events of tickets that person may see in that
//             scope at the moment it is fetched: their desk role and teams
//             are read every time, so a link stops showing a team its owner
//             has left, and stops working when their account is removed or
//             loses its desk role. One live link per person per scope;
//             making it again replaces it (the old address stops working).
//   the token "cdf_" + 32 random bytes in base64url, shown once. Only its
//             SHA-256 is stored, with its last four characters for display.
//             It is the only credential: no session is read, so the route
//             has no CSRF surface and the Duo desk rule (which is about
//             sessions) does not apply, as for API tokens.
//   refusals  one answer for everything that is not a working link (a
//             malformed token, an unknown one, a revoked one, an owner who
//             may no longer see the scope): 404 "Not found.", so an address
//             reveals nothing. The token is looked up by its hash and the
//             hashes compared in constant time. Unlicensed: 402 for every
//             address alike, before any lookup. Rate limits: 30 fetches a
//             minute per link, and 30 misses a minute per address (429).
//   contents  for each event: "#1047 Subject", the place, the start and end
//             (UTC instants, or whole days), a link back to the ticket, and
//             in the description when setup must be ready and whether it is
//             marked complete. Never the requester's name or address, never
//             a message or an internal note. Cancelled events are sent as
//             cancelled so calendars drop them. Events from 30 days ago to a
//             year ahead, at most 1,000.
//   audit     creating, replacing and revoking a link is audited
//             (helpdesk.calendar_feed.*) with its owner and scope, never the
//             token. Fetches are not audited (calendars poll all day);
//             last_used_at is kept, to the minute.
//
// Server-only.

import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { audit, type AuditActor } from "../audit";
import type { Role } from "../types";
import { hq, hqOne, withTx } from "./db-core";
import { agentTeamIds, hdRateLimited, helpdeskLicensed, HD_LICENCE_ERROR, isAgent } from "./access";
import { buildCalendar, type FeedEvent } from "./desk-calendar-ics";
import { HD_CALENDAR_FEED_PREFIX, leadLabel, readyByLabel, zoneLabel, type HdCalendarFeedView } from "./desk-calendar-shared";
import { toEvent, viewerZone, type EventRow } from "./desk-calendar";

export const FEED_TOKEN_RE = /^cdf_[A-Za-z0-9_-]{43}$/;
const FEED_BACK_DAYS = 30;
const FEED_AHEAD_DAYS = 366;
const FEED_MAX = 1000;

export class FeedError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function hashFeedToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

type U = { id: number; role: Role; name?: string; username?: string };

interface FeedRow {
  id: number;
  owner_id: number;
  owner_name: string;
  team_id: number | null;
  team_name: string | null;
  last4: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const SELECT = `SELECT f.id, f.owner_id, COALESCE(NULLIF(u.name, ''), u.username) AS owner_name, f.team_id, tm.name AS team_name, f.last4,
                       f.created_at, f.last_used_at, f.revoked_at
                  FROM hd_calendar_feeds f JOIN users u ON u.id = f.owner_id LEFT JOIN hd_teams tm ON tm.id = f.team_id`;

function toView(r: FeedRow, me: number): HdCalendarFeedView {
  return {
    id: r.id,
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    team_id: r.team_id,
    team_name: r.team_name,
    hint: `${HD_CALENDAR_FEED_PREFIX}…${r.last4}`,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
    mine: r.owner_id === me,
  };
}

/** The person's own live links; with `all` (settings.manage, checked by the route) everyone's. */
export async function listFeeds(user: U, opts: { all?: boolean } = {}): Promise<HdCalendarFeedView[]> {
  const rows = opts.all
    ? await hq<FeedRow>(`${SELECT} WHERE f.revoked_at IS NULL ORDER BY lower(COALESCE(NULLIF(u.name, ''), u.username)), tm.name NULLS FIRST, f.id LIMIT 500`)
    : await hq<FeedRow>(`${SELECT} WHERE f.revoked_at IS NULL AND f.owner_id = $1 ORDER BY tm.name NULLS FIRST, f.id`, [user.id]);
  return rows.map((r) => toView(r, user.id));
}

/** The teams this person may make a link for: the ones they work. */
export async function feedTeams(user: U): Promise<{ id: number; name: string }[]> {
  const teams = await agentTeamIds(user);
  return hq<{ id: number; name: string }>(
    teams === "all" ? "SELECT id, name FROM hd_teams ORDER BY position, name, id" : "SELECT id, name FROM hd_teams WHERE id = ANY($1::int[]) ORDER BY position, name, id",
    teams === "all" ? [] : [teams]
  );
}

/**
 * Make the person's link for a scope (a team id, or null for every team they
 * work), replacing the one they had: the old address stops working at once.
 * Returns the token once; it is never stored.
 */
export async function createFeed(user: U & AuditActor, teamId: number | null, ip: string | null = null): Promise<{ token: string; view: HdCalendarFeedView; replaced: boolean }> {
  if (!(await isAgent(user))) throw new FeedError("Only desk agents can subscribe to the calendar.", 403);
  let teamName: string | null = null;
  if (teamId !== null) {
    if (!Number.isSafeInteger(teamId) || teamId <= 0) throw new FeedError("Unknown team.");
    const mine = await feedTeams(user);
    const t = mine.find((x) => x.id === teamId);
    if (!t) throw new FeedError("Choose a team you work in.", 403);
    teamName = t.name;
  }
  const token = `${HD_CALENDAR_FEED_PREFIX}${randomBytes(32).toString("base64url")}`;
  const name = user.name || user.username || "";
  const res = await withTx(async (client) => {
    const old = await client.query(
      "UPDATE hd_calendar_feeds SET revoked_at = now(), revoked_by_name = $3 WHERE owner_id = $1 AND COALESCE(team_id, 0) = $2 AND revoked_at IS NULL",
      [user.id, teamId ?? 0, name]
    );
    const ins = await client.query<{ id: number }>("INSERT INTO hd_calendar_feeds (owner_id, team_id, token_hash, last4) VALUES ($1, $2, $3, $4) RETURNING id", [user.id, teamId, hashFeedToken(token), token.slice(-4)]);
    return { id: ins.rows[0].id, replaced: (old.rowCount ?? 0) > 0 };
  });
  await audit({
    actor: { id: user.id, name, role: user.role },
    action: res.replaced ? "helpdesk.calendar_feed.regenerated" : "helpdesk.calendar_feed.created",
    targetType: "helpdesk_calendar_feed",
    targetId: res.id,
    targetLabel: teamName ? `${name}: ${teamName}` : `${name}: all my teams`,
    details: { owner: name, scope: teamName ?? "all my teams", team_id: teamId },
    ip,
  });
  const row = (await hqOne<FeedRow>(`${SELECT} WHERE f.id = $1`, [res.id]))!;
  return { token, view: toView(row, user.id), replaced: res.replaced };
}

/** Revoke a link: its owner, or (with `manage`) anyone who runs the helpdesk's settings. False when it isn't there or isn't theirs. */
export async function revokeFeed(user: U & AuditActor, id: number, opts: { manage?: boolean; ip?: string | null } = {}): Promise<boolean> {
  const name = user.name || user.username || "";
  const row = await hqOne<FeedRow>(`${SELECT} WHERE f.id = $1 AND f.revoked_at IS NULL`, [id]);
  if (!row || (row.owner_id !== user.id && !opts.manage)) return false;
  const done = await hq("UPDATE hd_calendar_feeds SET revoked_at = now(), revoked_by_name = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id, name]);
  if (!done.length) return false;
  await audit({
    actor: { id: user.id, name, role: user.role },
    action: "helpdesk.calendar_feed.revoked",
    targetType: "helpdesk_calendar_feed",
    targetId: id,
    targetLabel: `${row.owner_name}: ${row.team_name ?? "all my teams"}`,
    details: { owner: row.owner_name, scope: row.team_name ?? "all my teams", team_id: row.team_id, by_owner: row.owner_id === user.id },
    ip: opts.ip ?? null,
  });
  return true;
}

// --- Serving ------------------------------------------------------------------------

export interface FeedResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const NOT_FOUND: FeedResponse = { status: 404, body: "Not found.\n", headers: TEXT };

interface FeedEventRow extends EventRow {
  number: number;
  subject: string;
}

/**
 * GET /api/helpdesk/calendar/feed/<token>.ics. `ip` keys the limit on
 * misses; `origin` is the address the ticket links point at.
 */
export async function serveFeed(rawToken: string, ctx: { origin: string; ip: string | null; now?: Date }): Promise<FeedResponse> {
  if (!(await helpdeskLicensed())) return { status: 402, body: `${HD_LICENCE_ERROR}\n`, headers: TEXT };
  const missKey = `hd-feed-miss:${ctx.ip ?? "?"}`;
  const tooMany: FeedResponse = { status: 429, body: "Too many requests. Try again in a minute.\n", headers: { ...TEXT, "Retry-After": "60" } };
  const miss = (): FeedResponse => (hdRateLimited(missKey, 30, 60_000) ? tooMany : NOT_FOUND);
  const token = rawToken.endsWith(".ics") ? rawToken.slice(0, -4) : rawToken;
  if (!FEED_TOKEN_RE.test(token)) return miss();
  const hash = hashFeedToken(token);
  const feed = await hqOne<{ id: number; owner_id: number; team_id: number | null; token_hash: string; role: Role; timezone: string; team_name: string | null }>(
    `SELECT f.id, f.owner_id, f.team_id, f.token_hash, u.role, COALESCE(u.timezone, '') AS timezone, tm.name AS team_name
       FROM hd_calendar_feeds f JOIN users u ON u.id = f.owner_id AND u.status = 'active' LEFT JOIN hd_teams tm ON tm.id = f.team_id
      WHERE f.token_hash = $1 AND f.revoked_at IS NULL`,
    [hash]
  );
  if (!feed) return miss();
  const a = Buffer.from(feed.token_hash, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return miss();
  if (hdRateLimited(`hd-feed:${feed.id}`, 30, 60_000)) return tooMany;
  // What the owner may see now, read fresh: their desk role and their teams.
  const owner = { id: feed.owner_id, role: feed.role };
  if (!(await isAgent(owner))) return NOT_FOUND;
  const teams = await agentTeamIds(owner);
  if (feed.team_id !== null && teams !== "all" && !teams.includes(feed.team_id)) return NOT_FOUND;

  const now = ctx.now ?? new Date();
  const params: unknown[] = [new Date(now.getTime() - FEED_BACK_DAYS * 86_400_000), new Date(now.getTime() + FEED_AHEAD_DAYS * 86_400_000)];
  let scope: string;
  if (feed.team_id !== null) {
    params.push(feed.team_id);
    scope = `t.team_id = $${params.length}`;
  } else if (teams === "all") scope = "TRUE";
  else {
    params.push(teams, feed.owner_id);
    scope = `(t.team_id = ANY($${params.length - 1}::int[]) OR t.assignee_id = $${params.length})`;
  }
  const rows = await hq<FeedEventRow>(
    `SELECT e.ticket_id, e.starts_at, e.ends_at, e.all_day, to_char(e.start_date, 'YYYY-MM-DD') AS start_date, to_char(e.end_date, 'YYYY-MM-DD') AS end_date,
            e.timezone, e.place, e.place_key, e.setup_minutes, e.ready_at, e.setup_done_at, e.setup_done_by, e.setup_done_by_name, e.cancelled_at,
            e.source, e.ics_uid, e.ics_sequence, e.repeats, e.time_rev, e.updated_at, t.number, t.subject
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND t.deleted_at IS NULL AND t.merged_into IS NULL AND e.ends_at >= $1 AND e.starts_at <= $2
      ORDER BY e.starts_at, t.number LIMIT ${FEED_MAX}`,
    params
  );
  void hq("UPDATE hd_calendar_feeds SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [feed.id]).catch(() => {});

  const tz = await viewerZone({ timezone: feed.timezone });
  const host = hostOf(ctx.origin);
  const events: FeedEvent[] = rows.map((r) => {
    const e = toEvent(r);
    const url = `${ctx.origin}/desk/tickets/${r.number}`;
    const setup = e.cancelled
      ? "The event was cancelled."
      : e.setup_minutes > 0
        ? `Setup ready by ${readyByLabel(e, tz)} (${zoneLabel(tz)}), ${leadLabel(e.setup_minutes)} before the start.`
        : "No setup time is planned before the start.";
    const done = e.cancelled ? "" : e.setup_complete ? "Setup complete: yes." : "Setup complete: not yet.";
    return {
      uid: `ticket-${r.number}@${host}`,
      summary: `#${r.number} ${r.subject}`,
      location: e.place,
      description: [setup, done, `Ticket: ${url}`].filter(Boolean).join("\n"),
      url,
      all_day: e.all_day,
      starts_at: new Date(e.starts_at),
      ends_at: new Date(e.ends_at),
      start_date: e.start_date,
      end_date: e.end_date,
      cancelled: e.cancelled,
      sequence: r.time_rev + (e.cancelled ? 1 : 0),
      updated_at: new Date(r.updated_at),
    };
  });
  const name = feed.team_name ? `${feed.team_name} events` : "Helpdesk events";
  return {
    status: 200,
    body: buildCalendar(name, events, now),
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="helpdesk-events.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || "compassdocs";
  } catch {
    return "compassdocs";
  }
}
