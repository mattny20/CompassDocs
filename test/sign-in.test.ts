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
  });
});

describe("the hand-off URL", () => {
  test("same-origin, with the page they wanted and a login hint for an email only", () => {
    assert.equal(routing.providerStart("oidc", "/"), "/api/ee/sso/login");
    assert.equal(routing.providerStart("oidc", "/doc/1", "ann@corp.test"), "/api/ee/sso/login?next=%2Fdoc%2F1&login_hint=ann%40corp.test");
    assert.equal(routing.providerStart("saml", "/", "ann@corp.test"), "/api/ee/saml/login?login_hint=ann%40corp.test");
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

  test("an email and its username share one throttle key: the account's username", async () => {
    const rec = await auth.resolveSignInAccount(`pw@${DOMAIN}`);
    assert.equal(auth.signInThrottleKey(`pw@${DOMAIN}`, rec), `${STAMP}-pw`);
    assert.equal(auth.signInThrottleKey("  stranger@x.test ", undefined), "stranger@x.test");
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

  test("lookups that read an account are limited per address (20 a minute); domain-routed ones are not counted", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 25; i++) {
      const r = await lookup({ identifier: `x${i}@${DOMAIN}` }, { "x-forwarded-for": ip });
      assert.equal(r.status, 200, "domain-routed lookups never count");
    }
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await lookup({ identifier: `someone-${i}` }, { "x-forwarded-for": ip })).status;
    assert.equal(last, 429);
    const limited = await lookup({ identifier: "someone-else" }, { "x-forwarded-for": ip });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.match(JSON.parse(limited.text).error, /^Too many attempts\. Try again in \d+ minutes?\.$/);
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
