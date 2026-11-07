// In-process fakes of Microsoft's Bot Framework and Slack's Web API for the
// chat apps (1.19.4, lib/helpdesk/chat). One node:http server on 127.0.0.1;
// the chat transport (lib/helpdesk/chat/http setChatTransportForTests) sends
// every https://<host>/<path> the client calls to http://127.0.0.1:<port>/<host>/<path>,
// so the real client code, headers, bodies and error mapping run over HTTP
// and nothing ever reaches Microsoft or Slack.
//
//   login.botframework.com      the OpenID metadata and the signing keys
//                               (an RSA key made here; endorsements msteams)
//   login.microsoftonline.com   client-credentials tokens for the bot
//   smba.trafficmanager.net     the Bot Connector: activities posted and
//                               replaced, recorded, with the bot's token checked
//   slack.com/api/<method>      auth.test, users.info, users.lookupByEmail,
//                               conversations.open/history/replies,
//                               chat.postMessage/postEphemeral/update/getPermalink,
//                               views.open; the bot token checked
//
// Helpers sign what the platforms would send: teamsJwt() a Bot Framework
// token (or one with a key the metadata doesn't list), slackHeaders() the
// signature headers.
//
//   const fake = await startFakeChat({ appId, secret, tenant, slackToken });
//   setChatTransportForTests(fake.transport);
//   …
//   await fake.close();

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export interface FakeChatState {
  teams: { appId: string; secret: string; tenant: string; tokenCalls: number; keyCalls: number; posted: { path: string; method: string; auth: string; body: Obj }[] };
  slack: {
    token: string;
    team: { id: string; name: string };
    botUserId: string;
    scopes: string[];
    users: Obj[];
    messages: Map<string, Obj[]>;
    calls: { method: string; auth: string; body: Obj }[];
    nextTs: number;
  };
  /** host+path prefix → a canned failure, used `times` times. */
  fail: Map<string, { status: number; body?: unknown; times: number }>;
}

