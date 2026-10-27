// Sign-in (1.16.0): where an identifier goes (lib/sign-in-routing), the
// lookup route that tells the page (/api/auth/lookup), and the password step
// accepting an email (lib/auth resolveSignInAccount, login).
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/sign-in.test.ts

import Module from "node:module";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// next/headers and lib/ee as a licensed enterprise build sees them, before
// anything that imports them loads (the route reads headers() for the
// cross-origin check, the routing reads featureEnabled("sso")).
let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.sign-in.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.sign-in.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["sso"] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const { pool, getSetting, setSetting, signInAccountFlags } = require("../src/lib/db") as typeof import("../src/lib/db");
const routing = require("../src/lib/sign-in-routing") as typeof import("../src/lib/sign-in-routing");
const auth = require("../src/lib/auth") as typeof import("../src/lib/auth");
const { hashPassword } = require("../src/lib/password") as typeof import("../src/lib/password");
const { signInLookupRetryAfter } = require("../src/lib/rate-limit") as typeof import("../src/lib/rate-limit");
const { totpCode, generateTotpSecret } = require("../src/lib/totp") as typeof import("../src/lib/totp");
const { PRESET_SSO, PRESET_SAML } = {
  PRESET_SSO: {
    enabled: true,
    tenant: "11111111-2222-3333-4444-555555555555",
    clientId: "client",
    clientSecret: "secret",
    authority: "",
    autoProvision: true,
    defaultRole: "viewer" as const,
    allowedDomains: [] as string[],
    ssoOnly: false,
    vendor: "microsoft" as const,
  },
  PRESET_SAML: {
    enabled: true,
    idpSsoUrl: "https://idp.example.test/sso",
    idpIssuer: "https://idp.example.test",
    idpCert: "MIIBdummy",
    autoProvision: true,
    defaultRole: "viewer" as const,
    allowedDomains: [] as string[],
    buttonLabel: "Sign in with Okta",
  },
};
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `signin${Date.now()}`;
const DOMAIN = `${STAMP}.example.test`;
const userIds: number[] = [];

