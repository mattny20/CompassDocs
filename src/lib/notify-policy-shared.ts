// Notification policy and personal preferences (1.19.0), as data and pure
// functions. The admin Policies page, Account → Notifications (clients) and
// lib/notify-policy (server) share this module, so the matrix a person sees
// and the rule the server applies cannot drift. No server imports here.
//
// Three layers decide whether one notice reaches one person on one channel:
//   1. the catalog: every event the product sends, its channels, defaults
//      and whether its email may wait in a digest;
//   2. the workspace policy (settings key `notification_policy`): per event
//      and channel, the default and who decides (Locked on / Locked off /
//      Person chooses), and the email delivery mode;
//   3. the person's choices (user_notify_prefs.prefs): channel switches,
//      a digest frequency per section, quiet hours and a pause. A person
//      with no row yet is read from the pre-1.19 columns on users
//      (notify_prefs, email_notifications, weekly_digest) through
//      prefsFromLegacy, so nobody's mail changes until they change it.
// decide() combines them. Both stored shapes are sparse: only what differs
// from the layer below is kept, so an event added later reaches everyone
// with its default.

import {
  AGENT_NOTIFY_EVENTS as HD_NOTIFY_EVENTS,
  HD_NOTIFY_EVENT_INFO,
  inQuietHours,
  pauseFor as deskPauseFor,
  type HdNotifyEvent,
} from "./helpdesk/notify-prefs-shared";

// --- Vocabulary --------------------------------------------------------------------

