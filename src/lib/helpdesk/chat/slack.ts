// Helpdesk 1.19.4: Slack, through the admin's own Slack app (a bot token
// and the app's signing secret).
//
//   verify   X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing secret,
//            "v0:" + X-Slack-Request-Timestamp + ":" + raw body)), the
//            timestamp within five minutes, compared in constant time.
//            Anything else is refused before the body is read as JSON.
//   Web API  https://slack.com/api/<method> with the bot token (JSON in,
//            { ok, error } out): auth.test, users.info, users.lookupByEmail,
//            conversations.open, conversations.history/replies,
//            chat.postMessage, chat.postEphemeral, chat.update,
//            chat.getPermalink, views.open
//   render   our neutral messages as Block Kit (mrkdwn escaped)
//
// Scopes the app needs: chat:write, im:history, im:write, users:read,
// users:read.email, app_mentions:read, reactions:read, channels:history,
// groups:history, commands (for the message shortcuts). Server-only.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ChatHttpError, chatRequest } from "./http";
import type { ChatMsg } from "./types";

const SLACK_HOSTS = ["slack.com"];
export const SLACK_WINDOW_S = 300;
export const SLACK_SCOPES = ["chat:write", "im:history", "im:write", "users:read", "users:read.email", "app_mentions:read", "reactions:read", "channels:history", "commands"] as const;

// --- Signing ------------------------------------------------------------------------------

export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

/** Is this request signed by our Slack app, within five minutes? */
export function verifySlackSignature(secret: string, timestamp: string | null, body: string, signature: string | null, nowMs = Date.now()): boolean {
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SLACK_WINDOW_S) return false;
  const want = Buffer.from(slackSignature(secret, timestamp, body));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

// --- Web API ------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const SLACK_ERRORS: Record<string, string> = {
  invalid_auth: "Slack refused the bot token. Copy the Bot User OAuth Token (xoxb-…) again from the app's OAuth & Permissions page.",
  not_authed: "Slack refused the bot token. Copy the Bot User OAuth Token (xoxb-…) again.",
  token_revoked: "The bot token was revoked. Reinstall the app to the workspace and paste the new token.",
  account_inactive: "The bot token belongs to a deactivated app or workspace.",
  missing_scope: "The Slack app is missing a permission. Add the scopes listed on this page, then reinstall the app.",
  ratelimited: "Slack is limiting requests right now. Try again in a minute.",
};

/** One Web API call with the bot token; the answer's JSON when ok, else ChatHttpError with Slack's error code. */
export async function slackApi(token: string, method: string, args: Obj = {}): Promise<{ json: Obj; scopes: string[] }> {
  let res;
  try {
    res = await chatRequest({
      url: `https://slack.com/api/${method}`,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8", accept: "application/json" },
      body: JSON.stringify(args),
      label: "Slack",
      allowHosts: SLACK_HOSTS,
      secrets: [token],
    });
  } catch (e) {
    if (e instanceof ChatHttpError && e.status === 429) throw new ChatHttpError(SLACK_ERRORS.ratelimited, 429, "ratelimited");
    throw e;
  }
  const json = obj(res.json);
  if (json.ok !== true) {
    const code = typeof json.error === "string" ? json.error : "unknown_error";
    const needed = typeof json.needed === "string" ? ` (needs ${json.needed})` : "";
    throw new ChatHttpError((SLACK_ERRORS[code] ?? `Slack refused ${method}: ${code}.`) + needed, res.status, code);
  }
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { json, scopes };
}

export interface SlackMember {
  id: string;
  name: string;
  email: string;
  /** Slack says the address is confirmed (absent on older workspaces: treated as confirmed when the field is missing). */
  email_confirmed: boolean;
  deleted: boolean;
  is_bot: boolean;
  team_id: string;
}

