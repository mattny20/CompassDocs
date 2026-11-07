// Helpdesk 1.19.4: what the chat apps do, the same for Microsoft Teams and
// Slack (teams.ts and slack.ts only speak the platforms). The inbound
// endpoints (lib/helpdesk/chat/inbound) verify a request, answer at once,
// then call one of these after the response.
//
//   identity   Teams: the Entra object ID → the directory entry the Entra
//              sync wrote (directory_people source 'graph', external_id) →
//              the active account linked to it. Slack: users.info's email
//              (needs users:read.email; Slack must call it confirmed) → the
//              one active account with that confirmed address
//              (email_self_set = 0 and held by no other account: the
//              asset-matching rule). Nobody else gets a ticket: they get
//              "ask IT to add you". The account must hold helpdesk.request.
//   raise      a direct message (or the Get help message action) suggests
//              a request type (word overlap with the person's own types,
//              only types whose form has no required question) and up to
//              two articles (lib/helpdesk/suggest, under their own scope),
//              then a "Raise a request?" card: Raise request, or Edit (type,
//              device from their assets when a source is connected, what's
//              wrong). Raising goes through createTicket like Get help:
//              request types, routing rules, workflows, notices.
//   follow     a public desk reply (never an internal note, never a reply
//              held for review: the hook sits after both checks in
//              notify.notifyReply) is posted to the request's chat; a reply
//              there (a Slack thread reply, "#1047 …", or a plain message
//              within three days of the last message about a request)
//              becomes the requester's message, like Get help's.
//   approvals  approvers who use the app get a card (Approve, Decline…,
//              Ask a question, Open). The click is decided as the clicking
//              person's own account through approvals.decideApproval, the
//              same rule as the email buttons; anyone else is told "Only
//              <name> can decide this".
//   channels   a mention (or, in Slack, the chosen reaction) in a configured
//              channel opens a ticket for the channel's team with the poster
//              as requester and a link back; agents may turn any channel
//              message into a ticket when that toggle is on.
//
// Limits: 20 messages a minute per chat account, the requester limits of
// Get help (new requests, replies), approval decisions as on the web, and a
// message is cut at 8,000 characters. Server-only.

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { audit } from "../../audit";
import { logEvent } from "../../log";
import { canUseHelpdesk, hdRateLimited, isAgent, agentTeamIds, messagePostLimited, requestCreateLimited } from "../access";
import { hq, hqOne } from "../db-core";
import { mdInline } from "../md-inline";
import { helpdeskOrigin, hdLinks } from "../email";
import { markdownToPlain } from "../inbound-parse";
import { CHAT_LIMITS, HD_CHAT_APP_LABEL, HD_CHAT_APP_SHORT, type HdChatAbility, type HdChatApp, type HdChatChannel } from "../chat-shared";
import { ChatHttpError } from "./http";
import { appConnected, getChatSettings, type ChatSettings } from "./settings";
import type { ChatMsg, ChatPerson, ChatUser, ConvRef } from "./types";

// --- Ports: one per app --------------------------------------------------------------------

export interface ChatPort {
  app: HdChatApp;
  post(ref: ConvRef, msg: ChatMsg): Promise<string>;
  update(ref: ConvRef, messageId: string, msg: ChatMsg): Promise<void>;
  /**
   * A line only `person` sees: Slack posts it ephemerally; Teams has no such thing, so it goes to
   * the person's direct chat with the app (or to `ref` when that is already a direct chat), and
   * nowhere when they have none. Never a public channel post.
   */
  whisper(ref: ConvRef, person: ChatPerson, text: string): Promise<void>;
  /** The direct chat with this account (Slack opens one; Teams needs one the person started or the app's install). */
  dmFor(userId: number): Promise<ConvRef | null>;
  /** `fresh`: re-read the person from the platform now (raising, deciding), never a cached link. */
  identify(person: ChatPerson, opts?: { fresh?: boolean }): Promise<ChatUser | null>;
}

export async function portFor(app: HdChatApp, s?: ChatSettings): Promise<ChatPort | null> {
  const settings = s ?? (await getChatSettings());
  if (!appConnected(settings, app)) return null;
  if (app === "teams") {
    const t = await import("./teams");
    const ts = settings.teams;
    return {
      app,
      post: (ref, msg) => t.teamsPost(ts, ref, msg),
      update: (ref, id, msg) => t.teamsUpdate(ts, ref, id, msg),
      whisper: async (ref, p, text) => {
        const dm = isTeamsDirect(ref) ? ref : await teamsDmOf(p.id);
        if (dm) await t.teamsPost(ts, { service_url: dm.service_url, conversation_id: dm.conversation_id }, { kind: "text", text });
      },
      dmFor: async (userId) => {
        const r = await hqOne<{ dm_ref: ConvRef }>(
          `SELECT dm_ref FROM hd_chat_people WHERE app = 'teams' AND user_id = $1 AND dm_ref ? 'conversation_id' ORDER BY checked_at DESC LIMIT 1`,
          [userId]
        );
        return r?.dm_ref?.conversation_id && r.dm_ref.service_url ? { service_url: r.dm_ref.service_url, conversation_id: r.dm_ref.conversation_id } : null;
      },
      identify: (p) => userFromTeams(p.id),
    };
  }
  const sl = await import("./slack");
  const token = settings.slack.bot_token;
  const teamId = settings.slack.team_id;
  return {
    app,
    post: (ref, msg) => sl.slackPost(token, ref.conversation_id, msg, ref.thread_id || undefined),
    update: (ref, ts, msg) => sl.slackUpdate(token, ref.conversation_id, ts, msg),
    whisper: (ref, p, text) => sl.slackEphemeral(token, ref.conversation_id, p.id, text, ref.thread_id || undefined),
    dmFor: async (userId) => {
      const r = await hqOne<{ chat_user_id: string; dm_ref: ConvRef; fresh: boolean }>(
        `SELECT chat_user_id, dm_ref, checked_at > now() - make_interval(hours => $2) AS fresh FROM hd_chat_people
          WHERE app = 'slack' AND user_id = $1 ORDER BY (dm_ref ? 'conversation_id') DESC, checked_at DESC LIMIT 1`,
        [userId, IDENTITY_RECHECK_HOURS]
      );
      let slackId = r?.chat_user_id ?? "";
      // Before writing to a remembered chat: is that Slack member still this person (a stale link is re-read from Slack)?
      if (slackId && !r!.fresh) {
        const still = await userFromSlack(token, teamId, slackId, { fresh: true }).catch(() => null);
        if (!still || still.id !== userId) slackId = "";
      }
      if (slackId && r?.dm_ref?.conversation_id) return { conversation_id: r.dm_ref.conversation_id };
      if (!slackId) {
        // An approver who never wrote to the app: found by their confirmed address (users:read.email).
        const email = await confirmedEmail(userId);
        if (!email) return null;
        const m = await sl.slackUserByEmail(token, email);
        if (!m || m.deleted || m.is_bot || !m.email_confirmed || m.email !== email || (teamId && m.team_id && m.team_id !== teamId)) return null;
        slackId = m.id;
      }
      const channel = await sl.slackOpenDm(token, slackId);
      await rememberPerson("slack", slackId, userId, { conversation_id: channel }, { verified: true });
      return { conversation_id: channel };
    },
    identify: (p, o) => userFromSlack(token, teamId, p.id, o),
  };
}

