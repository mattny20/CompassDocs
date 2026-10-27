// Who set an account's email (1.16.0, users.email_self_set). An email the
// owner types on Account → Profile is unverified: it is refused when another
// account already has it as its email or username (409), and it is marked,
// so it never links an SSO identity (getUserByEmailForLink and the overlay's
// link guard) or matches a synced group member by email
// (matchUsersByIdentity). An administrator saving the email, or SCIM sending
// one, clears the mark. The upgrade marks every profile email change the
// audit log recorded, once.
//
// The route handlers are called directly, the way test/ack-statement.test.ts
// does it: next/headers resolves to a stub that serves the request under
// test, with its session cookie.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/account-email.test.ts

import Module from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.account-email.virtual.js");
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
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `acctemail${Date.now()}`;
const D = `${STAMP}.example.test`;
const userIds: number[] = [];

async function newUser(
  tag: string,
  opts: { email?: string; username?: string; role?: string; status?: string; provider?: string; selfSet?: number; externalId?: string } = {}
): Promise<number> {
  const r = await db.pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, status, auth_provider, external_id, email_self_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      opts.username ?? `${STAMP}-${tag}`,
      `Email ${tag}`,
      opts.email ?? "",
      opts.role ?? "viewer",
      opts.status ?? "active",
      opts.provider ?? "local",
      opts.externalId ?? null,
      opts.selfSet ?? 0,
    ]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function sessionFor(userId: number): Promise<string> {
  const token = newToken();
  await db.createSession(token, userId, new Date(Date.now() + 3_600_000).toISOString());
  return token;
}

const row = async (id: number) =>
  (await db.pool().query<{ email: string; email_self_set: number }>("SELECT email, email_self_set FROM users WHERE id = $1", [id])).rows[0];

type Handler = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, url: string, session: string, body: unknown, id?: number) {
  currentRequest = new Request(url, {
    method: "PATCH",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.90" },
    body: JSON.stringify(body),
  });
  try {
    const res = await handler(currentRequest, id === undefined ? undefined : { params: Promise.resolve({ id: String(id) }) });
    return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string } | null };
  } finally {
    currentRequest = null;
  }
}

let meId = 0;
let meSession = "";
let adminSession = "";
let profile: { PATCH: Handler };
let adminUser: { PATCH: Handler };

before(async () => {
  await db.getSetting("__schema_bootstrap__");
  meId = await newUser("me");
  meSession = await sessionFor(meId);
  adminSession = await sessionFor(await newUser("admin", { role: "admin" }));
  await newUser("taken", { email: `Taken@${D}` });
  await newUser("off", { email: `off@${D}`, status: "disabled" });
  // An SSO account whose username is an address and whose email is empty.
  await newUser("jit", { username: `jit@${D}`, provider: "oidc" });
  profile = (await import("../src/app/api/account/profile/route")) as unknown as { PATCH: Handler };
  adminUser = (await import("../src/app/api/admin/users/[id]/route")) as unknown as { PATCH: Handler };
});