function member(u: Obj): SlackMember {
  const p = obj(u.profile);
  return {
    id: String(u.id ?? ""),
    name: String(p.real_name || u.real_name || u.name || ""),
    email: typeof p.email === "string" ? p.email.trim().toLowerCase() : "",
    email_confirmed: u.is_email_confirmed !== false,
    deleted: u.deleted === true,
    is_bot: u.is_bot === true || u.id === "USLACKBOT",
    team_id: String(u.team_id ?? u.team ?? ""),
  };
}

export async function slackUser(token: string, userId: string): Promise<SlackMember> {
  return member(obj((await slackApi(token, "users.info", { user: userId })).json.user));
}

export async function slackUserByEmail(token: string, email: string): Promise<SlackMember | null> {
  try {
    return member(obj((await slackApi(token, "users.lookupByEmail", { email })).json.user));
  } catch (e) {
    if (e instanceof ChatHttpError && e.code === "users_not_found") return null;
    throw e;
  }
}

export async function slackOpenDm(token: string, userId: string): Promise<string> {
  const ch = obj((await slackApi(token, "conversations.open", { users: userId })).json.channel);
  if (typeof ch.id !== "string") throw new ChatHttpError("Slack didn't open a direct message.", 200);
  return ch.id;
}

export async function slackPost(token: string, channel: string, msg: ChatMsg, threadTs?: string): Promise<string> {
  const r = await slackApi(token, "chat.postMessage", { channel, ...slackBlocks(msg), ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false });
  return typeof r.json.ts === "string" ? r.json.ts : "";
}

export async function slackEphemeral(token: string, channel: string, user: string, text: string, threadTs?: string): Promise<void> {
  await slackApi(token, "chat.postEphemeral", { channel, user, text: mrkdwn(text), ...(threadTs ? { thread_ts: threadTs } : {}) });
}

export async function slackUpdate(token: string, channel: string, ts: string, msg: ChatMsg): Promise<void> {
  await slackApi(token, "chat.update", { channel, ts, ...slackBlocks(msg) });
}

export async function slackPermalink(token: string, channel: string, ts: string): Promise<string> {
  try {
    const r = await slackApi(token, "chat.getPermalink", { channel, message_ts: ts });
    const link = r.json.permalink;
    return typeof link === "string" && /^https:\/\/[a-z0-9-]+\.slack\.com\//i.test(link) ? link : "";
  } catch {
    return "";
  }
}

/** The text and poster of one message (a reaction names only its channel and ts). */
export async function slackMessage(token: string, channel: string, ts: string): Promise<{ text: string; user: string; thread_ts: string } | null> {
  const pick = (list: unknown) => (Array.isArray(list) ? list.map(obj).find((m) => m.ts === ts) : undefined);
  let m = pick((await slackApi(token, "conversations.history", { channel, latest: ts, inclusive: true, limit: 1 })).json.messages);
  if (!m) m = pick((await slackApi(token, "conversations.replies", { channel, ts, inclusive: true, limit: 1 })).json.messages);
  if (!m) return null;
  return { text: String(m.text ?? ""), user: String(m.user ?? ""), thread_ts: String(m.thread_ts ?? "") };
}

export async function slackOpenView(token: string, triggerId: string, view: Obj): Promise<void> {
  await slackApi(token, "views.open", { trigger_id: triggerId, view });
}

// --- Rendering ----------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Our small Markdown as Slack mrkdwn: **b** → *b*, [l](u) → <u|l>, the rest escaped. */
export function mrkdwn(md: string): string {
  const out: string[] = [];
  const re = /\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]{1,2000})\)|\*\*([^*\n]{1,500})\*\*/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    out.push(esc(md.slice(last, m.index)));
    if (m[1] !== undefined) out.push(`<${m[2].replace(/[<>|]/g, "")}|${esc(m[1]).replace(/\|/g, "¦")}>`);
    else out.push(`*${esc(m[3])}*`);
    last = m.index + m[0].length;
  }
  out.push(esc(md.slice(last)));
  return out.join("");
}