// --- Identity ------------------------------------------------------------------------------

const CONFIRMED = (u: string) =>
  `(${u}.email <> '' AND ${u}.email_self_set = 0 AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> ${u}.id AND lower(o.email) = lower(${u}.email)))`;
const USER_COLS = "u.id, u.username, coalesce(u.name, '') AS name, coalesce(u.email, '') AS email, u.role";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY_RECHECK_HOURS = 24;

async function confirmedEmail(userId: number): Promise<string> {
  const r = await hqOne<{ email: string }>(`SELECT lower(u.email) AS email FROM users u WHERE u.id = $1 AND u.status = 'active' AND ${CONFIRMED("u")}`, [userId]);
  return r?.email ?? "";
}

/** Teams: the Entra object ID through the directory the Entra sync keeps, to the one active account linked to that entry. */
export async function userFromTeams(aadObjectId: string): Promise<ChatUser | null> {
  if (!GUID_RE.test(aadObjectId)) return null;
  const rows = await hq<ChatUser>(
    `SELECT ${USER_COLS} FROM directory_people dp JOIN users u ON u.directory_person_id = dp.id
      WHERE dp.source = 'graph' AND lower(dp.external_id) = lower($1) AND u.status = 'active'
      ORDER BY u.id LIMIT 2`,
    [aadObjectId]
  );
  return rows.length === 1 ? rows[0] : null;
}

/** Slack: users.info's confirmed email to the one active account holding that confirmed address (re-read from Slack once a day). */
export async function userFromSlack(token: string, teamId: string, slackUserId: string, opts: { fresh?: boolean } = {}): Promise<ChatUser | null> {
  if (!/^[UW][A-Z0-9]{2,30}$/.test(slackUserId)) return null;
  const cached = opts.fresh ? undefined : await hqOne<ChatUser>(
    `SELECT ${USER_COLS} FROM hd_chat_people p JOIN users u ON u.id = p.user_id
      WHERE p.app = 'slack' AND p.chat_user_id = $1 AND p.checked_at > now() - make_interval(hours => $2) AND u.status = 'active' AND ${CONFIRMED("u")}`,
    [slackUserId, IDENTITY_RECHECK_HOURS]
  );
  if (cached) return cached;
  const { slackUser } = await import("./slack");
  const m = await slackUser(token, slackUserId);
  const forget = () => forgetChatPerson("slack", slackUserId);
  if (m.deleted || m.is_bot || !m.email || !m.email_confirmed || (teamId && m.team_id && m.team_id !== teamId)) {
    await forget();
    return null;
  }
  const rows = await hq<ChatUser>(`SELECT ${USER_COLS} FROM users u WHERE lower(u.email) = $1 AND u.status = 'active' AND ${CONFIRMED("u")} LIMIT 2`, [m.email]);
  if (rows.length !== 1) {
    await forget();
    return null;
  }
  // The member now stands for another account: the old account's direct-chat threads must not reach them.
  const prior = await hqOne<{ user_id: number }>("SELECT user_id FROM hd_chat_people WHERE app = 'slack' AND chat_user_id = $1", [slackUserId]);
  if (prior && prior.user_id !== rows[0].id) await forgetChatPerson("slack", slackUserId);
  await rememberPerson("slack", slackUserId, rows[0].id, undefined, { verified: true });
  return rows[0];
}

/**
 * Drop a chat account's link and the direct-chat threads that went through it, so no desk
 * reply for that account goes to this chat any more (identity no longer holds, or moved).
 */
export async function forgetChatPerson(app: HdChatApp, chatUserId: string): Promise<void> {
  const row = await hqOne<{ user_id: number; conv: string | null }>(
    "DELETE FROM hd_chat_people WHERE app = $1 AND chat_user_id = $2 RETURNING user_id, dm_ref ->> 'conversation_id' AS conv",
    [app, chatUserId]
  );
  if (row?.conv) await hq("DELETE FROM hd_chat_threads WHERE app = $1 AND kind = 'dm' AND user_id = $2 AND conversation_id = $3", [app, row.user_id, row.conv]);
}

/** Teams: a personal chat ("a:…"), as opposed to a channel or group chat ("19:…"). */
function isTeamsDirect(ref: ConvRef): boolean {
  return !!ref.service_url && !!ref.conversation_id && !ref.conversation_id.startsWith("19:");
}

async function teamsDmOf(aadObjectId: string): Promise<ConvRef | null> {
  const r = await hqOne<{ dm_ref: ConvRef }>("SELECT dm_ref FROM hd_chat_people WHERE app = 'teams' AND chat_user_id = $1 AND dm_ref ? 'conversation_id'", [aadObjectId]);
  return r?.dm_ref?.conversation_id && r.dm_ref.service_url ? r.dm_ref : null;
}

/** Remember a chat account's link (and its direct chat, when given). A different account clears the focus. */
export async function rememberPerson(app: HdChatApp, chatUserId: string, userId: number, dmRef?: ConvRef & { platform_id?: string }, opts: { verified?: boolean } = {}): Promise<void> {
  await hq(
    `INSERT INTO hd_chat_people (app, chat_user_id, user_id, dm_ref) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (app, chat_user_id) DO UPDATE SET
       focus_ticket_id = CASE WHEN hd_chat_people.user_id = EXCLUDED.user_id THEN hd_chat_people.focus_ticket_id END,
       focus_at = CASE WHEN hd_chat_people.user_id = EXCLUDED.user_id THEN hd_chat_people.focus_at END,
       user_id = EXCLUDED.user_id,
       -- Only a real check against the platform renews the link (a message alone never does).
       checked_at = CASE WHEN $5::boolean THEN now() ELSE hd_chat_people.checked_at END,
       dm_ref = CASE WHEN EXCLUDED.dm_ref = '{}'::jsonb THEN hd_chat_people.dm_ref ELSE EXCLUDED.dm_ref END`,
    [app, chatUserId, userId, JSON.stringify(dmRef ?? {}), opts.verified === true]
  );
}

async function setFocus(app: HdChatApp, userId: number, ticketId: number | null): Promise<void> {
  await hq(`UPDATE hd_chat_people SET focus_ticket_id = $3, focus_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() END WHERE app = $1 AND user_id = $2`, [app, userId, ticketId]);
}

// --- Words ---------------------------------------------------------------------------------