export const NOTIFY_CHANNELS = ["bell", "email", "push", "webhook"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const NOTIFY_CHANNEL_LABEL: Record<NotifyChannel, string> = {
  bell: "Bell",
  email: "Email",
  push: "Push",
  webhook: "Chat",
};

export const NOTIFY_CHANNEL_HINT: Record<NotifyChannel, string> = {
  bell: "The bell inbox in CompassDocs",
  email: "Email to the address on the account",
  push: "Browser push from the desk (helpdesk agents and approvers)",
  webhook: "The personal Slack or Teams webhook on Account → Notifications",
};

export const NOTIFY_MODES = ["instant", "digest_hourly", "digest_daily"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

export const NOTIFY_MODE_LABEL: Record<NotifyMode, string> = {
  instant: "Instant",
  digest_hourly: "Hourly digest",
  digest_daily: "Daily digest",
};

/** Who decides one event's channel: the person, or the workspace for everyone. */
export const NOTIFY_CONTROLS = ["choose", "locked_on", "locked_off"] as const;
export type NotifyControl = (typeof NOTIFY_CONTROLS)[number];

export const NOTIFY_CONTROL_LABEL: Record<NotifyControl, string> = {
  choose: "Person chooses",
  locked_on: "Locked on",
  locked_off: "Locked off",
};

export const NOTIFY_SECTIONS = [
  "read_confirmations",
  "documents",
  "helpdesk",
  "approvals",
  "desk",
  "training",
  "newsletter",
  "security",
] as const;
export type NotifySection = (typeof NOTIFY_SECTIONS)[number];

/** The licence a section needs; unlicensed sections are left off both pages. */
export type NotifyFeature = "policy_ack" | "training" | "helpdesk";

export interface NotifySectionInfo {
  label: string;
  description: string;
  feature?: NotifyFeature;
  /** Shown on the personal page (the desk's own events live on the desk's page). */
  personal: boolean;
}

export const NOTIFY_SECTION_INFO: Record<NotifySection, NotifySectionInfo> = {
  read_confirmations: {
    label: "Read confirmations",
    description: "Policies you're asked to read and confirm, their reminders and escalations.",
    feature: "policy_ack",
    personal: true,
  },
  documents: {
    label: "Documents and comments",
    description: "Mentions, comments, subscribed spaces, reviews and change requests.",
    personal: true,
  },
  helpdesk: {
    label: "Helpdesk requests",
    description: "Requests you raised through Get help.",
    feature: "helpdesk",
    personal: true,
  },
  approvals: {
    label: "Approvals",
    description: "Requests waiting for your approval, and decisions on yours.",
    feature: "helpdesk",
    personal: true,
  },
  desk: {
    label: "Helpdesk (agents)",
    description: "Agents' notices in the desk. Agents choose theirs on the desk's Notifications page.",
    feature: "helpdesk",
    personal: false,
  },
  training: {
    label: "Training",
    description: "Training assigned to you, due dates and the team digest for leads.",
    feature: "training",
    personal: true,
  },
  newsletter: {
    label: "Newsletter and announcements",
    description: "Newsletters, announcements sent by email and newsletter reviews.",
    personal: true,
  },
  security: {
    label: "Security",
    description: "Mail about your account's security. Always sent.",
    personal: true,
  },
};

// --- The catalog -------------------------------------------------------------------

export interface NotifyEventDef {
  id: string;
  section: NotifySection;
  label: string;
  hint: string;
  /** The channels this event can use, each with its out-of-the-box default. */
  channels: Partial<Record<NotifyChannel, boolean>>;
  /** Its email may wait in an hourly or daily digest. */
  digest: boolean;
  /** Always sent on every channel it has; never locked off, paused or held. */
  security?: boolean;
  /**
   * Compliance evidence (read confirmations): the email records that the
   * person was told, so quiet hours never hold it back (a held mail would
   * never be retried). A pause still applies; the bell is the record then.
   */
  evidence?: boolean;
  /** Who receives it, for the admin page ("Agents", "Group leads"). */
  audience?: string;
  /** Email templates this event sends (Settings → Email templates). */
  templates?: string[];
}

const BWE = { bell: true, webhook: true, email: true } as const;
const BW = { bell: true, webhook: true } as const;

/** The requester-side helpdesk events (agent C's REQUESTER_NOTIFY_EVENTS). */
export const HD_REQUESTER_EVENTS = [
  "hd_request_received",
  "hd_desk_replied",
  "hd_waiting_on_you",
  "hd_solved",
  "hd_workflow_message",
  "hd_merged",
  "hd_incident_update",
] as const;

/** The catalog id of one of the desk's agent events (agent F's names). */
export function deskEvent(ev: HdNotifyEvent | string): string {
  return ev === "approval_needed" ? "hd_approval_needed" : `desk_${ev}`;
}

/**
 * Desk events the catalog lists even before the desk's own module names
 * them (agent J's reply reviews for newer agents, sent through F's
 * deliverAgentNotification). Once HD_NOTIFY_EVENT_INFO has an entry, its
 * label and defaults win.
 */
const DESK_EXTRA: Record<string, { label: string; hint: string; email: boolean; defaults: { push: boolean; email: boolean; bell: boolean } }> = {
  review_requested: {
    label: "Reply waiting for review",
    hint: "A newbie's reply in your team needs your review",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  review_returned: {
    label: "Reply returned",
    hint: "A reviewer sent your reply back with a note",
    email: true,
    defaults: { push: true, email: false, bell: true },
  },
  workflow_blocked: {
    label: "Workflow stopped",
    hint: "A team couldn't do its task, so the request came back to your team",
    email: true,
    defaults: { push: true, email: true, bell: true },
  },
};

const DESK_TEMPLATES: Record<string, string[]> = {
  assigned_to_me: ["hd_assigned"],
  requester_replied: ["hd_reply"],
  reopened: ["hd_reply"],
  followed_update: ["hd_reply", "hd_internal_note"],
  mention_or_note: ["hd_internal_note", "hd_workflow_notify"],
  task_assigned: ["hd_task_assigned"],
  sla_warning: ["hd_sla_warning"],
  sla_breach: ["hd_sla_breach"],
};

const DESK_NAMES: string[] = [
  ...HD_NOTIFY_EVENTS.filter((e) => e !== "approval_needed"),
  ...Object.keys(DESK_EXTRA).filter((e) => !(HD_NOTIFY_EVENTS as readonly string[]).includes(e)),
];

const DESK_EVENTS: NotifyEventDef[] = DESK_NAMES.map((e) => {
  const info = (HD_NOTIFY_EVENT_INFO as Record<string, (typeof DESK_EXTRA)[string]>)[e] ?? DESK_EXTRA[e];
  // No webhook: desk notices go to the bell, email and Web Push only (the
  // personal chat webhook is notify()'s, which the desk doesn't use).
  const channels: Partial<Record<NotifyChannel, boolean>> = { bell: info.defaults.bell, push: info.defaults.push };
  if (info.email) channels.email = info.defaults.email;
  return {
    id: deskEvent(e),
    section: "desk" as const,
    label: info.label,
    // The desk's own page says "(choose the teams below)"; that belongs there.
    hint: info.hint.replace(/\s*\([^)]*\)$/, ""),
    channels,
    digest: info.email && e !== "sla_breach",
    audience: "Agents",
    templates: DESK_TEMPLATES[e],
  };
});

export const NOTIFY_EVENTS: readonly NotifyEventDef[] = [
  // Read confirmations
  { id: "ack_requested", section: "read_confirmations", label: "Read confirmation requests", hint: "You're asked to read and confirm a policy", channels: BWE, digest: false, evidence: true, templates: ["ack_request", "ack_welcome"] },
  { id: "ack_due", section: "read_confirmations", label: "Policy reminders", hint: "A policy you must confirm is due soon or overdue", channels: BWE, digest: false, evidence: true, templates: ["ack_due", "ack_due_bundle"] },
  { id: "ack_escalation", section: "read_confirmations", label: "Compliance escalations", hint: "People you own or lead are overdue on a policy", channels: BWE, digest: false, evidence: true, audience: "Owners and leads", templates: ["ack_escalation"] },
  // Documents and comments
  { id: "mention", section: "documents", label: "Mentions", hint: "Someone @mentions you in a comment", channels: BWE, digest: true, templates: ["mention"] },
  { id: "comment", section: "documents", label: "Comment replies", hint: "New comments on threads you're in", channels: BW, digest: false },
  { id: "doc_update", section: "documents", label: "Subscribed spaces", hint: "A document in a space you follow is published or updated", channels: BWE, digest: true, templates: ["doc_update"] },
  { id: "cr_submitted", section: "documents", label: "Change requests", hint: "A change request arrives for your review", channels: BW, digest: false, audience: "Approvers" },
  { id: "cr_resolved", section: "documents", label: "Review decisions", hint: "Your change request is approved or rejected", channels: BW, digest: false },
  { id: "review_due", section: "documents", label: "Review reminders", hint: "A document you steward is due for review", channels: BWE, digest: true, audience: "Approvers", templates: ["review_due"] },
  { id: "weekly_digest", section: "documents", label: "Weekly digest", hint: "A Monday summary of your subscribed spaces, reviews and the most-read documents", channels: { email: false }, digest: false },
  { id: "service_status", section: "documents", label: "Service status", hint: "A tracked SaaS tool goes down or recovers", channels: BW, digest: false },
  // Helpdesk requests (requester side)
  { id: "hd_request_received", section: "helpdesk", label: "Request received", hint: "The desk has your new request", channels: BWE, digest: true, templates: ["hd_request_received"] },
  { id: "hd_desk_replied", section: "helpdesk", label: "Reply from the desk", hint: "An agent answers on your request", channels: BWE, digest: true, templates: ["hd_reply"] },
  { id: "hd_waiting_on_you", section: "helpdesk", label: "Waiting on you", hint: "The desk needs something from you to carry on", channels: BWE, digest: true, templates: ["hd_reply"] },
  { id: "hd_solved", section: "helpdesk", label: "Solved and satisfaction", hint: "Your request is solved, with the one-question survey", channels: BWE, digest: true, templates: ["hd_solved_csat"] },
  { id: "hd_cc_added", section: "helpdesk", label: "Copied on a request", hint: "Someone adds you as CC on a request", channels: BW, digest: false },
  { id: "hd_workflow_message", section: "helpdesk", label: "Workflow messages", hint: "A step in your request's workflow sends you a message", channels: BWE, digest: true, templates: ["hd_workflow_notify"] },
  { id: "hd_merged", section: "helpdesk", label: "Requests joined", hint: "The desk joins your request with another one about the same thing", channels: BWE, digest: true, templates: ["hd_merged"] },
  // 1.19.2 (agent W1, lib/helpdesk/incidents): an outage's updates are urgent, so never held for a digest.
  { id: "hd_incident_update", section: "helpdesk", label: "Major incident updates", hint: "The desk posts an update on an outage your request is part of, or that you said affects you", channels: { bell: true, email: true }, digest: false, templates: ["hd_incident_update"] },
  // Approvals
  { id: "hd_approval_needed", section: "approvals", label: "Approval needed", hint: "A request waits for your approval, and its reminders", channels: { ...BWE, push: true }, digest: true, audience: "Approvers", templates: ["hd_approval_needed"] },
  { id: "hd_approval_decided", section: "approvals", label: "Approval decided", hint: "Your request is approved or declined", channels: BWE, digest: true, templates: ["hd_approval_decided"] },
  // The desk (agent side)
  ...DESK_EVENTS,
  { id: "hd_report_digest", section: "desk", label: "Report digests", hint: "A scheduled summary of a desk dashboard you're on the schedule for", channels: { email: true }, digest: false, audience: "People on a report schedule", templates: ["hd_report_digest"] },
  // 1.19.2 (agent W5, lib/helpdesk/import-check): a background dry run or rescan finished.
  { id: "hd_import_ready", section: "desk", label: "Import checks", hint: "A dry run of a ticket import you started is ready, or stopped", channels: { bell: true }, digest: false, audience: "Helpdesk admins" },
  // Training
  { id: "training_assigned", section: "training", label: "Training assigned", hint: "A training deck is assigned to you", channels: BWE, digest: true, templates: ["training_assigned"] },
  { id: "training_due", section: "training", label: "Training due", hint: "An assigned training is due soon or overdue, and manager reminders", channels: BWE, digest: true, templates: ["training_due"] },
  { id: "training_team_digest", section: "training", label: "Team digest", hint: "The weekly training and policy summary for group leads", channels: { email: true }, digest: false, audience: "Group leads", templates: ["training_team_digest"] },
  // Newsletter and announcements
  { id: "newsletter", section: "newsletter", label: "Newsletters", hint: "The workspace newsletter", channels: { email: true }, digest: false },
  { id: "announcement", section: "newsletter", label: "Announcements by email", hint: "An announcement its author also sent by email", channels: { email: true }, digest: false, templates: ["announcement"] },
  { id: "newsletter_review", section: "newsletter", label: "Newsletter reviews", hint: "A newsletter waits for your review, or yours was decided", channels: { email: true }, digest: false, audience: "Newsletter editors" },
  // Security
  { id: "security_password", section: "security", label: "Password and two-factor changes", hint: "Your password or two-factor setup changes, or a reset is requested", channels: { email: true }, digest: false, security: true },
  { id: "security_sign_in", section: "security", label: "New sign-in alerts", hint: "Your account signs in from a new device", channels: { email: true }, digest: false, security: true },
];

const BY_ID = new Map(NOTIFY_EVENTS.map((e) => [e.id, e]));

/**
 * The helpdesk's bell kinds are coarser than its events (agent C writes
 * kind "hd_request" with event "hd_desk_replied"). A bell sent with only
 * the kind is decided as the kind's most common event.
 */
export const BELL_KIND_EVENT: Record<string, string> = {
  hd_request: "hd_desk_replied",
  hd_ticket: "desk_assigned_to_me",
  hd_approval: "hd_approval_needed",
  hd_sla: "desk_sla_breach",
};

/** The catalog event a bell kind stands for when no finer event is given. */
export function eventForKind(kind: string): string {
  return BELL_KIND_EVENT[kind] ?? kind;
}

export function notifyEvent(id: string): NotifyEventDef | undefined {
  return BY_ID.get(id);
}

export function eventsInSection(section: NotifySection): NotifyEventDef[] {
  return NOTIFY_EVENTS.filter((e) => e.section === section);
}

/**
 * The bell kinds and event ids before 1.19.0 were the same strings; these
 * are the ones users.notify_prefs may hold. The email column of a kind
 * counted only where the sender read it (EMAIL_FROM_PREFS).
 */
export const LEGACY_KINDS = [
  "mention",
  "comment",
  "doc_update",
  "cr_submitted",
  "cr_resolved",
  "review_due",
  "ack_requested",
  "ack_due",
  "ack_escalation",
  "training_assigned",
  "training_due",
  "service_status",
] as const;
const EMAIL_FROM_PREFS = new Set(["review_due", "ack_requested", "ack_due", "ack_escalation", "training_assigned", "training_due"]);
/** Emails that followed the master switch "Email me about my subscriptions" (users.email_notifications). */
const EMAIL_FROM_MASTER = new Set(["mention", "doc_update"]);

// --- Stored shapes -----------------------------------------------------------------

export interface PolicyCell {
  default?: boolean;
  control?: NotifyControl;
}

export interface PolicyEvent {
  channels?: Partial<Record<NotifyChannel, PolicyCell>>;
  /** The email delivery mode (events whose email may wait in a digest). */
  mode?: NotifyMode;
  /** "locked": everyone gets `mode`; "choose": the person's section frequency wins. */
  mode_control?: "choose" | "locked";
}

export interface NotifyPolicy {
  v: 1;
  events: Record<string, PolicyEvent>;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", 24-hour, in the person's time zone. */
  start: string;
  end: string;
  /** Days the quiet window starts on: 0 Sunday … 6 Saturday. */
  days: number[];
}

export interface UserNotifyPrefs {
  v: 1;
  /** Explicit channel choices; a missing one follows the workspace default. */
  channels: Record<string, Partial<Record<NotifyChannel, boolean>>>;
  /** The email frequency per section; a missing one follows the workspace. */
  digest: Partial<Record<NotifySection, NotifyMode>>;
  quiet: QuietHours;
  /** Everything except security paused: `until` an instant, or null for "until I resume". */
  pause: { until: string | null } | null;
}

export type PausePreset = "1h" | "tomorrow" | "week" | "indefinite" | "off";

export const PAUSE_PRESET_LABEL: Record<Exclude<PausePreset, "off">, string> = {
  "1h": "For 1 hour",
  tomorrow: "Until tomorrow",
  week: "For a week",
  indefinite: "Until I resume",
};

export const DEFAULT_QUIET: QuietHours = { enabled: false, start: "18:00", end: "08:00", days: [0, 1, 2, 3, 4, 5, 6] };

export function emptyPolicy(): NotifyPolicy {
  return { v: 1, events: {} };
}

export function emptyPrefs(): UserNotifyPrefs {
  return { v: 1, channels: {}, digest: {}, quiet: { ...DEFAULT_QUIET, days: [...DEFAULT_QUIET.days] }, pause: null };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isChannel = (c: string): c is NotifyChannel => (NOTIFY_CHANNELS as readonly string[]).includes(c);
const isMode = (m: unknown): m is NotifyMode => typeof m === "string" && (NOTIFY_MODES as readonly string[]).includes(m);
const isSection = (s: string): s is NotifySection => (NOTIFY_SECTIONS as readonly string[]).includes(s);

/** Read a stored policy, dropping anything unknown or malformed. Never throws. */
export function resolvePolicy(stored: unknown): NotifyPolicy {
  const out = emptyPolicy();
  if (!isObj(stored) || !isObj(stored.events)) return out;
  for (const [id, raw] of Object.entries(stored.events)) {
    const def = BY_ID.get(id);
    if (!def || def.security || !isObj(raw)) continue;
    const ev: PolicyEvent = {};
    if (isObj(raw.channels)) {
      for (const [ch, cell] of Object.entries(raw.channels)) {
        if (!isChannel(ch) || def.channels[ch] === undefined || !isObj(cell)) continue;
        const c: PolicyCell = {};
        if (typeof cell.default === "boolean") c.default = cell.default;
        if (typeof cell.control === "string" && (NOTIFY_CONTROLS as readonly string[]).includes(cell.control)) c.control = cell.control as NotifyControl;
        if (c.default !== undefined || c.control !== undefined) (ev.channels ??= {})[ch] = c;
      }
    }
    if (def.digest && isMode(raw.mode)) ev.mode = raw.mode;
    if (def.digest && (raw.mode_control === "locked" || raw.mode_control === "choose")) ev.mode_control = raw.mode_control;
    if (ev.channels || ev.mode || ev.mode_control) out.events[id] = ev;
  }
  return out;
}

/** Check a submitted policy strictly. Returns the problem sentence, or null. */
export function policyProblem(raw: unknown): string | null {
  if (!isObj(raw)) return "Send the policy as an object.";
  if (raw.events === undefined) return null;
  if (!isObj(raw.events)) return "The policy's events must be an object.";
  const entries = Object.entries(raw.events);
  if (entries.length > 200) return "Too many events.";
  for (const [id, ev] of entries) {
    const def = BY_ID.get(id);
    if (!def) return `Unknown event "${id.slice(0, 40)}".`;
    if (!isObj(ev)) return "Each event needs an object.";
    for (const k of Object.keys(ev)) if (!["channels", "mode", "mode_control"].includes(k)) return `Unknown field "${k.slice(0, 40)}".`;
    if (def.security && Object.keys(ev).length > 0) return `${def.label} is always sent; it can't be changed.`;
    if (ev.channels !== undefined) {
      if (!isObj(ev.channels)) return "Channels must be an object.";
      for (const [ch, cell] of Object.entries(ev.channels)) {
        if (!isChannel(ch)) return `Unknown channel "${ch.slice(0, 40)}".`;
        if (def.channels[ch] === undefined) return `${def.label} isn't sent by ${NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}.`;
        if (!isObj(cell)) return "Each channel needs an object.";
        for (const k of Object.keys(cell)) if (k !== "default" && k !== "control") return `Unknown field "${k.slice(0, 40)}".`;
        if (cell.default !== undefined && typeof cell.default !== "boolean") return "A channel's default is on or off.";
        if (cell.control !== undefined && !(NOTIFY_CONTROLS as readonly string[]).includes(cell.control as string)) {
          return "Who decides is Person chooses, Locked on or Locked off.";
        }
      }
    }
    if (ev.mode !== undefined) {
      if (!def.digest) return `${def.label} is always sent at once.`;
      if (!isMode(ev.mode)) return "Delivery is instant, an hourly digest or a daily digest.";
    }
    if (ev.mode_control !== undefined && ev.mode_control !== "choose" && ev.mode_control !== "locked") return "Delivery is locked or the person's choice.";
  }
  return null;
}

/** Drop what equals the catalog's defaults, so the stored policy stays sparse. */
export function compactPolicy(p: NotifyPolicy): NotifyPolicy {
  const out = emptyPolicy();
  for (const [id, ev] of Object.entries(resolvePolicy(p).events)) {
    const def = BY_ID.get(id)!;
    const keep: PolicyEvent = {};
    for (const [ch, cell] of Object.entries(ev.channels ?? {}) as [NotifyChannel, PolicyCell][]) {
      const c: PolicyCell = {};
      if (cell.default !== undefined && cell.default !== def.channels[ch]) c.default = cell.default;
      if (cell.control && cell.control !== "choose") c.control = cell.control;
      if (c.default !== undefined || c.control) (keep.channels ??= {})[ch] = c;
    }
    if (ev.mode && ev.mode !== "instant") keep.mode = ev.mode;
    if (ev.mode_control === "locked") keep.mode_control = "locked";
    if (keep.channels || keep.mode || keep.mode_control) out.events[id] = keep;
  }
  return out;
}

/** Read stored (or submitted) personal prefs, dropping anything unknown. Never throws. */
export function resolveUserPrefs(stored: unknown): UserNotifyPrefs {
  const out = emptyPrefs();
  if (!isObj(stored)) return out;
  if (isObj(stored.channels)) {
    for (const [id, row] of Object.entries(stored.channels)) {
      const def = BY_ID.get(id);
      if (!def || def.security || !isObj(row)) continue;
      for (const [ch, v] of Object.entries(row)) {
        if (isChannel(ch) && def.channels[ch] !== undefined && typeof v === "boolean") (out.channels[id] ??= {})[ch] = v;
      }
    }
  }
  if (isObj(stored.digest)) {
    for (const [s, m] of Object.entries(stored.digest)) if (isSection(s) && isMode(m)) out.digest[s] = m;
  }
  if (isObj(stored.quiet)) {
    const q = stored.quiet;
    if (typeof q.enabled === "boolean") out.quiet.enabled = q.enabled;
    if (typeof q.start === "string" && TIME_RE.test(q.start)) out.quiet.start = q.start;
    if (typeof q.end === "string" && TIME_RE.test(q.end)) out.quiet.end = q.end;
    if (Array.isArray(q.days)) out.quiet.days = [...new Set(q.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  }
  if (isObj(stored.pause)) {
    const u = stored.pause.until;
    if (u === null) out.pause = { until: null };
    else if (typeof u === "string" && !Number.isNaN(Date.parse(u))) out.pause = { until: new Date(u).toISOString() };
  }
  return out;
}

/** Check a submitted personal prefs object strictly. Returns the problem sentence, or null. */
export function userPrefsProblem(raw: unknown): string | null {
  if (!isObj(raw)) return "Send your preferences as an object.";
  for (const k of Object.keys(raw)) if (!["v", "channels", "digest", "quiet", "pause"].includes(k)) return `Unknown preference "${k.slice(0, 40)}".`;
  if (raw.channels !== undefined) {
    if (!isObj(raw.channels)) return "Channels must be an object.";
    if (Object.keys(raw.channels).length > 200) return "Too many events.";
    for (const [id, row] of Object.entries(raw.channels)) {
      const def = BY_ID.get(id);
      if (!def) return `Unknown event "${id.slice(0, 40)}".`;
      if (!isObj(row)) return "Each event needs an object of channels.";
      for (const [ch, v] of Object.entries(row)) {
        if (!isChannel(ch)) return `Unknown channel "${ch.slice(0, 40)}".`;
        if (def.channels[ch] === undefined) return `${def.label} isn't sent by ${NOTIFY_CHANNEL_LABEL[ch].toLowerCase()}.`;
        if (typeof v !== "boolean") return "Channel switches are on or off.";
        if (def.security && v === false) return `${def.label} is always sent.`;
      }
    }
  }
  if (raw.digest !== undefined) {
    if (!isObj(raw.digest)) return "Digest frequency must be an object of sections.";
    for (const [s, m] of Object.entries(raw.digest)) {
      if (!isSection(s)) return `Unknown section "${s.slice(0, 40)}".`;
      if (!isMode(m)) return "Frequency is instant, hourly or daily.";
    }
  }
  if (raw.quiet !== undefined) {
    if (!isObj(raw.quiet)) return "Quiet hours must be an object.";
    const q = raw.quiet;
    for (const k of Object.keys(q)) if (!["enabled", "start", "end", "days"].includes(k)) return `Unknown quiet-hours field "${k.slice(0, 40)}".`;
    if (q.enabled !== undefined && typeof q.enabled !== "boolean") return "Quiet hours are on or off.";
    if (q.start !== undefined && (typeof q.start !== "string" || !TIME_RE.test(q.start))) return "Start quiet hours at a time like 18:00.";
    if (q.end !== undefined && (typeof q.end !== "string" || !TIME_RE.test(q.end))) return "End quiet hours at a time like 08:00.";
    if (q.days !== undefined && (!Array.isArray(q.days) || q.days.length > 7 || !q.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
      return "Quiet days are numbers from 0 (Sunday) to 6 (Saturday).";
    }
  }
  if (raw.pause !== undefined && raw.pause !== null) {
    if (!isObj(raw.pause)) return "A pause has an end time, or none.";
    const u = raw.pause.until;
    if (u !== null && (typeof u !== "string" || Number.isNaN(Date.parse(u)))) return "A pause ends at a date and time, or when you resume.";
  }
  return null;
}

// --- Pre-1.19 settings -------------------------------------------------------------

/** The pre-1.19 personal columns on users. */
export interface LegacyPrefs {
  notify_prefs: Record<string, Record<string, boolean>> | null | undefined;
  email_notifications: number;
  weekly_digest: number;
}

/**
 * The choices someone made before 1.19.0, in the new shape: their opt-outs
 * per kind and channel ("inapp" is the bell), the master switch as the
 * mention, subscribed-space and weekly-digest emails, and the weekly digest
 * as an explicit opt-in. Only what a sender actually read is carried, so
 * the effective behaviour is unchanged (test/notify-policy-migration).
 */
export function prefsFromLegacy(legacy: LegacyPrefs): UserNotifyPrefs {
  const out = emptyPrefs();
  const np = isObj(legacy.notify_prefs) ? legacy.notify_prefs : {};
  for (const kind of LEGACY_KINDS) {
    const row = np[kind];
    if (!isObj(row)) continue;
    if (row.inapp === false) (out.channels[kind] ??= {}).bell = false;
    if (row.webhook === false) (out.channels[kind] ??= {}).webhook = false;
    if (row.email === false && EMAIL_FROM_PREFS.has(kind)) (out.channels[kind] ??= {}).email = false;
  }
  const master = legacy.email_notifications === 1;
  if (!master) {
    for (const kind of EMAIL_FROM_MASTER) (out.channels[kind] ??= {}).email = false;
    (out.channels.weekly_digest ??= {}).email = false;
  } else if (legacy.weekly_digest === 1) {
    (out.channels.weekly_digest ??= {}).email = true;
  }
  return out;
}

/**
 * What the pre-1.19 columns should say for these prefs, written alongside
 * every save so a rollback (or any reader not yet on shouldNotify) still
 * sees the person's choices.
 */
export function legacyFromPrefs(p: UserNotifyPrefs): LegacyPrefs {
  const notify_prefs: Record<string, Record<string, boolean>> = {};
  for (const kind of LEGACY_KINDS) {
    const row = p.channels[kind] ?? {};
    if (row.bell === false) (notify_prefs[kind] ??= {}).inapp = false;
    if (row.webhook === false) (notify_prefs[kind] ??= {}).webhook = false;
    if (row.email === false && EMAIL_FROM_PREFS.has(kind)) (notify_prefs[kind] ??= {}).email = false;
  }
  return {
    notify_prefs,
    email_notifications: p.channels.doc_update?.email === false ? 0 : 1,
    weekly_digest: p.channels.weekly_digest?.email === true ? 1 : 0,
  };
}

/**
 * Lay the pre-1.19 columns over saved prefs: the legacy PATCH route (and
 * anything else still writing those columns) keeps the new row in step.
 * Only the keys the columns describe change; "on" in a column clears the
 * choice (back to the workspace default), "off" sets it.
 */
export function mergeLegacyIntoPrefs(p: UserNotifyPrefs, legacy: LegacyPrefs): UserNotifyPrefs {
  const out: UserNotifyPrefs = structuredClone(p);
  const from = prefsFromLegacy(legacy);
  const set = (id: string, ch: NotifyChannel, v: boolean | undefined) => {
    if (v === undefined) {
      if (out.channels[id]) {
        delete out.channels[id][ch];
        if (Object.keys(out.channels[id]).length === 0) delete out.channels[id];
      }
    } else (out.channels[id] ??= {})[ch] = v;
  };
  for (const kind of LEGACY_KINDS) {
    set(kind, "bell", from.channels[kind]?.bell);
    set(kind, "webhook", from.channels[kind]?.webhook);
    if (EMAIL_FROM_PREFS.has(kind) || EMAIL_FROM_MASTER.has(kind)) set(kind, "email", from.channels[kind]?.email);
  }
  set("weekly_digest", "email", from.channels.weekly_digest?.email);
  return out;
}

/**
 * The pre-1.19 answer for one kind and channel, as the senders computed it
 * (the regression test holds decide() to it under the default policy).
 */
export function legacyAllows(legacy: LegacyPrefs, kind: string, channel: NotifyChannel): boolean {
  const np = isObj(legacy.notify_prefs) ? legacy.notify_prefs : {};
  if (channel === "bell") return np[kind]?.inapp !== false;
  if (channel === "webhook") return np[kind]?.webhook !== false;
  if (channel === "push") return true;
  if (EMAIL_FROM_MASTER.has(kind)) return legacy.email_notifications === 1;
  if (kind === "weekly_digest") return legacy.email_notifications === 1 && legacy.weekly_digest === 1;
  if (EMAIL_FROM_PREFS.has(kind)) return np[kind]?.email !== false;
  return true;
}

// --- The decision ------------------------------------------------------------------

export type NotifyReason =
  | "security"
  | "locked_on"
  | "locked_off"
  | "default_on"
  | "default_off"
  | "chosen_on"
  | "chosen_off"
  | "desk_off"
  | "paused"
  | "quiet_hours"
  | "no_channel"
  | "automated"
  | "unknown_event"
  | "lookup_failed";

export interface NotifyDecision {
  send: boolean;
  mode: NotifyMode;
  reason: NotifyReason;
}

/** What the workspace says for one event and channel. */
export function policyCell(policy: NotifyPolicy, def: NotifyEventDef, ch: NotifyChannel): { default: boolean; control: NotifyControl } {
  if (def.security) return { default: true, control: "locked_on" };
  const cell = policy.events[def.id]?.channels?.[ch];
  return { default: cell?.default ?? def.channels[ch] ?? false, control: cell?.control ?? "choose" };
}

/** What the workspace says about an event's email delivery mode. */
export function policyMode(policy: NotifyPolicy, def: NotifyEventDef): { mode: NotifyMode; locked: boolean } {
  if (!def.digest) return { mode: "instant", locked: true };
  const ev = policy.events[def.id];
  return { mode: ev?.mode ?? "instant", locked: ev?.mode_control === "locked" };
}

/** The desk's own choices (agent F's hd_notify_prefs), as far as decide() needs them. */
export interface DeskPrefsView {
  /** Explicit switches the agent stored, by F's event name. */
  matrix: Partial<Record<string, Partial<Record<"push" | "email" | "bell", boolean>>>>;
  /** Push and email held right now by the desk's own pause or quiet hours (F's holdReason). */
  hold: (event: HdNotifyEvent, urgent: boolean) => "paused" | "quiet" | null;
}

export interface DecideInput {
  policy: NotifyPolicy;
  prefs: UserNotifyPrefs;
  /** The person's IANA time zone, for quiet hours. */
  timeZone: string;
  now: Date;
  urgent?: boolean;
  desk?: DeskPrefsView | null;
  /** For an event the catalog doesn't know: the pre-1.19 columns decide. */
  legacy?: LegacyPrefs | null;
  /** The ticket was raised by an alert intake (agent P): no human requester, so requester events are never sent. */
  automated?: boolean;
}

/** The events that tell a request's requester (silent for automated tickets). */
export const REQUESTER_SIDE_EVENTS: readonly string[] = [...HD_REQUESTER_EVENTS, "hd_approval_decided"];

/** True while a pause holds at `at`. */
export function pausedAt(prefs: Pick<UserNotifyPrefs, "pause">, at: Date): boolean {
  if (!prefs.pause) return false;
  if (prefs.pause.until === null) return true;
  return Date.parse(prefs.pause.until) > at.getTime();
}

export function quietAt(prefs: Pick<UserNotifyPrefs, "quiet">, at: Date, timeZone: string): boolean {
  return inQuietHours({ ...prefs.quiet, breakthrough: false }, at, timeZone);
}

function deskName(id: string): HdNotifyEvent | null {
  if (id === "hd_approval_needed") return "approval_needed";
  if (!id.startsWith("desk_")) return null;
  const name = id.slice(5);
  return DESK_NAMES.includes(name) ? (name as HdNotifyEvent) : null;
}

/**
 * The one answer: does `event` reach this person on `channel` now, and how.
 * Order: security always; the workspace's lock; the person's choice (and
 * the desk's, for desk events: an explicit off in either wins) or the
 * workspace default; then pause (all but the bell), quiet hours (push, and
 * email that can wait: it is queued for the hourly digest, which waits for
 * the quiet hours to end), and the delivery mode for email.
 */
export function decide(eventId: string, channel: NotifyChannel, input: DecideInput): NotifyDecision {
  const def = BY_ID.get(eventId);
  if (!def) {
    const ok = input.legacy ? legacyAllows(input.legacy, eventId, channel) : true;
    return { send: ok, mode: "instant", reason: "unknown_event" };
  }
  if (def.channels[channel] === undefined) return { send: false, mode: "instant", reason: "no_channel" };
  if (input.automated && REQUESTER_SIDE_EVENTS.includes(def.id)) return { send: false, mode: "instant", reason: "automated" };
  if (def.security) return { send: true, mode: "instant", reason: "security" };

  const cell = policyCell(input.policy, def, channel);
  let on: boolean;
  let reason: NotifyReason;
  if (cell.control === "locked_on") {
    on = true;
    reason = "locked_on";
  } else if (cell.control === "locked_off") {
    on = false;
    reason = "locked_off";
  } else {
    const mine = input.prefs.channels[def.id]?.[channel];
    const dn = deskName(def.id);
    const theirs = dn && channel !== "webhook" ? input.desk?.matrix[dn]?.[channel as "push" | "email" | "bell"] : undefined;
    if (mine === false || theirs === false) {
      on = false;
      reason = mine === false ? "chosen_off" : "desk_off";
    } else if (mine === true || theirs === true) {
      on = true;
      reason = "chosen_on";
    } else {
      on = cell.default;
      reason = on ? "default_on" : "default_off";
    }
  }
  if (!on) return { send: false, mode: "instant", reason };

  // The bell is the record: never paused or held.
  if (channel === "bell") return { send: true, mode: "instant", reason };

  if (pausedAt(input.prefs, input.now)) return { send: false, mode: "instant", reason: "paused" };
  const dn = deskName(def.id);
  const deskHold = dn && channel !== "webhook" && input.desk ? input.desk.hold(dn, !!input.urgent) : null;
  if (deskHold === "paused") return { send: false, mode: "instant", reason: "paused" };

  let mode: NotifyMode = "instant";
  if (channel === "email" && def.digest) {
    const pm = policyMode(input.policy, def);
    mode = pm.locked ? pm.mode : input.prefs.digest[def.section] ?? pm.mode;
  }

  const quiet = !input.urgent && (quietAt(input.prefs, input.now, input.timeZone) || deskHold === "quiet");
  if (quiet && channel === "push") return { send: false, mode: "instant", reason: "quiet_hours" };
  if (quiet && channel === "email" && mode === "instant" && def.digest && !def.evidence) {
    return { send: true, mode: "digest_hourly", reason: "quiet_hours" };
  }
  // A desk event with no digest of its own (an SLA breach) still waits for
  // quiet hours when break-through is off (urgent is false then): it goes
  // to the hourly digest, which itself waits for the quiet hours to end.
  if (quiet && channel === "email" && mode === "instant" && dn && !def.evidence) {
    return { send: true, mode: "digest_hourly", reason: "quiet_hours" };
  }
  return { send: true, mode, reason };
}

// --- Labels for the pages ----------------------------------------------------------

export const NOTIFY_REASON_LABEL: Record<NotifyReason, string> = {
  security: "Security mail is always sent",
  locked_on: "Set by your workspace",
  locked_off: "Set by your workspace",
  default_on: "Workspace default",
  default_off: "Workspace default",
  chosen_on: "Your choice",
  chosen_off: "Your choice",
  desk_off: "Off on the desk's Notifications page",
  paused: "Paused",
  quiet_hours: "Held for your quiet hours",
  no_channel: "Not sent this way",
  automated: "Automated ticket: no requester to tell",
  unknown_event: "Not in the catalog",
  lookup_failed: "Preferences couldn't be read, so it wasn't sent",
};

/** The stored pause for a preset: an hour, 08:00 tomorrow in the person's zone, a week, until resumed, or none. */
export function pauseForPreset(preset: PausePreset, now: Date, timeZone: string): UserNotifyPrefs["pause"] {
  if (preset === "off") return null;
  if (preset === "week") return { until: new Date(now.getTime() + 7 * 86_400_000).toISOString() };
  return deskPauseFor(preset, now, timeZone);
}

/** The time zone for quiet hours: the person's, else the workspace's, else UTC. */
export function zoneFor(personal: string | null | undefined, workspace: string | null | undefined): string {
  for (const z of [personal, workspace]) {
    const t = (z ?? "").trim();
    if (!t) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: t });
      return t;
    } catch {
      /* next */
    }
  }
  return "UTC";
}
