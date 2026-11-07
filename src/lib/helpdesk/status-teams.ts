// Helpdesk 1.19.2: Status page services per team (agent W6). The Status
// page (lib/status: vendor feeds polled by refreshDueStatuses, internal
// "manual" services declared by hand) is the one source of truth; this
// module only decides who on the desk hears about it.
//
//   follow    a team ticks the Status page services that matter to it
//             (hd_team_status_services) with a pop-up level per service:
//             outage and degraded, outage only, or off (top bar and queue
//             banner only). teams.manage, or agents.manage_team in that
//             team (its lead). Audited.
//   episodes  syncTeamStatus() turns the services' states into spells of
//             trouble (hd_status_episodes): one opens when a followed
//             service turns degraded or outage and closes when it is
//             operational (or in maintenance) again; "unknown" (a feed that
//             never answered) changes nothing. It runs on the minute tick,
//             at the end of refreshDueStatuses (the poller keeps its own
//             per-service interval, so vendors are not asked more often),
//             and, throttled, when an agent's desk polls, so a service set
//             down by hand on the Status page reaches the desk within the
//             minute. Per service under an advisory lock, so instances
//             never double-send.
//   telling  the first time an episode reaches a team's pop-up level, the
//             team's agents get the desk event service_down (bell and push
//             by default, through F's deliverAgentNotification and the
//             agent's preferences); when it ends, those told hear it is
//             back. Each person once per episode and level.
//   desk     statusForAgent(): the services the agent's teams follow (the
//             union, never every service), the pop-ups (one per person per
//             episode; dismissing is remembered; a recovery note follows
//             for those who saw it), the queue banners (per team; "Hide for
//             today" per person) and the solve asks below.
//   declare  a major incident declared from a service (W1's dialog,
//             prefilled by declarePrefill) records the service on the
//             incident (hd_incidents.status_service_id, when it has none)
//             and, when asked, watches it: once the service is operational
//             again its runners (who declared it, and its ticket's
//             assignee) are asked to solve it with its linked tickets.
//             Nothing is ever solved without a person's click.
//
// Server-only. Licence: the helpdesk; the Status page itself is unchanged
// in every edition.

import "server-only";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { hasAgentAll, helpdeskLicensed, isAgent, memberTeamIds } from "./access";
import { hdCan } from "./roles";
import { HD_OPEN_STATUSES } from "./types";
import { matchesRule } from "./incidents-shared";
import { userHolds } from "../access";
import {
  isAffected,
  isRecovered,
  popupApplies,
  stateSentence,
  suggestTitle,
  suggestWords,
  troubleRank,
  type DeclarePrefill,
  type PopupLevel,
  type SeenAction,
  type ServiceStatus,
  type StatusIncidentRef,
  type TeamStatusAsk,
  type TeamStatusBanner,
  type TeamStatusPopup,
  type TeamStatusService,
  type TeamStatusSettingsRow,
  type TeamStatusView,
} from "./status-teams-shared";
import type { Role } from "../types";

export * from "./status-teams-shared";

type U = { id: number; role: Role };

/**
 * The sync's advisory lock, two-key with the service id (one service synced
 * at a time). Listed beside RECURRING_SWEEP_LOCK in lib/helpdesk/recurring.
 */
export const STATUS_TEAMS_LOCK = 7_281_983;

/** How long a recovery note stays for those who saw the pop-up. */
const RECOVERY_HOURS = 12;
/** Trouble back within this many minutes of a recovery reopens the same episode (a flapping feed is one spell). */
export const REOPEN_MINUTES = 10;
/** Deliveries sent at once (each is a prefs read, a policy decision and a push). */
const DELIVERY_CONCURRENCY = 8;
/** Ended episodes kept this long, then swept. */
const KEEP_DAYS = 90;
const OPEN_SQL = `('new', 'open', 'pending', 'on_hold')`;

export class StatusTeamsError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

async function licensed(): Promise<boolean> {
  try {
    return await helpdeskLicensed();
  } catch {
    return false;
  }
}

// --- Who sees and manages ------------------------------------------------------------

/**
 * The workspace's own Status page permission (status.read, as /api/status
 * asks it). Everything here shows Status page data, so the desk role alone
 * is never enough: without it the desk shows no services, no pop-ups and no
 * banners, and the person is never sent a status notice.
 */
export function canReadStatus(user: U): Promise<boolean> {
  return userHolds(user, "status.read", { legacyMin: "viewer" });
}

/** status.read, and teams.manage or agents.manage_team in this team (its lead). */
export async function canManageTeamStatus(user: U, teamId: number): Promise<boolean> {
  if (!(await canReadStatus(user))) return false;
  if (await hdCan(user, "teams.manage")) return true;
  return hdCan(user, "agents.manage_team", { teamId });
}

// --- Team settings ------------------------------------------------------------------

interface ServiceRow {
  id: number;
  name: string;
  provider: string;
  status: ServiceStatus;
  status_detail: string;
  status_url: string;
  last_checked_at: string | null;
  last_changed_at: string | null;
}