export const T = {
  unknown:
    "I couldn't find your CompassDocs account, so I can't raise requests for you yet. Ask IT to add you (with the same email address you use here), then message me again.",
  noHelpdesk: "Your CompassDocs account can't raise helpdesk requests. Ask IT if you need to.",
  slowDown: "That's a lot of messages at once. Wait a minute, then try again.",
  off: (app: HdChatApp) => `The helpdesk isn't taking requests in ${HD_CHAT_APP_SHORT[app]} right now. Use Get help in CompassDocs instead.`,
  ask: "What do you need help with? Describe it in a sentence or two.",
};

const STOP = new Set(
  "the and for with from that this have has had not can cant can't won't wont don't dont doesn't isn't its it's i'm you your our out are was were been any all get got need needs please help new request when what why how who there their them then than into onto just also some more most very really still keep".split(" ")
);
const stem = (w: string) => (w.length > 5 ? w.replace(/(ing|ed|es)$/, "") : w.length > 3 ? w.replace(/s$/, "") : w);
export function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
}

/** The person's request type that best fits the text (title words count double); null under a score of 2. */
export function bestType<T extends { id: number; title: string; description: string; category: string }>(text: string, types: T[]): T | null {
  const said = words(text);
  let best: T | null = null;
  let top = 1;
  for (const t of types) {
    let score = 0;
    for (const w of words(t.title)) if (said.has(w)) score += 2;
    for (const w of words(`${t.description} ${t.category}`)) if (said.has(w)) score += 1;
    if (score > top) {
      top = score;
      best = t;
    }
  }
  return best;
}

/** A subject from a message: its first line, mentions dropped, at most 120 characters. */
export function subjectOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const s = line.replace(/\s+/g, " ").trim();
  return s.length > 120 ? `${s.slice(0, 117).trimEnd()}…` : s || "Request from chat";
}

/**
 * A channel's name in the requester's own first message ("(From #it-help in
 * Slack)"). That body is Markdown in the desk and plain text in Get help, so
 * the name carries no backslash escapes (they would show in Get help) and
 * nothing Markdown acts on: Slack names are only a-z, 0-9, "-" and "_"; any
 * other character (a Teams name may hold more) becomes a space, and so does
 * an "_" that isn't inside a word (emphasis). "www." gets an invisible word
 * joiner (U+2060), or GFM would link it.
 */
export function channelLabel(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N}\p{M}._ -]+/gu, " ")
      .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, " ")
      .replace(/(www)(?=\.)/gi, "$1\u2060")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "a channel"
  );
}

/** The first message of a ticket opened from a channel: the poster's own text, then where it came from. */
export function channelTicketBody(text: string, app: HdChatApp, where: { name: string }, link?: string | null): string {
  const from = link ? `[Open the message in ${HD_CHAT_APP_SHORT[app]}](${link})` : `(From #${channelLabel(where.name)} in ${HD_CHAT_APP_SHORT[app]})`;
  return `${text}\n\n${from}`;
}

/** The internal note when an agent opened the ticket from someone's message: Markdown, names escaped. */
export function channelOpenedNote(by: string, app: HdChatApp, where: { name: string }): string {
  return `${mdInline(by)} opened this from a message in #${mdInline(where.name)} (${HD_CHAT_APP_SHORT[app]}).`;
}

export function cleanText(raw: string): string {
  const t = raw.replace(/\u0000/g, "").trim();
  return t.length > CHAT_LIMITS.text ? `${t.slice(0, CHAT_LIMITS.text)}\n\n(trimmed)` : t;
}

async function abs(path: string): Promise<string> {
  const o = await helpdeskOrigin();
  return o ? `${o.replace(/\/+$/, "")}${path}` : "";
}

function fail(where: string, e: unknown, extra: Record<string, unknown> = {}): void {
  logEvent("warn", "helpdesk.chat_failed", { where, ...extra, error: e instanceof Error ? e.message : String(e) });
}

/** A chat account's message budget (20 a minute). */
export function chatLimited(app: HdChatApp, chatUserId: string): boolean {
  return hdRateLimited(`hd-chat:${app}:${chatUserId}`, CHAT_LIMITS.perUserPerMinute, 60_000);
}

async function allowed(app: HdChatApp, ability: HdChatAbility, s?: ChatSettings): Promise<boolean> {
  const settings = s ?? (await getChatSettings());
  return appConnected(settings, app) && settings[app].abilities[ability];
}

/** The account behind a chat person, or a polite reply and null. */
async function whoIs(port: ChatPort, person: ChatPerson, replyTo: ConvRef | null, opts: { fresh?: boolean } = {}): Promise<ChatUser | null> {
  let user: ChatUser | null = null;
  try {
    user = await port.identify(person, opts);
  } catch (e) {
    fail("identify", e, { app: port.app });
    if (replyTo) await port.whisper(replyTo, person, "I couldn't check who you are just now. Try again in a minute.").catch(() => {});
    return null;
  }
  if (!user) {
    if (replyTo) await port.whisper(replyTo, person, T.unknown).catch((e) => fail("reply", e));
    return null;
  }
  if (!(await canUseHelpdesk(user))) {
    if (replyTo) await port.whisper(replyTo, person, T.noHelpdesk).catch((e) => fail("reply", e));
    return null;
  }
  return user;
}

// --- A direct message --------------------------------------------------------------------

export interface DmEvent {
  person: ChatPerson;
  text: string;
  /** The direct chat (Teams: with service_url). */
  ref: ConvRef;
  /** Slack: the thread the message was written in, when it was. */
  threadTs?: string;
}

export async function handleDm(port: ChatPort, ev: DmEvent): Promise<void> {
  const s = await getChatSettings();
  if (chatLimited(port.app, ev.person.id)) {
    await port.post(ev.ref, { kind: "text", text: T.slowDown }).catch(() => {});
    return;
  }
  const user = await whoIs(port, ev.person, ev.ref);
  if (!user) return;
  await rememberPerson(port.app, ev.person.id, user.id, { ...ev.ref, thread_id: undefined, ...(ev.person.platform_id ? { platform_id: ev.person.platform_id } : {}) });
  const text = cleanText(ev.text);
  if (!text) return;
  const canRaise = s[port.app].abilities.raise;
  const canFollow = s[port.app].abilities.follow;
  if (!canRaise && !canFollow) {
    await port.post(ev.ref, { kind: "text", text: T.off(port.app) });
    return;
  }
  if (/^(new|new request|start over|cancel)[.!]?$/i.test(text)) {
    await setFocus(port.app, user.id, null);
    await port.post(ev.ref, { kind: "text", text: T.ask });
    return;
  }
  // A reply to a request: a Slack thread of one, "#1047 …", or the request last talked about here.
  if (canFollow) {
    const target = await replyTarget(port.app, user, ev, text);
    if (target) {
      // Only a reply in the request's own Slack thread is plainly on it; anything else says where it went.
      await replyAsRequester(port, user, target.ticketId, target.number, target.body, ev.ref, target.viaThread);
      return;
    }
  }
  if (!canRaise) {
    await port.post(ev.ref, { kind: "text", text: `Raising requests in ${HD_CHAT_APP_SHORT[port.app]} is off. Use Get help in CompassDocs.` });
    return;
  }
  if (/^(hi|hello|hey|help|\?)[.!]?$/i.test(text)) {
    await port.post(ev.ref, { kind: "text", text: T.ask });
    return;
  }
  await suggest(port, user, ev.person.id, text, ev.ref, {});
}

