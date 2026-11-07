// Helpdesk 1.19.4: Microsoft Teams, through the admin's own Azure Bot
// registration (Bot Framework). Three jobs:
//
//   verify   every activity's `Authorization: Bearer <JWT>` (RS256): the
//            signing keys come from the OpenID metadata at
//            login.botframework.com (jwks_uri on that host only) and are
//            cached until the answer's max-age (24 hours when none; a key
//            id we don't know refetches at most every 5 minutes). The
//            key's endorsements must include the activity's channelId,
//            iss = https://api.botframework.com, aud = the bot's app ID,
//            exp/nbf with 5 minutes of skew, and the serviceurl claim must
//            equal the activity's serviceUrl. Anything else is refused.
//   token    the bot's own token for the Bot Connector (client
//            credentials at login.microsoftonline.com/<tenant>, scope
//            https://api.botframework.com/.default), cached until five
//            minutes before it expires
//   send     POST {serviceUrl}/v3/conversations/{id}/activities (and PUT
//            …/activities/{activityId} to replace a card after a click),
//            only to serviceUrls on Microsoft's Bot Framework hosts
//
// Cards are Adaptive Cards 1.4 with Action.Submit (the click comes back as
// a message activity whose `value` holds the data and any typed input).
// Server-only.

import "server-only";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { ChatHttpError, chatRequest } from "./http";
import type { TeamsSettings } from "./settings";
import type { ChatMsg, ConvRef } from "./types";

export const BOTFRAMEWORK_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOTFRAMEWORK_ISSUER = "https://api.botframework.com";
const OPENID_HOSTS = ["login.botframework.com"];
const LOGIN_HOSTS = ["login.microsoftonline.com"];
/** Where Microsoft's Bot Connector lives (public cloud and the government clouds). */
export const SERVICE_HOSTS = [".trafficmanager.net", ".botframework.com", ".botframework.us", ".botframework.azure.us", ".teams.microsoft.com", ".teams.microsoft.us"];
const SKEW_S = 300;

// --- Inbound: the Bot Framework JWT ---------------------------------------------------

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  endorsements?: string[];
}

let keyCache: { keys: Map<string, Jwk>; expiresAt: number; fetchedAt: number } | null = null;
let loading: Promise<void> | null = null;

/** Tests: forget the cached signing keys. */
export function resetTeamsKeysForTests(): void {
  keyCache = null;
  loading = null;
  tokenCache.clear();
}

function maxAgeMs(h: Headers): number {
  const m = /max-age=(\d+)/i.exec(h.get("cache-control") ?? "");
  const s = m ? Number(m[1]) : 86_400;
  return Math.min(5 * 86_400, Math.max(300, s)) * 1000;
}

async function fetchKeys(): Promise<void> {
  const meta = await chatRequest({ url: BOTFRAMEWORK_OPENID, label: "Microsoft", allowHosts: OPENID_HOSTS });
  const jwksUri = (meta.json as { jwks_uri?: unknown } | null)?.jwks_uri;
  if (typeof jwksUri !== "string") throw new ChatHttpError("Microsoft's sign-in metadata had no keys address.", 0);
  const res = await chatRequest({ url: jwksUri, label: "Microsoft", allowHosts: OPENID_HOSTS });
  const list = (res.json as { keys?: unknown } | null)?.keys;
  const keys = new Map<string, Jwk>();
  for (const k of Array.isArray(list) ? list : []) {
    const j = k as Jwk;
    if (j && typeof j.kid === "string" && j.kty === "RSA" && typeof j.n === "string" && typeof j.e === "string") keys.set(j.kid, j);
  }
  keyCache = { keys, expiresAt: Date.now() + maxAgeMs(res.headers), fetchedAt: Date.now() };
}

/** Read the signing keys now (Test); how many there are. */
export async function refreshTeamsKeys(): Promise<number> {
  await fetchKeys();
  return keyCache?.keys.size ?? 0;
}

async function signingKey(kid: string): Promise<Jwk | null> {
  const now = Date.now();
  const stale = !keyCache || keyCache.expiresAt <= now;
  const unknown = !!keyCache && !keyCache.keys.has(kid) && now - keyCache.fetchedAt > 300_000;
  if (stale || unknown) {
    loading ??= fetchKeys().finally(() => {
      loading = null;
    });
    await loading;
  }
  return keyCache?.keys.get(kid) ?? null;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, "").toLowerCase();

export type TeamsVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verify the Bot Connector's token for one activity. Never throws for a bad
 * token (a verdict with the reason, for the log); throws ChatHttpError only
 * when Microsoft's keys can't be read at all.
 */
