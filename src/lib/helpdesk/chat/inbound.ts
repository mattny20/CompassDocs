// Helpdesk 1.19.4: the two endpoints the chat platforms call.
//
//   POST /api/helpdesk/chat/teams/messages   Bot Framework activities
//   POST /api/helpdesk/chat/slack/events     Slack Events API and
//                                            Interactivity (one Request URL)
//
// Each request is checked before anything is read as data: the app must be
// connected (a disconnected app reads nothing), the body at most 256 KB,
// then the platform's proof (Teams: the Bot Framework JWT, the tenant;
// Slack: the signing secret over v0:timestamp:body within five minutes, and
// the workspace). Anything that fails is 401 and never processed. A
// verified request is answered at once (Slack wants an answer within three
// seconds) and the work runs after the response (`work`, which the routes
// hand to next/server's after()); a retried event is recognised by its id
// and done once. Server-only.

import "server-only";
import { createHash } from "node:crypto";
import { logEvent } from "../../log";
import { helpdeskLicensed } from "../access";
import { CHAT_LIMITS, type HdChatApp } from "../chat-shared";
import {
  apologise,
  channelFor,
  approvalPrecheck,
  draftForEdit,
  handleApprovalClick,
  handleChannelEvent,
  handleDm,
  handleMessageAction,
  portFor,
  raiseFromDraft,
  rememberPerson,
  seenBefore,
  type ChatPort,
} from "./core";
import { ChatHttpError } from "./http";
import { appConnected, getChatSettings, pinSlackTeam } from "./settings";
import type { ChatPerson, ConvRef } from "./types";

export interface ChatHttpResult {
  status: number;
  /** JSON to answer with; undefined = an empty body. */
  body?: unknown;
  /** What to do once the answer has gone. */
  work?: () => Promise<void>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, max = 8_000): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

class TooLarge extends Error {}

async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > CHAT_LIMITS.bodyBytes) throw new TooLarge();
  const text = await req.text();
  if (Buffer.byteLength(text) > CHAT_LIMITS.bodyBytes) throw new TooLarge();
  return text;
}

const refused = (app: HdChatApp, reason: string): ChatHttpResult => {
  logEvent("warn", "helpdesk.chat_rejected", { app, reason });
  return { status: 401, body: { error: "Unauthorized." } };
};

function guarded(app: HdChatApp, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      logEvent("error", "helpdesk.chat_failed", { app, where: "work", error: e instanceof Error ? e.message : String(e) });
    }
  };
}

// --- Microsoft Teams ----------------------------------------------------------------------

/** Teams text is lightly HTML ("<p>…</p>", "<at>CompassDocs</at>"): the words only. */
/** A Teams replay key: activity ids are unique only within a conversation, so the conversation is part of it. */
export function replayKey(type: string, conversationId: string, activityId: string): string {
  return `${type}:${createHash("sha256").update(`${conversationId}\n${activityId}`).digest("hex")}`;
}