async function replyTarget(app: HdChatApp, user: ChatUser, ev: DmEvent, text: string): Promise<{ ticketId: number; number: number; body: string; viaThread: boolean } | null> {
  if (ev.threadTs) {
    const t = await hqOne<{ id: number; number: number }>(
      `SELECT t.id, t.number FROM hd_chat_threads c JOIN hd_tickets t ON t.id = c.ticket_id
        WHERE c.app = $1 AND c.conversation_id = $2 AND c.thread_id = $3 AND t.requester_id = $4 AND (to_jsonb(t) ->> 'deleted_at') IS NULL ORDER BY c.id DESC LIMIT 1`,
      [app, ev.ref.conversation_id, ev.threadTs, user.id]
    );
    if (t) return { ticketId: t.id, number: t.number, body: text, viaThread: true };
  }
  const hash = /^#(\d{1,9})\b[\s:,-]*([\s\S]*)$/.exec(text);
  if (hash && hash[2].trim()) {
    const t = await hqOne<{ id: number; number: number }>("SELECT id, number FROM hd_tickets t WHERE number = $1 AND requester_id = $2 AND (to_jsonb(t) ->> 'deleted_at') IS NULL", [Number(hash[1]), user.id]);
    if (t) return { ticketId: t.id, number: t.number, body: hash[2].trim(), viaThread: false };
  }
  // A Slack thread that belongs to no request is not the focused request: it starts a new one.
  if (ev.threadTs) return null;
  const f = await hqOne<{ id: number; number: number }>(
    `SELECT t.id, t.number FROM hd_chat_people p JOIN hd_tickets t ON t.id = p.focus_ticket_id
      WHERE p.app = $1 AND p.chat_user_id = $2 AND p.user_id = $3 AND t.requester_id = $3
        AND p.focus_at > now() - make_interval(days => $4) AND t.status <> 'closed' AND (to_jsonb(t) ->> 'deleted_at') IS NULL`,
    [app, ev.person.id, user.id, CHAT_LIMITS.focusDays]
  );
  return f ? { ticketId: f.id, number: f.number, body: text, viaThread: false } : null;
}

async function replyAsRequester(port: ChatPort, user: ChatUser, ticketId: number, number: number, body: string, ref: ConvRef, inThread: boolean): Promise<void> {
  if (messagePostLimited(user.id)) {
    await port.post(ref, { kind: "text", text: T.slowDown });
    return;
  }
  const t = await hqOne<{ status: string; requester_id: number | null }>("SELECT status, requester_id FROM hd_tickets WHERE id = $1", [ticketId]);
  if (!t || t.requester_id !== user.id) return;
  if (t.status === "closed") {
    await setFocus(port.app, user.id, null);
    await port.post(ref, { kind: "text", text: `#${number} is closed, so I didn't add that to it. Send it again to raise a new request.` });
    return;
  }
  const { addMessage } = await import("../messages");
  const { HdTicketError } = await import("../tickets");
  try {
    const res = await addMessage(ticketId, { kind: "public", body, author: { id: user.id, name: user.name || user.username, email: user.email }, via: "portal", asRequester: true }, { origin: await helpdeskOrigin() });
    if (!res) return;
    await setFocus(port.app, user.id, ticketId);
    // In a Slack thread the reply is plainly on that request; elsewhere say where it went.
    if (!inThread) await port.post(ref, { kind: "text", text: `Added to #${number}${res.reopened ? " (reopened)" : ""}. Something else? Say **new request**.` });
  } catch (e) {
    if (e instanceof HdTicketError) {
      await port.post(ref, { kind: "text", text: e.status === 409 ? `#${number} was merged into another request. Reply on that one.` : e.message });
      return;
    }
    throw e;
  }
}

// --- Raise a request ------------------------------------------------------------------------

interface DraftOrigin {
  /** A link to the message the Get help action was used on. */
  link?: string;
  where?: string;
}

interface RaiseChoices {
  types: { id: number; title: string; team_name: string | null; description: string; category: string }[];
  devices: { id: number; label: string }[];
}

async function choicesFor(user: ChatUser): Promise<RaiseChoices> {
  const { listRequestTypesForUser, validateAnswers } = await import("../request-types");
  const all = await listRequestTypesForUser(user);
  // Only types a chat can raise: no required question (a form like that belongs in Get help).
  const types: RaiseChoices["types"] = [];
  for (const t of all) if ((await validateAnswers(t.form ?? [], {})).ok) types.push({ id: t.id, title: t.title, team_name: t.team_name ?? null, description: t.description, category: t.category });
  let devices: RaiseChoices["devices"] = [];
  try {
    const assets = await import("../assets");
    if (await assets.assetsConnected()) devices = (await assets.myAssets(user)).map((d) => ({ id: d.id, label: d.tag ? `${d.name} (${d.tag})` : d.name }));
  } catch (e) {
    fail("devices", e);
  }
  return { types, devices };
}

function confirmCard(draftId: string, body: string, typeId: number | null, assetId: number | null, c: RaiseChoices): Extract<ChatMsg, { kind: "confirm" }> {
  const type = c.types.find((t) => t.id === typeId) ?? null;
  return {
    kind: "confirm",
    draftId,
    subtitle: type ? `${type.title} · ${type.team_name || "The helpdesk"}` : "The helpdesk",
    device: c.devices.find((d) => d.id === assetId)?.label ?? "",
    body,
    typeId: type?.id ?? null,
    assetId,
    types: c.types.map((t) => ({ id: t.id, title: t.title })),
    devices: c.devices,
  };
}