after(async () => {
  await db.pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await db.pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

const PROFILE_URL = "https://docs.example.test/api/account/profile";
const setOwnEmail = (email: string, extra: Record<string, unknown> = {}) =>
  call(profile.PATCH, PROFILE_URL, meSession, { email, ...extra });

describe("an email the owner sets on their profile", () => {
  test("is saved and marked as theirs; a name change or a change of case keeps the mark; clearing it clears the mark", async () => {
    assert.equal((await setOwnEmail(`me@${D}`)).status, 200);
    assert.deepEqual(await row(meId), { email: `me@${D}`, email_self_set: 1 });

    assert.equal((await call(profile.PATCH, PROFILE_URL, meSession, { name: "Email me, renamed" })).status, 200);
    assert.equal((await row(meId)).email_self_set, 1, "a name-only save keeps the mark");
    assert.equal((await setOwnEmail(`ME@${D}`)).status, 200, "their own address in another case is no conflict");
    assert.equal((await row(meId)).email_self_set, 1);

    assert.equal((await setOwnEmail("")).status, 200);
    assert.deepEqual(await row(meId), { email: "", email_self_set: 0 });
  });

  test("is refused, and nothing changes, when another account of any status has it as its email or username", async () => {
    await setOwnEmail(`me@${D}`);
    for (const email of [`taken@${D}`, `TAKEN@${D}`, `off@${D}`, `JIT@${D}`]) {
      const r = await setOwnEmail(email, { name: "Should not stick" });
      assert.equal(r.status, 409, email);
      assert.equal(r.body?.error, "That email address is already used by another account.");
      assert.deepEqual(await row(meId), { email: `me@${D}`, email_self_set: 1 }, `${email}: unchanged`);
    }
    const name = (await db.pool().query("SELECT name FROM users WHERE id = $1", [meId])).rows[0].name;
    assert.notEqual(name, "Should not stick", "a refused save changes nothing, the name included");
  });
});

describe("an email an administrator or the directory sets", () => {
  const url = (id: number) => `https://docs.example.test/api/admin/users/${id}`;

  test("an administrator re-saving an unchanged self-set email clears the mark, and it is audited", async () => {
    const id = await newUser("vouch", { email: `vouch@${D}`, selfSet: 1 });
    const r = await call(adminUser.PATCH, url(id), adminSession, { email: `vouch@${D}` }, id);
    assert.equal(r.status, 200);
    assert.deepEqual(await row(id), { email: `vouch@${D}`, email_self_set: 0 });
    const audit = await db.pool().query(
      "SELECT details FROM audit_log WHERE action = 'user.email_change' AND target_id = $1",
      [String(id)]
    );
    assert.deepEqual(audit.rows.map((a) => a.details), [{ changed: false, was_self_set: true }]);
  });

  test("an administrator's save must look like an email; a viewer cannot make one", async () => {
    const id = await newUser("vouch2", { email: `vouch2@${D}`, selfSet: 1 });
    assert.equal((await call(adminUser.PATCH, url(id), adminSession, { email: "not an email" }, id)).status, 400);
    assert.equal((await call(adminUser.PATCH, url(id), meSession, { email: `vouch2@${D}` }, id)).status, 403);
    assert.equal((await row(id)).email_self_set, 1);
  });

  test("an administrator cannot give an account another account's email (any case), and nothing is audited", async () => {
    const id = await newUser("vouch3", { email: `vouch3@${D}`, selfSet: 1 });
    await newUser("admintaken", { email: `admintaken@${D}` });
    const r = await call(adminUser.PATCH, url(id), adminSession, { email: `ADMINTAKEN@${D}` }, id);
    assert.equal(r.status, 409);
    assert.equal(r.body?.error, "That email address is already used by another account.");
    assert.deepEqual(await row(id), { email: `vouch3@${D}`, email_self_set: 1 });
    const audit = await db.pool().query(
      "SELECT 1 FROM audit_log WHERE action = 'user.email_change' AND target_id = $1",
      [String(id)]
    );
    assert.equal(audit.rowCount, 0);
  });

  test("SCIM sending an email clears the mark; an update without one keeps it", async () => {
    const id = await newUser("scim", { email: `scim@${D}`, selfSet: 1 });
    await db.scimUpdateUser(id, { name: "Email scim renamed" });
    assert.equal((await row(id)).email_self_set, 1);
    await db.scimUpdateUser(id, { email: `scim@${D}` });
    assert.equal((await row(id)).email_self_set, 0);
  });
});

describe("matching an SSO identity or a group member by email", () => {
  test("SSO linking takes only the one account with the email, and carries the mark for the link guard", async () => {
    const solo = await newUser("solo", { email: `solo@${D}`, selfSet: 1 });
    await newUser("pair1", { email: `pair@${D}` });
    await newUser("pair2", { email: `PAIR@${D}` });
    const one = await db.getUserByEmailForLink(`SOLO@${D}`);
    assert.equal(one.ambiguous, false);
    assert.equal(one.user?.id, solo);
    assert.equal((one.user as { email_self_set?: number }).email_self_set, 1);
    const two = await db.getUserByEmailForLink(`pair@${D}`);
    assert.deepEqual(two, { user: undefined, ambiguous: true });
    assert.deepEqual(await db.getUserByEmailForLink(`nobody@${D}`), { user: undefined, ambiguous: false });
  });

  test("group sync skips a self-set email, matches a unique trusted one, and still matches by external id", async () => {
    const trusted = await newUser("trusted", { email: `trusted@${D}` });
    await newUser("claimer", { email: `TRUSTED@${D}`, selfSet: 1 });
    const claimed = await newUser("claimed", { email: `claimed@${D}`, selfSet: 1, externalId: `ext-${STAMP}` });
    await newUser("twin1", { email: `twin@${D}` });
    await newUser("twin2", { email: `twin@${D}` });
    const ids = await db.matchUsersByIdentity([
      { email: `trusted@${D}` },
      { email: `claimed@${D}` },
      { email: `twin@${D}` },
      { externalId: `ext-${STAMP}`, email: `elsewhere@${D}` },
    ]);
    assert.deepEqual(ids.sort((a, b) => a - b), [trusted, claimed].sort((a, b) => a - b));
  });
});

describe("the upgrade marks the emails the audit log shows their owners set", () => {
  const BASE = process.env.DATABASE_URL ?? "";
  const DB = `email_self_set_${Date.now()}`;
  const urlFor = (name: string) => {
    const u = new URL(BASE);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const boot = () => {
    const r = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.test.json", "test/support/boot.ts"],
      { env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: "utf8", timeout: 180_000 }
    );
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  };
  async function withDb<T>(name: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: urlFor(name) });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const adminDb = new URL(BASE).pathname.slice(1);

  before(async () => {
    await withDb(adminDb, (c) => c.query(`CREATE DATABASE ${DB}`));
  });
  after(async () => {
    await withDb(adminDb, (c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  test("once, at the column's creation", async () => {
    boot();
    const ids = await withDb(DB, async (c) => {
      await c.query("ALTER TABLE users DROP COLUMN email_self_set");
      const u = await c.query<{ id: number; username: string }>(
        `INSERT INTO users (username, email) VALUES ('typed', 'typed@x.test'), ('given', 'given@x.test'), ('cleared', '')
         RETURNING id, username`
      );
      const id = Object.fromEntries(u.rows.map((r) => [r.username, r.id]));
      await c.query(
        `INSERT INTO audit_log (actor_id, actor_name, action, details) VALUES
           ($1, 'typed', 'account.profile_updated', '{"name_changed":false,"email_changed":true}'),
           ($2, 'given', 'account.profile_updated', '{"name_changed":true,"email_changed":false}'),
           ($3, 'cleared', 'account.profile_updated', '{"name_changed":false,"email_changed":true}')`,
        [id.typed, id.given, id.cleared]
      );
      return id;
    });
    boot();
    const flags = () =>
      withDb(DB, async (c) =>
        Object.fromEntries(
          (await c.query<{ username: string; email_self_set: number }>("SELECT username, email_self_set FROM users WHERE id = ANY($1)", [Object.values(ids)])).rows.map(
            (r) => [r.username, r.email_self_set]
          )
        )
      );
    assert.deepEqual(await flags(), { typed: 1, given: 0, cleared: 0 });

    // An administrator vouches for it; a later boot never marks it again.
    await withDb(DB, (c) => c.query("UPDATE users SET email_self_set = 0 WHERE id = $1", [ids.typed]));
    boot();
    assert.deepEqual(await flags(), { typed: 0, given: 0, cleared: 0 });
  });
});