export function teamsPlain(raw: string): string {
  return raw
    .replace(/<at>[^<]{0,200}<\/at>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]{0,500}>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleTeamsRequest(req: Request): Promise<ChatHttpResult> {
  const s = await getChatSettings();
  if (!appConnected(s, "teams")) return refused("teams", "not_connected");
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e instanceof TooLarge) return { status: 413, body: { error: "Too large." } };
    throw e;
  }
  let activity: Obj;
  try {
    activity = obj(JSON.parse(raw));
  } catch {
    // Unread (not JSON): refused like an unverified one, without a lookup.
    return refused("teams", "not_json");
  }
  const serviceUrl = str(activity.serviceUrl, 500);
  const channelId = str(activity.channelId, 50);
  const { verifyBotToken } = await import("./teams");
  let verdict;
  try {
    verdict = await verifyBotToken(req.headers.get("authorization"), { appId: s.teams.app_id, serviceUrl, channelId });
  } catch (e) {
    // Microsoft's keys couldn't be read: nothing is processed; the Bot Connector retries.
    logEvent("warn", "helpdesk.chat_rejected", { app: "teams", reason: "keys_unavailable", error: e instanceof ChatHttpError ? e.message : "keys" });
    return { status: 503, body: { error: "Try again shortly." } };
  }
  if (!verdict.ok) return refused("teams", verdict.reason);
  if (channelId !== "msteams") return refused("teams", "channel");
  const conv = obj(activity.conversation);
  const channelData = obj(activity.channelData);
  const tenant = str(conv.tenantId, 100) || str(obj(channelData.tenant).id, 100);
  // Always compared: the saved tenant is a GUID (settings refuse anything else), and an activity without one is refused.
  if (!GUID_RE.test(s.teams.tenant_id) || !tenant || tenant.toLowerCase() !== s.teams.tenant_id.toLowerCase()) return refused("teams", "tenant");
  if (!(await helpdeskLicensed())) return { status: 402, body: { error: "The helpdesk is not included in your licence." } };

  const type = str(activity.type, 50);
  const activityId = str(activity.id, 300);
  const from = obj(activity.from);
  const person: ChatPerson = { app: "teams", id: str(from.aadObjectId, 100), name: str(from.name, 200), platform_id: str(from.id, 300) };
  const convType = str(conv.conversationType, 30);
  const convId = str(conv.id, 500);
  const ref: ConvRef = { service_url: serviceUrl, conversation_id: convId };
  const port = (await portFor("teams", s)) as ChatPort;

  if (type === "invoke") {
    const name = str(activity.name, 100);
    if (name !== "composeExtension/fetchTask" && name !== "composeExtension/submitAction") return { status: 200, body: {} };
    const v = obj(activity.value);
    const command = str(v.commandId, 60).toLowerCase();
    const mp = obj(v.messagePayload);
    const mUser = obj(obj(mp.from).user);
    const base = convId.split(";")[0];
    const msgId = str(mp.id, 100);
    const rootId = str(mp.replyToId, 100) || msgId;
    const channel = obj(channelData.channel);
    const channelKey = str(channel.id, 300);
    const cfg = s.channels.find((c) => c.app === "teams" && c.channel_id === channelKey);
    const where = {
      service_url: serviceUrl,
      conversation_id: convType === "channel" && rootId ? `${base};messageid=${rootId}` : convId,
      channel_id: channelKey || base,
      name: cfg?.name || str(channel.name, 80) || "the channel",
    };
    const ev = {
      person,
      command: command === "maketicket" || command === "make_ticket" ? ("make_ticket" as const) : ("get_help" as const),
      message: {
        text: teamsPlain(str(obj(mp.body).content)),
        poster: mUser.id || mUser.aadObjectId ? { app: "teams" as const, id: str(mUser.aadObjectId, 100) || str(mUser.id, 100), name: str(mUser.displayName, 200) } : null,
        id: msgId,
        link: /^https:\/\/teams\.microsoft\.com\//.test(str(mp.linkToMessage, 2000)) ? str(mp.linkToMessage, 2000) : "",
      },
      where,
    };
    const answer = ev.command === "make_ticket" ? "Turning that into a ticket: the number appears in the thread." : "Check your chat with CompassDocs to confirm the request.";
    if (activityId && (await seenBefore("teams", replayKey("invoke", convId, activityId)))) return { status: 200, body: { task: { type: "message", value: answer } } };
    return {
      status: 200,
      body: name === "composeExtension/fetchTask" ? { task: { type: "message", value: answer } } : {},
      work: guarded("teams", () => handleMessageAction(port, ev)),
    };
  }

  if (activityId && (await seenBefore("teams", replayKey(type, convId, activityId)))) return { status: 200 };

  if ((type === "conversationUpdate" || type === "installationUpdate") && convType === "personal" && person.id) {
    // The app was added for this person (an admin installing it for everyone does this for each person): keep the direct chat.
    return {
      status: 200,
      work: guarded("teams", async () => {
        const user = await port.identify(person);
        if (user) await rememberPerson("teams", person.id, user.id, { ...ref, platform_id: person.platform_id });
      }),
    };
  }

  if (type !== "message") return { status: 200 };
  const value = obj(activity.value);
  const cd = str(value.cd, 20);
  if (cd) {
    const replyTo = str(activity.replyToId, 300);
    if (cd === "raise") {
      const edits = value.edited ? { type_id: num(value.type), asset_id: num(value.device), body: str(value.body, CHAT_LIMITS.text + 100) } : null;
      return { status: 200, work: guarded("teams", () => raiseFromDraft(port, person, str(value.d, 64), edits, ref).catch((e) => apologise(port, ref, e))) };
    }
    if (cd === "approve" || cd === "decline" || cd === "ask") {
      const approvalId = num(value.a);
      if (!approvalId) return { status: 200 };
      const text = cd === "decline" ? str(value.note, 2_100) : cd === "ask" ? str(value.question, 5_100) : "";
      return {
        status: 200,
        work: guarded("teams", async () => {
          const r = await handleApprovalClick(port, { person, action: cd, approvalId, text, ref, cardId: replyTo });
          if (!r.ok) await port.post(ref, { kind: "text", text: r.error });
        }),
      };
    }
    return { status: 200 };
  }
  const text = teamsPlain(str(activity.text, CHAT_LIMITS.text * 2));
  if (convType === "personal") {
    if (!person.id) return { status: 200 };
    return { status: 200, work: guarded("teams", () => handleDm(port, { person, text, ref }).catch((e) => apologise(port, ref, e))) };
  }
  if (convType === "channel") {
    const recipient = str(obj(activity.recipient).id, 300);
    const mentioned = (Array.isArray(activity.entities) ? activity.entities : []).some((x) => obj(x).type === "mention" && str(obj(obj(x).mentioned).id, 300) === recipient);
    if (!mentioned || !person.id) return { status: 200 };
    const channel = obj(channelData.channel);
    const channelKey = str(channel.id, 300);
    const base = convId.split(";")[0];
    const m = /;messageid=(\d+)/.exec(convId);
    const rootId = m ? m[1] : activityId;
    const cfg = channelFor(s, "teams", channelKey, "mention");
    const ev = {
      person,
      trigger: "mention" as const,
      message: { text, poster: person, id: activityId, link: channelKey && activityId ? `https://teams.microsoft.com/l/message/${encodeURIComponent(channelKey)}/${encodeURIComponent(activityId)}` : "" },
      where: { service_url: serviceUrl, conversation_id: `${base};messageid=${rootId}`, channel_id: channelKey, name: cfg?.name || str(channel.name, 80) || "the channel" },
    };
    return { status: 200, work: guarded("teams", () => handleChannelEvent(port, ev)) };
  }
  // A group chat: the app answers people one to one.
  if (person.id && text) {
    return { status: 200, work: guarded("teams", () => port.post(ref, { kind: "text", text: "Message me directly to raise a request." }).then(() => {})) };
  }
  return { status: 200 };
}