export async function verifyBotToken(
  authorization: string | null,
  expect: { appId: string; serviceUrl: string; channelId: string },
  nowMs = Date.now()
): Promise<TeamsVerdict> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec((authorization ?? "").trim());
  if (!m) return { ok: false, reason: "no_token" };
  const header = b64urlJson(m[1]);
  const claims = b64urlJson(m[2]);
  if (!header || !claims) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "alg" };
  const jwk = await signingKey(header.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  if (Array.isArray(jwk.endorsements) && expect.channelId && !jwk.endorsements.includes(expect.channelId)) return { ok: false, reason: "endorsement" };
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    good = cryptoVerify("RSA-SHA256", Buffer.from(`${m[1]}.${m[2]}`), key, Buffer.from(m[3], "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "signature" };
  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== BOTFRAMEWORK_ISSUER) return { ok: false, reason: "issuer" };
  const aud = claims.aud;
  if (!expect.appId || !(aud === expect.appId || (Array.isArray(aud) && aud.includes(expect.appId)))) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) return { ok: false, reason: "not_yet" };
  const su = claims.serviceurl ?? claims.serviceUrl;
  if (typeof su !== "string" || !expect.serviceUrl || trimSlash(su) !== trimSlash(expect.serviceUrl)) return { ok: false, reason: "service_url" };
  return { ok: true };
}

// --- Outbound: the bot's token and the Bot Connector -------------------------------------

const tokenCache = new Map<string, { token: string; until: number }>();

function tokenKey(s: TeamsSettings): string {
  return createHash("sha256").update(`${s.app_id}|${s.tenant_id}|${s.secret}`).digest("hex");
}

/** The bot's access token for the Bot Connector (client credentials). */
export async function botToken(s: TeamsSettings, opts: { fresh?: boolean } = {}): Promise<string> {
  const key = tokenKey(s);
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now() && !opts.fresh) return hit.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: s.app_id, client_secret: s.secret, scope: "https://api.botframework.com/.default" });
  let res;
  try {
    res = await chatRequest({
      url: `https://login.microsoftonline.com/${encodeURIComponent(s.tenant_id)}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      label: "Microsoft",
      allowHosts: LOGIN_HOSTS,
      secrets: [s.secret],
    });
  } catch (e) {
    if (e instanceof ChatHttpError && (e.code === "invalid_client" || e.code === "unauthorized_client")) {
      throw new ChatHttpError("Microsoft refused the app ID and client secret. Check the secret hasn't expired, and that the app ID is the bot's Microsoft App ID.", e.status, e.code);
    }
    if (e instanceof ChatHttpError && e.code === "invalid_request") {
      throw new ChatHttpError("Microsoft didn't recognise that tenant for this app. Check the tenant ID, and that the bot is single tenant in that tenant.", e.status, e.code);
    }
    throw e;
  }
  const j = (res.json ?? {}) as { access_token?: unknown; expires_in?: unknown };
  if (typeof j.access_token !== "string") throw new ChatHttpError("Microsoft didn't send a token.", res.status);
  const ttl = Math.max(60, Number(j.expires_in) || 3600);
  tokenCache.set(key, { token: j.access_token, until: Date.now() + (ttl - 300) * 1000 });
  if (tokenCache.size > 20) tokenCache.delete(tokenCache.keys().next().value!);
  return j.access_token;
}

/** Is this a Bot Connector address we may send the bot's token to? */
export function serviceUrlAllowed(serviceUrl: string): boolean {
  try {
    const u = new URL(serviceUrl);
    return u.protocol === "https:" && SERVICE_HOSTS.some((h) => u.hostname.toLowerCase().endsWith(h));
  } catch {
    return false;
  }
}

async function connector(s: TeamsSettings, ref: ConvRef, path: string, method: "POST" | "PUT", activity: Record<string, unknown>): Promise<string> {
  if (!ref.service_url || !serviceUrlAllowed(ref.service_url)) throw new ChatHttpError("That Teams conversation isn't on a Bot Framework address.", 0);
  const base = ref.service_url.replace(/\/+$/, "");
  const call = async (fresh: boolean) =>
    chatRequest({
      url: `${base}/v3/conversations/${encodeURIComponent(ref.conversation_id)}/activities${path}`,
      method,
      headers: { authorization: `Bearer ${await botToken(s, { fresh })}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activity),
      label: "Microsoft Teams",
      allowHosts: SERVICE_HOSTS,
    });
  let res;
  try {
    res = await call(false);
  } catch (e) {
    // A token revoked early: one fresh try.
    if (!(e instanceof ChatHttpError) || e.status !== 401) throw e;
    res = await call(true);
  }
  const id = (res.json as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
}

/** Post a message (or card) into a conversation; returns the new activity's id. */
export async function teamsPost(s: TeamsSettings, ref: ConvRef, msg: ChatMsg): Promise<string> {
  const activity = teamsActivity(msg);
  if (ref.thread_id) activity.replyToId = ref.thread_id;
  return connector(s, ref, ref.thread_id ? `/${encodeURIComponent(ref.thread_id)}` : "", "POST", activity);
}