/** Suggest a type and articles, then post the "Raise a request?" card into `ref`. */
export async function suggest(port: ChatPort, user: ChatUser, chatUserId: string, text: string, ref: ConvRef, origin: DraftOrigin): Promise<void> {
  const c = await choicesFor(user);
  const type = bestType(text, c.types);
  let articles: { title: string; url: string }[] = [];
  try {
    const { suggestArticles } = await import("../suggest");
    articles = (await suggestArticles(user, text, 2)).map((a) => ({ title: a.title, url: a.url }));
  } catch (e) {
    fail("articles", e);
  }
  const assetId = c.devices.length === 1 ? c.devices[0].id : null;
  const draftId = randomBytes(16).toString("hex");
  await hq("DELETE FROM hd_chat_drafts WHERE created_at < now() - interval '1 day'");
  await hq(
    `INSERT INTO hd_chat_drafts (id, app, user_id, chat_user_id, body, request_type_id, asset_id, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [draftId, port.app, user.id, chatUserId, text, type?.id ?? null, assetId, JSON.stringify(origin)]
  );
  const lines: string[] = [];
  lines.push(type ? `That sounds like a **${type.title}** for ${type.team_name || "the helpdesk"}.` : "I can raise this with the helpdesk.");
  if (articles.length) {
    const links = await Promise.all(articles.map(async (a) => ((await abs(a.url)) ? `• [${a.title}](${await abs(a.url)})` : `• ${a.title}`)));
    lines.push(`These might help first:\n${links.join("\n")}`);
  }
  await port.post(ref, { kind: "text", text: lines.join(" ") });
  await port.post(ref, confirmCard(draftId, text, type?.id ?? null, assetId, c));
}

export interface RaiseEdits {
  type_id?: number | null;
  asset_id?: number | null;
  body?: string;
}

/** The card's Raise request (or the Edit form's): one ticket per card, however often it is clicked. */
export async function raiseFromDraft(port: ChatPort, person: ChatPerson, draftId: string, edits: RaiseEdits | null, ref: ConvRef): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(draftId)) return;
  // Raising acts as the account: re-read the person from the platform first, never a cached link.
  const user = await whoIs(port, person, ref, { fresh: true });
  if (!user) return;
  if (!(await allowed(port.app, "raise"))) {
    await port.post(ref, { kind: "text", text: T.off(port.app) });
    return;
  }
  const d = await hqOne<{ body: string; request_type_id: number | null; asset_id: number | null; origin: DraftOrigin; ticket_id: number | null; expired: boolean }>(
    `SELECT body, request_type_id, asset_id, origin, ticket_id, created_at < now() - make_interval(mins => $3) AS expired
       FROM hd_chat_drafts WHERE id = $1 AND app = $2 AND user_id = $4`,
    [draftId, port.app, CHAT_LIMITS.draftMinutes, user.id]
  );
  if (!d) return;
  if (d.ticket_id) {
    const n = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [d.ticket_id]);
    await port.post(ref, { kind: "text", text: `Already raised: **#${n?.number ?? "?"}**.` });
    return;
  }
  if (d.expired) {
    await port.post(ref, { kind: "text", text: "That card has expired. Send your message again and I'll start a new one." });
    return;
  }
  if (requestCreateLimited(user.id)) {
    await port.post(ref, { kind: "text", text: T.slowDown });
    return;
  }
  const c = await choicesFor(user);
  let typeId = d.request_type_id;
  let assetId = d.asset_id;
  let body = d.body;
  if (edits) {
    if (edits.type_id !== undefined) typeId = edits.type_id && c.types.some((t) => t.id === edits.type_id) ? edits.type_id : null;
    if (edits.asset_id !== undefined) assetId = edits.asset_id && c.devices.some((x) => x.id === edits.asset_id) ? edits.asset_id : null;
    if (typeof edits.body === "string" && edits.body.trim()) body = cleanText(edits.body);
  }
  // The type may have changed or gone since the card was made.
  if (typeId && !c.types.some((t) => t.id === typeId)) typeId = null;
  if (assetId && !c.devices.some((x) => x.id === assetId)) assetId = null;
  // Claim the card first: a double click raises one ticket.
  const claimed = await hqOne(
    `UPDATE hd_chat_drafts SET origin = origin || '{"raising": true}'::jsonb WHERE id = $1 AND ticket_id IS NULL AND NOT (origin ? 'raising') RETURNING id`,
    [draftId]
  );
  if (!claimed) return;
  const { createTicket } = await import("../tickets");
  const { getRequestType } = await import("../request-types");
  const rt = typeId ? await getRequestType(typeId) : undefined;
  const fullBody = d.origin?.link ? `${body}\n\n[From a message in ${HD_CHAT_APP_SHORT[port.app]}](${d.origin.link})` : body;
  let ticket;
  try {
    ticket = await createTicket(
      {
        subject: subjectOf(body),
        body: fullBody,
        requester: { id: user.id, name: user.name || user.username, email: user.email },
        via: "portal",
        source: port.app,
        source_ref: { chat: port.app },
        request_type_id: rt?.id ?? null,
        answers: {},
      },
      { actorId: user.id, actorName: user.name || user.username, origin: await helpdeskOrigin() }
    );
  } catch (e) {
    await hq(`UPDATE hd_chat_drafts SET origin = origin - 'raising' WHERE id = $1`, [draftId]);
    throw e;
  }
  await hq("UPDATE hd_chat_drafts SET ticket_id = $2 WHERE id = $1", [draftId, ticket.id]);
  if (assetId) {
    const assets = await import("../assets");
    if ((await assets.assetsConnected()) && (await assets.isRequesterAsset(user, assetId)) && (await assets.linkRequesterAsset(ticket.id, assetId, { id: user.id, name: user.name || user.username }))) {
      await audit({ actor: { id: user.id, name: user.name || user.username, role: user.role }, action: "helpdesk.asset.linked", targetType: "helpdesk_ticket", targetId: ticket.id, targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200), details: { number: ticket.number, asset_id: assetId, via: port.app } });
    }
  }
  const team = rt?.team_name || (ticket.team_id ? (await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [ticket.team_id]))?.name : null);
  // The chat link first: desk replies must reach this chat even when the "Done" line can't be posted.
  const threadRow = await addThread(ticket.id, port.app, "dm", user.id, ref, "", d.origin?.link ?? "");
  await setFocus(port.app, user.id, ticket.id);
  try {
    const doneTs = await port.post(ref, { kind: "text", text: `Done: **#${ticket.number}**. I'll message you here when ${team || "the helpdesk"} replies.` });
    // Slack: replies thread under the "Done" line.
    if (port.app === "slack" && doneTs && threadRow) await hq("UPDATE hd_chat_threads SET thread_id = $2 WHERE id = $1", [threadRow, doneTs]);
  } catch (e) {
    fail("done_line", e, { app: port.app, ticket_id: ticket.id });
  }
  await audit({
    actor: { id: user.id, name: user.name || user.username, role: user.role },
    action: "helpdesk.chat.request_raised",
    targetType: "helpdesk_ticket",
    targetId: ticket.id,
    targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
    details: { app: port.app, number: ticket.number, request_type_id: rt?.id ?? null, edited: !!edits, from_message: !!d.origin?.link },
  });
}

/** The Edit button's form data (Slack opens a modal with it; Teams carries the inputs in the card). */
export async function draftForEdit(app: HdChatApp, userId: number, draftId: string): Promise<Extract<ChatMsg, { kind: "confirm" }> | null> {
  const d = await hqOne<{ body: string; request_type_id: number | null; asset_id: number | null; user_id: number }>(
    "SELECT body, request_type_id, asset_id, user_id FROM hd_chat_drafts WHERE id = $1 AND app = $2 AND user_id = $3 AND ticket_id IS NULL",
    [draftId, app, userId]
  );
  if (!d) return null;
  const u = await hqOne<ChatUser>(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [userId]);
  if (!u) return null;
  return confirmCard(draftId, d.body, d.request_type_id, d.asset_id, await choicesFor(u));
}

