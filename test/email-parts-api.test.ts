// The composable email templates' routes (1.19.0, /api/admin/email-templates/**):
// who may do what (a template manager: everything; a helpdesk admin on a
// licensed helpdesk: read parts, compose and preview hd_* events, team
// variants included, never the other events and never the parts library;
// a viewer: nothing), the JSON shapes agent H's admin UI builds on, the
// 409 that lists the emails using a part, reset of a built-in, the audit
// rows of every write, the preview, the test-send limits, and the 1.18
// single-template route still answering.
//
// Route handlers are called directly with a stubbed next/headers (as in
// test/account-email.test.ts) and the licensed-edition stub. Real events'
// compositions are never changed: the file registers its own events.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/email-parts-api.test.ts

import { edition } from "./support/ee-stub";
import Module from "node:module";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.email-parts.virtual.js");
{
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const tpl = require("../src/lib/email-templates") as typeof import("../src/lib/email-templates");
const parts = require("../src/lib/email-parts") as typeof import("../src/lib/email-parts");
const access = require("../src/lib/email-parts-access") as typeof import("../src/lib/email-parts-access");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `eptapi${Date.now()}${Math.floor(Math.random() * 1000)}`;
const EV_HD = `hd_zzeptapi_${STAMP}`;
const EV_CORE = `zz_eptapi_${STAMP}`;
const BASE = "http://localhost:3000/api/admin/email-templates";
const userIds: number[] = [];
const partIds: number[] = [];
let teamId = 0;

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Json = Record<string, any>;

async function newUser(tag: string, role: string): Promise<number> {
  const r = await db.pool().query<{ id: number }>(
    "INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
    [`${STAMP}-${tag}`, `Ept ${tag}`, `${STAMP}-${tag}@example.test`, role]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function sessionFor(userId: number): Promise<string> {
  const token = newToken();
  await db.createSession(token, userId, new Date(Date.now() + 3_600_000).toISOString());
  return token;
}

async function call(
  handler: Handler,
  url: string,
  session: string,
  method: string,
  body?: unknown,
  params?: Record<string, string>
): Promise<{ status: number; body: Json }> {
  currentRequest = new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", host: "localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const res = await handler(currentRequest, params ? { params: Promise.resolve(params) } : undefined);
    return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Json };
  } finally {
    currentRequest = null;
  }
}

async function auditRows(action: string, targetId: string | number): Promise<number> {
  const r = await db.pool().query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM audit_log WHERE action = $1 AND target_id = $2 AND actor_id = ANY($3)",
    [action, String(targetId), userIds]
  );
  return r.rows[0].n;
}

let admin = "";
let hdAdmin = "";
let viewer = "";
let R: {
  parts: { GET: Handler; POST: Handler };
  part: { GET: Handler; PATCH: Handler; DELETE: Handler };
  reset: { POST: Handler };
  dflt: { POST: Handler };
  comps: { GET: Handler };
  comp: { GET: Handler; PUT: Handler; DELETE: Handler };
  preview: { POST: Handler };
  test: { POST: Handler };
  legacy: { GET: Handler; PUT: Handler; DELETE: Handler; POST: Handler };
};

const mkDef = (key: string) => ({
  key,
  label: `Test ${key}`,
  description: "test-only event",
  tags: [{ tag: "subject", label: "Subject" }],
  text: ["subject"],
  subject: "About {{subject}}",
  body: "We got **{{subject}}**.",
});