// --- Slack --------------------------------------------------------------------------------

export async function handleSlackRequest(req: Request): Promise<ChatHttpResult> {
  const s = await getChatSettings();
  if (!appConnected(s, "slack")) return refused("slack", "not_connected");
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e instanceof TooLarge) return { status: 413, body: { error: "Too large." } };
    throw e;
  }
  const { verifySlackSignature } = await import("./slack");
  if (!verifySlackSignature(s.slack.signing_secret, req.headers.get("x-slack-request-timestamp"), raw, req.headers.get("x-slack-signature"))) return refused("slack", "signature");
  const form = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  let body: Obj;
  try {
    body = form ? obj(JSON.parse(new URLSearchParams(raw).get("payload") ?? "")) : obj(JSON.parse(raw));
  } catch {
    return { status: 400, body: { error: "Not JSON." } };
  }
  if (!form && body.type === "url_verification") return { status: 200, body: { challenge: str(body.challenge, 200) } };
  const team = form ? str(obj(body.team).id, 40) || str(obj(obj(body.user)).team_id, 40) : str(body.team_id, 40);
  if (s.slack.team_id && team && team !== s.slack.team_id) return refused("slack", "workspace");
  if (!s.slack.team_id && team) await pinSlackTeam(team);
  if (!(await helpdeskLicensed())) return { status: 402, body: { error: "The helpdesk is not included in your licence." } };
  const port = (await portFor("slack", s)) as ChatPort;
  return form ? slackInteraction(port, s, body) : slackEvent(port, s, body);
}