/** Every Status page service with this team's choice. */
export async function teamStatusSettings(teamId: number): Promise<TeamStatusSettingsRow[]> {
  const rows = await hq<ServiceRow & { popup_level: PopupLevel | null }>(
    `SELECT s.id, s.name, s.provider, s.status, s.status_detail, f.popup_level
       FROM status_services s
       LEFT JOIN hd_team_status_services f ON f.service_id = s.id AND f.team_id = $1
      ORDER BY (f.team_id IS NULL), lower(s.name), s.id`,
    [teamId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    status: r.status,
    detail: r.status_detail,
    followed: r.popup_level !== null,
    popup_level: r.popup_level ?? "degraded",
  }));
}

export interface TeamStatusChange {
  added: string[];
  removed: string[];
  changed: { name: string; from: PopupLevel; to: PopupLevel }[];
}

/** Replace the team's followed services. Answers what changed (for the audit). */
export async function saveTeamStatusServices(
  user: U,
  teamId: number,
  items: { service_id: number; popup_level: PopupLevel }[]
): Promise<TeamStatusChange> {
  const team = await hqOne<{ id: number }>("SELECT id FROM hd_teams WHERE id = $1", [teamId]);
  if (!team) throw new StatusTeamsError("That team does not exist.", 404);
  if (!(await canManageTeamStatus(user, teamId))) throw new StatusTeamsError("You can't change this team's status services.", 403);
  return withTx(async (client) => {
    const services = await hq<{ id: number; name: string }>("SELECT id, name FROM status_services WHERE id = ANY($1)", [items.map((i) => i.service_id)], client);
    const names = new Map(services.map((s) => [s.id, s.name]));
    const missing = items.find((i) => !names.has(i.service_id));
    if (missing) throw new StatusTeamsError("One of those services is no longer on the Status page. Reload and try again.", 409);
    const before = await hq<{ service_id: number; popup_level: PopupLevel; name: string }>(
      `SELECT f.service_id, f.popup_level, s.name FROM hd_team_status_services f JOIN status_services s ON s.id = f.service_id WHERE f.team_id = $1 FOR UPDATE OF f`,
      [teamId],
      client
    );
    const was = new Map(before.map((b) => [b.service_id, b]));
    const out: TeamStatusChange = { added: [], removed: [], changed: [] };
    const keep = new Set(items.map((i) => i.service_id));
    for (const b of before) if (!keep.has(b.service_id)) out.removed.push(b.name);
    if (out.removed.length) {
      await hq("DELETE FROM hd_team_status_services WHERE team_id = $1 AND NOT (service_id = ANY($2))", [teamId, [...keep]], client);
    }
    for (const i of items) {
      const prev = was.get(i.service_id);
      if (!prev) out.added.push(names.get(i.service_id)!);
      else if (prev.popup_level !== i.popup_level) out.changed.push({ name: prev.name, from: prev.popup_level, to: i.popup_level });
      else continue;
      await hq(
        `INSERT INTO hd_team_status_services (team_id, service_id, popup_level, added_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, service_id) DO UPDATE SET popup_level = EXCLUDED.popup_level`,
        [teamId, i.service_id, i.popup_level, user.id],
        client
      );
    }
    return out;
  });
}

// --- The sync (minute tick and desk polls) ----------------------------------------------

interface EpisodeRow {
  id: number;
  service_id: number;
  state: string;
  worst: string;
  detail: string;
  started_at: string;
  ended_at: string | null;
  recovery_told: number;
}

interface AskRow {
  incident_id: number;
  number: number;
  title: string;
  team_id: number | null;
  declared_by: number | null;
  assignee_id: number | null;
}

interface SyncEffects {
  service: { id: number; name: string; status: string };
  episode: EpisodeRow | null;
  /** Teams reached for the first time in this episode, and the teams told before (their people are not told twice). */
  down?: { teams: number[]; before: number[] };
  /** The episode ended for the first time: the teams that were told. */
  recovered?: { teams: number[] };
  /** Incidents whose runners are now asked to solve. */
  asks: AskRow[];
}

export interface SyncOptions {
  /** Only these services (tests). */
  serviceIds?: number[];
  /** Wait for another instance's lock instead of skipping (tests). */
  wait?: boolean;
  origin?: string;
}

/** Test seam: each notice the sync sends (they are still sent). */
let noticeSpy: ((n: { userId: number; title: string; url: string }) => void) | null = null;
export function setStatusNoticeSpyForTests(spy: typeof noticeSpy): void {
  noticeSpy = spy;
}

let lastPrune = 0;

/**
 * Bring the episodes in line with the Status page and tell the agents. Never
 * throws. Answers the number of services that had something to tell.
 */