before(async () => {
  edition.features = ["policy_ack", "helpdesk"];
  await db.getSetting("__schema_bootstrap__");
  tpl.EMAIL_TEMPLATES.push(mkDef(EV_HD), mkDef(EV_CORE));
  await parts.seedEmailParts([EV_HD, EV_CORE]);
  admin = await sessionFor(await newUser("admin", "admin"));
  viewer = await sessionFor(await newUser("viewer", "viewer"));
  const hd = await newUser("hdadmin", "viewer");
  await db.pool().query(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
     SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-manager'`,
    [hd]
  );
  hdAdmin = await sessionFor(hd);
  teamId = (await db.pool().query<{ id: number }>("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`ept-api-${STAMP}`])).rows[0].id;
  R = {
    parts: (await import("../src/app/api/admin/email-templates/parts/route")) as never,
    part: (await import("../src/app/api/admin/email-templates/parts/[id]/route")) as never,
    reset: (await import("../src/app/api/admin/email-templates/parts/[id]/reset/route")) as never,
    dflt: (await import("../src/app/api/admin/email-templates/parts/[id]/default/route")) as never,
    comps: (await import("../src/app/api/admin/email-templates/compositions/route")) as never,
    comp: (await import("../src/app/api/admin/email-templates/compositions/[event]/route")) as never,
    preview: (await import("../src/app/api/admin/email-templates/preview/route")) as never,
    test: (await import("../src/app/api/admin/email-templates/test/route")) as never,
    legacy: (await import("../src/app/api/admin/email-templates/route")) as never,
  };
});

after(async () => {
  await db.pool().query("DELETE FROM email_template_compositions WHERE event_key = ANY($1)", [[EV_HD, EV_CORE]]);
  await db.pool().query("DELETE FROM email_template_parts WHERE event_key = ANY($1) OR id = ANY($2)", [[EV_HD, EV_CORE], partIds]);
  await db.pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await db.pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await db.pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await db.pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

describe("permissions", () => {
  test("a viewer is refused everywhere; signed out is 401; a cross-origin request is 403", async () => {
    assert.equal((await call(R.parts.GET, `${BASE}/parts`, viewer, "GET")).status, 403);
    assert.equal((await call(R.comps.GET, `${BASE}/compositions`, viewer, "GET")).status, 403);
    assert.equal((await call(R.preview.POST, `${BASE}/preview`, viewer, "POST", { event: EV_HD })).status, 403);
    assert.equal((await call(R.comp.PUT, `${BASE}/compositions/${EV_HD}`, viewer, "PUT", {}, { event: EV_HD })).status, 403);
    assert.equal((await call(R.parts.GET, `${BASE}/parts`, "nope", "GET")).status, 401);
    currentRequest = new Request(`${BASE}/parts`, { headers: { cookie: `compass_session=${admin}`, origin: "https://evil.example", host: "localhost:3000" } });
    try {
      assert.equal((await R.parts.GET(currentRequest)).status, 403);
    } finally {
      currentRequest = null;
    }
  });

  test("a helpdesk admin reads parts and composes hd_* events only; not the library, not other events; nothing without the licence", async () => {
    const list = await call(R.parts.GET, `${BASE}/parts?kind=signature`, hdAdmin, "GET");
    assert.equal(list.status, 200);
    assert.ok(list.body.parts.every((p: Json) => p.kind === "signature"));
    assert.equal((await call(R.parts.POST, `${BASE}/parts`, hdAdmin, "POST", { kind: "signature", name: "x", content: "y" })).status, 403);
    const comps = await call(R.comps.GET, `${BASE}/compositions`, hdAdmin, "GET");
    assert.equal(comps.status, 200);
    assert.ok(comps.body.events.length > 0 && comps.body.events.every((e: Json) => e.key.startsWith("hd_")), "hd_* events only");
    assert.equal(comps.body.can_manage, false);
    assert.equal((await call(R.comp.GET, `${BASE}/compositions/doc_update`, hdAdmin, "GET", undefined, { event: "doc_update" })).status, 403);
    assert.equal((await call(R.comp.PUT, `${BASE}/compositions/${EV_CORE}`, hdAdmin, "PUT", {}, { event: EV_CORE })).status, 403);
    assert.equal((await call(R.preview.POST, `${BASE}/preview`, hdAdmin, "POST", { event: "doc_update" })).status, 403);
    const put = await call(R.comp.PUT, `${BASE}/compositions/${EV_HD}`, hdAdmin, "PUT", { scope: `hd_team:${teamId}`, signature_id: null }, { event: EV_HD });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.composition.scope, `hd_team:${teamId}`);
    edition.features = ["policy_ack"];
    try {
      assert.equal((await call(R.comps.GET, `${BASE}/compositions`, hdAdmin, "GET")).status, 403);
    } finally {
      edition.features = ["policy_ack", "helpdesk"];
    }
  });
});

describe("parts", () => {
  test("create, read, update, delete (refused while in use, with the emails), each audited", async () => {
    const created = await call(R.parts.POST, `${BASE}/parts`, admin, "POST", { kind: "signature", name: `Sig ${STAMP}`, content: "Cheers, {{sender_name}}" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const p = created.body.part;
    partIds.push(p.id);
    assert.equal(p.kind, "signature");
    assert.equal(p.builtin, false);
    assert.deepEqual(p.used_by, []);
    assert.equal(await auditRows("email_template.part_created", p.id), 1);

    const got = await call(R.part.GET, `${BASE}/parts/${p.id}`, admin, "GET", undefined, { id: String(p.id) });
    assert.equal(got.status, 200);
    assert.ok(got.body.tags.some((t: Json) => t.tag === "sender_title"), "a signature offers the sender tags");

    const patched = await call(R.part.PATCH, `${BASE}/parts/${p.id}`, admin, "PATCH", { content: "Thanks, {{sender_name}}" }, { id: String(p.id) });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.part.content, "Thanks, {{sender_name}}");
    assert.equal(await auditRows("email_template.part_updated", p.id), 1);
    assert.equal((await call(R.part.PATCH, `${BASE}/parts/${p.id}`, admin, "PATCH", { name: "" }, { id: String(p.id) })).status, 400);

    const put = await call(R.comp.PUT, `${BASE}/compositions/${EV_CORE}`, admin, "PUT", { signature_id: p.id }, { event: EV_CORE });
    assert.equal(put.status, 200);
    assert.equal(put.body.composition.signature.source, "chosen");
    assert.equal(await auditRows("email_template.composition_updated", EV_CORE), 1);

    const refused = await call(R.part.DELETE, `${BASE}/parts/${p.id}`, admin, "DELETE", undefined, { id: String(p.id) });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.used_by, [{ event_key: EV_CORE, event_label: `Test ${EV_CORE}`, scope: "all", slot: "signature" }]);

    await call(R.comp.PUT, `${BASE}/compositions/${EV_CORE}`, admin, "PUT", { signature_id: null }, { event: EV_CORE });
    const del = await call(R.part.DELETE, `${BASE}/parts/${p.id}`, admin, "DELETE", undefined, { id: String(p.id) });
    assert.equal(del.status, 200);
    assert.equal(await auditRows("email_template.part_deleted", p.id), 1);
    assert.equal((await call(R.part.GET, `${BASE}/parts/${p.id}`, admin, "GET", undefined, { id: String(p.id) })).status, 404);
  });

  test("a built-in can be edited and reset to its original, never deleted; a body can't be the default", async () => {
    const body = (await parts.builtinBody(EV_CORE))!;
    const id = String(body.id);
    const edited = await call(R.part.PATCH, `${BASE}/parts/${id}`, admin, "PATCH", { subject: "Edited {{subject}}" }, { id });
    assert.equal(edited.body.part.customized, true);
    assert.deepEqual(await tpl.templateOverride(EV_CORE), { subject: "Edited {{subject}}", body: mkDef(EV_CORE).body });
    const reset = await call(R.reset.POST, `${BASE}/parts/${id}/reset`, admin, "POST", undefined, { id });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.part.subject, mkDef(EV_CORE).subject);
    assert.equal(reset.body.part.customized, false);
    assert.equal(await auditRows("email_template.part_reset", body.id), 1);
    assert.equal((await call(R.part.DELETE, `${BASE}/parts/${id}`, admin, "DELETE", undefined, { id })).status, 409);
    assert.equal((await call(R.dflt.POST, `${BASE}/parts/${id}/default`, admin, "POST", undefined, { id })).status, 400);
    assert.equal((await call(R.dflt.POST, `${BASE}/parts/${id}/default`, hdAdmin, "POST", undefined, { id })).status, 403);
  });
});

describe("compositions", () => {
  test("the list carries every event, the team variants and where each slot comes from", async () => {
    const r = await call(R.comps.GET, `${BASE}/compositions`, admin, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.can_manage, true);
    assert.deepEqual(r.body.events.map((e: Json) => e.key), tpl.EMAIL_TEMPLATES.map((t) => t.key));
    const mine = r.body.compositions.find((c: Json) => c.event_key === EV_HD);
    assert.deepEqual(Object.keys(mine.header).sort(), ["effective_id", "effective_name", "id", "source"]);
    assert.equal(mine.body.source, "chosen");
    assert.ok(r.body.variants.some((v: Json) => v.event_key === EV_HD && v.team_id === teamId));
    const team = await call(R.comps.GET, `${BASE}/compositions?scope=hd_team:${teamId}`, admin, "GET");
    assert.ok(team.body.events.every((e: Json) => e.helpdesk));
    assert.equal((await call(R.comps.GET, `${BASE}/compositions?scope=everyone`, admin, "GET")).status, 400);
  });

  test("team variants: only for hd_* events and existing teams; removing one is audited", async () => {
    const scope = `hd_team:${teamId}`;
    assert.equal((await call(R.comp.PUT, `${BASE}/compositions/${EV_CORE}`, admin, "PUT", { scope }, { event: EV_CORE })).status, 400);
    assert.equal(
      (await call(R.comp.PUT, `${BASE}/compositions/${EV_HD}`, admin, "PUT", { scope: "hd_team:999999999" }, { event: EV_HD })).status,
      404
    );
    assert.equal((await call(R.comp.PUT, `${BASE}/compositions/nope`, admin, "PUT", {}, { event: "nope" })).status, 404);
    const del = await call(R.comp.DELETE, `${BASE}/compositions/${EV_HD}?scope=${scope}`, hdAdmin, "DELETE", undefined, { event: EV_HD });
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    assert.equal(del.body.composition.stored, false);
    assert.equal(await auditRows("email_template.composition_removed", `${EV_HD}@${scope}`), 1);
    assert.equal((await call(R.comp.DELETE, `${BASE}/compositions/${EV_HD}?scope=all`, admin, "DELETE", undefined, { event: EV_HD })).status, 400);
  });
});

describe("preview and test send", () => {
  test("preview answers subject, html, text and the parts used", async () => {
    const r = await call(R.preview.POST, `${BASE}/preview`, hdAdmin, "POST", {
      event: EV_HD,
      scope: `hd_team:${teamId}`,
      draft: { kind: "signature", content: "Draft {{team_name}}" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ["html", "parts", "subject", "text"]);
    // A team's version previews with that team's name, not the sample "IT".
    assert.ok(r.body.html.includes(`Draft ept-api-${STAMP}`), r.body.html);
    assert.equal((await call(R.preview.POST, `${BASE}/preview`, admin, "POST", { event: "nope" })).status, 404);
  });

  test("test send: only who may compose the event, five per ten minutes", async () => {
    assert.equal((await call(R.test.POST, `${BASE}/test`, hdAdmin, "POST", { event: EV_CORE })).status, 403);
    const r = await call(R.test.POST, `${BASE}/test`, admin, "POST", { event: EV_HD });
    // This database may or may not have SMTP configured; never a permission answer.
    assert.ok([200, 409, 502].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`);
    const t0 = 1_000_000;
    const uid = -Date.now();
    for (let i = 0; i < 5; i++) assert.equal(access.allowTestSend(uid, t0 + i), true);
    assert.equal(access.allowTestSend(uid, t0 + 10), false);
    assert.equal(access.allowTestSend(uid, t0 + 10 * 60_000 + 5), true, "the window moves on");
  });
});

describe("the 1.18 single-template route", () => {
  test("still lists every template, saves and resets through the event's built-in body", async () => {
    const list = await call(R.legacy.GET, BASE, admin, "GET");
    assert.equal(list.status, 200);
    assert.ok(list.body.templates.some((t: Json) => t.key === "doc_update"));
    const saved = await call(R.legacy.PUT, BASE, admin, "PUT", { key: EV_CORE, subject: "Legacy {{subject}}", body: "Legacy body" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.customized, true);
    assert.equal((await parts.builtinBody(EV_CORE))?.subject, "Legacy {{subject}}");
    const reset = await call(R.legacy.DELETE, `${BASE}?key=${EV_CORE}`, admin, "DELETE");
    assert.equal(reset.status, 200);
    assert.equal((await parts.builtinBody(EV_CORE))?.subject, mkDef(EV_CORE).subject);
    const preview = await call(R.legacy.POST, BASE, admin, "POST", { key: EV_CORE, subject: "P {{subject}}", body: "B" });
    assert.equal(preview.status, 200);
    assert.deepEqual(Object.keys(preview.body).sort(), ["html", "subject"]);
  });
});