async function slackEvent(port: ChatPort, s: Awaited<ReturnType<typeof getChatSettings>>, body: Obj): Promise<ChatHttpResult> {
  if (body.type !== "event_callback") return { status: 200 };
  if (await seenBefore("slack", str(body.event_id, 100))) return { status: 200 };
  const e = obj(body.event);
  const user = str(e.user, 40);
  const person: ChatPerson = { app: "slack", id: user, name: "" };
  const type = str(e.type, 40);
  if (type === "message") {
    if (e.channel_type !== "im" || e.subtype || e.bot_id || !user || user === s.slack.bot_user_id) return { status: 200 };
    const channel = str(e.channel, 40);
    const ts = str(e.ts, 40);
    const threadTs = str(e.thread_ts, 40);
    const ref: ConvRef = { conversation_id: channel };
    const replyRef: ConvRef = threadTs && threadTs !== ts ? { conversation_id: channel, thread_id: threadTs } : ref;
    return {
      status: 200,
      work: guarded("slack", () => handleDm(port, { person, text: slackPlain(str(e.text)), ref: replyRef, threadTs: threadTs && threadTs !== ts ? threadTs : undefined }).catch((err) => apologise(port, replyRef, err))),
    };
  }
  if (type === "app_mention") {
    if (!user || e.bot_id) return { status: 200 };
    const channel = str(e.channel, 40);
    const ts = str(e.ts, 40);
    const cfg = channelFor(s, "slack", channel, "mention");
    return {
      status: 200,
      work: guarded("slack", async () => {
        const { slackPermalink } = await import("./slack");
        const link = await slackPermalink(s.slack.bot_token, channel, ts);
        await handleChannelEvent(port, {
          person,
          trigger: "mention",
          message: { text: slackPlain(str(e.text)), poster: person, id: ts, link },
          where: { conversation_id: channel, thread_id: str(e.thread_ts, 40) || ts, channel_id: channel, name: cfg?.name || channel },
        });
      }),
    };
  }
  if (type === "reaction_added") {
    const item = obj(e.item);
    const channel = str(item.channel, 40);
    const ts = str(item.ts, 40);
    const reaction = str(e.reaction, 60).split("::")[0];
    // Only a configured channel and reaction reads the message.
    const cfg = channelFor(s, "slack", channel, "reaction", reaction);
    if (item.type !== "message" || !cfg || !user) return { status: 200 };
    return {
      status: 200,
      work: guarded("slack", async () => {
        const sl = await import("./slack");
        const m = await sl.slackMessage(s.slack.bot_token, channel, ts);
        if (!m || !m.user) return;
        const link = await sl.slackPermalink(s.slack.bot_token, channel, ts);
        await handleChannelEvent(port, {
          person,
          trigger: "reaction",
          reaction,
          message: { text: slackPlain(m.text), poster: { app: "slack", id: m.user, name: "" }, id: ts, link },
          where: { conversation_id: channel, thread_id: m.thread_ts || ts, channel_id: channel, name: cfg.name },
        });
      }),
    };
  }
  return { status: 200 };
}