/** Keep where a ticket lives in chat; the row's id (null when that channel message already has a ticket: idx_hd_chat_threads_channel_msg). */
async function addThread(ticketId: number, app: HdChatApp, kind: "dm" | "channel", userId: number | null, ref: ConvRef, threadId: string, link: string): Promise<number | null> {
  const r = await hqOne<{ id: number }>(
    `INSERT INTO hd_chat_threads (ticket_id, app, kind, user_id, service_url, conversation_id, thread_id, link, ticket_number)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, t.number FROM hd_tickets t WHERE t.id = $1
     ON CONFLICT DO NOTHING RETURNING id`,
    [ticketId, app, kind, userId, ref.service_url ?? "", ref.conversation_id, threadId, link.slice(0, 2000)]
  );
  return r?.id ?? null;
}

// --- Message actions: Get help, and Turn into a ticket --------------------------------------

export interface MessageActionEvent {
  /** Who used the action. */
  person: ChatPerson;
  command: "get_help" | "make_ticket";
  /** The message it was used on. */
  message: { text: string; poster: ChatPerson | null; id: string; link: string };
  /** The channel (or chat) the message is in, to answer in its thread. */
  where: ConvRef & { channel_id: string; name: string };
}

export async function handleMessageAction(port: ChatPort, ev: MessageActionEvent): Promise<void> {
  if (chatLimited(port.app, ev.person.id)) return;
  const s = await getChatSettings();
  const text = cleanText(ev.message.text);
  if (ev.command === "get_help") {
    if (!s[port.app].abilities.raise) {
      await port.whisper(ev.where, ev.person, T.off(port.app)).catch(() => {});
      return;
    }
    const user = await whoIs(port, ev.person, ev.where);
    if (!user) return;
    const dm = await port.dmFor(user.id);
    if (!dm) {
      await port.whisper(ev.where, ev.person, `Open a chat with the CompassDocs app first, then try again.`).catch(() => {});
      return;
    }
    if (!text) {
      await port.post(dm, { kind: "text", text: T.ask });
      return;
    }
    await suggest(port, user, ev.person.id, text, dm, { link: ev.message.link, where: ev.where.name });
    return;
  }
  // Turn a channel message into a ticket: agents only, when the toggle is on.
  if (!s[port.app].abilities.channel_ticket) {
    await port.whisper(ev.where, ev.person, "Turning messages into tickets is off for this app. An admin can turn it on in Desk settings, Chat apps.").catch(() => {});
    return;
  }
  const agent = await whoIs(port, ev.person, ev.where);
  if (!agent) return;
  if (!(await isAgent(agent))) {
    await port.whisper(ev.where, ev.person, "Only helpdesk agents can turn a message into a ticket. Use Get help to raise your own request.").catch(() => {});
    return;
  }
  const channel = s.channels.find((c) => c.app === port.app && c.channel_id === ev.where.channel_id) ?? null;
  let teamId = channel?.team_id ?? null;
  if (!teamId) {
    const mine = await agentTeamIds(agent);
    if (mine !== "all" && mine.length === 1) teamId = mine[0];
  }
  await openChannelTicket(port, ev.person, ev.message, ev.where, teamId, { by: agent, trigger: "agent" });
}

// --- Channels ------------------------------------------------------------------------------

export interface ChannelEvent {
  /** Who mentioned the app or reacted. */
  person: ChatPerson;
  trigger: "mention" | "reaction";
  reaction?: string;
  message: { text: string; poster: ChatPerson | null; id: string; link: string };
  where: ConvRef & { channel_id: string; name: string };
}

export function channelFor(s: ChatSettings, app: HdChatApp, channelId: string, trigger: "mention" | "reaction", reaction = ""): HdChatChannel | null {
  return s.channels.find((c) => c.app === app && c.channel_id === channelId && c.trigger === trigger && (trigger === "mention" || c.reaction === reaction)) ?? null;
}

export async function handleChannelEvent(port: ChatPort, ev: ChannelEvent): Promise<void> {
  const s = await getChatSettings();
  const channel = channelFor(s, port.app, ev.where.channel_id, ev.trigger, ev.reaction ?? "");
  if (!channel) {
    if (ev.trigger === "mention") await port.whisper(ev.where, ev.person, "This channel doesn't open tickets. Message me directly to raise a request.").catch(() => {});
    return;
  }
  if (chatLimited(port.app, ev.person.id)) return;
  await openChannelTicket(port, ev.person, ev.message, ev.where, channel.team_id, { trigger: ev.trigger, channelName: channel.name });
}

async function openChannelTicket(
  port: ChatPort,
  actor: ChatPerson,
  message: ChannelEvent["message"],
  where: ChannelEvent["where"],
  teamId: number | null,
  how: { by?: ChatUser; trigger: "mention" | "reaction" | "agent"; channelName?: string }
): Promise<void> {
  const threadRef: ConvRef = { ...where, thread_id: where.thread_id || message.id };
  // One ticket per message, whoever asks again.
  const already = await hqOne<{ number: number }>(
    `SELECT t.number FROM hd_chat_threads c JOIN hd_tickets t ON t.id = c.ticket_id
      WHERE c.app = $1 AND c.kind = 'channel' AND c.conversation_id = $2 AND c.thread_id = $3 LIMIT 1`,
    [port.app, where.conversation_id, message.id]
  );
  if (already) {
    if (how.trigger !== "reaction") await port.whisper(threadRef, actor, `That message is already #${already.number}.`).catch(() => {});
    return;
  }
  // Claim the message before anything else (insert-on-conflict on hd_chat_seen's key): two triggers
  // arriving together (two reactions, a mention and a reaction, an agent's action) open one ticket.
  const claimKey = `claim:${createHash("sha256").update(`${where.conversation_id}\n${message.id}`).digest("hex")}`;
  const claimed = await hqOne("INSERT INTO hd_chat_seen (app, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id", [port.app, claimKey]);
  if (!claimed) return;
  let opened = false;
  try {
    opened = await openClaimed(port, actor, message, where, teamId, how, threadRef);
  } finally {
    // Not opened (an unknown poster, no text, a limit): a later trigger may try again.
    if (!opened) await hq("DELETE FROM hd_chat_seen WHERE app = $1 AND event_id = $2", [port.app, claimKey]).catch(() => {});
  }
}