export async function syncTeamStatus(opts: SyncOptions = {}): Promise<number> {
  try {
    if (!(await licensed())) return 0;
    // Followed services, any with an open episode (unfollowed meanwhile: it still
    // closes), and any with a solve ask still to send.
    const services = await hq<{ id: number }>(
      `SELECT s.id FROM status_services s
        WHERE (EXISTS (SELECT 1 FROM hd_team_status_services f WHERE f.service_id = s.id)
               OR EXISTS (SELECT 1 FROM hd_status_episodes e WHERE e.service_id = s.id AND e.ended_at IS NULL)
               OR EXISTS (SELECT 1 FROM hd_status_incident_watch w WHERE w.service_id = s.id AND w.ask_solve = 1 AND w.asked_at IS NULL))
          AND ($1::int[] IS NULL OR s.id = ANY($1))`,
      [opts.serviceIds ?? null]
    );
    let changed = 0;
    for (const s of services) {
      try {
        const fx = await syncOne(s.id, Boolean(opts.wait));
        if (!fx) continue;
        changed++;
        await tell(fx, opts.origin);
      } catch (e) {
        console.error("[helpdesk] status sync:", e);
      }
    }
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      await hq(`DELETE FROM hd_status_episodes WHERE ended_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
    }
    return changed;
  } catch (e) {
    console.error("[helpdesk] status sync:", e);
    return 0;
  }
}

let lastDeskSync = 0;
let deskSyncOn = true;
let deskSyncRunning: Promise<void> | null = null;
let deskSyncFn: () => Promise<unknown> = () => syncTeamStatus();
/** Test seam: the desk poll's sync off (a test syncs only its own services), on, or replaced. */
export function setDeskSyncForTests(on: boolean | (() => Promise<unknown>)): void {
  deskSyncOn = on !== false;
  deskSyncFn = typeof on === "function" ? on : () => syncTeamStatus();
  lastDeskSync = 0;
}
/**
 * The desk poll's sync: at most every 20 seconds per instance, one at a
 * time, and never awaited by the poll (its deliveries can take a while).
 */
function deskSync(): boolean {
  if (!deskSyncOn || deskSyncRunning || Date.now() - lastDeskSync < 20_000) return false;
  lastDeskSync = Date.now();
  deskSyncRunning = deskSyncFn()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      deskSyncRunning = null;
    });
  return true;
}

/** An open W1 incident mirrored onto this (internal) service: its outage is the incident's own, already known. */
async function mirroredIncidentOpen(serviceId: number, client: HdQueryable): Promise<boolean> {
  return Boolean(
    await hqOne(
      `SELECT 1 FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id
        WHERE i.status_service_id = $1 AND i.status_incident_id IS NOT NULL AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL LIMIT 1`,
      [serviceId],
      client
    )
  );
}

async function syncOne(serviceId: number, wait: boolean): Promise<SyncEffects | null> {
  return withTx(async (client) => {
    if (wait) await client.query("SELECT pg_advisory_xact_lock($1, $2)", [STATUS_TEAMS_LOCK, serviceId]);
    else {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1, $2) AS ok", [STATUS_TEAMS_LOCK, serviceId]);
      if (!lock.rows[0]?.ok) return null;
    }
    const svc = await hqOne<ServiceRow>("SELECT id, name, status, status_detail, last_changed_at FROM status_services WHERE id = $1", [serviceId], client);
    if (!svc) return null;
    const service = { id: svc.id, name: svc.name, status: svc.status };
    const open = await hqOne<EpisodeRow>("SELECT * FROM hd_status_episodes WHERE service_id = $1 AND ended_at IS NULL", [serviceId], client);
    const detail = (svc.status_detail || "").slice(0, 500);

    if (isAffected(svc.status)) {
      let ep: EpisodeRow;
      let changed = false;
      if (open) {
        const worst = troubleRank(svc.status) > troubleRank(open.worst) ? svc.status : open.worst;
        ep = open;
        if (worst !== open.worst || svc.status !== open.state || detail !== open.detail) {
          ep = (await hqOne<EpisodeRow>("UPDATE hd_status_episodes SET state = $2, worst = $3, detail = $4 WHERE id = $1 RETURNING *", [open.id, svc.status, worst, detail], client))!;
          changed = true;
        }
      } else {
        // Back within REOPEN_MINUTES of a recovery: the same spell, so nobody is told twice.
        const recent = await hqOne<EpisodeRow>(
          `SELECT * FROM hd_status_episodes WHERE service_id = $1 AND ended_at > now() - make_interval(mins => $2) ORDER BY ended_at DESC LIMIT 1`,
          [serviceId, REOPEN_MINUTES],
          client
        );
        ep = recent
          ? (await hqOne<EpisodeRow>(
              `UPDATE hd_status_episodes SET ended_at = NULL, state = $2, detail = $3,
                      worst = CASE WHEN $2 = 'outage' THEN 'outage' ELSE worst END
                WHERE id = $1 RETURNING *`,
              [recent.id, svc.status, detail],
              client
            ))!
          : (await hqOne<EpisodeRow>(
              `INSERT INTO hd_status_episodes (service_id, state, worst, detail, started_at)
               VALUES ($1, $2, $2, $3, LEAST(now(), COALESCE($4::timestamptz, now()))) RETURNING *`,
              [serviceId, svc.status, detail, svc.last_changed_at],
              client
            ))!;
        changed = true;
      }
      // Each following team is told once per episode, when the episode reaches its level
      // (also a team that started following, or raised its level, meanwhile). An outage
      // that is a mirrored major incident's own is already known: nobody is told.
      let down: SyncEffects["down"];
      if (!(await mirroredIncidentOpen(serviceId, client))) {
        const follows = await hq<{ team_id: number; popup_level: PopupLevel }>("SELECT team_id, popup_level FROM hd_team_status_services WHERE service_id = $1", [serviceId], client);
        const due = follows.filter((f) => popupApplies(f.popup_level, ep.worst)).map((f) => f.team_id);
        const fresh = due.length
          ? (await hq<{ team_id: number }>(`INSERT INTO hd_status_told (episode_id, team_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING RETURNING team_id`, [ep.id, due], client)).map((r) => r.team_id)
          : [];
        if (fresh.length) {
          const before = (await hq<{ team_id: number }>("SELECT team_id FROM hd_status_told WHERE episode_id = $1 AND NOT (team_id = ANY($2))", [ep.id, fresh], client)).map((r) => r.team_id);
          down = { teams: fresh, before };
        }
      }
      return changed || down ? { service, episode: ep, down, asks: [] } : null;
    }

    let ep: EpisodeRow | null = null;
    let recovered: SyncEffects["recovered"];
    if (open && isRecovered(svc.status)) {
      ep = (await hqOne<EpisodeRow>("UPDATE hd_status_episodes SET ended_at = now(), state = $2, recovery_told = 1 WHERE id = $1 RETURNING *", [open.id, svc.status], client))!;
      // The "back" notice once per episode: a reopened (flapping) one has had it.
      if (!open.recovery_told) {
        recovered = { teams: (await hq<{ team_id: number }>("SELECT team_id FROM hd_status_told WHERE episode_id = $1", [open.id], client)).map((r) => r.team_id) };
      }
    }
    // Solve asks: every watch still waiting, once the service has recovered and no spell is open
    // (closed just now, or recovered while nobody was watching, or watched after it recovered).
    let asks: AskRow[] = [];
    if (isRecovered(svc.status) && (ep || !open)) {
      asks = await hq<AskRow>(
        `UPDATE hd_status_incident_watch w SET asked_at = now()
           FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id
          WHERE w.incident_id = i.id AND w.service_id = $1 AND w.ask_solve = 1 AND w.asked_at IS NULL
            AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL
          RETURNING i.id AS incident_id, t.number, i.title, t.team_id, i.declared_by, t.assignee_id`,
        [serviceId],
        client
      );
    }
    if (!ep && !asks.length) return null;
    return { service, episode: ep, recovered, asks };
  });
}

/** Active people in these teams with a desk role and the Status page permission (each once). */
async function teamAgents(teamIds: number[]): Promise<number[]> {
  if (!teamIds.length) return [];
  const rows = await hq<{ id: number; role: Role }>(
    `SELECT DISTINCT u.id, u.role FROM hd_team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ANY($1) AND u.status = 'active' ORDER BY u.id`,
    [teamIds]
  );
  const out: number[] = [];
  for (const r of rows) if ((await isAgent(r)) && (await canReadStatus(r))) out.push(r.id);
  return out;
}

/** Active desk people who may run major incidents in the team and read the Status page. */
async function canRunIn(userIds: number[], teamId: number | null): Promise<number[]> {
  if (!userIds.length) return [];
  const rows = await hq<{ id: number; role: Role; name: string; username: string }>("SELECT id, role, name, username FROM users WHERE id = ANY($1) AND status = 'active' ORDER BY id", [userIds]);
  const { manageRefusal } = await import("./incidents");
  const out: number[] = [];
  for (const r of rows) {
    if (!(await isAgent(r)) || !(await canReadStatus(r))) continue;
    if ((await manageRefusal(r, teamId)) === null) out.push(r.id);
  }
  return out;
}

/** Who is asked to solve: the declarer and the incident's assignee while they can still run it, else the team's people who can. */
async function askees(a: AskRow): Promise<number[]> {
  const first = await canRunIn([...new Set([a.declared_by, a.assignee_id].filter((x): x is number => x !== null))], a.team_id);
  if (first.length || a.team_id === null) return first;
  const team = (await hq<{ user_id: number }>("SELECT user_id FROM hd_team_members WHERE team_id = $1", [a.team_id])).map((r) => r.user_id);
  return canRunIn(team, a.team_id);
}

async function deliver(userId: number, n: { title: string; body?: string; url: string; teamId?: number | null; ticketNumber?: number | null }, origin?: string): Promise<void> {
  noticeSpy?.({ userId, title: n.title, url: n.url });
  const { deliverAgentNotification } = await import("./notify-prefs");
  await deliverAgentNotification(userId, "service_down", { ...n, origin });
}

/** Deliver to many with bounded concurrency. */
async function deliverAll(userIds: number[], n: Parameters<typeof deliver>[1], origin?: string): Promise<void> {
  for (let i = 0; i < userIds.length; i += DELIVERY_CONCURRENCY) {
    await Promise.all(userIds.slice(i, i + DELIVERY_CONCURRENCY).map((uid) => deliver(uid, n, origin).catch((e) => console.error("[helpdesk] status notice:", e))));
  }
}

async function tell(fx: SyncEffects, origin?: string): Promise<void> {
  const name = fx.service.name;
  if (fx.down && fx.episode) {
    const told = new Set(await teamAgents(fx.down.before));
    const people = (await teamAgents(fx.down.teams)).filter((id) => !told.has(id));
    const first = fx.down.teams.length === 1 ? fx.down.teams[0] : null;
    await deliverAll(people, { title: `${name} ${stateSentence(fx.episode.state)}`, body: fx.episode.detail || "A service your team uses, on the Status page.", url: first ? `/desk?team=${first}` : "/desk", teamId: first }, origin);
  }
  if (fx.recovered?.teams.length) {
    await deliverAll(await teamAgents(fx.recovered.teams), { title: `${name} ${stateSentence(fx.service.status)}`, body: "Back to normal on the Status page.", url: "/desk" }, origin);
  }
  for (const a of fx.asks) {
    const who = await askees(a);
    if (!who.length) {
      // Nobody who can run it now: ask again on a later sync rather than lose the ask.
      await hq("UPDATE hd_status_incident_watch SET asked_at = NULL WHERE incident_id = $1", [a.incident_id]);
      continue;
    }
    await hq("INSERT INTO hd_status_asks (incident_id, user_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING", [a.incident_id, who]);
    await deliverAll(
      who,
      { title: `${name} ${stateSentence(fx.service.status)}`, body: `Solve major incident #${a.number} and its linked tickets? Open it to choose.`, url: `/desk/tickets/${a.number}`, ticketNumber: a.number },
      origin
    );
    const { audit } = await import("../audit");
    await audit({
      actor: { name: "system" },
      action: "helpdesk.team_status.solve_asked",
      targetType: "helpdesk_ticket",
      targetLabel: `#${a.number} ${a.title}`.slice(0, 200),
      details: { incident: a.number, service: name, asked: who.length },
    });
  }
}

/**
 * The people the desk tells about this service change, so the workspace's
 * own service_status bell (lib/status) skips them: one bell per person.
 * "down": the agents of the teams whose pop-up level the state reaches;
 * "up": the agents of the teams told during its latest episode. Empty when
 * the helpdesk isn't licensed. Never throws.
 */
export async function deskStatusRecipients(serviceId: number, kind: "down" | "up", state: string): Promise<Set<number>> {
  try {
    if (!(await licensed())) return new Set();
    if (kind === "down") {
      const follows = await hq<{ team_id: number; popup_level: PopupLevel }>("SELECT team_id, popup_level FROM hd_team_status_services WHERE service_id = $1", [serviceId]);
      return new Set(await teamAgents(follows.filter((f) => popupApplies(f.popup_level, state)).map((f) => f.team_id)));
    }
    const ep = await hqOne<{ id: number; recovery_told: number }>("SELECT id, recovery_told FROM hd_status_episodes WHERE service_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1", [serviceId]);
    if (!ep) return new Set();
    return new Set(await teamAgents((await hq<{ team_id: number }>("SELECT team_id FROM hd_status_told WHERE episode_id = $1", [ep.id])).map((r) => r.team_id)));
  } catch (e) {
    console.error("[helpdesk] status recipients:", e);
    return new Set();
  }
}

// --- The desk's view ---------------------------------------------------------------------

/** Open tickets in the team since `since` whose subject or first message mentions one of the words. */
export async function mentioningTickets(teamId: number, since: string, words: string[], limit = 200): Promise<{ number: number; subject: string; team_id: number | null }[]> {
  if (!words.length) return [];
  const rows = await hq<{ number: number; subject: string; team_id: number | null; body: string | null }>(
    `SELECT t.number, t.subject, t.team_id,
            (SELECT m.body FROM hd_messages m WHERE m.ticket_id = t.id AND m.kind = 'public' ORDER BY m.created_at, m.id LIMIT 1) AS body
       FROM hd_tickets t
      WHERE t.team_id = $1 AND t.created_at >= $2 AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL AND t.deleted_at IS NULL
        AND t.source <> 'workflow' AND t.parent_ticket_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM hd_incident_links l WHERE l.ticket_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM hd_incidents i WHERE i.ticket_id = t.id)
      ORDER BY t.created_at DESC LIMIT 1000`,
    [teamId, since]
  );
  const match = words.join(", ");
  return rows
    .filter((r) => matchesRule(`${r.subject}\n${r.body ?? ""}`, match))
    .slice(0, limit)
    .map((r) => ({ number: r.number, subject: r.subject, team_id: r.team_id }));
}

const mentionCache = new Map<string, { at: number; n: number }>();
async function mentionCount(teamId: number, episode: { id: number; started_at: string }, words: string[]): Promise<number> {
  const key = `${teamId}:${episode.id}`;
  const hit = mentionCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const n = (await mentioningTickets(teamId, episode.started_at, words)).length;
  if (mentionCache.size > 500) mentionCache.clear();
  mentionCache.set(key, { at: Date.now(), n });
  return n;
}

/** May run major incidents in this team (W1's rule, read lazily: incidents pulls in the ticket code). */
async function declareCheck(user: U): Promise<(teamId: number) => Promise<boolean>> {
  const memo = new Map<number, boolean>();
  return async (teamId) => {
    if (!memo.has(teamId)) {
      const { manageRefusal } = await import("./incidents");
      memo.set(teamId, (await manageRefusal(user as Parameters<typeof manageRefusal>[0], teamId)) === null);
    }
    return memo.get(teamId)!;
  };
}

interface FollowRow extends ServiceRow {
  team_id: number;
  team_name: string;
  popup_level: PopupLevel;
}

interface SeenRow {
  episode_id: number;
  shown_at: string | null;
  dismissed_at: string | null;
  recovery_dismissed_at: string | null;
  banner_hidden_until: string | null;
}

/** The open major incident per service, declared from it (the watch) or mirrored onto it by W1. */
async function openIncidentsFor(serviceIds: number[]): Promise<Map<number, StatusIncidentRef>> {
  const out = new Map<number, StatusIncidentRef>();
  if (!serviceIds.length) return out;
  const rows = await hq<{ sid: number; number: number; title: string }>(
    `SELECT DISTINCT ON (x.sid) x.sid, t.number, i.title
       FROM (SELECT w.service_id AS sid, w.incident_id AS iid FROM hd_status_incident_watch w WHERE w.service_id = ANY($1)
             UNION SELECT i.status_service_id, i.id FROM hd_incidents i WHERE i.status_service_id = ANY($1)) x
       JOIN hd_incidents i ON i.id = x.iid
       JOIN hd_tickets t ON t.id = i.ticket_id
      WHERE t.status IN ${OPEN_SQL} AND t.merged_into IS NULL
      ORDER BY x.sid, i.declared_at DESC, i.id DESC`,
    [serviceIds]
  );
  for (const r of rows) out.set(r.sid, { number: r.number, title: r.title });
  return out;
}

/** Everything the desk's pill, pop-ups, queue banners and solve asks show this agent. */
export async function statusForAgent(user: U, opts: { sync?: boolean } = {}): Promise<TeamStatusView> {
  // In the background: the poll answers from what the last sync recorded.
  const syncing = opts.sync !== false && deskSync();
  const [member, viewAll, manageAll, reads] = await Promise.all([memberTeamIds(user.id), hasAgentAll(user), hdCan(user, "teams.manage"), canReadStatus(user)]);
  const teams = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1) ORDER BY position, lower(name), id", [member]);
  if (!reads) {
    // No status.read: the desk shows nothing from the Status page.
    return { now: new Date().toISOString(), checked_at: null, teams: teams.map((t) => ({ id: t.id, name: t.name, can_manage: false })), manage_all: false, services: [], popups: [], banners: [], asks: [] };
  }
  const follows = await hq<FollowRow>(
    `SELECT s.id, s.name, s.provider, s.status, s.status_detail, s.status_url, s.last_checked_at, s.last_changed_at,
            f.team_id, f.popup_level, tm.name AS team_name
       FROM hd_team_status_services f
       JOIN status_services s ON s.id = f.service_id
       JOIN hd_teams tm ON tm.id = f.team_id
      WHERE f.team_id = ANY($1) OR $2::boolean
      ORDER BY lower(s.name), s.id, tm.position, f.team_id`,
    [member, viewAll]
  );
  const mine = follows.filter((f) => member.includes(f.team_id));

  const services = new Map<number, TeamStatusService>();
  let checked: string | null = null;
  for (const f of mine) {
    const s = services.get(f.id);
    if (s) {
      s.team_ids.push(f.team_id);
      continue;
    }
    services.set(f.id, {
      id: f.id,
      name: f.name,
      provider: f.provider,
      status: f.status,
      detail: f.status_detail,
      url: f.status_url,
      changed_at: f.last_changed_at,
      checked_at: f.provider === "manual" ? null : f.last_checked_at,
      team_ids: [f.team_id],
    });
    if (f.provider !== "manual" && f.last_checked_at && (!checked || f.last_checked_at > checked)) checked = f.last_checked_at;
  }

  const serviceIds = [...new Set(follows.map((f) => f.id))];
  const episodes = serviceIds.length
    ? await hq<EpisodeRow>(
        `SELECT * FROM hd_status_episodes WHERE service_id = ANY($1) AND (ended_at IS NULL OR ended_at > now() - make_interval(hours => $2))`,
        [serviceIds, RECOVERY_HOURS]
      )
    : [];
  const seen = new Map<number, SeenRow>();
  if (episodes.length) {
    for (const r of await hq<SeenRow>("SELECT * FROM hd_status_seen WHERE user_id = $1 AND episode_id = ANY($2)", [user.id, episodes.map((e) => e.id)])) seen.set(r.episode_id, r);
  }
  const canDeclare = await declareCheck(user);
  const incidentFor = await openIncidentsFor([...new Set(episodes.map((e) => e.service_id))]);
  const now = Date.now();

  const popups: TeamStatusPopup[] = [];
  const banners: TeamStatusBanner[] = [];
  const shown: number[] = [];
  for (const ep of episodes) {
    const rows = follows.filter((f) => f.id === ep.service_id);
    const svc = rows[0];
    if (!svc) continue;
    const sn = seen.get(ep.id);
    const myRows = rows.filter((r) => member.includes(r.team_id));
    const incident = incidentFor.get(svc.id) ?? null;
    if (!ep.ended_at) {
      // Queue banners: every team this agent may view that follows it, while it is degraded or out.
      if (isAffected(svc.status)) {
        const hidden = sn?.banner_hidden_until && new Date(sn.banner_hidden_until).getTime() > now;
        if (!hidden) {
          for (const r of rows) {
            banners.push({ episode_id: ep.id, team_id: r.team_id, service_id: svc.id, service_name: svc.name, state: svc.status, detail: svc.status_detail, started_at: ep.started_at, can_declare: !incident && (await canDeclare(r.team_id)), incident });
          }
        }
      }
      // Pop-up: once per person per episode, for the first of their teams whose level it reaches.
      const reach = myRows.filter((r) => popupApplies(r.popup_level, ep.worst));
      if (reach.length && !sn?.dismissed_at) {
        let pick = reach[0];
        for (const r of reach) if (await canDeclare(r.team_id)) {
          pick = r;
          break;
        }
        const words = suggestWords(svc.name);
        popups.push({
          kind: "down",
          episode_id: ep.id,
          service_id: svc.id,
          service_name: svc.name,
          state: svc.status,
          detail: svc.status_detail,
          started_at: ep.started_at,
          ended_at: null,
          team_id: pick.team_id,
          team_name: pick.team_name,
          can_declare: !incident && (await canDeclare(pick.team_id)),
          mentions: await mentionCount(pick.team_id, ep, words),
          mention_word: words[0] ?? "",
          incident,
        });
        if (!sn?.shown_at) shown.push(ep.id);
      }
    } else if (sn?.shown_at && !sn.recovery_dismissed_at && myRows.length) {
      // Recovery note: only for those who saw the pop-up.
      popups.push({
        kind: "recovered",
        episode_id: ep.id,
        service_id: svc.id,
        service_name: svc.name,
        state: svc.status,
        detail: "",
        started_at: ep.started_at,
        ended_at: ep.ended_at,
        team_id: myRows[0].team_id,
        team_name: myRows[0].team_name,
        can_declare: false,
        mentions: 0,
        mention_word: "",
        incident: null,
      });
    }
  }
  if (shown.length) {
    await hq(
      `INSERT INTO hd_status_seen (user_id, episode_id, shown_at) SELECT $1, unnest($2::int[]), now()
       ON CONFLICT (user_id, episode_id) DO UPDATE SET shown_at = COALESCE(hd_status_seen.shown_at, now())`,
      [user.id, shown]
    );
  }

  // Solve asks: to the people asked, while they can still run the incident and the service is still recovered.
  const askRows = await hq<TeamStatusAsk>(
    `SELECT w.incident_id, t.number, i.title, s.name AS service_name, s.status AS state, t.team_id,
            (SELECT count(*)::int FROM hd_incident_links l JOIN hd_tickets lt ON lt.id = l.ticket_id
              WHERE l.incident_id = i.id AND lt.status IN ${OPEN_SQL} AND lt.merged_into IS NULL AND lt.deleted_at IS NULL) AS linked_open
       FROM hd_status_asks a
       JOIN hd_status_incident_watch w ON w.incident_id = a.incident_id
       JOIN hd_incidents i ON i.id = w.incident_id
       JOIN hd_tickets t ON t.id = i.ticket_id
       JOIN status_services s ON s.id = w.service_id
      WHERE a.user_id = $1 AND a.dismissed_at IS NULL AND w.ask_solve = 1 AND w.asked_at IS NOT NULL
        AND t.status IN ${OPEN_SQL} AND t.merged_into IS NULL
        AND s.status IN ('operational', 'maintenance')
      ORDER BY w.asked_at DESC LIMIT 5`,
    [user.id]
  );
  const asks: TeamStatusAsk[] = [];
  for (const a of askRows) if (a.team_id !== null && (await canDeclare(a.team_id))) asks.push(a);

  const teamOut: TeamStatusView["teams"] = [];
  for (const t of teams) teamOut.push({ id: t.id, name: t.name, can_manage: manageAll || (await canManageTeamStatus(user, t.id)) });

  return {
    now: new Date().toISOString(),
    checked_at: checked,
    teams: teamOut,
    manage_all: manageAll,
    services: [...services.values()],
    popups,
    banners,
    asks,
    ...(syncing ? { syncing: true } : {}),
  };
}

