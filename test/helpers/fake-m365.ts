// A fake Microsoft 365 for the suites (1.20.7): the sign-in and the Microsoft
// Graph calls the mailbox connection makes (lib/helpdesk/m365), and the
// device-code sign-in and app-registration calls of the one-click setup
// (ee/m365-mail-setup), on a loopback port. The app is pointed at it with
// COMPASSDOCS_M365_MAIL_TEST_BASE (lib/helpdesk/m365/graph, test only) and,
// for the setup, COMPASSDOCS_SSO_SETUP_LOGIN_BASE / _GRAPH_BASE, so neither
// test/helpdesk-m365-mail.test.ts nor e2e/helpdesk-m365-mail.spec.ts ever
// contacts Microsoft.
//
//   <base>/login/{tenant}/oauth2/v2.0/token          app sign-in (client credentials) and the device-code grant
//   <base>/login/organizations/oauth2/v2.0/devicecode
//   <base>/graph/v1.0/…                              applications, servicePrincipals, users/{mailbox}/…, subscriptions
//   <base>/__fake/…                                  control, for a driver in another process (the e2e spec)
//
// What it models, because the product's behaviour depends on it:
//
//   access      an app reaches a mailbox when its token carries a Graph mail
//               role granted "in Entra" (app.roles: every mailbox), or when
//               the mailbox is in the app's Exchange scope (app.scope: what
//               the PowerShell commands would grant). Otherwise 403. An
//               address that is no mailbox (a group, a distribution list, a
//               contact, unknown) is 404 ErrorInvalidUser.
//   identity    a mailbox has an object ID and a sign-in name (UPN). Graph
//               finds it by either. By its address only when that is also
//               the sign-in name: Microsoft documents /users/{id | UPN}, so
//               the fake is strict about it (404 ErrorInvalidUser).
//   delta       a change log per Inbox; pages by Prefer: odata.maxpagesize;
//               a moved or deleted message comes back as @removed;
//               `expireDelta` answers the next token as Microsoft documents
//               a lost one: true = 410 Gone with a Location (a
//               "synchronization reset"), "token" = a 4xx with the code
//               syncStateNotFound (the token expired).
//   folders     a message says where it lies (parentFolderId: the Inbox's id
//               or a folder's); a meeting message is an eventMessage whose
//               invite is in its MIME (/$value), never an attachment.
//   subscriptions  creating one runs the validation handshake against the
//               notificationUrl (and refuses when it fails); deliver() and
//               lifecycle() POST what Graph would.
//   activation  a new app's sign-in is refused for `signInDelayMs`.