/** Slack text: <@U…> mentions dropped, <url|label> to label, entities unescaped. */
export function slackPlain(raw: string): string {
  return raw
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!([a-z]+)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function slackInteraction(port: ChatPort, s: Awaited<ReturnType<typeof getChatSettings>>, p: Obj): Promise<ChatHttpResult> {
  const type = str(p.type, 40);
  const person: ChatPerson = { app: "slack", id: str(obj(p.user).id, 40), name: str(obj(p.user).name, 200) };
  if (!person.id) return { status: 200 };
  const sl = await import("./slack");
  const token = s.slack.bot_token;

  if (type === "block_actions") {
    const a = obj(Array.isArray(p.actions) ? p.actions[0] : null);
    const actionId = str(a.action_id, 40);
    const value = str(a.value, 100);
    const channel = str(obj(p.channel).id, 40) || str(obj(p.container).channel_id, 40);
    const ts = str(obj(p.message).ts, 40) || str(obj(p.container).message_ts, 40);
    const trigger = str(p.trigger_id, 200);
    const ref: ConvRef = { conversation_id: channel };
    switch (actionId) {
      case "cd_raise":
        return { status: 200, work: guarded("slack", () => raiseFromDraft(port, person, value, null, ref).catch((e) => apologise(port, ref, e))) };
      case "cd_edit":
        return {
          status: 200,
          work: guarded("slack", async () => {
            const user = await port.identify(person);
            const d = user ? await draftForEdit("slack", user.id, value) : null;
            if (!d) return;
            await sl.slackOpenView(token, trigger, sl.editModal({ d: value, c: channel }, d));
          }),
        };
      case "cd_approve":
        return {
          status: 200,
          work: guarded("slack", async () => {
            const r = await handleApprovalClick(port, { person, action: "approve", approvalId: Number(value) || 0, ref, cardId: ts });
            if (!r.ok) await port.whisper(ref, person, r.error);
          }),
        };
      case "cd_decline":
      case "cd_ask": {
        const decline = actionId === "cd_decline";
        const modal = decline
          ? sl.textModal("cd_decline", "Decline", "Why are you declining? The requester sees this.", "Decline", { a: Number(value) || 0, c: channel, ts }, 2000)
          : sl.textModal("cd_ask", "Ask a question", "Your question. The requester answers in the request.", "Send question", { a: Number(value) || 0, c: channel, ts }, 5000);
        return { status: 200, work: guarded("slack", () => sl.slackOpenView(token, trigger, modal)) };
      }
      default:
        return { status: 200 };
    }
  }

  if (type === "message_action") {
    const cb = str(p.callback_id, 60);
    if (cb !== "cd_get_help" && cb !== "cd_make_ticket") return { status: 200 };
    const m = obj(p.message);
    const ch = obj(p.channel);
    const channel = str(ch.id, 40);
    const ts = str(m.ts, 40);
    const cfg = s.channels.find((c) => c.app === "slack" && c.channel_id === channel);
    return {
      status: 200,
      work: guarded("slack", async () => {
        const link = await sl.slackPermalink(token, channel, ts);
        await handleMessageAction(port, {
          person,
          command: cb === "cd_make_ticket" ? "make_ticket" : "get_help",
          message: { text: slackPlain(str(m.text)), poster: str(m.user, 40) ? { app: "slack", id: str(m.user, 40), name: "" } : null, id: ts, link },
          where: { conversation_id: channel, thread_id: str(m.thread_ts, 40) || ts, channel_id: channel, name: cfg?.name || str(ch.name, 80) || channel },
        });
      }),
    };
  }

  if (type === "view_submission") {
    const view = obj(p.view);
    const cb = str(view.callback_id, 40);
    let meta: Obj = {};
    try {
      meta = obj(JSON.parse(str(view.private_metadata, 3000) || "{}"));
    } catch {
      meta = {};
    }
    const values = obj(obj(view.state).values);
    const input = (block: string) => obj(obj(values[block]).v);
    const ref: ConvRef = { conversation_id: str(meta.c, 40) };
    if (cb === "cd_decline" || cb === "cd_ask") {
      const text = str(input("text").value, 5_100);
      const action = cb === "cd_decline" ? ("decline" as const) : ("ask" as const);
      const approvalId = Number(meta.a) || 0;
      if (!text.trim()) return { status: 200, body: { response_action: "errors", errors: { text: action === "decline" ? "Say why you're declining: the requester sees your note." : "Write your question." } } };
      // Slack wants an answer within 3 seconds: only database checks here (the person's known link,
      // whether they may still decide); the decision itself runs after the answer, and a later
      // refusal reaches them as a line only they see.
      const pre = await approvalPrecheck("slack", person.id, approvalId);
      if (pre) return { status: 200, body: { response_action: "errors", errors: { text: pre } } };
      return {
        status: 200,
        body: { response_action: "clear" },
        work: guarded("slack", async () => {
          const r = await handleApprovalClick(port, { person, action, approvalId, text, ref, cardId: str(meta.ts, 40) });
          if (!r.ok) await port.whisper(ref, person, r.error);
        }),
      };
    }
    if (cb === "cd_edit") {
      const sel = (block: string) => Number(str(obj(input(block).selected_option).value, 20)) || null;
      const edits = { type_id: sel("type"), asset_id: values.device ? sel("device") : undefined, body: str(input("body").value, CHAT_LIMITS.text + 100) };
      if (!edits.body.trim()) return { status: 200, body: { response_action: "errors", errors: { body: "Say what's wrong." } } };
      return { status: 200, body: { response_action: "clear" }, work: guarded("slack", () => raiseFromDraft(port, person, str(meta.d, 64), edits, ref).catch((e) => apologise(port, ref, e))) };
    }
    return { status: 200 };
  }
  return { status: 200 };
}