// --- Per-person marks ---------------------------------------------------------------------


/** Remember a dismissal ("one pop-up per person"), a hidden banner or a "Not now" on a solve ask. */
export async function markSeen(user: U, action: SeenAction, input: { episode_id?: number; incident_id?: number; until?: string }): Promise<void> {
  if (action === "dismiss_ask") {
    const id = Number(input.incident_id);
    if (!Number.isInteger(id)) throw new StatusTeamsError("incident_id is required.");
    const r = await hq("UPDATE hd_status_asks SET dismissed_at = COALESCE(dismissed_at, now()) WHERE incident_id = $1 AND user_id = $2 RETURNING incident_id", [id, user.id]);
    if (!r.length) throw new StatusTeamsError("Not found.", 404);
    return;
  }
  const id = Number(input.episode_id);
  if (!Number.isInteger(id)) throw new StatusTeamsError("episode_id is required.");
  if (!(await hqOne("SELECT 1 FROM hd_status_episodes WHERE id = $1", [id]))) throw new StatusTeamsError("Not found.", 404);
  if (action === "hide_banner") {
    // Until the end of the person's day (sent by the browser), at most a day from now.
    const want = input.until ? new Date(input.until).getTime() : NaN;
    const max = Date.now() + 24 * 3_600_000;
    const until = new Date(Number.isFinite(want) && want > Date.now() ? Math.min(want, max) : max).toISOString();
    await hq(
      `INSERT INTO hd_status_seen (user_id, episode_id, banner_hidden_until) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, episode_id) DO UPDATE SET banner_hidden_until = EXCLUDED.banner_hidden_until`,
      [user.id, id, until]
    );
    return;
  }
  const col = action === "dismiss" ? "dismissed_at" : "recovery_dismissed_at";
  // Dismissing the pop-up also counts as having seen it (the recovery note follows).
  await hq(
    `INSERT INTO hd_status_seen (user_id, episode_id, shown_at, ${col}) VALUES ($1, $2, now(), now())
     ON CONFLICT (user_id, episode_id) DO UPDATE SET ${col} = COALESCE(hd_status_seen.${col}, now()), shown_at = COALESCE(hd_status_seen.shown_at, now())`,
    [user.id, id]
  );
}