async function newUser(tag: string, opts: { provider?: string; password?: string; email?: string; status?: string; role?: string } = {}) {
  const pw = opts.password ? hashPassword(opts.password) : null;
  const r = await pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, status, auth_provider, password_hash, password_salt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [`${STAMP}-${tag}`, `Sign ${tag}`, opts.email ?? "", opts.role ?? "viewer", opts.status ?? "active", opts.provider ?? "local", pw?.hash ?? null, pw?.salt ?? null]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

const setupOf = (sso: Partial<typeof PRESET_SSO> | null, saml: Partial<typeof PRESET_SAML> | null) =>
  routing.setupFrom({ ...PRESET_SSO, enabled: Boolean(sso), ...(sso ?? {}) }, { ...PRESET_SAML, enabled: Boolean(saml), ...(saml ?? {}) });

before(async () => {
  await getSetting("__schema_bootstrap__");
  await newUser("pw", { password: "Secret-pass-1", email: `pw@${DOMAIN}` });
  await newUser("oidc", { provider: "oidc", email: `oidc@other-${DOMAIN}` });
  await newUser("saml", { provider: "saml", email: `saml@other-${DOMAIN}` });
  await newUser("off", { provider: "oidc", email: `off@other-${DOMAIN}`, status: "disabled" });
  await newUser("dup1", { password: "Secret-pass-1", email: `dup@${DOMAIN}` });
  await newUser("dup2", { password: "Secret-pass-2", email: `dup@${DOMAIN}` });
  await newUser("nopw", { email: `nopw@${DOMAIN}` });
  await newUser("gone", { password: "Secret-pass-1", email: `gone@${DOMAIN}`, status: "disabled" });
  // Username/email collisions: a JIT SSO account's username is its email (the
  // overlay's freeUsername), and local password accounts can carry the same
  // address. "many@" has three of them, inserted first, so a username match
  // that sorted last would fall outside a limit of three.
  await newUser("loc", { password: "Secret-pass-1", email: `jit@${DOMAIN}` });
  for (const n of [1, 2, 3]) await newUser(`many${n}`, { password: "Secret-pass-1", email: `many@${DOMAIN}` });
  for (const name of [`jit@${DOMAIN}`, `many@${DOMAIN}`]) {
    const r = await pool().query<{ id: number }>(
      `INSERT INTO users (username, name, email, auth_provider) VALUES ($1, 'Sign jit', $1, 'oidc') RETURNING id`,
      [name]
    );
    userIds.push(r.rows[0].id);
  }
});

after(async () => {
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
});

describe("the providers a workspace offers", () => {
  test("labels follow the vendor; a custom authority is plain single sign-on", () => {
    assert.equal(setupOf({}, null).oidc?.label, "Sign in with Microsoft");
    assert.equal(setupOf({ vendor: "google" as never }, null).oidc?.label, "Sign in with Google");
    assert.equal(setupOf({ vendor: "generic" as never }, null).oidc?.label, "Sign in with single sign-on");
    assert.equal(setupOf({ authority: "https://login.okta.example/oauth2" }, null).oidc?.label, "Sign in with single sign-on");
    assert.equal(setupOf({ authority: "https://login.okta.example/oauth2" }, null).oidc?.mark, "generic");
    assert.equal(setupOf(null, {}).saml?.label, "Sign in with Okta");
  });

  test("a multi-tenant Microsoft authority with no domain list is not offered (its sign-in can never succeed)", () => {
    assert.equal(setupOf({ tenant: "common" }, null).oidc, null);
    assert.equal(setupOf({ tenant: "organizations", allowedDomains: ["corp.test"] }, null).oidc?.id, "oidc");
  });

  test("SSO only counts only when a provider is usable", () => {
    assert.equal(setupOf({ ssoOnly: true }, null).ssoOnly, true);
    assert.equal(setupOf({ ssoOnly: true, tenant: "common" }, null).ssoOnly, false);
    assert.equal(routing.anyProvider(setupOf(null, null)), false);
  });
});

describe("routing by configuration (rules 1 to 3)", () => {
  test("no provider: the password step, and nothing is read", () => {
    assert.deepEqual(routing.routeByConfig("anyone@corp.test", setupOf(null, null)), { step: "password" });
  });

  test("SSO only: every identifier goes to every usable provider", () => {
    assert.deepEqual(routing.routeByConfig("admin", setupOf({ ssoOnly: true }, {})), { step: "sso", providers: ["oidc", "saml"] });
  });

  test("an email on a provider's domain list goes there; both lists: both; a username never matches a domain", () => {
    const s = setupOf({ allowedDomains: ["corp.test", "both.test"] }, { allowedDomains: ["saml.test", "both.test"] });
    assert.deepEqual(routing.routeByConfig("Ann@Corp.Test", s), { step: "sso", providers: ["oidc"] });
    assert.deepEqual(routing.routeByConfig("bo@saml.test", s), { step: "sso", providers: ["saml"] });
    assert.deepEqual(routing.routeByConfig("cy@both.test", s), { step: "sso", providers: ["oidc", "saml"] });
    assert.equal(routing.routeByConfig("corp.test", s), null, "no @: rule 4 decides");
    assert.equal(routing.routeByConfig("dee@elsewhere.test", s), null);
  });

  test("an empty domain list claims nothing", () => {
    assert.equal(routing.routeByConfig("ann@corp.test", setupOf({}, {})), null);
  });

  test("the domain is the part after the last @, lowercased", () => {
    assert.equal(routing.emailDomain("a@b@Corp.Test"), "corp.test");
    assert.equal(routing.emailDomain("@corp.test"), null);
    assert.equal(routing.emailDomain("ann@"), null);
    assert.equal(routing.emailDomain("ann"), null);
  });
});

describe("routing by account (rules 4 and 5)", () => {
  const both = () => setupOf({}, {});

  test("an SSO account goes to its provider; a SAML one to SAML; status does not change the route", async () => {
    assert.deepEqual(await routing.routeByAccount(`${STAMP}-oidc`, both()), { step: "sso", providers: ["oidc"] });
    assert.deepEqual(await routing.routeByAccount(`oidc@other-${DOMAIN}`, both()), { step: "sso", providers: ["oidc"] });
    assert.deepEqual(await routing.routeByAccount(`${STAMP}-saml`, both()), { step: "sso", providers: ["saml"] });
    assert.deepEqual(await routing.routeByAccount(`off@other-${DOMAIN}`, both()), { step: "sso", providers: ["oidc"] });
  });

  test("an OIDC account on a SAML-only workspace goes to SAML (SCIM rows are written as oidc)", async () => {
    assert.deepEqual(await routing.routeByAccount(`${STAMP}-oidc`, setupOf(null, {})), { step: "sso", providers: ["saml"] });
  });

  test("a password account, an unknown identifier and an ambiguous email all get the password step", async () => {
    for (const id of [`${STAMP}-pw`, `pw@${DOMAIN}`, `nobody@${DOMAIN}`, "nobody-at-all", `dup@${DOMAIN}`]) {
      assert.deepEqual(await routing.routeByAccount(id, both()), { step: "password" }, id);
    }
  });

  test("the flags never carry a name, and the username wins over an email", async () => {
    const f = await signInAccountFlags(`${STAMP}-oidc`);
    assert.deepEqual(Object.keys(f!).sort(), ["auth_provider", "has_password"]);
    assert.equal((await signInAccountFlags(`dup@${DOMAIN}`)), null, "two accounts share the email: no match");
    // The JIT account's username against a local account's email.
    assert.deepEqual(await signInAccountFlags(`JIT@${DOMAIN}`), { auth_provider: "oidc", has_password: false });
    assert.deepEqual(await routing.routeByAccount(`jit@${DOMAIN}`, both()), { step: "sso", providers: ["oidc"] });
    // ...and against three of them.
    assert.deepEqual(await signInAccountFlags(`many@${DOMAIN}`), { auth_provider: "oidc", has_password: false });
  });
});

describe("the hand-off URL", () => {
  test("same-origin, with the page they wanted and, for OIDC, a login hint for an email only", () => {
    assert.equal(routing.providerStart("oidc", "/"), "/api/ee/sso/login");
    assert.equal(routing.providerStart("oidc", "/doc/1", "ann@corp.test"), "/api/ee/sso/login?next=%2Fdoc%2F1&login_hint=ann%40corp.test");
    assert.equal(routing.providerStart("saml", "/", "ann@corp.test"), "/api/ee/saml/login", "the SAML start reads no hint, so it gets none");
    assert.equal(routing.providerStart("saml", "/doc/1", "ann@corp.test"), "/api/ee/saml/login?next=%2Fdoc%2F1");
    assert.equal(routing.providerStart("oidc", "/", "ann"), "/api/ee/sso/login", "a username is not a hint");
    assert.equal(routing.hintable("a b@corp.test"), false);
    assert.equal(routing.hintable(`${"a".repeat(250)}@x.io`), false);
  });
});

describe("the password step accepts an email", () => {
  const device = { ip: "203.0.113.40", userAgent: "test" };

  test("the one active password account with that email signs in; its username still works", async () => {
    const byEmail = await auth.login(`PW@${DOMAIN}`, "Secret-pass-1", undefined, device);
    assert.ok(byEmail && "token" in byEmail, "signed in by email");
    assert.equal(byEmail.user.username, `${STAMP}-pw`);
    const byName = await auth.login(`${STAMP}-pw`, "Secret-pass-1", undefined, device);
    assert.ok(byName && "token" in byName);
  });

  test("an ambiguous, password-less or disabled match signs nobody in", async () => {
    assert.equal(await auth.login(`dup@${DOMAIN}`, "Secret-pass-1", undefined, device), null);
    assert.equal(await auth.login(`nopw@${DOMAIN}`, "anything", undefined, device), null);
    assert.equal(await auth.login(`gone@${DOMAIN}`, "Secret-pass-1", undefined, device), null);
    assert.equal(await auth.login(`${"x".repeat(300)}@${DOMAIN}`, "Secret-pass-1", undefined, device), null);
  });

  test("a username wins over an email here too, whatever the account it names can do", async () => {
    assert.equal((await auth.resolveSignInAccount(`JIT@${DOMAIN}`))?.username, `jit@${DOMAIN}`);
    assert.equal((await auth.resolveSignInAccount(`many@${DOMAIN}`))?.username, `many@${DOMAIN}`);
    assert.equal(await auth.login(`jit@${DOMAIN}`, "Secret-pass-1", undefined, device), null, "the local account with that email is not signed in");
  });

  test("every outcome reads the database once, so the time it takes names nothing", async () => {
    const p = pool() as unknown as { query: (...a: unknown[]) => unknown };
    const real = p.query;
    let n = 0;
    p.query = function (this: unknown, ...a: unknown[]) {
      n++;
      return real.apply(this, a);
    };
    try {
      for (const id of [`${STAMP}-pw`, `pw@${DOMAIN}`, `nobody@${DOMAIN}`, `nobody-${STAMP}`, `dup@${DOMAIN}`, `nopw@${DOMAIN}`, `gone@${DOMAIN}`, `jit@${DOMAIN}`]) {
        n = 0;
        await auth.resolveSignInAccount(id);
        assert.equal(n, 1, id);
      }
    } finally {
      p.query = real;
    }
  });

  test("an unknown account costs a password check, like a real one", async () => {
    const t = async (id: string) => {
      const start = process.hrtime.bigint();
      await auth.login(id, "wrong-password", undefined, device);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    await t(`${STAMP}-pw`);
    const real = Math.min(await t(`${STAMP}-pw`), await t(`${STAMP}-pw`));
    const unknown = Math.min(await t(`nobody-${STAMP}`), await t(`nobody-${STAMP}`));
    assert.ok(unknown > real * 0.5, `unknown ${unknown.toFixed(1)}ms vs real ${real.toFixed(1)}ms`);
  });
});

describe("POST /api/auth/lookup", () => {
  const KEYS = ["sso_enabled", "sso_tenant", "sso_client_id", "sso_client_secret", "sso_authority", "sso_allowed_domains", "sso_only", "sso_vendor", "saml_enabled"];
  const saved = new Map<string, string | undefined>();
  type Handler = (req: Request) => Promise<Response>;
  let route: { POST: Handler };

  before(async () => {
    for (const k of KEYS) saved.set(k, await getSetting(k));
    await setSetting("sso_enabled", "1");
    await setSetting("sso_tenant", "11111111-2222-3333-4444-555555555555");
    await setSetting("sso_client_id", "client");
    await setSetting("sso_client_secret", "secret");
    await setSetting("sso_authority", "");
    await setSetting("sso_allowed_domains", DOMAIN);
    await setSetting("sso_only", "0");
    await setSetting("sso_vendor", "microsoft");
    await setSetting("saml_enabled", "0");
    route = (await import("../src/app/api/auth/lookup/route")) as unknown as { POST: Handler };
  });

  after(async () => {
    for (const k of KEYS) {
      await pool().query("DELETE FROM settings WHERE key = $1", [k]);
      const v = saved.get(k);
      if (v !== undefined) await setSetting(k, v);
    }
  });

  async function lookup(body: unknown, headers: Record<string, string> = {}) {
    currentRequest = new Request("https://docs.example.test/api/auth/lookup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    try {
      const res = await route.POST(currentRequest);
      return { status: res.status, text: await res.text(), headers: res.headers };
    } finally {
      currentRequest = null;
    }
  }

  test("a company email goes to SSO with a same-origin start carrying next and the hint", async () => {
    const r = await lookup({ identifier: `new.hire@${DOMAIN}`, next: "/doc/7" });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.equal(body.step, "sso");
    assert.deepEqual(body.providers.map((p: { id: string }) => p.id), ["oidc"]);
    assert.equal(body.providers[0].label, "Sign in with Microsoft");
    assert.equal(body.providers[0].start, `/api/ee/sso/login?next=%2Fdoc%2F7&login_hint=new.hire%40${encodeURIComponent(DOMAIN)}`);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  test("an SSO account outside the domains goes to SSO; an unknown identifier and a password account get identical answers", async () => {
    const sso = JSON.parse((await lookup({ identifier: `${STAMP}-oidc` })).text);
    assert.equal(sso.step, "sso");
    const unknown = await lookup({ identifier: `stranger-${STAMP}` });
    const pw = await lookup({ identifier: `${STAMP}-pw` });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.text, pw.text);
    assert.equal(unknown.text, '{"step":"password"}');
  });

  test("a hostile next is reduced to a same-app path", async () => {
    const body = JSON.parse((await lookup({ identifier: `a@${DOMAIN}`, next: "//evil.example/x" })).text);
    assert.equal(body.providers[0].start, `/api/ee/sso/login?login_hint=a%40${encodeURIComponent(DOMAIN)}`);
  });

  test("JSON only, a sane identifier only, and a foreign Origin is refused", async () => {
    assert.equal((await lookup({ identifier: "x" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await lookup({ identifier: "" })).status, 400);
    assert.equal((await lookup({ identifier: "a\u0000b" })).status, 400);
    assert.equal((await lookup({ identifier: "x".repeat(255) })).status, 400);
    assert.equal((await lookup("{not json")).status, 400);
    assert.equal((await lookup({ identifier: "x" }, { origin: "https://evil.example", host: "docs.example.test" })).status, 403);
  });

  test("lookups that read an account are limited per address (20 a minute, audited once); domain-routed ones are not counted", async () => {
    const ip = "192.0.2.77";
    const since = new Date();
    for (let i = 0; i < 25; i++) {
      const r = await lookup({ identifier: `x${i}@${DOMAIN}` }, { "x-forwarded-for": ip });
      assert.equal(r.status, 200, "domain-routed lookups never count");
    }
    for (let i = 0; i < 20; i++) {
      const r = await lookup({ identifier: `someone-${i}` }, { "x-forwarded-for": ip });
      assert.equal(r.status, 200, `account lookup ${i + 1} of 20 is allowed`);
    }
    assert.equal((await lookup({ identifier: "someone-20" }, { "x-forwarded-for": ip })).status, 429, "the 21st in the minute is refused");
    const limited = await lookup({ identifier: "someone-else" }, { "x-forwarded-for": ip });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.match(JSON.parse(limited.text).error, /^Too many attempts\. Try again in \d+ minutes?\.$/);
    const { rows } = await pool().query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.lookup_throttled' AND ip = $1 AND at >= $2",
      [ip, since]
    );
    assert.equal(rows[0].n, 1, "two refusals in one window are audited once");
  });

  test("and 100 an hour: five full minutes, then the hour's wait", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const ip = "192.0.2.78";
    for (let minute = 1; minute <= 5; minute++) {
      for (let i = 1; i <= 20; i++) assert.equal(signInLookupRetryAfter(ip), 0, `minute ${minute}, lookup ${i}`);
      t.mock.timers.tick(61_000);
    }
    const wait = signInLookupRetryAfter(ip);
    assert.ok(wait > 60, `the 101st in the hour waits for the hour, not a minute (${wait} s)`);
  });

  test("without the SSO licence every identifier gets the password step", async () => {
    edition.features = [];
    try {
      assert.equal((await lookup({ identifier: `a@${DOMAIN}` })).text, '{"step":"password"}');
    } finally {
      edition.features = ["sso"];
    }
  });
});

describe("POST /api/auth/login", () => {
  type Handler = (req: Request) => Promise<Response>;
  let route: { POST: Handler };
  const totpUser = `${STAMP}-totp`;
  const secret = generateTotpSecret();

  before(async () => {
    route = (await import("../src/app/api/auth/login/route")) as unknown as { POST: Handler };
    const id = await newUser("totp", { password: "Secret-pass-1" });
    // Stored unsealed: openSecret passes a plaintext secret through.
    await pool().query("UPDATE users SET totp_enabled = 1, totp_secret = $1 WHERE id = $2", [secret, id]);
  });

  async function post(body: Record<string, unknown>, ip: string) {
    currentRequest = new Request("https://docs.example.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
    try {
      const res = await route.POST(currentRequest);
      return { status: res.status, body: await res.json() };
    } finally {
      currentRequest = null;
    }
  }

  const audited = async (action: string, label: string) =>
    (await pool().query("SELECT details FROM audit_log WHERE action = $1 AND target_label = $2 ORDER BY id", [action, label])).rows.map(
      (r) => r.details
    );

  test("an identifier longer than any email is refused on its length: never throttled, read or audited", async () => {
    const long = `${STAMP}-${"x".repeat(255)}`.slice(0, 255);
    for (let i = 0; i < 6; i++) {
      const r = await post({ username: long, password: "whatever" }, "203.0.113.50");
      assert.equal(r.status, 400, `attempt ${i + 1}`);
      assert.deepEqual(r.body, { error: "Invalid username or password." });
    }
    const { rows } = await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor_name = $1 OR target_label = $1", [long]);
    assert.equal(rows[0].n, 0);
  });

  test("the throttle counts what was typed: five failures under an email lock that email, not its account's username", async () => {
    const ip = "203.0.113.51";
    for (let i = 1; i <= 5; i++) assert.equal((await post({ username: `pw@${DOMAIN}`, password: "wrong" }, ip)).status, 401, `failure ${i}`);
    assert.equal((await post({ username: `PW@${DOMAIN}`, password: "Secret-pass-1" }, ip)).status, 429, "the email is locked, right password or not");
    assert.equal((await post({ username: `${STAMP}-pw`, password: "wrong" }, ip)).status, 401, "the username is not: no 429 ties the two together");
    // An email no account has locks exactly the same way.
    for (let i = 1; i <= 5; i++) await post({ username: `nobody@${DOMAIN}`, password: "wrong" }, ip);
    assert.equal((await post({ username: `nobody@${DOMAIN}`, password: "wrong" }, ip)).status, 429);
  });

  test("a wrong two-factor code counts toward the lock, and the lock it engages is audited once", async () => {
    const ip = "203.0.113.52";
    const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpCode(secret, Date.now() + d * 30_000)));
    const wrong = ["111111", "222222", "333333", "444444", "555555", "666666"].find((c) => !valid.has(c))!;
    assert.deepEqual((await post({ username: totpUser, password: "Secret-pass-1" }, ip)).body, { totp_required: true }, "no code yet: asked, not counted");
    for (let i = 1; i <= 5; i++) {
      const r = await post({ username: totpUser, password: "Secret-pass-1", totp_code: wrong }, ip);
      assert.equal(r.status, 401, `wrong code ${i}`);
      assert.equal(r.body.totp_required, true);
    }
    assert.equal((await post({ username: totpUser, password: "Secret-pass-1", totp_code: wrong }, ip)).status, 429);
    assert.deepEqual(await audited("auth.login_failed", totpUser), Array(5).fill({ stage: "two_factor" }));
    assert.deepEqual(await audited("auth.lockout", totpUser), [{ minutes: 15, stage: "two_factor" }]);
  });
});

// ---------------------------------------------------------------------------
// The sign-in artwork (1.16.0, lib/sign-in-art; spec §8.1). An upload is
// sniffed by its bytes, refused with a sentence for the admin when it is
// empty, over 15 MB, not a JPEG/PNG/WebP/GIF, unreadable or cut short,
// smaller than 1280 × 720 as shown (after the camera's EXIF rotation) or over
// 100 megapixels, and otherwise re-encoded to WebP at 960, 1600 and 2560
// wide, with its size, mean colour (in sRGB) and a blurred placeholder in
// settings. Remove clears every key and deletes the files. Store and remove
// take turns under one advisory lock, writing the five keys together.
//
// The files go to a throwaway uploads directory: lib/uploads reads
// COMPASSDOCS_UPLOAD_DIR on every call, so setting it here, before
// lib/sign-in-art is loaded and before any test runs, keeps this file away
// from a real volume. The sign_in_art_* settings are saved first and put
// back afterwards.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const zlib = require("node:zlib") as typeof import("node:zlib");
const ART_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "compass-sign-in-art-"));
process.env.COMPASSDOCS_UPLOAD_DIR = ART_DIR;
const sharp = require("sharp") as typeof import("sharp").default;
const art = require("../src/lib/sign-in-art") as typeof import("../src/lib/sign-in-art");
/* eslint-enable @typescript-eslint/no-require-imports */