import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ typ: "JWT", alg: "RS256" })}.${b64({ ...claims, jti: randomUUID() })}.c2lnbmF0dXJl`;

export interface FakeAttachment {
  id: string;
  name: string;
  contentType: string;
  data: Buffer;
  isInline?: boolean;
  /** "#microsoft.graph.itemAttachment" for an attached message. */
  odataType?: string;
  /** Claim this size instead of the real one. */
  size?: number;
}

export interface FakeMessage {
  id: string;
  internetMessageId: string;
  subject: string;
  from: { name: string; address: string } | null;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  body: { contentType: "html" | "text"; content: string };
  receivedDateTime: string;
  isDraft: boolean;
  isRead: boolean;
  headers: { name: string; value: string }[];
  attachments: FakeAttachment[];
  /** "inbox", or a folder id after a move ("sentitems", "deleteditems" and the like are folders too). */
  folder: string;
  /** Exchange's kind for a meeting invite, update or cancellation: Graph says "#microsoft.graph.eventMessage". */
  eventMessage?: boolean;
  /** The message's MIME (GET …/$value). */
  mime?: Buffer;
  /** Graph's `sender` when it differs from `from` (a message sent on behalf of someone). */
  sender?: { name: string; address: string } | null;
}

export interface FakeMailbox {
  address: string;
  /** The sign-in name (default: the address). */
  upn: string;
  objectId: string;
  /** "shared" and "user" are mailboxes; anything else is not one (404). */
  kind: "shared" | "user" | "group" | "distribution_list" | "contact";
  messages: Map<string, FakeMessage>;
  folders: Map<string, string>;
  changes: { seq: number; id: string }[];
  seq: number;
  /** The MIME of every message sent as this mailbox. */
  sent: Buffer[];
  expireDelta: boolean | "token";
}

export interface FakeApp {
  appId: string;
  objectId: string;
  spId: string;
  tenant: string;
  displayName: string;
  secrets: string[];
  /** Graph application permissions granted in Entra (tenant-wide). */
  roles: string[];
  /** Mailboxes the Exchange scope gives it (read, mark, move). */
  scope: Set<string>;
  /** Mailboxes it may send as through the scope. */
  sendScope: Set<string>;
  activeAt: number;
  deleted: boolean;
}

export interface FakeSubscription {
  id: string;
  appId: string;
  resource: string;
  /** The Prefer header it was created with (IdType="ImmutableId" or ''). */
  prefer: string;
  mailbox: string;
  notificationUrl: string;
  lifecycleNotificationUrl: string;
  clientState: string;
  expirationDateTime: string;
  changeType: string;
}

export interface FakeM365 {
  base: string;
  port: number;
  tenantId: string;
  apps: Map<string, FakeApp>;
  mailboxes: Map<string, FakeMailbox>;
  subscriptions: Map<string, FakeSubscription>;
  /** One line per request: "GET /graph/v1.0/users/help@x/mailFolders/inbox 200". */
  log: string[];
  /** One line per request as it arrived, with its query: "GET /graph/v1.0/users/…/messages/…?$select=id,body". */
  requests: string[];
  /** Every read of a message takes this long (so tests can see how many run at once). */
  delayMs: number;
  /** The most message reads that were in flight at the same moment since it was last set to 0. */
  maxInflight: number;
  /** With fail.attachmentValue: only this attachment's content fails ('' = every one). */
  failAttachmentId: string;
  /**
   * Fail a kind of call: { sendMail: 403, subscriptions: 403, patch: 500, move: 404, attachments: 500, message: 500,
   * body: 500, attachmentValue: 503, mime: 500, token: 503 }. -1 = no answer at all (the connection is cut).
   */
  fail: Record<string, number>;
  /** Seconds in a Retry-After header on every 429 and 503 the fake answers (0 = none). */
  retryAfter: number;
  /** A new app cannot sign in for this long. */
  signInDelayMs: number;
  /** Fail a step of the setup: "addPassword" | "servicePrincipals". */
  failStep: string;
  deleteFails: boolean;
  /** The tenant the next device-code sign-in lands in (default: tenantId). */
  deviceTenant: string;
  /** Polls answered "authorization_pending" before the sign-in is approved. */
  devicePending: number;
  /** The delta query's next page link points at another host. */
  evilNextLink: boolean;
  addApp(over?: Partial<FakeApp> & { secret?: string }): FakeApp;
  addMailbox(address: string, kind?: FakeMailbox["kind"], over?: { upn?: string; objectId?: string }): FakeMailbox;
  addMessage(address: string, over?: Partial<FakeMessage>): FakeMessage;
  removeMessage(address: string, id: string): void;
  /** POST the change notification Graph would send for a new message. Resolves with the status the app answered. */
  deliver(address: string, messageId: string, over?: Record<string, unknown>): Promise<number>;
  /** POST a lifecycle notification (reauthorizationRequired, subscriptionRemoved, missed). */
  lifecycle(address: string, event: string): Promise<number>;
  calls(match: string | RegExp): string[];
  close(): Promise<void>;
}

const GRAPH = "/graph/v1.0";
/** The Inbox's own id (a folder id, not the word "inbox"). */
export const INBOX_ID = "AQMkInboxFolderId=";

/** The headers Exchange Online puts on an inbound message, top first, above the sender's own. */
export function exchangeHeaders(o: {
  from: string;
  to: string;
  cc?: string;
  messageId: string;
  subject?: string;
  /** "spf=pass … dkim=pass … dmarc=pass …" as Exchange writes it; undefined = none stamped. */
  results?: string;
  /** X-MS-Exchange-Organization-AuthAs values (one per header). */
  authAs?: string[];
  /** Headers the sender wrote (below Exchange's). */
  sender?: [string, string][];
}): { name: string; value: string }[] {
  const out: [string, string][] = [
    ["Received", "from BN8PR12MB0001.namprd12.prod.outlook.com (2603:10b6:408:1::10) by MN2PR12MB0002.namprd12.prod.outlook.com with HTTPS; Fri, 13 Nov 2026 10:00:03 +0000"],
    ["Received", "from BN1NAM02FT001.eop-nam02.prod.protection.outlook.com (2603:10b6:408:1::20) by BN8PR12MB0001.outlook.office365.com with Microsoft SMTP Server; Fri, 13 Nov 2026 10:00:02 +0000"],
  ];
  if (o.results !== undefined) out.push(["Authentication-Results", o.results]);
  for (const v of o.authAs ?? []) out.push(["X-MS-Exchange-Organization-AuthAs", v]);
  out.push(["Received", "from mail.sender.example (203.0.113.9) by BN1NAM02FT001.mail.protection.outlook.com (10.13.2.1) with Microsoft SMTP Server; Fri, 13 Nov 2026 10:00:01 +0000"]);
  for (const h of o.sender ?? []) out.push(h);
  out.push(["From", o.from], ["To", o.to]);
  if (o.cc) out.push(["Cc", o.cc]);
  out.push(["Subject", o.subject ?? ""], ["Message-ID", `<${o.messageId}>`], ["MIME-Version", "1.0"]);
  return out.map(([name, value]) => ({ name, value }));
}

/** Exchange's verdict line for a sender domain: every check passing and aligned. */
export const passResults = (domain: string) =>
  `spf=pass (sender IP is 203.0.113.9) smtp.mailfrom=${domain}; dkim=pass (signature was verified) header.d=${domain};dmarc=pass action=none header.from=${domain};compauth=pass reason=100`;
export const failResults = (domain: string) =>
  `spf=fail (sender IP is 198.51.100.7) smtp.mailfrom=${domain}; dkim=none (message not signed) header.d=none;dmarc=fail action=oreject header.from=${domain};compauth=fail reason=000`;

export async function startFakeM365(opts: { port?: number } = {}): Promise<FakeM365> {
  const tenantId = "8f4c2b7e-3d1a-4e6f-9b2c-5a7d1e0f4c93";
  const apps = new Map<string, FakeApp>();
  const mailboxes = new Map<string, FakeMailbox>();
  const subscriptions = new Map<string, FakeSubscription>();
  const appTokens = new Map<string, FakeApp>();
  const delegated = new Map<string, string>();
  const deviceCodes = new Map<string, { polls: number; tenant: string }>();
  const log: string[] = [];
  let base = "";
  let inflight = 0;

  const fake: FakeM365 = {
    base: "",
    port: 0,
    tenantId,
    apps,
    mailboxes,
    subscriptions,
    log,
    requests: [],
    delayMs: 0,
    maxInflight: 0,
    failAttachmentId: "",
    fail: {},
    retryAfter: 0,
    signInDelayMs: 0,
    failStep: "",
    deleteFails: false,
    deviceTenant: tenantId,
    devicePending: 1,
    evilNextLink: false,
    addApp(over = {}) {
      const app: FakeApp = {
        appId: randomUUID(),
        objectId: randomUUID(),
        spId: randomUUID(),
        tenant: tenantId,
        displayName: "CompassDocs Helpdesk Mail",
        secrets: [over.secret ?? `fake~${randomBytes(18).toString("base64url")}`],
        roles: [],
        scope: new Set(),
        sendScope: new Set(),
        activeAt: 0,
        deleted: false,
        ...over,
      };
      apps.set(app.appId, app);
      return app;
    },
    addMailbox(address, kind = "shared", over = {}) {
      const mb: FakeMailbox = {
        address: address.toLowerCase(),
        upn: (over.upn ?? address).toLowerCase(),
        objectId: (over.objectId ?? randomUUID()).toLowerCase(),
        kind,
        messages: new Map(),
        folders: new Map(),
        changes: [],
        seq: 0,
        sent: [],
        expireDelta: false,
      };
      mailboxes.set(mb.address, mb);
      return mb;
    },
    addMessage(address, over = {}) {
      const mb = mailboxes.get(address.toLowerCase());
      if (!mb) throw new Error(`fake-m365: no mailbox ${address}`);
      const id = over.id ?? `AAMk${randomBytes(24).toString("base64url")}=`;
      const internetMessageId = over.internetMessageId ?? `<${randomBytes(12).toString("hex")}@mail.sender.example>`;
      const from = over.from === undefined ? { name: "Cara Customer", address: "cara@customer.example" } : over.from;
      const to = over.to ?? [{ name: "", address: mb.address }];
      const msg: FakeMessage = {
        id,
        internetMessageId,
        subject: "A question about my invoice",
        from,
        to,
        cc: [],
        body: { contentType: "text", content: "Hello, could you help with my invoice?" },
        receivedDateTime: new Date().toISOString(),
        isDraft: false,
        isRead: false,
        headers: [],
        attachments: [],
        folder: "inbox",
        ...over,
      };
      if (!over.headers) {
        msg.headers = exchangeHeaders({
          from: from ? `${from.name} <${from.address}>` : "",
          to: msg.to.map((a) => a.address).join(", "),
          cc: msg.cc.map((a) => a.address).join(", ") || undefined,
          messageId: internetMessageId.replace(/^<|>$/g, ""),
          subject: msg.subject,
          results: from ? passResults(from.address.split("@")[1]) : undefined,
          authAs: ["Anonymous"],
        });
      }
      mb.messages.set(id, msg);
      mb.changes.push({ seq: ++mb.seq, id });
      return msg;
    },
    removeMessage(address, id) {
      const mb = mailboxes.get(address.toLowerCase());
      if (!mb) return;
      mb.messages.delete(id);
      mb.changes.push({ seq: ++mb.seq, id });
    },
    async deliver(address, messageId, over = {}) {
      const sub = [...subscriptions.values()].find((s) => s.mailbox === address.toLowerCase());
      if (!sub) throw new Error(`fake-m365: no subscription for ${address}`);
      const body = {
        value: [
          {
            subscriptionId: sub.id,
            subscriptionExpirationDateTime: sub.expirationDateTime,
            changeType: "created",
            resource: `Users/${address}/Messages/${messageId}`,
            clientState: sub.clientState,
            tenantId,
            resourceData: { "@odata.type": "#Microsoft.Graph.Message", "@odata.id": `Users/${address}/Messages/${messageId}`, id: messageId },
            ...over,
          },
        ],
      };
      const r = await fetch(sub.notificationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return r.status;
    },
    async lifecycle(address, event) {
      const sub = [...subscriptions.values()].find((s) => s.mailbox === address.toLowerCase());
      if (!sub) throw new Error(`fake-m365: no subscription for ${address}`);
      const body = { value: [{ subscriptionId: sub.id, subscriptionExpirationDateTime: sub.expirationDateTime, clientState: sub.clientState, tenantId, lifecycleEvent: event, resource: sub.resource }] };
      if (event === "subscriptionRemoved") subscriptions.delete(sub.id);
      const r = await fetch(sub.lifecycleNotificationUrl || sub.notificationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return r.status;
    },
    calls(match) {
      return log.filter((l) => (typeof match === "string" ? l.includes(match) : match.test(l)));
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
    if (status === -1) {
      // No answer at all: the connection is cut.
      res.destroy();
      return;
    }
    if ((status === 429 || status === 503) && fake.retryAfter > 0) headers = { "retry-after": String(fake.retryAfter), ...headers };
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
    } else if (Buffer.isBuffer(body)) {
      res.writeHead(status, { "content-type": "application/octet-stream", ...headers });
      res.end(body);
    } else {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    }
  };
  const gerr = (code: string, message: string) => ({ error: { code, message } });
  const read = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  const messageJson = (m: FakeMessage, select: string[] | null) => {
    const addr = (a: { name: string; address: string }) => ({ emailAddress: { name: a.name, address: a.address } });
    const full: Record<string, unknown> = {
      id: m.id,
      internetMessageId: m.internetMessageId,
      subject: m.subject,
      from: m.from ? addr(m.from) : undefined,
      sender: m.sender === null ? undefined : m.sender ? addr(m.sender) : m.from ? addr(m.from) : undefined,
      parentFolderId: m.folder === "inbox" ? INBOX_ID : m.folder,
      toRecipients: m.to.map(addr),
      ccRecipients: m.cc.map(addr),
      replyTo: [],
      body: m.body,
      receivedDateTime: m.receivedDateTime,
      isDraft: m.isDraft,
      isRead: m.isRead,
      hasAttachments: m.attachments.some((a) => !a.isInline),
      internetMessageHeaders: m.headers,
    };
    if (!select) {
      delete full.internetMessageHeaders; // only with $select, as Graph
      return full;
    }
    const out: Record<string, unknown> = { "@odata.etag": 'W/"x"', id: m.id };
    // A derived type is named whatever is selected.
    if (m.eventMessage) out["@odata.type"] = "#microsoft.graph.eventMessage";
    for (const k of select) if (k in full) out[k] = full[k];
    return out;
  };

  /** The mailbox a /users/{x} segment names: by object ID, by sign-in name, and by address only when that is the sign-in name. */
  const resolve = (key: string): FakeMailbox | undefined => {
    const k = key.toLowerCase().replace(/^aad-upn:/, "");
    return [...mailboxes.values()].find((m) => m.objectId === k || m.upn === k);
  };

  /** Whether the app may read (or send as) the mailbox; null = allowed, else the answer to give. */
  const refuse = (app: FakeApp, key: string, sending = false): [number, unknown] | null => {
    const mb = resolve(key);
    if (!mb || (mb.kind !== "shared" && mb.kind !== "user")) return [404, gerr("ErrorInvalidUser", "The requested user is invalid.")];
    const address = mb.address;
    const wide = sending ? app.roles.includes("Mail.Send") : app.roles.some((r) => r === "Mail.ReadWrite" || r === "Mail.Read" || r === "MailboxItem.Read.All" || r === "Mail-Advanced.ReadWrite.All");
    const scoped = sending ? app.sendScope.has(address) : app.scope.has(address);
    return wide || scoped ? null : [403, gerr("ErrorAccessDenied", "Access is denied. Check credentials and try again.")];
  };

  async function graph(req: http.IncomingMessage, res: http.ServerResponse, url: URL, path: string): Promise<void> {
    const method = req.method ?? "GET";
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const raw = await read(req);
    const json = () => {
      try {
        return JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    // --- The one-click setup, as the signed-in admin ---
    if (delegated.has(bearer)) {
      if (method === "POST" && path === "/applications") {
        const b = json();
        if (Array.isArray(b.requiredResourceAccess) && b.requiredResourceAccess.length) fake.log.push("! setup asked for Graph permissions");
        const app = fake.addApp({ displayName: String(b.displayName ?? ""), tenant: delegated.get(bearer)!, secrets: [], activeAt: Date.now() + fake.signInDelayMs });
        return send(res, 201, { id: app.objectId, appId: app.appId, displayName: app.displayName });
      }
      const pw = path.match(/^\/applications\/([^/]+)\/addPassword$/);
      if (method === "POST" && pw) {
        if (fake.failStep === "addPassword") return send(res, 403, gerr("Authorization_RequestDenied", "Insufficient privileges to complete the operation."));
        const app = [...apps.values()].find((a) => a.objectId === pw[1]);
        if (!app) return send(res, 404, gerr("Request_ResourceNotFound", "No such application."));
        const secret = `fake~${randomBytes(24).toString("base64url")}`;
        app.secrets.push(secret);
        return send(res, 200, { secretText: secret, keyId: randomUUID() });
      }
      if (method === "POST" && path === "/servicePrincipals") {
        if (fake.failStep === "servicePrincipals") return send(res, 403, gerr("Authorization_RequestDenied", "Insufficient privileges to complete the operation."));
        const app = apps.get(String(json().appId ?? ""));
        if (!app) return send(res, 404, gerr("Request_ResourceNotFound", "No such application."));
        return send(res, 201, { id: app.spId, appId: app.appId });
      }
      const del = path.match(/^\/applications\/([^/]+)$/);
      if (method === "DELETE" && del) {
        if (fake.deleteFails) return send(res, 500, gerr("InternalServerError", "Try again."));
        const app = [...apps.values()].find((a) => a.objectId === del[1]);
        if (app) app.deleted = true;
        return send(res, 204);
      }
      return send(res, 404, gerr("BadRequest", "Not part of the fake."));
    }

    const app = appTokens.get(bearer);
    if (!app || app.deleted) return send(res, 401, gerr("InvalidAuthenticationToken", "Access token is empty or invalid."));

    // --- Subscriptions ---
    if (path === "/subscriptions" && method === "POST") {
      if (fake.fail.subscriptions) return send(res, fake.fail.subscriptions, gerr("ExtensionError", "Operation: Create; Exception: [Status Code: Forbidden]"));
      const b = json();
      const resource = String(b.resource ?? "");
      const named = decodeURIComponent(resource.match(/^users\/([^/]+)\//i)?.[1] ?? "").toLowerCase();
      const no = refuse(app, named);
      if (no) return send(res, no[0], no[1]);
      const mailbox = resolve(named)!.address;
      const notificationUrl = String(b.notificationUrl ?? "");
      const token = `Validation: Testing client application reachability for subscription Request-Id: ${randomUUID()}`;
      for (const target of [...new Set([notificationUrl, String(b.lifecycleNotificationUrl ?? notificationUrl)])]) {
        let ok = false;
        try {
          const v = await fetch(`${target}?validationToken=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
          ok = v.status === 200 && (v.headers.get("content-type") ?? "").startsWith("text/plain") && (await v.text()) === token;
        } catch {
          ok = false;
        }
        if (!ok) return send(res, 400, gerr("InvalidRequest", "Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request."));
      }
      const sub: FakeSubscription = {
        id: randomUUID(),
        appId: app.appId,
        resource,
        prefer: String(req.headers.prefer ?? ""),
        mailbox,
        notificationUrl,
        lifecycleNotificationUrl: String(b.lifecycleNotificationUrl ?? ""),
        clientState: String(b.clientState ?? ""),
        expirationDateTime: String(b.expirationDateTime ?? ""),
        changeType: String(b.changeType ?? ""),
      };
      subscriptions.set(sub.id, sub);
      return send(res, 201, { id: sub.id, resource, changeType: sub.changeType, expirationDateTime: sub.expirationDateTime, notificationUrl });
    }
    const subPath = path.match(/^\/subscriptions\/([^/]+)$/);
    if (subPath) {
      const sub = subscriptions.get(decodeURIComponent(subPath[1]));
      if (method === "DELETE") {
        if (sub) subscriptions.delete(sub.id);
        return send(res, 204);
      }
      if (method === "PATCH") {
        if (fake.fail.renew) return send(res, fake.fail.renew, gerr("ExtensionError", "Could not renew."));
        if (!sub) return send(res, 404, gerr("ResourceNotFound", "The object was not found."));
        sub.expirationDateTime = String(json().expirationDateTime ?? sub.expirationDateTime);
        return send(res, 200, { id: sub.id, expirationDateTime: sub.expirationDateTime });
      }
    }

    // --- A mailbox ---
    const user = path.match(/^\/users\/([^/]+)(\/.*)?$/);
    if (!user) return send(res, 404, gerr("BadRequest", "Not part of the fake."));
    const key = decodeURIComponent(user[1]).toLowerCase();
    const rest = user[2] ?? "";
    const sending = rest === "/sendMail";
    const no = refuse(app, key, sending);
    if (no) return send(res, no[0], no[1]);
    const mb = resolve(key)!;
    const address = mb.address;
    const select = url.searchParams.get("$select")?.split(",") ?? null;

    if (sending && method === "POST") {
      if (fake.fail.sendMail) return send(res, fake.fail.sendMail, gerr(fake.fail.sendMail === 403 ? "ErrorSendAsDenied" : "ErrorInternalServerError", "The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account."));
      if (!String(req.headers["content-type"] ?? "").startsWith("text/plain")) return send(res, 400, gerr("BadRequest", "The fake takes the MIME form only."));
      const text = raw.toString("utf8");
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return send(res, 400, gerr("ErrorMimeContentInvalidBase64String", "Invalid base64 string for MIME content."));
      mb.sent.push(Buffer.from(text, "base64"));
      return send(res, 202);
    }
    if (rest === "/mailFolders/inbox" && method === "GET") return send(res, 200, { id: INBOX_ID, displayName: "Inbox" });
    if (rest === "/mailFolders" && method === "GET") {
      const want = (url.searchParams.get("$filter") ?? "").match(/^displayName eq '(.*)'$/)?.[1]?.replace(/''/g, "'");
      const value = [...mb.folders].filter(([, name]) => want === undefined || name === want).map(([id, displayName]) => ({ id, displayName }));
      return send(res, 200, { value });
    }
    if (rest === "/mailFolders" && method === "POST") {
      const name = String(json().displayName ?? "");
      if ([...mb.folders.values()].includes(name)) return send(res, 409, gerr("ErrorFolderExists", "A folder with the specified name already exists."));
      const id = `folder-${randomBytes(6).toString("hex")}`;
      mb.folders.set(id, name);
      return send(res, 201, { id, displayName: name });
    }
    if (rest === "/mailFolders/inbox/messages/delta" && method === "GET") {
      if (fake.fail.delta) return send(res, fake.fail.delta, gerr("ErrorInternalServerError", "Try again."));
      const size = Number(String(req.headers.prefer ?? "").match(/odata\.maxpagesize=(\d+)/)?.[1] ?? 10);
      const token = url.searchParams.get("$deltatoken");
      const skip = url.searchParams.get("$skiptoken");
      if ((token !== null || skip !== null) && mb.expireDelta) {
        const how = mb.expireDelta;
        mb.expireDelta = false;
        // The token expired: "a 40X-series error with error codes such as syncStateNotFound".
        if (how === "token") return send(res, 404, gerr("syncStateNotFound", "The sync state generation is not found."));
        // A synchronization reset: 410 Gone and where to start over.
        return send(res, 410, gerr("resyncRequired", "Resync required."), { location: `${base}${GRAPH}/users/${encodeURIComponent(key)}/mailFolders/inbox/messages/delta?$deltatoken=` });
      }
      const [since, offset] = skip !== null ? skip.split(":").map(Number) : [token !== null ? Number(token) : -1, 0];
      let items: Record<string, unknown>[];
      if (since < 0) {
        items = [...mb.messages.values()].filter((m) => m.folder === "inbox").map((m) => messageJson(m, select));
      } else {
        const ids = [...new Set(mb.changes.filter((c) => c.seq > since).map((c) => c.id))];
        items = ids.map((id) => {
          const m = mb.messages.get(id);
          return m && m.folder === "inbox" ? messageJson(m, select) : { id, "@removed": { reason: "deleted" } };
        });
      }
      const page = items.slice(offset, offset + size);
      const root = `${base}${GRAPH}/users/${encodeURIComponent(key)}/mailFolders/inbox/messages/delta`;
      const more = offset + size < items.length;
      const until = mb.seq;
      const link = more
        ? { "@odata.nextLink": fake.evilNextLink ? `http://evil.example/v1.0/users/${address}/steal` : `${root}?$skiptoken=${since}:${offset + size}` }
        : { "@odata.deltaLink": `${root}?$deltatoken=${until}` };
      return send(res, 200, { "@odata.context": "delta", value: page, ...link });
    }
    const msgPath = rest.match(/^\/messages\/([^/]+)(\/.*)?$/);
    if (msgPath) {
      const id = decodeURIComponent(msgPath[1]);
      const tail = msgPath[2] ?? "";
      const m = mb.messages.get(id);
      if (!m) return send(res, 404, gerr("ErrorItemNotFound", "The specified object was not found in the store."));
      if (tail === "" && method === "GET") {
        inflight++;
        fake.maxInflight = Math.max(fake.maxInflight, inflight);
        try {
          if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
        } finally {
          inflight--;
        }
        if (fake.fail.message) return send(res, fake.fail.message, gerr("ErrorInternalServerError", "Try again."));
        if (fake.fail.body && select?.includes("body")) return send(res, fake.fail.body, gerr("ErrorInternalServerError", "Try again."));
        return send(res, 200, messageJson(m, select));
      }
      if (tail === "/$value" && method === "GET") {
        if (fake.fail.mime) return send(res, fake.fail.mime, gerr("ErrorInternalServerError", "Try again."));
        return send(res, 200, m.mime ?? Buffer.from(`From: ${m.from?.address ?? ""}\r\nSubject: ${m.subject}\r\nContent-Type: text/plain\r\n\r\n${m.body.content}\r\n`));
      }
      if (tail === "" && method === "PATCH") {
        if (fake.fail.patch) return send(res, fake.fail.patch, gerr("ErrorAccessDenied", "Access is denied."));
        const b = json();
        if (typeof b.isRead === "boolean") m.isRead = b.isRead;
        mb.changes.push({ seq: ++mb.seq, id });
        return send(res, 200, messageJson(m, null));
      }
      if (tail === "/move" && method === "POST") {
        if (fake.fail.move) return send(res, fake.fail.move, gerr("ErrorInternalServerError", "Try again."));
        const dest = String(json().destinationId ?? "");
        if (!mb.folders.has(dest)) return send(res, 404, gerr("ErrorItemNotFound", "The specified folder could not be found in the store."));
        m.folder = dest;
        mb.changes.push({ seq: ++mb.seq, id });
        return send(res, 201, messageJson(m, null));
      }
      if (tail === "/attachments" && method === "GET") {
        if (fake.fail.attachments) return send(res, fake.fail.attachments, gerr("ErrorInternalServerError", "Try again."));
        return send(res, 200, {
          value: m.attachments.map((a) => ({ "@odata.type": a.odataType ?? "#microsoft.graph.fileAttachment", id: a.id, name: a.name, contentType: a.contentType, size: a.size ?? a.data.length, isInline: a.isInline === true })),
        });
      }
      const att = tail.match(/^\/attachments\/([^/]+)\/\$value$/);
      if (att && method === "GET") {
        const a = m.attachments.find((x) => x.id === decodeURIComponent(att[1]));
        if (fake.fail.attachmentValue && (!fake.failAttachmentId || fake.failAttachmentId === a?.id)) return send(res, fake.fail.attachmentValue, gerr("ErrorInternalServerError", "Try again."));
        return a ? send(res, 200, a.data) : send(res, 404, gerr("ErrorItemNotFound", "No such attachment."));
      }
    }
    return send(res, 404, gerr("BadRequest", "Not part of the fake."));
  }

  async function login(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const form = new URLSearchParams((await read(req)).toString("utf8"));
    if (path === "/organizations/oauth2/v2.0/devicecode") {
      const code = randomBytes(24).toString("base64url");
      deviceCodes.set(code, { polls: 0, tenant: fake.deviceTenant });
      return send(res, 200, { device_code: code, user_code: "H7KQ2MZP9", verification_uri: "https://microsoft.com/devicelogin", interval: 1, expires_in: 900 });
    }
    const m = path.match(/^\/([^/]+)\/oauth2\/v2\.0\/token$/);
    if (!m) return send(res, 404, { error: "not_found" });
    if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      const d = deviceCodes.get(form.get("device_code") ?? "");
      if (!d) return send(res, 400, { error: "expired_token", error_description: "AADSTS70020: The provided value for the input parameter 'device_code' is not valid." });
      if (d.polls++ < fake.devicePending) return send(res, 400, { error: "authorization_pending", error_description: "AADSTS70016: pending." });
      deviceCodes.delete(form.get("device_code")!);
      const token = jwt({ tid: d.tenant, scp: "Application.ReadWrite.All", upn: "admin@contoso.example" });
      delegated.set(token, d.tenant);
      return send(res, 200, { token_type: "Bearer", access_token: token, expires_in: 3600 });
    }
    if (fake.fail.token) return send(res, fake.fail.token, { error: "temporarily_unavailable", error_description: "AADSTS90033: A transient error has occurred." });
    const tenant = decodeURIComponent(m[1]).toLowerCase();
    const app = apps.get(form.get("client_id") ?? "");
    if (!app || app.deleted) return send(res, 400, { error: "unauthorized_client", error_description: "AADSTS700016: Application with identifier was not found in the directory." });
    if (tenant !== app.tenant && tenant !== "contoso.example") return send(res, 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant not found." });
    if (!app.secrets.includes(form.get("client_secret") ?? "") || Date.now() < app.activeAt) {
      return send(res, 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value." });
    }
    const token = jwt({ tid: app.tenant, oid: app.spId, appid: app.appId, roles: app.roles.length ? app.roles : undefined });
    appTokens.set(token, app);
    return send(res, 200, { token_type: "Bearer", access_token: token, expires_in: 3599 });
  }

  /** For a driver in another process: POST /__fake/<op> with JSON. */
  async function control(req: http.IncomingMessage, res: http.ServerResponse, op: string): Promise<void> {
    const raw = (await read(req)).toString("utf8");
    const b = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (op === "ping") return send(res, 200, { ok: true, fake: "m365" });
    if (op === "reset") {
      apps.clear();
      mailboxes.clear();
      subscriptions.clear();
      appTokens.clear();
      delegated.clear();
      log.length = 0;
      fake.requests.length = 0;
      Object.assign(fake, { fail: {}, retryAfter: 0, delayMs: 0, maxInflight: 0, failAttachmentId: "", signInDelayMs: 0, failStep: "", deleteFails: false, deviceTenant: tenantId, devicePending: 1, evilNextLink: false });
      return send(res, 200, { ok: true });
    }
    if (op === "set") {
      Object.assign(fake, b);
      return send(res, 200, { ok: true });
    }
    if (op === "app") {
      // An app registration the admin "made by hand", for the manual form.
      const made = fake.addApp();
      return send(res, 200, { tenant: made.tenant, client_id: made.appId, secret: made.secrets[0] });
    }
    if (op === "mailbox") {
      const made = fake.addMailbox(String(b.address), (b.kind as FakeMailbox["kind"]) ?? "shared", { upn: b.upn as string | undefined, objectId: b.objectId as string | undefined });
      return send(res, 200, { address: made.address, upn: made.upn, objectId: made.objectId });
    }
    if (op === "message") {
      const { address, attachments, mimeBase64, ...over } = b as { address: string; mimeBase64?: string; attachments?: { name: string; contentType: string; base64: string }[] } & Partial<FakeMessage>;
      const msg = fake.addMessage(address, { ...over, ...(mimeBase64 ? { mime: Buffer.from(mimeBase64, "base64") } : {}), ...(attachments ? { attachments: attachments.map((a, i) => ({ id: `att-${i}`, name: a.name, contentType: a.contentType, data: Buffer.from(a.base64, "base64") })) } : {}) });
      return send(res, 200, { id: msg.id });
    }
    if (op === "unsubscribe") {
      // Microsoft dropped every subscription (as after an outage at its end).
      subscriptions.clear();
      return send(res, 200, { ok: true });
    }
        if (op === "deliver") return send(res, 200, { status: await fake.deliver(String(b.address), String(b.id)) });
    if (op === "scope") {
      // What the PowerShell commands would grant: every app gets these mailboxes (read and send).
      for (const app of apps.values()) {
        app.scope = new Set((b.addresses as string[]).map((a) => a.toLowerCase()));
        app.sendScope = new Set(((b.send as string[]) ?? (b.addresses as string[])).map((a) => a.toLowerCase()));
      }
      return send(res, 200, { ok: true });
    }
    if (op === "roles") {
      for (const app of apps.values()) app.roles = b.roles as string[];
      return send(res, 200, { ok: true });
    }
    if (op === "state") {
      return send(res, 200, {
        apps: [...apps.values()].map((a) => ({ appId: a.appId, spId: a.spId, displayName: a.displayName, roles: a.roles, scope: [...a.scope], deleted: a.deleted })),
        mailboxes: [...mailboxes.values()].map((m) => ({
          address: m.address,
          upn: m.upn,
          objectId: m.objectId,
          kind: m.kind,
          folders: [...m.folders.values()],
          messages: [...m.messages.values()].map((x) => ({ id: x.id, subject: x.subject, isRead: x.isRead, folder: x.folder === "inbox" ? "inbox" : (m.folders.get(x.folder) ?? x.folder) })),
          sent: m.sent.map((s) => s.toString("utf8")),
        })),
        subscriptions: [...subscriptions.values()].map((s) => ({ id: s.id, mailbox: s.mailbox, changeType: s.changeType, resource: s.resource, prefer: s.prefer })),
        log,
      });
    }
    return send(res, 404, { error: "unknown control" });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const done = (status: number) => log.push(`${req.method} ${url.pathname} ${status}`);
    let search = url.search;
    try {
      search = decodeURIComponent(url.search);
    } catch {
      /* as it came */
    }
    fake.requests.push(`${req.method} ${url.pathname}${search}`);
    res.on("finish", () => done(res.statusCode));
    const run = url.pathname.startsWith(`${GRAPH}/`)
      ? graph(req, res, url, url.pathname.slice(GRAPH.length))
      : url.pathname.startsWith("/login/")
        ? login(req, res, url.pathname.slice("/login".length))
        : url.pathname.startsWith("/__fake/")
          ? control(req, res, url.pathname.slice("/__fake/".length))
          : Promise.resolve(send(res, 404, { error: "not found" }));
    run.catch((e) => {
      if (!res.headersSent) send(res, 500, { error: String(e) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  fake.port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${fake.port}`;
  fake.base = base;
  return fake;
}