async function openClaimed(
  port: ChatPort,
  actor: ChatPerson,
  message: ChannelEvent["message"],
  where: ChannelEvent["where"],
  teamId: number | null,
  how: { by?: ChatUser; trigger: "mention" | "reaction" | "agent"; channelName?: string },
  threadRef: ConvRef
): Promise<boolean> {
  const poster = message.poster;
  const requester = poster ? await port.identify(poster, { fresh: true }).catch((e) => (fail("identify", e), null)) : null;
  if (!requester || !(await canUseHelpdesk(requester))) {
    const who = how.by ? `I couldn't find ${poster?.name || "the poster"}'s CompassDocs account, so I didn't open a ticket. Raise it from the desk instead.` : T.unknown;
    await port.whisper(threadRef, how.by ? actor : poster ?? actor, who).catch(() => {});
    return false;
  }
  if (requestCreateLimited(requester.id)) return false;
  const text = cleanText(message.text.replace(/<at>[^<]{0,200}<\/at>/gi, "").replace(/<@[UW][A-Z0-9]+>/g, "").trim());
  if (!text) {
    await port.whisper(threadRef, actor, "There's no text in that message to raise.").catch(() => {});
    return false;
  }
  const { createTicket } = await import("../tickets");
  const { addSystemMessage } = await import("../messages");
  const ticket = await createTicket(
    {
      subject: subjectOf(text),
      body: channelTicketBody(text, port.app, where, message.link),
      requester: { id: requester.id, name: requester.name || requester.username, email: requester.email },
      via: "portal",
      source: port.app,
      source_ref: { chat: port.app, channel: where.name.slice(0, 80) },
      team_id: teamId,
    },
    { actorId: how.by?.id ?? requester.id, actorName: how.by ? how.by.name || how.by.username : requester.name, origin: await helpdeskOrigin() }
  );
  if (how.by) await addSystemMessage(ticket.id, channelOpenedNote(how.by.name || how.by.username, port.app, where), { internal: true });
  await addThread(ticket.id, port.app, "channel", requester.id, where, message.id, message.link);
  const team = teamId ? (await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [teamId]))?.name : null;
  await port.post(threadRef, { kind: "text", text: `Opened **#${ticket.number}**${team ? ` for ${team}` : ""}. ${requester.name || "The requester"} will hear from the desk in a direct message.` }).catch((e) => fail("channel_reply", e));
  await audit({
    actor: how.by ? { id: how.by.id, name: how.by.name || how.by.username, role: how.by.role } : { id: requester.id, name: requester.name || requester.username, role: requester.role },
    action: "helpdesk.chat.channel_ticket",
    targetType: "helpdesk_ticket",
    targetId: ticket.id,
    targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
    details: { app: port.app, number: ticket.number, channel: where.name.slice(0, 80), trigger: how.trigger, team_id: teamId },
  });
  return true;
}

// --- Approvals ------------------------------------------------------------------------------

async function approvalCard(approvalId: number, userId: number, reminder: boolean): Promise<Extract<ChatMsg, { kind: "approval" }> | null> {
  const { getApprovalForUser } = await import("../approvals");
  const card = await getApprovalForUser({ id: userId }, approvalId);
  if (!card || !card.can_decide) return null;
  const rows: [string, string][] = card.answers.map((a) => [a.label, a.value]);
  if (!rows.length && card.body) rows.push(["Request", markdownToPlain(card.body).replace(/\s+/g, " ").slice(0, 300)]);
  return {
    kind: "approval",
    approvalId,
    requester: card.requester_name || "Someone",
    typeTitle: card.request_type_title || card.step_title || card.subject,
    number: card.ticket_number,
    rows,
    openUrl: (await abs(hdLinks.approvals())) || "https://localhost/help/approvals",
    reminder,
  };
}

/** notify.notifyApprovalNeeded's hook: a card to each approver who uses a connected app. Never throws. */
export async function sendApprovalCards(approvalId: number, approverIds: number[], reminder = false): Promise<void> {
  try {
    const s = await getChatSettings();
    for (const app of ["teams", "slack"] as const) {
      if (!appConnected(s, app) || !s[app].abilities.approve) continue;
      const port = await portFor(app, s);
      if (!port) continue;
      for (const userId of approverIds.slice(0, 50)) {
        try {
          const msg = await approvalCard(approvalId, userId, reminder);
          if (!msg) continue;
          const dm = await port.dmFor(userId);
          if (dm) await port.post(dm, msg);
        } catch (e) {
          fail("approval_card", e, { app, approval_id: approvalId });
        }
      }
    }
  } catch (e) {
    fail("approval_cards", e, { approval_id: approvalId });
  }
}

export interface ApprovalClick {
  person: ChatPerson;
  action: "approve" | "decline" | "ask";
  approvalId: number;
  text?: string;
  /** Where the card is, and its message id, to replace it after the decision. */
  ref: ConvRef;
  cardId: string;
}

export type ApprovalClickResult = { ok: true } | { ok: false; error: string };

