// Changing your own password (POST /api/auth/change-password, the forced
// change and Account → Security) re-checks the current password, an oracle
// like the sign-in form's. Since 1.16.0 it is throttled as the typed
// signature is (lib/login-guard): per username and address only, checked and
// counted with no await between, five misses lock the pair for 15 minutes
// (429 with Retry-After), each miss is audited as auth.login_failed
// { via: "change_password" } and the lock it engages as auth.lockout, and a
// right password clears the pair.
//
// The route is called directly: next/headers resolves to a stub that serves
// the request under test, with its session cookie (as in
// test/account-email.test.ts).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/change-password.test.ts

import Module from "node:module";
import path from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.change-password.virtual.js");
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
const { hashPassword, newToken, verifyPassword } = require("../src/lib/password") as typeof import("../src/lib/password");
const { loginRetryAfter, recordLoginFailure } = require("../src/lib/login-guard") as typeof import("../src/lib/login-guard");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `chpw${Date.now()}`;
const PASSWORD = "Current-pass-1";
const userIds: number[] = [];
type Handler = (req: Request) => Promise<Response>;
let route: { POST: Handler };

async function account(tag: string, opts: { provider?: string } = {}) {
  const pw = opts.provider ? null : hashPassword(PASSWORD);
  const username = `${STAMP}-${tag}`;
  const r = await db.pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, status, auth_provider, password_hash, password_salt)
     VALUES ($1, $2, '', 'viewer', 'active', $3, $4, $5) RETURNING id`,
    [username, `Change ${tag}`, opts.provider ?? "local", pw?.hash ?? null, pw?.salt ?? null]
  );
  const id = r.rows[0].id;
  userIds.push(id);
  const session = newToken();
  await db.createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  return { id, username, session };
}

const request = (session: string, body: unknown, ip: string) =>
  new Request("https://docs.example.test/api/auth/change-password", {
    method: "POST",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

/** Several requests in flight at once under one session; currentRequest serves their cookie throughout. */
async function change(session: string, bodies: unknown[], ip: string) {
  currentRequest = request(session, {}, ip);
  try {
    return await Promise.all(
      bodies.map(async (body) => {
        const res = await route.POST(request(session, body, ip));
        return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as { error?: string; ok?: boolean } };
      })
    );
  } finally {
    currentRequest = null;
  }
}

const one = async (session: string, body: unknown, ip: string) => (await change(session, [body], ip))[0];
const wrong = { currentPassword: "Not-the-one-1", newPassword: "Brand-new-pass-1" };
const right = { currentPassword: PASSWORD, newPassword: "Brand-new-pass-1" };

const audited = async (action: string, userId: number) =>
  (
    await db.pool().query<{ details: unknown; actor_id: number }>(
      "SELECT details, actor_id FROM audit_log WHERE action = $1 AND target_type = 'user' AND target_id = $2 ORDER BY id",
      [action, String(userId)]
    )
  ).rows;

before(async () => {
  await db.getSetting("__schema_bootstrap__");
  route = (await import("../src/app/api/auth/change-password/route")) as unknown as { POST: Handler };
});

after(async () => {
  await db.pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await db.pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

test("five wrong current passwords lock the pair: the sixth, right or not, waits, and each miss and the lock are audited once", async () => {
  const me = await account("five");
  const ip = "203.0.113.70";
  for (let i = 1; i <= 5; i++) {
    const r = await one(me.session, wrong, ip);
    assert.equal(r.status, 400, `miss ${i}`);
    assert.equal(r.body.error, "Current password is incorrect.");
  }
  const locked = await one(me.session, right, ip);
  assert.equal(locked.status, 429);
  assert.match(locked.body.error!, /^Too many failed attempts\. Try again in 15 minutes\.$/);
  assert.ok(Number(locked.retryAfter) > 800, `Retry-After ${locked.retryAfter}`);

  const failed = await audited("auth.login_failed", me.id);
  assert.deepEqual(failed.map((r) => r.details), Array(5).fill({ via: "change_password" }));
  assert.ok(failed.every((r) => r.actor_id === me.id), "the session's user is the actor");
  assert.deepEqual((await audited("auth.lockout", me.id)).map((r) => r.details), [{ minutes: 15, via: "change_password" }]);

  const row = await db.getUserByUsername(me.username);
  assert.ok(verifyPassword(PASSWORD, row!.password_hash!, row!.password_salt!), "the password is unchanged");
});

test("a burst sent at once gets five checks, not one each", async () => {
  const me = await account("burst");
  const ip = "203.0.113.71";
  const statuses = (await change(me.session, Array(10).fill(wrong), ip)).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 400).length, 5, statuses.join(" "));
  assert.equal(statuses.filter((s) => s === 429).length, 5);
  assert.equal((await audited("auth.login_failed", me.id)).length, 5);
  assert.equal((await audited("auth.lockout", me.id)).length, 1);
});

test("the lock is the pair's: the sign-in form honours it, and the address's spray counter is untouched", async () => {
  const me = await account("pair");
  const ip = "203.0.113.72";
  for (let i = 0; i < 5; i++) await one(me.session, wrong, ip);
  assert.ok(loginRetryAfter(me.username, ip) > 0, "the same pair cannot sign in either");
  // Fill the address to one below the 30 spray limit from the sign-in side:
  // had any of the five misses counted against the address, it is locked.
  for (let i = 0; i < 29; i++) recordLoginFailure(`${STAMP}-spray-${i}`, ip);
  assert.equal(loginRetryAfter(`${STAMP}-someone-else`, ip), 0, "the address's spray counter never saw the misses");
  assert.equal((await one(me.session, right, "203.0.113.73")).status, 200, "another address is its own pair");
});

test("the right current password changes it and clears the pair's misses", async () => {
  const me = await account("clear");
  const ip = "203.0.113.74";
  for (let i = 0; i < 4; i++) assert.equal((await one(me.session, wrong, ip)).status, 400);
  const ok = await one(me.session, right, ip);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  const row = await db.getUserByUsername(me.username);
  assert.ok(verifyPassword(right.newPassword, row!.password_hash!, row!.password_salt!), "the new password is set");
  const again = { currentPassword: "Not-the-one-1", newPassword: "Another-pass-1" };
  for (let i = 1; i <= 4; i++) assert.equal((await one(me.session, again, ip)).status, 400, `miss ${i} after it: not locked`);
  assert.equal((await audited("auth.lockout", me.id)).length, 0);
});

test("refusals that never check the password are not counted or audited", async () => {
  const me = await account("policy");
  const sso = await account("sso", { provider: "oidc" });
  const ip = "203.0.113.75";
  for (let i = 0; i < 6; i++) {
    assert.equal((await one(me.session, { currentPassword: "x", newPassword: "short" }, ip)).status, 400);
    assert.equal((await one(sso.session, wrong, ip)).status, 400);
  }
  assert.equal((await one(me.session, right, ip)).status, 200);
  assert.equal((await audited("auth.login_failed", me.id)).length + (await audited("auth.login_failed", sso.id)).length, 0);
  assert.equal((await one("not-a-session", right, ip)).status, 401);
});
