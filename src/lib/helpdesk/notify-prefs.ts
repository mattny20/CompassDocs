// Helpdesk 1.19.0: per-agent notification preferences and the one entry
// point for agent-facing notifications.
//
// `deliverAgentNotification(userId, event, payload)` applies the agent's
// preferences and fans out to the three channels:
//   bell   the existing notifications inbox (lib/db insertNotifications),
//          never held back: it is the record, so nothing is lost;
//   email  lib/helpdesk/email's sendHelpdeskEmail, when the caller passes
//          an email template for the event;
//   push   lib/helpdesk/push, to every browser the agent turned on.
// Pause and quiet hours hold back push and email (urgent tickets and SLA
// breaches break through quiet hours when the agent allows it). Private
// previews keep ticket text out of the push payload. Requester-facing
// notifications stay on lib/helpdesk/notify's own path.
//
// Callers fire and forget (`void deliverAgentNotification(…)`) after their
// transaction commits; nothing here throws. Server-only.

import "server-only";
import { getSetting, insertNotifications } from "../db";
import { hq, hqOne } from "./db-core";
import {
  holdReason,
  isPaused,
  pauseFor,
  prefsPatchProblem,
  resolvePrefs,
  HD_NOTIFY_EVENTS,
  breaksThrough,
  type HdNotifyChannel,
  type HdNotifyEvent,
  type HdNotifyPrefs,
  type HdPauseRequest,
} from "./notify-prefs-shared";
import { deskEvent, effectiveMatrix, enqueueDigest, shouldNotify } from "../notify-policy";
import { countPushDevices, sendPushToUser, type HdPushPayload, type SendResult } from "./push";

export * from "./notify-prefs-shared";

// --- Storage ----------------------------------------------------------------------