// --- Declaring a major incident from a service --------------------------------------------

/** W1's declare dialog, prefilled from the service: title, words, and the team's tickets that mention it since it changed. */
export async function declarePrefill(user: U, serviceId: number, teamId: number): Promise<DeclarePrefill> {
  if (!(await canReadStatus(user))) throw new StatusTeamsError("You can't see the Status page.", 403);
  const svc = await hqOne<ServiceRow>("SELECT * FROM status_services WHERE id = $1", [serviceId]);
  if (!svc) throw new StatusTeamsError("That service is no longer on the Status page.", 404);
  const team = await hqOne<{ id: number }>("SELECT id FROM hd_teams WHERE id = $1", [teamId]);
  if (!team) throw new StatusTeamsError("That team does not exist.", 404);
  const { manageRefusal } = await import("./incidents");
  const why = await manageRefusal(user as Parameters<typeof manageRefusal>[0], teamId);
  if (why) throw new StatusTeamsError(why, 403);
  const ep = await hqOne<EpisodeRow>("SELECT * FROM hd_status_episodes WHERE service_id = $1 ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1", [serviceId]);
  const since = ep && !ep.ended_at ? ep.started_at : svc.last_changed_at ?? new Date(Date.now() - 2 * 3_600_000).toISOString();
  const words = suggestWords(svc.name);
  return {
    service: { id: svc.id, name: svc.name, state: svc.status, detail: svc.status_detail },
    team_id: teamId,
    since,
    title: suggestTitle(svc.name, svc.status),
    words,
    tickets: await mentioningTickets(teamId, since, words),
  };
}