/** Plain text for notifications (Slack's `text` beside blocks). */
const plain = (md: string) => md.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https:[^)]+)\)/g, "$1").slice(0, 3000);

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: mrkdwn(text).slice(0, 3000) } });
const button = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text, emoji: false },
  action_id,
  value,
  ...(style ? { style } : {}),
});

export function slackBlocks(msg: ChatMsg): { text: string; blocks?: unknown[] } {
  switch (msg.kind) {
    case "text":
      return { text: mrkdwn(msg.text).slice(0, 39_000) };
    case "confirm":
      return {
        text: "Raise a request?",
        blocks: [
          section(`**Raise a request?**\n${msg.subtitle}`),
          section(`${msg.device ? `**Device** ${msg.device}\n` : ""}**What's wrong** ${msg.body.slice(0, 600)}`),
          { type: "actions", block_id: "cd_confirm", elements: [button("Raise request", "cd_raise", msg.draftId, "primary"), button("Edit", "cd_edit", msg.draftId)] },
        ],
      };
    case "approval": {
      const rows = msg.rows.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${esc(k)}*\n${esc(v.slice(0, 300))}` }));
      return {
        text: `${msg.requester} needs your approval: #${msg.number}`,
        blocks: [
          section(`**${msg.reminder ? "Reminder: approval" : "Approval"} needed**\n${msg.requester} asks for **${msg.typeTitle}** · #${msg.number}`),
          ...(rows.length ? [{ type: "section", fields: rows }] : []),
          {
            type: "actions",
            block_id: "cd_approval",
            elements: [
              button("Approve", "cd_approve", String(msg.approvalId), "primary"),
              button("Decline…", "cd_decline", String(msg.approvalId)),
              button("Ask a question", "cd_ask", String(msg.approvalId)),
              { type: "button", text: { type: "plain_text", text: "Open" }, action_id: "cd_open", url: msg.openUrl },
            ],
          },
        ],
      };
    }
    case "decided":
      return { text: plain(`${msg.title}: ${msg.text}`), blocks: [section(`**${msg.title}**\n${msg.text}`)] };
  }
}

/** A modal asking for one piece of text (Decline… and Ask a question). */
export function textModal(callbackId: string, title: string, label: string, submit: string, meta: Obj, max: number): Obj {
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: title.slice(0, 24) },
    submit: { type: "plain_text", text: submit.slice(0, 24) },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "text", label: { type: "plain_text", text: label.slice(0, 2000) }, element: { type: "plain_text_input", action_id: "v", multiline: true, max_length: max } }],
  };
}

/** The Edit modal of a "Raise a request?" card. */
export function editModal(meta: Obj, d: Extract<ChatMsg, { kind: "confirm" }>): Obj {
  const opt = (text: string, value: string) => ({ text: { type: "plain_text", text: text.slice(0, 75) }, value });
  const typeOpts = [opt("Something else", "0"), ...d.types.slice(0, 99).map((t) => opt(t.title, String(t.id)))];
  const devOpts = [opt("Not about one of my devices", "0"), ...d.devices.slice(0, 99).map((x) => opt(x.label, String(x.id)))];
  const initial = (opts: ReturnType<typeof opt>[], id: number | null) => opts.find((o) => o.value === String(id ?? 0)) ?? opts[0];
  return {
    type: "modal",
    callback_id: "cd_edit",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Raise a request" },
    submit: { type: "plain_text", text: "Raise request" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "type", label: { type: "plain_text", text: "What kind of request" }, element: { type: "static_select", action_id: "v", options: typeOpts, initial_option: initial(typeOpts, d.typeId) } },
      ...(d.devices.length
        ? [{ type: "input", block_id: "device", label: { type: "plain_text", text: "Device" }, element: { type: "static_select", action_id: "v", options: devOpts, initial_option: initial(devOpts, d.assetId) } }]
        : []),
      { type: "input", block_id: "body", label: { type: "plain_text", text: "What's wrong" }, element: { type: "plain_text_input", action_id: "v", multiline: true, max_length: 3000, initial_value: d.body.slice(0, 3000) } },
    ],
  };
}