export interface FakeChat {
  state: FakeChatState;
  port: number;
  transport: (url: string, init: RequestInit) => Promise<Response>;
  /** A Bot Framework JWT for this app; `over` replaces claims, `rogue` signs with an unlisted key. */
  teamsJwt(over?: Obj, opts?: { rogue?: boolean; kid?: string; alg?: string }): string;
  slackHeaders(secret: string, body: string, ts?: number): Record<string, string>;
  close(): Promise<void>;
}

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function jwt(header: Obj, claims: Obj, key: KeyObject): string {
  const head = `${b64url(header)}.${b64url(claims)}`;
  return `${head}.${cryptoSign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

export const SERVICE_URL = "https://smba.trafficmanager.net/teams/";

export async function startFakeChat(opts: { appId: string; secret: string; tenant: string; slackToken: string }): Promise<FakeChat> {
  const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = good.publicKey.export({ format: "jwk" }) as Obj;
  const KID = "fake-kid-1";
  const state: FakeChatState = {
    teams: { appId: opts.appId, secret: opts.secret, tenant: opts.tenant, tokenCalls: 0, keyCalls: 0, posted: [] },
    slack: { token: opts.slackToken, team: { id: "T0FAKE", name: "Acme" }, botUserId: "UBOT", scopes: ["app_mentions:read", "channels:history", "chat:write", "commands", "im:history", "im:write", "reactions:read", "users:read", "users:read.email"], users: [], messages: new Map(), calls: [], nextTs: 1_700_000_000 },
    fail: new Map(),
  };
  let tokenSeq = 0;
  const issued = new Set<string>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      const [, host, ...rest] = url.pathname.split("/");
      const path = `/${rest.join("/")}`;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      for (const [k, f] of state.fail) {
        if (`${host}${path}`.startsWith(k) && f.times > 0) {
          f.times--;
          return send(f.status, f.body ?? { error: "canned" });
        }
      }
      const auth = String(req.headers.authorization ?? "");
      let body: Obj = {};
      try {
        body = (req.headers["content-type"] ?? "").includes("json") && raw ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        body = {};
      }

      if (host === "login.botframework.com") {
        if (path === "/v1/.well-known/openidconfiguration") return send(200, { issuer: "https://api.botframework.com", jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
        if (path === "/v1/.well-known/keys") {
          state.teams.keyCalls++;
          return send(200, { keys: [{ kty: "RSA", use: "sig", kid: KID, n: jwk.n, e: jwk.e, endorsements: ["msteams"] }] }, { "cache-control": "public, max-age=86400" });
        }
        return send(404, {});
      }
      if (host === "login.microsoftonline.com") {
        if (path !== `/${state.teams.tenant}/oauth2/v2.0/token`) return send(400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
        if (body.client_id !== state.teams.appId || body.client_secret !== state.teams.secret) {
          return send(401, { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided. ${body.client_secret}` });
        }
        if (body.grant_type !== "client_credentials" || body.scope !== "https://api.botframework.com/.default") return send(400, { error: "invalid_scope" });
        state.teams.tokenCalls++;
        const t = `bot-token-${++tokenSeq}`;
        issued.add(t);
        return send(200, { token_type: "Bearer", expires_in: 3599, access_token: t });
      }
      if (host === "smba.trafficmanager.net") {
        const token = auth.replace(/^Bearer /, "");
        if (!issued.has(token)) return send(401, { error: { code: "Unauthorized", message: "bad token" } });
        state.teams.posted.push({ path, method: req.method ?? "", auth, body });
        return send(200, { id: `act-${state.teams.posted.length}` });
      }
      if (host === "slack.com" && path.startsWith("/api/")) {
        const method = path.slice(5);
        state.slack.calls.push({ method, auth, body });
        const ok = (extra: Obj = {}) => send(200, { ok: true, ...extra }, { "x-oauth-scopes": state.slack.scopes.join(",") });
        const err = (e: string) => send(200, { ok: false, error: e });
        if (auth !== `Bearer ${state.slack.token}`) return err("invalid_auth");
        const user = (pred: (u: Obj) => boolean) => state.slack.users.find(pred);
        switch (method) {
          case "auth.test":
            return ok({ team: state.slack.team.name, team_id: state.slack.team.id, user_id: state.slack.botUserId, url: "https://acme.slack.com/" });
          case "users.info": {
            const u = user((x) => x.id === body.user);
            return u ? ok({ user: u }) : err("user_not_found");
          }
          case "users.lookupByEmail": {
            const u = user((x) => String(x.profile?.email ?? "").toLowerCase() === String(body.email).toLowerCase());
            return u ? ok({ user: u }) : err("users_not_found");
          }
          case "conversations.open":
            return ok({ channel: { id: `D${String(body.users).slice(1)}` } });
          case "chat.postMessage":
          case "chat.postEphemeral": {
            const ts = `${++state.slack.nextTs}.000100`;
            const list = state.slack.messages.get(String(body.channel)) ?? [];
            list.push({ ...body, ts, method });
            state.slack.messages.set(String(body.channel), list);
            return ok(method === "chat.postMessage" ? { channel: body.channel, ts } : { message_ts: ts });
          }
          case "chat.update":
            return ok({ channel: body.channel, ts: body.ts });
          case "chat.getPermalink":
            return ok({ permalink: `https://acme.slack.com/archives/${body.channel}/p${String(body.message_ts).replace(".", "")}` });
          case "conversations.history":
          case "conversations.replies": {
            const list = (state.slack.messages.get(String(body.channel)) ?? []).filter((m) => m.ts === (body.latest ?? body.ts));
            return ok({ messages: list });
          }
          case "views.open":
            return ok({ view: { id: "V1" } });
          default:
            return err("unknown_method");
        }
      }
      send(404, { error: "no such host" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  return {
    state,
    port,
    transport: (url, init) => {
      const u = new URL(url);
      return fetch(`http://127.0.0.1:${port}/${u.hostname}${u.pathname}${u.search}`, init);
    },
    teamsJwt(over: Obj = {}, o: { rogue?: boolean; kid?: string; alg?: string } = {}) {
      const now = Math.floor(Date.now() / 1000);
      return jwt(
        { alg: o.alg ?? "RS256", kid: o.kid ?? KID, typ: "JWT" },
        { iss: "https://api.botframework.com", aud: state.teams.appId, serviceurl: SERVICE_URL, nbf: now - 10, exp: now + 3600, ...over },
        o.rogue ? rogue.privateKey : good.privateKey
      );
    },
    slackHeaders(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
      return { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}` };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A Slack member as users.info answers. */
export function slackMember(id: string, email: string, name: string, extra: Obj = {}): Obj {
  return { id, team_id: "T0FAKE", name: name.toLowerCase().replace(/\s+/g, "."), real_name: name, deleted: false, is_bot: false, is_email_confirmed: true, profile: { email, real_name: name }, ...extra };
}