describe("the sign-in artwork", () => {
  const ART_KEYS = ["sign_in_art_files", "sign_in_art_version", "sign_in_art_color", "sign_in_art_placeholder", "sign_in_art_size"];
  const saved = new Map<string, string | undefined>();

  const solid = (width: number, height: number, background: { r: number; g: number; b: number } = { r: 200, g: 30, b: 60 }) =>
    sharp({ create: { width, height, channels: 3, background } });
  const png = (width: number, height: number) => solid(width, height).png().toBuffer();
  /** A JPEG whose pixels are width × height, shown rotated when orientation is 5 to 8 (a phone held upright). */
  const jpeg = (width: number, height: number, orientation = 1) => solid(width, height).jpeg().withMetadata({ orientation }).toBuffer();

  const storedFiles = () => fs.readdirSync(ART_DIR).sort();
  const filesSetting = async () => JSON.parse((await getSetting("sign_in_art_files")) || "null") as Record<string, string> | null;
  const tooSmall = (w: number, h: number) =>
    `That image is ${w} × ${h} pixels. Use one at least 1280 pixels wide and 720 pixels tall.`;

  async function refused(input: Buffer, sentence: string) {
    await assert.rejects(art.storeSignInArt(input), (e: unknown) => {
      assert.ok(e instanceof art.ArtworkError, `an ArtworkError, not ${String(e)}`);
      assert.equal((e as Error).message, sentence);
      return true;
    });
  }

  async function clearArt() {
    for (const k of ART_KEYS) await setSetting(k, "");
    for (const f of storedFiles()) fs.rmSync(path.join(ART_DIR, f));
  }

  before(async () => {
    for (const k of ART_KEYS) saved.set(k, await getSetting(k));
    await clearArt();
  });

  after(async () => {
    for (const k of ART_KEYS) {
      await pool().query("DELETE FROM settings WHERE key = $1", [k]);
      const v = saved.get(k);
      if (v !== undefined) await setSetting(k, v);
    }
    fs.rmSync(ART_DIR, { recursive: true, force: true });
  });

  test("the limits are 15 MB, 1280 × 720 to 100 megapixels, and three widths", () => {
    assert.equal(art.ART_MAX_BYTES, 15 * 1024 * 1024);
    assert.deepEqual(art.ART_MIN, { width: 1280, height: 720 });
    assert.equal(art.ART_MAX_PIXELS, 100_000_000);
    assert.deepEqual([...art.ART_WIDTHS], [960, 1600, 2560]);
  });

  describe("refusals (nothing is stored)", () => {
    before(clearArt);
    after(async () => {
      assert.equal(await getSetting("sign_in_art_files"), "", "no refusal wrote a setting");
      assert.deepEqual(storedFiles(), [], "no refusal wrote a file");
    });

    test("an empty file", async () => {
      await refused(Buffer.alloc(0), "The file is empty.");
    });

    test("over 15 MB, even when it starts like a PNG", async () => {
      const big = Buffer.alloc(art.ART_MAX_BYTES + 1);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
      await refused(big, "Artwork is limited to 15 MB.");
    });

    test("not an image, or an image type the page does not serve (SVG, TIFF, PDF, text)", async () => {
      const tiff = await solid(1600, 900).tiff().toBuffer();
      for (const input of [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900"/></svg>'),
        Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj"),
        Buffer.from("just some text that is long enough to sniff"),
        tiff,
      ]) {
        await refused(input, "Use a JPEG, PNG, WebP or GIF image.");
      }
    });

    test("bytes that start like a PNG but are not one", async () => {
      const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a png at all".repeat(20))]);
      await refused(broken, "That image could not be read. Try saving it as a JPEG or PNG.");
    });

    test("a JPEG or PNG cut short (a download or sync that never finished)", async () => {
      // Noise, so the missing part is real picture and not a run of one colour.
      const noisy = sharp({ create: { width: 1600, height: 900, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 30 } } });
      for (const whole of [await noisy.clone().jpeg().toBuffer(), await noisy.clone().png().toBuffer()]) {
        await refused(whole.subarray(0, Math.floor(whole.length * 0.3)), "That image could not be read. Try saving it as a JPEG or PNG.");
      }
    });

    test("over 100 megapixels, read from the header before anything is decoded", async () => {
      // A 1 × 1 PNG whose header says 12000 × 9000: nothing behind it is read.
      const header = Buffer.from(await png(1, 1));
      header.writeUInt32BE(12000, 16);
      header.writeUInt32BE(9000, 20);
      header.writeUInt32BE(zlib.crc32(header.subarray(12, 29)), 29);
      const meta = await sharp(header).metadata();
      assert.deepEqual([meta.width, meta.height], [12000, 9000]);
      await refused(header, "That image is 12000 × 9000 pixels. Use one with no more than 100 megapixels.");
    });

    test("smaller than 1280 × 720, by either side, with the image's own size in the sentence", async () => {
      await refused(await png(1279, 720), tooSmall(1279, 720));
      await refused(await png(1280, 719), tooSmall(1280, 719));
      await refused(await png(640, 480), tooSmall(640, 480));
    });

    test("an EXIF-rotated portrait counts as the portrait it shows: 1600 × 1000 pixels turned upright is 1000 × 1600", async () => {
      const upright = await jpeg(1600, 1000, 6);
      await refused(upright, tooSmall(1000, 1600));
      // The same pixels with no rotation are a fine landscape.
      assert.equal((await sharp(await jpeg(1600, 1000)).metadata()).width, 1600);
    });
  });

  describe("an accepted upload", () => {
    before(clearArt);
    after(clearArt);

    test("is stored at three widths as WebP, with its size, colour, placeholder and version", async () => {
      const stored = await art.storeSignInArt(await png(2600, 1600));
      const files = (await filesSetting())!;
      assert.ok(files, "sign_in_art_files is set");
      assert.deepEqual(Object.keys(files).sort(), ["1600", "2560", "960"]);
      assert.deepEqual(storedFiles(), Object.values(files).sort(), "exactly the three files are on disk");
      for (const w of art.ART_WIDTHS) {
        assert.match(files[w], /^[a-f0-9]{32}\.webp$/);
        const meta = await sharp(path.join(ART_DIR, files[w])).metadata();
        assert.equal(meta.format, "webp");
        assert.equal(meta.width, w);
        assert.equal(meta.height, Math.round((1600 * w) / 2600));
      }

      assert.equal(await getSetting("sign_in_art_size"), "2600x1600");
      assert.equal(await getSetting("sign_in_art_color"), "#c81e3c", "the mean colour of a solid picture is that colour");
      assert.equal(await getSetting("sign_in_art_version"), files[1600].slice(0, 12));
      const placeholder = (await getSetting("sign_in_art_placeholder"))!;
      assert.match(placeholder, /^data:image\/webp;base64,/);
      const tiny = await sharp(Buffer.from(placeholder.split(",")[1], "base64")).metadata();
      assert.equal(tiny.width, 20);

      const v = stored.version;
      assert.deepEqual(stored, {
        width: 2600,
        height: 1600,
        version: files[1600].slice(0, 12),
        color: "#c81e3c",
        placeholder,
        src: `/api/brand/artwork?w=1600&v=${v}`,
        srcSet: `/api/brand/artwork?w=960&v=${v} 960w, /api/brand/artwork?w=1600&v=${v} 1600w, /api/brand/artwork?w=2560&v=${v} 2560w`,
      });
      assert.deepEqual(await art.getSignInArt(), stored);
      const look = await art.getSignInLook();
      assert.deepEqual(look.art, stored);
    });

    test("a requested width is served by the smallest copy at least that wide, else the largest", async () => {
      const files = (await filesSetting())!;
      assert.equal(await art.artFileFor(1), files[960]);
      assert.equal(await art.artFileFor(960), files[960]);
      assert.equal(await art.artFileFor(961), files[1600]);
      assert.equal(await art.artFileFor(1600), files[1600]);
      assert.equal(await art.artFileFor(2000), files[2560]);
      assert.equal(await art.artFileFor(9999), files[2560]);
    });

    test("a replacement deletes the previous files, and a new upload gets a new version", async () => {
      const first = (await filesSetting())!;
      const v1 = await getSetting("sign_in_art_version");
      await art.storeSignInArt(await png(1920, 1080));
      const second = (await filesSetting())!;
      assert.notEqual(await getSetting("sign_in_art_version"), v1);
      assert.equal(await getSetting("sign_in_art_size"), "1920x1080");
      for (const name of Object.values(first)) assert.equal(fs.existsSync(path.join(ART_DIR, name)), false, `${name} deleted`);
      assert.deepEqual(storedFiles(), Object.values(second).sort());
    });

    test("an image narrower than a width is never enlarged to it", async () => {
      await art.storeSignInArt(await png(1400, 800));
      const files = (await filesSetting())!;
      const widths = await Promise.all(art.ART_WIDTHS.map(async (w) => (await sharp(path.join(ART_DIR, files[w])).metadata()).width));
      assert.deepEqual(widths, [960, 1400, 1400]);
    });

    test("an EXIF-rotated portrait is stored upright, with the size it shows", async () => {
      // Pixels 800 × 1400, turned by the camera's tag into a 1400 × 800 landscape.
      const stored = await art.storeSignInArt(await jpeg(800, 1400, 6));
      assert.equal(await getSetting("sign_in_art_size"), "1400x800");
      assert.equal(stored.width, 1400);
      assert.equal(stored.height, 800);
      const files = (await filesSetting())!;
      const small = await sharp(path.join(ART_DIR, files[960])).metadata();
      assert.equal(small.width, 960);
      assert.equal(small.height, Math.round((800 * 960) / 1400), "the copy is a landscape: the rotation was applied");
      assert.equal(small.orientation, undefined, "and no tag is left to rotate it again");
    });

    test("camera metadata is not kept: the copies carry no EXIF", async () => {
      const withExif = await solid(2000, 1200)
        .jpeg()
        .withExif({ IFD0: { Make: "PhoneCo", Model: "Pocket 9", Copyright: "Private" } })
        .toBuffer();
      assert.ok((await sharp(withExif).metadata()).exif, "the upload has EXIF");
      await art.storeSignInArt(withExif);
      const files = (await filesSetting())!;
      for (const w of art.ART_WIDTHS) {
        const meta = await sharp(path.join(ART_DIR, files[w])).metadata();
        assert.equal(meta.exif, undefined, `${w} has no EXIF`);
        assert.equal(meta.xmp, undefined, `${w} has no XMP`);
      }
    });

    test("an animated GIF keeps only its first frame", async () => {
      const frame = (background: string) => sharp({ create: { width: 1280, height: 720, channels: 3, background } }).png().toBuffer();
      const gif = await sharp([await frame("#ff0000"), await frame("#0000ff")], { join: { animated: true } })
        .gif({ delay: [100, 100] })
        .toBuffer();
      assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2, "the upload is animated");
      await art.storeSignInArt(gif);
      assert.equal(await getSetting("sign_in_art_size"), "1280x720", "one frame tall, not two");
      const files = (await filesSetting())!;
      const meta = await sharp(path.join(ART_DIR, files[960]), { animated: true }).metadata();
      assert.equal(meta.pages ?? 1, 1, "the copy is a still");
      assert.equal(meta.height, 540);
      const color = (await getSetting("sign_in_art_color"))!;
      assert.ok(parseInt(color.slice(1, 3), 16) > 200 && parseInt(color.slice(5, 7), 16) < 60, `the first (red) frame: ${color}`);
    });

    test("the colour is the picture's in sRGB, whatever its depth, colour space or alpha", async () => {
      // A 16-bit PNG (a Photoshop or Lightroom export) once clamped to white.
      const deep = await solid(1600, 900, { r: 75, g: 79, b: 121 }).toColourspace("rgb16").png().toBuffer();
      assert.equal((await sharp(deep).metadata()).depth, "ushort");
      assert.equal((await art.storeSignInArt(deep)).color, "#4b4f79");
      // A CMYK JPEG (print artwork) once stored its C, M and Y means: cyan for red.
      const cmyk = await solid(1600, 900, { r: 200, g: 10, b: 5 }).toColourspace("cmyk").jpeg().toBuffer();
      assert.equal((await sharp(cmyk).metadata()).space, "cmyk");
      const red = (await art.storeSignInArt(cmyk)).color;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(red.slice(i, i + 2), 16));
      assert.ok(r > 180 && g < 40 && b < 40, `CMYK red: ${red}`);
      // Grey with alpha once put the alpha's mean in green.
      const grey = await sharp({ create: { width: 1600, height: 900, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
        .toColourspace("b-w")
        .png()
        .toBuffer();
      const greyMeta = await sharp(grey).metadata();
      assert.deepEqual([greyMeta.channels, greyMeta.hasAlpha], [2, true]);
      assert.equal((await art.storeSignInArt(grey)).color, "#808080");
      assert.equal(await getSetting("sign_in_art_color"), "#808080");
    });

    test("a size missing from settings (an upload from before the key) reads as 0 × 0, not an error", async () => {
      await art.storeSignInArt(await png(1600, 900));
      await setSetting("sign_in_art_size", "");
      const stored = await art.getSignInArt();
      assert.ok(stored);
      assert.equal(stored.width, 0);
      assert.equal(stored.height, 0);
    });

    test("a missing file (a database-only restore) falls back to the default art", async () => {
      await art.storeSignInArt(await png(1600, 900));
      const files = (await filesSetting())!;
      fs.rmSync(path.join(ART_DIR, files[1600]));
      assert.equal(await art.getSignInArt(), null);
      const look = await art.getSignInLook();
      assert.equal(look.art, null);
      assert.equal(look.showText, true, "the default art always carries the name");
    });
  });

  describe("removeSignInArt", () => {
    before(clearArt);
    after(clearArt);

    test("clears every key, size included, and deletes the files", async () => {
      await art.storeSignInArt(await png(2600, 1600));
      const files = (await filesSetting())!;
      for (const k of ART_KEYS) assert.notEqual(await getSetting(k), "", `${k} was set`);

      await art.removeSignInArt();
      for (const k of ART_KEYS) assert.equal(await getSetting(k), "", `${k} cleared`);
      for (const name of Object.values(files)) assert.equal(fs.existsSync(path.join(ART_DIR, name)), false, `${name} deleted`);
      assert.deepEqual(storedFiles(), []);
      assert.equal(await art.getSignInArt(), null);
      assert.equal(await art.artFileFor(1600), null);
      assert.equal((await art.getSignInLook()).art, null);
    });

    test("removing when there is nothing is fine", async () => {
      await art.removeSignInArt();
      for (const k of ART_KEYS) assert.equal(await getSetting(k), "");
    });
  });

  describe("store and remove take turns", () => {
    before(clearArt);
    after(clearArt);

    /** Callers queued on the store's advisory lock (lib/sign-in-art LOCK, as a pg_advisory_xact_lock key). */
    const queued = async () =>
      Number(
        (
          await pool().query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtext('sign_in_art')::bigint & 4294967295)`
          )
        ).rows[0].n
      );

    test("two uploads and a remove queued together end whole, with no file left behind", async () => {
      const first = await art.storeSignInArt(await png(1600, 900));
      const [a, b] = [await png(1920, 1080), await png(2000, 1200)];
      // Hold the lock, so all three reach it (the uploads with their files
      // saved) and wait; then let them through.
      const holder = await pool().connect();
      let pending: [ReturnType<typeof art.storeSignInArt>, Promise<void>, ReturnType<typeof art.storeSignInArt>];
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext('sign_in_art'))");
        pending = [art.storeSignInArt(a), art.removeSignInArt(), art.storeSignInArt(b)];
        for (const p of pending) p.catch(() => {});
        const until = Date.now() + 10_000;
        while ((await queued()) < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        assert.equal(await queued(), 3, "all three wait for the lock");
        assert.equal(await getSetting("sign_in_art_version"), first.version, "nothing changes while it is held");
        assert.equal(storedFiles().length, 9, "the first upload's files and both new uploads'");
      } finally {
        await holder.query("COMMIT");
        holder.release();
      }
      const [x, , y] = await Promise.all(pending!);
      assert.deepEqual([x.width, y.width], [1920, 2000], "each upload returns its own art");

      const files = await filesSetting();
      const values = await Promise.all(ART_KEYS.map((k) => getSetting(k)));
      if (files) {
        assert.ok(values.every((v) => v), `every key set: ${JSON.stringify(values)}`);
        const stored = (await art.getSignInArt())!;
        assert.ok(stored, "the art is there");
        assert.ok([x.version, y.version].includes(stored.version), "from one of the uploads");
        assert.deepEqual(stored, stored.version === x.version ? x : y, "every key from that same upload");
        assert.deepEqual(storedFiles(), Object.values(files).sort(), "only its three files are on disk");
      } else {
        assert.deepEqual(values, ["", "", "", "", ""], "every key cleared");
        assert.deepEqual(storedFiles(), [], "and no file is left");
      }
    });
  });
});