async function storedPrefs(userId: number): Promise<Record<string, unknown>> {
  const row = await hqOne<{ prefs: unknown }>("SELECT prefs FROM hd_notify_prefs WHERE user_id = $1", [userId]);
  const v = row?.prefs;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The agent's preferences over the defaults. */
export async function getNotifyPrefs(userId: number): Promise<HdNotifyPrefs> {
  return resolvePrefs(await storedPrefs(userId));
}

/** Thrown for a patch the API should refuse with 400. */
export class NotifyPrefsError extends Error {}

/**
 * Merge a validated patch into the stored preferences and return the
 * result. The matrix is stored sparse: only the cells the agent switched,
 * so a cell they never touched follows the workspace default (the
 * notification policy reads this row). Teams and quiet hours merge field
 * by field. `pause` takes a request ("1h", "tomorrow", "indefinite", "off")
 * that the server turns into an instant in the agent's time zone.
 */
export async function saveNotifyPrefs(userId: number, patch: unknown, now = new Date()): Promise<HdNotifyPrefs> {
  const problem = prefsPatchProblem(patch);
  if (problem) throw new NotifyPrefsError(problem);
  const p = patch as {
    matrix?: Record<string, Record<string, boolean>>;
    teams?: Record<string, boolean>;
    quiet?: Partial<HdNotifyPrefs["quiet"]>;
    preview?: HdNotifyPrefs["preview"];
    sound?: boolean;
    pause?: HdPauseRequest;
    auto_follow?: boolean;
  };
  const raw = await storedPrefs(userId);
  const next: HdNotifyPrefs = resolvePrefs(raw);
  // The explicit cells, kept as stored (validated through resolvePrefs' rules).
  const sparse: Record<string, Record<string, boolean>> = {};
  const storedMatrix = raw.matrix && typeof raw.matrix === "object" ? (raw.matrix as Record<string, unknown>) : {};
  for (const ev of HD_NOTIFY_EVENTS) {
    const row = storedMatrix[ev];
    if (!row || typeof row !== "object") continue;
    for (const [ch, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === "boolean" && (["push", "email", "bell"] as string[]).includes(ch)) (sparse[ev] ??= {})[ch] = v;
    }
  }
  if (p.matrix) {
    for (const [ev, row] of Object.entries(p.matrix)) {
      Object.assign(next.matrix[ev as HdNotifyEvent], row);
      Object.assign((sparse[ev] ??= {}), row);
    }
  }
  if (p.teams) Object.assign(next.teams, p.teams);
  if (p.quiet) Object.assign(next.quiet, p.quiet);
  if (p.preview) next.preview = p.preview;
  if (p.sound !== undefined) next.sound = p.sound;
  if (p.auto_follow !== undefined) next.auto_follow = p.auto_follow;
  if (p.pause) next.pause = pauseFor(p.pause, now, await userTimeZone(userId));
  const resolved = resolvePrefs(next);
  const toStore = { ...resolved, matrix: sparse };
  await hq(
    `INSERT INTO hd_notify_prefs (user_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [userId, JSON.stringify(toStore)]
  );
  return resolved;
}

/** One cell of the matrix as it applies now: on or off, and whether the workspace decides it. */
export interface HdEffectiveCell {
  on: boolean;
  locked: boolean;
}
export type HdEffectiveMatrix = Record<HdNotifyEvent, Record<HdNotifyChannel, HdEffectiveCell>>;

/**
 * The matrix the agent sees: the workspace policy's answer for each desk
 * event and channel (its locks and defaults, then the agent's own
 * switches), ignoring pause and quiet hours, which the page shows apart.
 */
export async function effectiveDeskMatrix(userId: number, prefs?: HdNotifyPrefs): Promise<HdEffectiveMatrix> {
  const mine = prefs ?? (await getNotifyPrefs(userId));
  const out = {} as HdEffectiveMatrix;
  let policy: Awaited<ReturnType<typeof effectiveMatrix>> = {};
  try {
    policy = await effectiveMatrix(userId);
  } catch (e) {
    console.error("helpdesk notify: policy matrix unavailable:", e);
  }
  for (const ev of HD_NOTIFY_EVENTS) {
    const row = policy[deskEvent(ev)];
    out[ev] = {} as Record<HdNotifyChannel, HdEffectiveCell>;
    for (const ch of ["push", "email", "bell"] as const) {
      const cell = row?.[ch];
      out[ev][ch] = cell ? { on: cell.on, locked: cell.locked } : { on: mine.matrix[ev][ch], locked: false };
    }
  }
  return out;
}

/** Everything the Notifications page and its API show. */
export interface HdNotifyView {
  prefs: HdNotifyPrefs;
  effective: HdEffectiveMatrix;
  timezone: string;
  paused_now: boolean;
  teams: { id: number; name: string; on: boolean }[];
  devices: number;
}

export async function notifyView(userId: number, prefs?: HdNotifyPrefs): Promise<HdNotifyView> {
  const p = prefs ?? (await getNotifyPrefs(userId));
  const [effective, timezone, teams, devices] = await Promise.all([
    effectiveDeskMatrix(userId, p),
    userTimeZone(userId),
    listMyTeams(userId),
    countPushDevices(userId),
  ]);
  return {
    prefs: p,
    effective,
    timezone,
    paused_now: isPaused(p, new Date()),
    teams: teams.map((t) => ({ id: t.id, name: t.name, on: p.teams[String(t.id)] !== false })),
    devices,
  };
}

/** The agent's zone (Account → Preferences), else the workspace's, else UTC. */
export async function userTimeZone(userId: number): Promise<string> {
  const valid = (tz: string | undefined | null) => {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  const row = await hqOne<{ timezone: string }>("SELECT timezone FROM users WHERE id = $1", [userId]);
  if (valid(row?.timezone?.trim())) return row!.timezone.trim();
  try {
    const ws = (await getSetting("timezone"))?.trim();
    if (valid(ws)) return ws!;
  } catch {
    /* fall through */
  }
  return "UTC";
}

/** The helpdesk teams the agent belongs to, for the per-team switches. */
export async function listMyTeams(userId: number): Promise<{ id: number; name: string }[]> {
  return hq<{ id: number; name: string }>(
    `SELECT t.id, t.name FROM hd_team_members m JOIN hd_teams t ON t.id = m.team_id
     WHERE m.user_id = $1 ORDER BY t.position NULLS LAST, t.name`,
    [userId]
  );
}

// --- Delivery ---------------------------------------------------------------------

export type HdEmailTemplate =
  | "hd_assigned"
  | "hd_reply"
  | "hd_internal_note"
  | "hd_task_assigned"
  | "hd_approval_needed"
  | "hd_sla_warning"
  | "hd_sla_breach"
  | "hd_request_received"
  | "hd_workflow_notify";

export interface HdAgentNotification {
  ticketNumber?: number | null;
  /** Full title, e.g. "Assigned to you: VPN keeps dropping". */
  title: string;
  body?: string;
  /** An urgent ticket: high push urgency, and it may break through quiet hours. */
  urgent?: boolean;
  /** Same-origin path, e.g. /desk/tickets/1048. */
  url: string;
  /** The ticket's team, for the per-team switch of "New in my teams". */
  teamId?: number | null;
  actorName?: string;
  /** The email for this event; without it the email channel is skipped. */
  email?: { template: HdEmailTemplate; vars: Record<string, string> };
  origin?: string;
}

export interface HdDeliveryResult {
  bell: boolean;
  email: boolean;
  push: SendResult | null;
  /** Why push and email were held back, when they were. */
  held: "paused" | "quiet" | "team_off" | null;
}

/** Bell kinds shared with lib/helpdesk/notify. */
export function bellKind(event: HdNotifyEvent): "hd_ticket" | "hd_sla" | "hd_approval" {
  if (event === "sla_warning" || event === "sla_breach") return "hd_sla";
  if (event === "approval_needed") return "hd_approval";
  return "hd_ticket";
}

const PRIVATE_TITLE: Record<HdNotifyEvent, (n: string) => string> = {
  assigned_to_me: (n) => `Ticket ${n} assigned to you`,
  new_in_my_teams: (n) => `New ticket ${n}`,
  requester_replied: (n) => `New reply on ${n}`,
  mention_or_note: (n) => `New note on ${n}`,
  approval_needed: (n) => `Approval needed for ${n}`,
  task_assigned: (n) => `New workflow task ${n}`,
  workflow_blocked: (n) => `Workflow stopped on ${n}`,
  reopened: (n) => `Ticket ${n} reopened`,
  followed_update: (n) => `Update on ${n}, which you follow`,
  review_requested: (n) => `Reply on ${n} waits for review`,
  review_returned: (n) => `Your reply on ${n} was sent back`,
  sla_warning: (n) => `${n} is close to its SLA target`,
  sla_breach: (n) => `${n} missed its SLA target`,
  service_down: () => "A service your team uses changed",
};

/** A same-origin path, or /desk. */
export function safePath(url: string | undefined): string {
  if (!url || typeof url !== "string") return "/desk";
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\") || /[\u0000-\u001f]/.test(url)) return "/desk";
  return url.slice(0, 300);
}

/** The push payload for an event under the agent's preview and sound choices. */
export function buildPushPayload(event: HdNotifyEvent, n: HdAgentNotification, prefs: Pick<HdNotifyPrefs, "preview" | "sound">, now = Date.now()): HdPushPayload {
  const num = n.ticketNumber ? `#${n.ticketNumber}` : "";
  const priv = prefs.preview === "private";
  return {
    v: 1,
    title: priv ? (num ? PRIVATE_TITLE[event](num) : "New helpdesk activity") : n.title,
    body: priv ? "Open the desk to read it." : (n.body ?? ""),
    tag: n.ticketNumber ? `hd-t${n.ticketNumber}` : `hd-${event}`,
    url: safePath(n.url),
    ticket: n.ticketNumber ?? null,
    silent: !prefs.sound,
    renotify: true,
    ts: now,
  };
}

type EmailSender = (userId: number, template: string, vars: Record<string, string>, origin?: string) => Promise<boolean>;

let emailOverride: EmailSender | null = null;
/** Test seam: replace the email channel's sender. */
export function setAgentEmailSenderForTests(fn: EmailSender | null): void {
  emailOverride = fn;
}

async function emailSender(): Promise<EmailSender | null> {
  if (emailOverride) return emailOverride;
  const mod = (await import("./email")) as unknown as { sendHelpdeskEmail?: EmailSender };
  return typeof mod.sendHelpdeskEmail === "function" ? mod.sendHelpdeskEmail : null;
}

/** One channel's answer: send now, or not (and why). */
export interface HdChannelDecision {
  send: boolean;
  mode: "instant" | "digest_hourly" | "digest_daily";
  reason: string;
}

/**
 * The agent's own answer for one channel: the matrix switch, then (push
 * and email only) pause and quiet hours with the break-through rule. The
 * bell is never held back: it is the record, so nothing is lost.
 */
export function localDecision(
  prefs: HdNotifyPrefs,
  event: HdNotifyEvent,
  channel: HdNotifyChannel,
  urgent: boolean,
  at: Date,
  timeZone: string
): HdChannelDecision {
  if (!prefs.matrix[event][channel]) return { send: false, mode: "instant", reason: "off" };
  if (channel === "bell") return { send: true, mode: "instant", reason: "on" };
  const held = holdReason(prefs, event, urgent, at, timeZone);
  return held ? { send: false, mode: "instant", reason: held } : { send: true, mode: "instant", reason: "on" };
}

/**
 * The one answer per channel: the workspace notification policy
 * (lib/notify-policy shouldNotify), which combines admin locks and defaults
 * with these preferences (the matrix, pause and quiet hours, read from
 * hd_notify_prefs). Break-through is the agent's choice here, so "urgent"
 * reaches the policy only when they allow it (SLA breaches count as urgent
 * then).
 */
async function channelDecision(
  userId: number,
  event: HdNotifyEvent,
  channel: HdNotifyChannel,
  ctx: { urgent: boolean; prefs: HdNotifyPrefs; at: Date; timeZone: string }
): Promise<HdChannelDecision> {
  const urgent = ctx.prefs.quiet.breakthrough && breaksThrough(event, ctx.urgent);
  const d = await shouldNotify(userId, deskEvent(event), channel, { urgent, now: ctx.at });
  const reason = d.reason === "quiet_hours" ? "quiet" : d.reason;
  return { send: d.send, mode: d.mode, reason };
}

/**
 * The desk's event key for a name in either spelling: the desk's own
 * ("workflow_blocked") or the notification catalog's ("desk_workflow_blocked",
 * "hd_approval_needed"). Null for anything else.
 */
export function agentEventName(name: string): HdNotifyEvent | null {
  const key = name === "hd_approval_needed" ? "approval_needed" : name.startsWith("desk_") ? name.slice(5) : name;
  return (HD_NOTIFY_EVENTS as readonly string[]).includes(key) ? (key as HdNotifyEvent) : null;
}

/**
 * Notify one agent about one event, honouring their preferences. Never
 * throws; returns what went out on each channel.
 */
export async function deliverAgentNotification(
  userId: number,
  eventName: HdNotifyEvent | `desk_${HdNotifyEvent}` | "hd_approval_needed",
  n: HdAgentNotification,
  now = new Date()
): Promise<HdDeliveryResult> {
  const out: HdDeliveryResult = { bell: false, email: false, push: null, held: null };
  const event = agentEventName(eventName);
  if (!event) return out;
  let prefs: HdNotifyPrefs;
  let tz = "UTC";
  try {
    [prefs, tz] = await Promise.all([getNotifyPrefs(userId), userTimeZone(userId)]);
  } catch (e) {
    console.error("helpdesk notify: prefs lookup failed:", e);
    prefs = resolvePrefs(null);
  }
  if (event === "new_in_my_teams" && n.teamId != null && prefs.teams[String(n.teamId)] === false) {
    out.held = "team_off";
    return out;
  }
  const urgent = Boolean(n.urgent);
  const ctx = { urgent, prefs, at: now, timeZone: tz };
  const [bell, email, push] = await Promise.all(
    (["bell", "email", "push"] as const).map((ch) =>
      channelDecision(userId, event, ch, ctx).catch((e): HdChannelDecision => {
        console.error("helpdesk notify: policy lookup failed:", e);
        return localDecision(prefs, event, ch, urgent, now, tz);
      })
    )
  );
  for (const d of [email, push]) {
    if (!d.send && (d.reason === "paused" || d.reason === "quiet")) out.held = d.reason;
  }

  if (bell.send) {
    try {
      await insertNotifications([userId], {
        kind: bellKind(event),
        title: n.title,
        body: n.body,
        link: safePath(n.url),
        actor_name: n.actorName,
      });
      out.bell = true;
    } catch (e) {
      console.error("helpdesk notify: bell failed:", e);
    }
  }

  const jobs: Promise<void>[] = [];
  // A digest mode (the agent's or the workspace's choice, or quiet hours)
  // queues the email for the hourly or daily summary instead.
  if (email.send && email.mode !== "instant" && n.email) {
    jobs.push(
      enqueueDigest(userId, deskEvent(event), email.mode, { title: n.title, body: n.body, link: safePath(n.url) })
        .then(() => {
          out.email = true;
        })
        .catch((e) => console.error("helpdesk notify: digest queue failed:", e))
    );
  } else if (email.send && n.email) {
    jobs.push(
      (async () => {
        try {
          const send = await emailSender();
          if (send) out.email = await send(userId, n.email!.template, n.email!.vars, n.origin);
        } catch (e) {
          console.error("helpdesk notify: email failed:", e);
        }
      })()
    );
  }
  if (push.send && push.mode === "instant") {
    jobs.push(
      (async () => {
        try {
          const high = urgent || event === "sla_breach";
          out.push = await sendPushToUser(userId, buildPushPayload(event, n, prefs, now.getTime()), {
            urgency: high ? "high" : "normal",
            ttl: high ? 6 * 3600 : 24 * 3600,
            topic: n.ticketNumber ? `t${n.ticketNumber}` : undefined,
          });
        } catch (e) {
          console.error("helpdesk notify: push failed:", e);
        }
      })()
    );
  }
  await Promise.all(jobs);
  return out;
}