/** A click on an approval card, decided as the clicking person's own account. */
export async function handleApprovalClick(port: ChatPort, c: ApprovalClick): Promise<ApprovalClickResult> {
  const s = await getChatSettings();
  if (!appConnected(s, port.app) || !s[port.app].abilities.approve) return { ok: false, error: `Approving in ${HD_CHAT_APP_SHORT[port.app]} is off. Open the approval in CompassDocs.` };
  // Deciding acts as the account: re-read the person from the platform first, never a cached link.
  const user = await whoIs(port, c.person, null, { fresh: true });
  const approvals = await import("../approvals");
  if (!user) return { ok: false, error: await onlyWho(c.approvalId) };
  if (approvals.approvalRateLimited(c.action === "ask" ? "question" : "decide", user.id)) return { ok: false, error: "Too many at once. Try again in a few minutes." };
  const who = { id: user.id, name: user.name, username: user.username, email: user.email };
  let outcome: "approved" | "declined" | "asked";
  if (c.action === "ask") {
    const r = await approvals.askQuestion(who, c.approvalId, c.text ?? "");
    if (!r.ok) return { ok: false, error: r.status === 404 ? await onlyWho(c.approvalId) : r.error };
    outcome = "asked";
    // The requester hears the question the way the web's Ask a question tells them (email, bell, and their chat).
    try {
      const { notifyReply } = await import("../notify");
      await notifyReply(r.ticket_id, r.message_id, { actorId: user.id, actorName: user.name || user.username });
    } catch (e) {
      fail("question_notice", e, { approval_id: c.approvalId });
    }
  } else {
    const r = await approvals.decideApproval(who, c.approvalId, { decision: c.action === "approve" ? "approved" : "declined", note: c.text ?? "" });
    if (!r.ok) return { ok: false, error: r.status === 404 ? await onlyWho(c.approvalId) : r.error };
    outcome = c.action === "approve" ? "approved" : "declined";
  }
  const t = await hqOne<{ id: number; number: number; requester_name: string }>(
    "SELECT t.id, t.number, t.requester_name FROM hd_approvals a JOIN hd_tickets t ON t.id = a.ticket_id WHERE a.id = $1",
    [c.approvalId]
  );
  await audit({
    actor: { id: user.id, name: user.name || user.username, role: user.role },
    action: "helpdesk.chat.approval_clicked",
    targetType: "helpdesk_ticket",
    targetId: t?.id ?? null,
    targetLabel: t ? `#${t.number}` : null,
    details: { app: port.app, approval_id: c.approvalId, outcome },
  });
  if (outcome !== "asked" && c.cardId) {
    const msg: ChatMsg = {
      kind: "decided",
      title: outcome === "approved" ? "Approved" : "Declined",
      text: `You ${outcome} #${t?.number ?? "?"} for ${t?.requester_name || "the requester"} in ${HD_CHAT_APP_SHORT[port.app]}.${outcome === "declined" && c.text ? ` Your note: ${c.text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
    };
    await port.update(c.ref, c.cardId, msg).catch((e) => fail("card_update", e));
  } else if (outcome === "asked") {
    await port.post(c.ref, { kind: "text", text: `Your question is on #${t?.number ?? "?"}. ${t?.requester_name || "The requester"} answers in the request.` }).catch(() => {});
  }
  return { ok: true };
}

/**
 * The quick checks before answering a Slack modal (database only, no platform call): the chat
 * account's known link and whether that account may still decide. Null when it looks fine, or
 * when the link isn't known yet (the full check, with a fresh identity, runs after the answer).
 */
export async function approvalPrecheck(app: HdChatApp, chatUserId: string, approvalId: number): Promise<string | null> {
  const link = await hqOne<{ user_id: number }>("SELECT user_id FROM hd_chat_people WHERE app = $1 AND chat_user_id = $2", [app, chatUserId]);
  if (!link) return null;
  const { getApprovalForUser } = await import("../approvals");
  const card = await getApprovalForUser({ id: link.user_id }, approvalId);
  if (!card) return onlyWho(approvalId);
  return card.can_decide ? null : "This approval has already been decided.";
}

/** "Only Ana Kowalski can decide this." (up to two names, then "or another approver"). */
async function onlyWho(approvalId: number): Promise<string> {
  const { approverUserIds } = await import("../approvals");
  const ids = await approverUserIds(approvalId).catch(() => [] as number[]);
  const names = ids.length ? (await hq<{ name: string }>("SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[]) ORDER BY id LIMIT 3", [ids])).map((r) => r.name) : [];
  if (!names.length) return "Only the approver can decide this.";
  const shown = names.slice(0, 2).join(" or ");
  return `Only ${shown}${ids.length > 2 ? " or another approver" : ""} can decide this.`;
}

// --- Desk replies back to the chat ----------------------------------------------------------

/**
 * notify.notifyReply's hook for an agent's public reply that is being sent
 * (held replies and internal notes never reach it): the reply goes to the
 * request's chat when it was raised in one and Follow and reply is on. A
 * request opened from a channel is answered in the requester's direct chat,
 * not the channel. Never throws.
 */
export async function sendDeskReply(ticketId: number, messageId: number): Promise<void> {
  try {
    const threads = await hq<{ app: HdChatApp; kind: string; user_id: number | null; service_url: string; conversation_id: string; thread_id: string }>(
      "SELECT app, kind, user_id, service_url, conversation_id, thread_id FROM hd_chat_threads WHERE ticket_id = $1 ORDER BY id DESC",
      [ticketId]
    );
    if (!threads.length) return;
    const s = await getChatSettings();
    const t = await hqOne<{ number: number; requester_id: number | null; team_name: string | null; anonymised_at: string | null; deleted_at: string | null }>(
      "SELECT t.number, t.requester_id, tm.name AS team_name, t.anonymised_at, (to_jsonb(t) ->> 'deleted_at') AS deleted_at FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id WHERE t.id = $1",
      [ticketId]
    );
    const m = await hqOne<{ author_name: string; kind: string; body: string; review_state: string | null; attachments: { name: string }[] | null }>(
      "SELECT author_name, kind, body, review_state, attachments FROM hd_messages WHERE id = $1 AND ticket_id = $2",
      [messageId, ticketId]
    );
    // Nothing is sent about a ticket in the recycle bin (1.19.4 C7).
    if (!t || !t.requester_id || t.anonymised_at || t.deleted_at || !m || m.kind !== "public" || m.review_state === "pending" || m.review_state === "returned") return;
    for (const app of ["teams", "slack"] as const) {
      if (!appConnected(s, app) || !s[app].abilities.follow) continue;
      const mine = threads.filter((x) => x.app === app);
      if (!mine.length) continue;
      const port = await portFor(app, s);
      if (!port) continue;
      try {
        // The requester's own direct chat only, re-checked before writing: the chat link must still be
        // theirs now (Slack re-reads a link older than a day), not just when the request was raised.
        const current = await port.dmFor(t.requester_id);
        if (!current) continue;
        const dmRow = mine.find((x) => x.kind === "dm" && x.user_id === t.requester_id && x.conversation_id === current.conversation_id);
        const ref: ConvRef = dmRow ? { service_url: dmRow.service_url || undefined, conversation_id: dmRow.conversation_id, thread_id: dmRow.thread_id || undefined } : current;
        const files = (m.attachments ?? []).length;
        const link = await abs(hdLinks.request(t.number));
        let body = markdownToPlain(m.body).trim();
        if (body.length > 2500) body = `${body.slice(0, 2500).trimEnd()}…`;
        const text = [
          `**${m.author_name || "The helpdesk"}${t.team_name ? ` (${t.team_name})` : ""}** replied on #${t.number}:`,
          body,
          ...(files ? [`(${files} ${files === 1 ? "file" : "files"}: open the request to see ${files === 1 ? "it" : "them"}.)`] : []),
          ...(link ? [`[Open #${t.number}](${link})`] : []),
        ].join("\n");
        const ts = await port.post(ref, { kind: "text", text });
        if (!dmRow) await addThread(ticketId, app, "dm", t.requester_id, ref, app === "slack" ? ts : "", "");
        await setFocus(app, t.requester_id, ticketId);
      } catch (e) {
        fail("desk_reply", e, { app, ticket_id: ticketId });
      }
    }
  } catch (e) {
    fail("desk_reply", e, { ticket_id: ticketId });
  }
}

/** Has this event (or activity) been handled already? Marks it handled. */
export async function seenBefore(app: HdChatApp, eventId: string): Promise<boolean> {
  if (!eventId) return false;
  if (Math.random() < 0.02) await hq("DELETE FROM hd_chat_seen WHERE at < now() - interval '1 day'").catch(() => {});
  const r = await hqOne("INSERT INTO hd_chat_seen (app, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id", [app, eventId.slice(0, 200)]);
  return !r;
}

/** Report an error to the person in the chat without saying anything internal. */
export async function apologise(port: ChatPort, ref: ConvRef, e: unknown): Promise<void> {
  fail("handler", e, { app: port.app });
  const text = e instanceof ChatHttpError ? "Something went wrong talking to the chat service. Try again in a minute." : "Something went wrong on our side. Try again in a minute, or use Get help in CompassDocs.";
  await port.post(ref, { kind: "text", text }).catch(() => {});
}

export const appLabel = (app: HdChatApp) => HD_CHAT_APP_LABEL[app];