/** Replace a message the bot sent (an approval card after the decision). */
export async function teamsUpdate(s: TeamsSettings, ref: ConvRef, activityId: string, msg: ChatMsg): Promise<void> {
  await connector(s, ref, `/${encodeURIComponent(activityId)}`, "PUT", { ...teamsActivity(msg), id: activityId });
}

// --- Rendering ----------------------------------------------------------------------------

/** Teams reads Markdown; our text is already Markdown (bold, links, "•" lines). Line breaks need two spaces or a blank line. */
const teamsText = (t: string) => t.replace(/\n(?!\n)/g, "\n\n");

const tb = (text: string, extra: Record<string, unknown> = {}) => ({ type: "TextBlock", text, wrap: true, ...extra });

function card(body: unknown[], actions: unknown[] = []): Record<string, unknown> {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body, ...(actions.length ? { actions } : {}) },
      },
    ],
  };
}

/** One message in the Bot Framework's activity shape. */
export function teamsActivity(msg: ChatMsg): Record<string, unknown> {
  switch (msg.kind) {
    case "text":
      return { type: "message", textFormat: "markdown", text: teamsText(msg.text) };
    case "confirm": {
      const facts = [
        ...(msg.device ? [{ title: "Device", value: msg.device }] : []),
        { title: "What's wrong", value: msg.body.slice(0, 600) },
      ];
      return card(
        [
          tb("Raise a request?", { weight: "Bolder", size: "Medium" }),
          tb(msg.subtitle, { isSubtle: true, spacing: "None" }),
          { type: "FactSet", facts },
        ],
        [
          { type: "Action.Submit", title: "Raise request", style: "positive", data: { cd: "raise", d: msg.draftId } },
          {
            type: "Action.ShowCard",
            title: "Edit",
            card: {
              type: "AdaptiveCard",
              body: [
                {
                  type: "Input.ChoiceSet",
                  id: "type",
                  label: "What kind of request",
                  value: msg.typeId ? String(msg.typeId) : "",
                  choices: [{ title: "Something else", value: "" }, ...msg.types.map((t) => ({ title: t.title, value: String(t.id) }))],
                },
                ...(msg.devices.length
                  ? [
                      {
                        type: "Input.ChoiceSet",
                        id: "device",
                        label: "Device",
                        value: msg.assetId ? String(msg.assetId) : "",
                        choices: [{ title: "Not about one of my devices", value: "" }, ...msg.devices.map((d) => ({ title: d.label, value: String(d.id) }))],
                      },
                    ]
                  : []),
                { type: "Input.Text", id: "body", label: "What's wrong", isMultiline: true, value: msg.body.slice(0, 4000), maxLength: 8000 },
              ],
              actions: [{ type: "Action.Submit", title: "Raise request", data: { cd: "raise", d: msg.draftId, edited: true } }],
            },
          },
        ]
      );
    }
    case "approval": {
      const facts = msg.rows.slice(0, 8).map(([title, value]) => ({ title, value: value.slice(0, 300) }));
      return card(
        [
          tb(`${msg.reminder ? "Reminder: approval" : "Approval"} needed`, { weight: "Bolder", size: "Medium" }),
          tb(`${msg.requester} asks for **${msg.typeTitle}** · #${msg.number}`, { isSubtle: true, spacing: "None" }),
          ...(facts.length ? [{ type: "FactSet", facts }] : []),
        ],
        [
          { type: "Action.Submit", title: "Approve", style: "positive", data: { cd: "approve", a: msg.approvalId } },
          {
            type: "Action.ShowCard",
            title: "Decline…",
            card: {
              type: "AdaptiveCard",
              body: [{ type: "Input.Text", id: "note", label: "Why are you declining? The requester sees this.", isMultiline: true, isRequired: true, errorMessage: "Say why.", maxLength: 2000 }],
              actions: [{ type: "Action.Submit", title: "Decline", style: "destructive", data: { cd: "decline", a: msg.approvalId } }],
            },
          },
          {
            type: "Action.ShowCard",
            title: "Ask a question",
            card: {
              type: "AdaptiveCard",
              body: [{ type: "Input.Text", id: "question", label: `Your question for ${msg.requester}`, isMultiline: true, isRequired: true, errorMessage: "Write your question.", maxLength: 5000 }],
              actions: [{ type: "Action.Submit", title: "Send question", data: { cd: "ask", a: msg.approvalId } }],
            },
          },
          { type: "Action.OpenUrl", title: "Open", url: msg.openUrl },
        ]
      );
    }
    case "decided":
      return card([tb(msg.title, { weight: "Bolder" }), tb(teamsText(msg.text), { isSubtle: true })]);
  }
}