/**
 * Watch a major incident declared from a service, for the solve ask. The
 * service is kept only in hd_status_incident_watch: W1's
 * hd_incidents.status_service_id (its Status page mirror, which needs
 * status.incident_manage) is never written here. Needs W1's
 * incidents.manage in the incident's team and status.read. Decided under
 * the sync's per-service lock, so a recovery can't slip between; when the
 * service has already recovered, the ask goes out at once.
 */
export async function watchIncident(user: U, number: number, serviceId: number, askSolve: boolean, opts: { origin?: string } = {}): Promise<{ incident_id: number; service_name: string }> {
  if (!(await canReadStatus(user))) throw new StatusTeamsError("You can't see the Status page.", 403);
  const inc = await hqOne<{ id: number; team_id: number | null; status: string; merged_into: number | null }>(
    `SELECT i.id, t.team_id, t.status, t.merged_into FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id WHERE t.number = $1`,
    [number]
  );
  if (!inc) throw new StatusTeamsError(`#${number} isn't a major incident.`, 404);
  const { manageRefusal } = await import("./incidents");
  const why = await manageRefusal(user as Parameters<typeof manageRefusal>[0], inc.team_id);
  if (why) throw new StatusTeamsError(why, 403);
  if (!HD_OPEN_STATUSES.includes(inc.status as (typeof HD_OPEN_STATUSES)[number]) || inc.merged_into) throw new StatusTeamsError(`Major incident #${number} is solved.`, 409);
  const svc = await hqOne<{ id: number; name: string }>("SELECT id, name FROM status_services WHERE id = $1", [serviceId]);
  if (!svc) throw new StatusTeamsError("That service is no longer on the Status page.", 404);
  await withTx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [STATUS_TEAMS_LOCK, svc.id]);
    await hq(
      `INSERT INTO hd_status_incident_watch (incident_id, service_id, ask_solve, asked_at, created_by) VALUES ($1, $2, $3, NULL, $4)
       ON CONFLICT (incident_id) DO UPDATE SET service_id = EXCLUDED.service_id, ask_solve = EXCLUDED.ask_solve, asked_at = NULL`,
      [inc.id, svc.id, askSolve ? 1 : 0, user.id],
      client
    );
    await hq("DELETE FROM hd_status_asks WHERE incident_id = $1", [inc.id], client);
  });
  // Already recovered (or recovered meanwhile): the sync asks now; otherwise it asks when the spell ends.
  if (askSolve) await syncTeamStatus({ serviceIds: [svc.id], wait: true, origin: opts.origin });
  return { incident_id: inc.id, service_name: svc.name };
}
