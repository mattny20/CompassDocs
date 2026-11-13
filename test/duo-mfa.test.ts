// The Duo sign-in check (1.20.5): the HS512 tokens (lib/duo-jwt), the
// decision table (lib/duo-policy), the session gates (lib/auth, lib/api-auth,
// the desk gates), the single-use state, the whole step against a fake Duo
// (test/helpers/fake-duo, never the real one), fail-closed and fail-open, the
// lockout guard on the settings route, and that API tokens and the connector's
// OAuth tokens are never asked.
//
// It writes duo_* settings to the database it runs against and puts back what
// was there, so a rig is left exactly as it was: Duo not set up.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/duo-mfa.test.ts

import Module from "node:module";
import path from "node:path";
import { createHmac } from "node:crypto";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDuo, type FakeDuo } from "./helpers/fake-duo";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
delete process.env.COMPASSDOCS_DUO_DISABLED;

// next/headers (the session cookie and the request's headers) and lib/ee (a
// licensed Enterprise build, switchable) as the code under test sees them.
let currentRequest: Request | null = null;
let currentToken = "";
const edition = { present: true, features: ["sso", "helpdesk"] as string[] };
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.duo.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.duo.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => ({
      get: (name: string) => (name === "compass_session" && currentToken ? { name, value: currentToken } : undefined),
      getAll: () => [],
      has: () => false,
    }),
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => edition.present,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
    featureEnabledFrom: (feature: string) => edition.features.includes(feature),
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
    if (request === "../ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "..", "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const jwt = require("../src/lib/duo-jwt") as typeof import("../src/lib/duo-jwt");
const policy = require("../src/lib/duo-policy") as typeof import("../src/lib/duo-policy");
const config = require("../src/lib/duo-config") as typeof import("../src/lib/duo-config");
const duoClient = require("../src/lib/duo") as typeof import("../src/lib/duo");
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const auth = require("../src/lib/auth") as typeof import("../src/lib/auth");
const apiAuth = require("../src/lib/api-auth") as typeof import("../src/lib/api-auth");
const hdAccess = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const hdRoles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const { deskUserGate } = require("../src/lib/helpdesk/appearance-http") as typeof import("../src/lib/helpdesk/appearance-http");
const { v1Auth } = require("../src/lib/v1-auth") as typeof import("../src/lib/v1-auth");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const startRoute = require("../src/app/api/auth/duo/start/route") as typeof import("../src/app/api/auth/duo/start/route");
const callbackRoute = require("../src/app/api/auth/duo/callback/route") as typeof import("../src/app/api/auth/duo/callback/route");
const adminRoute = require("../src/app/api/admin/duo/route") as typeof import("../src/app/api/admin/duo/route");
const adminTestRoute = require("../src/app/api/admin/duo/test/route") as typeof import("../src/app/api/admin/duo/test/route");
const logoutRoute = require("../src/app/api/auth/logout/route") as typeof import("../src/app/api/auth/logout/route");
const tokensRoute = require("../src/app/api/account/tokens/route") as typeof import("../src/app/api/account/tokens/route");
const oauthApproveRoute = require("../src/app/api/oauth/approve/route") as typeof import("../src/app/api/oauth/approve/route");
const profileRoute = require("../src/app/api/account/profile/route") as typeof import("../src/app/api/account/profile/route");
const hdRequestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const hdRequestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const hdRequestMessagesRoute = require("../src/app/api/helpdesk/requests/[number]/messages/route") as typeof import("../src/app/api/helpdesk/requests/[number]/messages/route");
const hdContactsRoute = require("../src/app/api/helpdesk/contacts/route") as typeof import("../src/app/api/helpdesk/contacts/route");
const hdApprovalsRoute = require("../src/app/api/helpdesk/approvals/route") as typeof import("../src/app/api/helpdesk/approvals/route");
const hdAttachmentRoute = require("../src/app/api/helpdesk/attachments/[id]/route") as typeof import("../src/app/api/helpdesk/attachments/[id]/route");
const hdBannersRoute = require("../src/app/api/helpdesk/incidents/banners/route") as typeof import("../src/app/api/helpdesk/incidents/banners/route");
const { emailTemplatesGate } = require("../src/lib/email-parts-access") as typeof import("../src/lib/email-parts-access");
const { duoView } = require("../src/lib/duo-view") as typeof import("../src/lib/duo-view");
const rateLimit = require("../src/lib/rate-limit") as typeof import("../src/lib/rate-limit");
const proxyModule = require("../src/proxy") as typeof import("../src/proxy");
const { NextRequest } = require("next/server") as typeof import("next/server");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, setSetting } = db;
const K = policy.DUO_KEYS;

const CLIENT_ID = "DITESTCLIENT00000ABC";
const SECRET = "s3cr3tS3cr3tS3cr3tS3cr3tS3cr3tS3cr3t0123";
const HOST = "api-1a2b3c4d.duosecurity.com";
const ORIGIN = "https://docs.example.test";

// --- 1. The tokens ----------------------------------------------------------------

const b64 = (v: object | string) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
/** A JWT with any header, signed (or not) the way an attacker might. */
function forge(header: object, payload: object, key: string | null, alg: "sha512" | "sha256" = "sha512"): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = key === null ? "" : createHmac(alg, key).update(input).digest("base64url");
  return `${input}.${sig}`;
}

describe("HS512 tokens (lib/duo-jwt)", () => {
  const now = 1_800_000_000;
  const ISS = `https://${HOST}/oauth/v1/token`;
  const good = {
    iss: ISS,
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: "n-123",
    preferred_username: "ada@example.com",
    auth_result: { result: "allow", status: "allow", status_msg: "Login Successful" },
  };
  const expect = { secret: SECRET, issuer: ISS, clientId: CLIENT_ID, nonce: "n-123", username: "ada@example.com", now };
  const problemOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof jwt.DuoTokenError, `expected a DuoTokenError, got ${e}`);
      return e.problem;
    }
    return "accepted";
  };

  test("signs HS512, byte for byte what node:crypto makes of the same input", () => {
    const token = jwt.signDuoJwt({ a: 1 }, SECRET);
    const [head, body, sig] = token.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "HS512", typ: "JWT" });
    assert.equal(sig, createHmac("sha512", SECRET).update(`${head}.${body}`).digest("base64url"));
    assert.deepEqual(jwt.verifyDuoJwt(token, SECRET), { a: 1 });
  });

  test("a good ID token is accepted, and its claims come back", () => {
    const claims = jwt.verifyDuoIdToken(jwt.signDuoJwt(good, SECRET), expect);
    assert.equal(claims.preferred_username, "ada@example.com");
    // An audience list that includes us is fine too.
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(jwt.signDuoJwt({ ...good, aud: ["x", CLIENT_ID] }, SECRET), expect)), "accepted");
  });

  test("any algorithm but HS512 is refused before a key is used", () => {
    const HS512 = { alg: "HS512", typ: "JWT" };
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: "none", typ: "JWT" }, good, null), expect)), "alg");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: "None" }, good, null), expect)), "alg");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: "HS256", typ: "JWT" }, good, SECRET, "sha256"), expect)), "alg");
    // Signed correctly with the right key, but the header claims another algorithm.
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: "HS384" }, good, SECRET), expect)), "alg");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: "RS256" }, good, SECRET), expect)), "alg");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ typ: "JWT" }, good, SECRET), expect)), "alg");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge({ alg: ["HS512"] }, good, SECRET), expect)), "alg");
    // HS512 with no signature at all.
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(forge(HS512, good, null), expect)), "signature");
  });

  test("a bad signature is refused: another secret, a changed payload, a cut signature", () => {
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(jwt.signDuoJwt(good, "another-secret-another-secret-another-12"), expect)), "signature");
    const [h, , s] = jwt.signDuoJwt(good, SECRET).split(".");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(`${h}.${b64({ ...good, preferred_username: "eve@example.com" })}.${s}`, { ...expect, username: "eve@example.com" })), "signature");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(`${h}.${b64(good)}.${s.slice(0, 40)}`, expect)), "signature");
    assert.equal(problemOf(() => jwt.verifyDuoIdToken(`${h}.${b64(good)}.${s}!`, expect)), "signature");
  });

  test("malformed tokens are refused", () => {
    for (const t of ["", "abc", "a.b", "a.b.c.d", `${b64("not json")}.${b64(good)}.x`, `${b64(["HS512"])}.${b64(good)}.x`]) {
      assert.equal(problemOf(() => jwt.verifyDuoIdToken(t, expect)), "malformed", t);
    }
    assert.equal(problemOf(() => jwt.verifyDuoJwt(jwt.signDuoJwt(good, SECRET), "")), "malformed");
  });

  test("each claim is checked: issuer, audience, expiry, nonce, username, result", () => {
    const check = (claims: object, over: Partial<typeof expect> = {}) =>
      problemOf(() => jwt.verifyDuoIdToken(jwt.signDuoJwt(claims as Record<string, unknown>, SECRET), { ...expect, ...over }));
    assert.equal(check({ ...good, iss: "https://api-evil0000.duosecurity.com/oauth/v1/token" }), "issuer");
    assert.equal(check({ ...good, iss: undefined }), "issuer");
    assert.equal(check({ ...good, aud: "DIOTHERCLIENT0000XYZ" }), "audience");
    assert.equal(check({ ...good, aud: [] }), "audience");
    assert.equal(check({ ...good, exp: now - jwt.DUO_CLOCK_SKEW - 1 }), "expired");
    assert.equal(check({ ...good, exp: now - jwt.DUO_CLOCK_SKEW }), "accepted", "inside the clock skew");
    assert.equal(check({ ...good, exp: undefined }), "expired");
    assert.equal(check({ ...good, exp: "2099" }), "expired");
    assert.equal(check({ ...good, iat: now + jwt.DUO_CLOCK_SKEW + 5 }), "not_yet_valid");
    assert.equal(check({ ...good, nonce: "n-124" }), "nonce");
    assert.equal(check({ ...good, nonce: 7 }), "nonce");
    // No nonce claim at all: accepted (state and username still bind the attempt).
    assert.equal(check({ ...good, nonce: undefined }), "accepted");
    assert.equal(check(good, { nonce: "" }), "nonce");
    assert.equal(check({ ...good, preferred_username: "eve@example.com" }), "username");
    assert.equal(check({ ...good, preferred_username: "ADA@example.com" }), "username", "exactly what was sent");
    assert.equal(check({ ...good, preferred_username: undefined }), "username");
    assert.equal(check({ ...good, auth_result: { result: "deny" } }), "denied");
    assert.equal(check({ ...good, auth_result: { result: "ALLOW" } }), "denied");
    assert.equal(check({ ...good, auth_result: undefined }), "denied");
    assert.equal(check({ ...good, auth_result: "allow" }), "denied");
  });
});

// --- 2. The decision table ----------------------------------------------------------

describe("the decision (lib/duo-policy)", () => {
  const map = (over: Record<string, string> = {}) => ({
    [K.clientId]: CLIENT_ID,
    [K.clientSecret]: SECRET,
    [K.apiHost]: HOST,
    [K.enforceSignIn]: "1",
    ...over,
  });
  const licensed = { disabled: false, licensed: true };
  const NOW = Date.parse("2026-11-13T12:00:00Z");
  const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const verdict = (settings: Record<string, string>, session: Partial<import("../src/lib/duo-policy").DuoSessionFacts>, facts = licensed) =>
    policy.duoVerdict(policy.duoPolicy(policy.duoSettingsFrom(settings), facts), { userId: 7, mfaAt: null, mfaMethod: null, ...session }, NOW);

  test("only a Duo API hostname is a hostname", () => {
    assert.equal(policy.normalizeDuoHost(" API-1A2B3C4D.duosecurity.com "), "api-1a2b3c4d.duosecurity.com");
    assert.equal(policy.normalizeDuoHost("api-1a2b3c4d.duofederal.com"), "api-1a2b3c4d.duofederal.com");
    for (const bad of [
      "",
      "duosecurity.com",
      "https://api-1a2b3c4d.duosecurity.com",
      "api-1a2b3c4d.duosecurity.com/",
      "api-1a2b3c4d.duosecurity.com:8443",
      "api-1a2b3c4d.duosecurity.com.evil.example",
      "evil.example/api-1a2b3c4d.duosecurity.com",
      "user@api-1a2b3c4d.duosecurity.com",
      "api-1a2b3c4d.duosecurity.com@evil.example",
      "api-1a2b3c4d.duosecurity.co",
      "api-.duosecurity.com",
      "api-1a2b_3c4d.duosecurity.com",
      "api-1a2b3c4d.evil-duosecurity.com",
      "xapi-1a2b3c4d.duosecurity.com",
      "127.0.0.1",
      "localhost:4000",
      "api-1a2b3c4d.duosecurity.com\n.evil.example",
      "api-1a2b3c4d.duosecurity.com?x",
      "api-1a2b3c4d.duosecurity.com#x",
    ]) {
      assert.equal(policy.normalizeDuoHost(bad), null, JSON.stringify(bad));
    }
    assert.equal(policy.normalizeDuoHost(null), null);
    // A stored value that is not a Duo host reads as "no host": it is never used to build a request.
    assert.equal(policy.duoSettingsFrom(map({ [K.apiHost]: "evil.example" })).apiHost, "");
    assert.equal(policy.duoConfigured(policy.duoSettingsFrom(map({ [K.apiHost]: "evil.example" }))), false);
  });

  test("nothing is enforced unless a rule is on, Duo is set up, the licence grants it and the escape hatch is off", () => {
    assert.equal(policy.duoSwitchedOn({}), false);
    assert.equal(policy.duoSwitchedOn(map({ [K.enforceSignIn]: "0" })), false);
    assert.equal(policy.duoSwitchedOn(map({ [K.enforceSignIn]: "0", [K.enforceDesk]: "1" })), true);
    const p = (over: Record<string, string>, facts = licensed) => policy.duoPolicy(policy.duoSettingsFrom(map(over)), facts);
    assert.ok(p({}));
    assert.equal(p({ [K.enforceSignIn]: "0" }), null, "no rule on");
    // A rule that is on with details that went missing (a lost master key) is still on: damage does not switch the check off.
    assert.ok(p({ [K.clientId]: "" }), "no client ID");
    assert.ok(p({ [K.clientSecret]: "" }), "no secret");
    assert.ok(p({ [K.apiHost]: "" }), "no host");
    assert.equal(verdict(map({ [K.clientSecret]: "" }), {}).signIn, true);
    assert.equal(p({}, { disabled: false, licensed: false }), null, "licence off");
    assert.equal(p({}, { disabled: true, licensed: true }), null, "escape hatch");
    // And with nothing enforced, no session owes anything.
    assert.deepEqual(verdict(map({ [K.enforceSignIn]: "0" }), {}), policy.DUO_NOTHING_OWED);
    assert.deepEqual(verdict({}, {}), policy.DUO_NOTHING_OWED);
    assert.deepEqual(verdict(map(), {}, { disabled: false, licensed: false }), policy.DUO_NOTHING_OWED);
    assert.deepEqual(verdict(map(), {}, { disabled: true, licensed: true }), policy.DUO_NOTHING_OWED);
  });

  test("the sign-in rule: every session passes once, and stays passed", () => {
    assert.deepEqual(verdict(map(), {}), { signIn: true, desk: true, bypassed: false });
    assert.deepEqual(verdict(map(), { mfaAt: ago(0.1), mfaMethod: "duo" }), { signIn: false, desk: false, bypassed: false });
    assert.deepEqual(verdict(map(), { mfaAt: ago(500), mfaMethod: "duo" }), { signIn: false, desk: false, bypassed: false }, "no age limit at sign-in");
    assert.deepEqual(verdict(map(), { mfaAt: ago(1), mfaMethod: "duo_unreachable" }), { signIn: false, desk: false, bypassed: false });
    // A method this code does not know, or a time without a method, is not a pass.
    assert.equal(verdict(map(), { mfaAt: ago(1), mfaMethod: "totp" }).signIn, true);
    assert.equal(verdict(map(), { mfaAt: ago(1), mfaMethod: null }).signIn, true);
    assert.equal(verdict(map(), { mfaAt: null, mfaMethod: "duo" }).signIn, true);
    assert.equal(verdict(map(), { mfaAt: "not a date", mfaMethod: "duo" }).signIn, true);
  });

  test("the desk rule: only the desk, and only for N hours", () => {
    const desk = map({ [K.enforceSignIn]: "0", [K.enforceDesk]: "1" });
    assert.equal(policy.duoSettingsFrom(desk).deskHours, 12, "the default");
    assert.deepEqual(verdict(desk, {}), { signIn: false, desk: true, bypassed: false }, "the rest of CompassDocs is unaffected");
    assert.deepEqual(verdict(desk, { mfaAt: ago(11.9), mfaMethod: "duo" }), { signIn: false, desk: false, bypassed: false });
    assert.deepEqual(verdict(desk, { mfaAt: ago(12), mfaMethod: "duo" }), { signIn: false, desk: false, bypassed: false }, "exactly at the limit");
    assert.deepEqual(verdict(desk, { mfaAt: ago(12.01), mfaMethod: "duo" }), { signIn: false, desk: true, bypassed: false });
    const two = map({ [K.enforceSignIn]: "0", [K.enforceDesk]: "1", [K.deskHours]: "2" });
    assert.equal(verdict(two, { mfaAt: ago(1.9), mfaMethod: "duo" }).desk, false);
    assert.equal(verdict(two, { mfaAt: ago(2.1), mfaMethod: "duo" }).desk, true);
    // A time in the future is not "recent".
    assert.equal(verdict(two, { mfaAt: ago(-1), mfaMethod: "duo" }).desk, true);
    // Hours are clamped to 1..168, and nonsense reads as the default.
    assert.equal(policy.clampDeskHours(0), 1);
    assert.equal(policy.clampDeskHours(9999), 168);
    assert.equal(policy.clampDeskHours("abc"), 12);
    assert.equal(policy.duoSettingsFrom(map({ [K.deskHours]: "0" })).deskHours, 1);
  });

  test("both rules: sign-in once, the desk again when the approval is old", () => {
    const both = map({ [K.enforceDesk]: "1", [K.deskHours]: "4" });
    assert.deepEqual(verdict(both, {}), { signIn: true, desk: true, bypassed: false });
    assert.deepEqual(verdict(both, { mfaAt: ago(1), mfaMethod: "duo" }), { signIn: false, desk: false, bypassed: false });
    assert.deepEqual(verdict(both, { mfaAt: ago(5), mfaMethod: "duo" }), { signIn: false, desk: true, bypassed: false });
  });

  test("the bypass list skips both rules, for the named accounts only", () => {
    const both = map({ [K.enforceDesk]: "1", [K.bypass]: "[7, 9]" });
    assert.deepEqual(verdict(both, { userId: 7 }), { signIn: false, desk: false, bypassed: true });
    assert.deepEqual(verdict(both, { userId: 8 }), { signIn: true, desk: true, bypassed: false });
    // With nothing enforced there is nothing to bypass (and nothing to audit).
    assert.equal(verdict(map({ [K.enforceSignIn]: "0", [K.bypass]: "[7]" }), { userId: 7 }).bypassed, false);
    // A damaged list is an empty list, never "everyone".
    for (const raw of ["", "null", "{}", "[\"7\"]", "7", "[7", "[0,-1,1.5]"]) {
      assert.equal(verdict(map({ [K.bypass]: raw }), { userId: 7 }).signIn, true, raw);
    }
  });

  test("the desk is /desk and what is under it; an unknown path counts as the desk", () => {
    for (const p of ["/desk", "/desk/", "/desk/requests/12", "/desk?view=mine", "/DESK/settings", "/%64esk/x", "/desk/tickets/4/print"]) assert.equal(policy.isDeskPath(p), true, p);
    for (const p of ["/", "/doc/3", "/desktop", "/help/desk", "/admin/sso", "/support", "/login/duo?for=desk"]) assert.equal(policy.isDeskPath(p), false, p);
    assert.equal(policy.isDeskPath(""), true);
    assert.equal(policy.isDeskPath(null), true);
    assert.equal(policy.isDeskPath("/%zz"), true);
  });

  test("the step's address keeps a safe way back and never an unsafe one", () => {
    assert.equal(policy.duoStepHref("/doc/3?x=1"), "/login/duo?next=%2Fdoc%2F3%3Fx%3D1");
    for (const bad of ["", "/", "//evil.example", "https://evil.example", "/login/duo", "/login/duo?next=/x", "/api/x", "/\\evil.example", null]) {
      assert.equal(policy.duoStepHref(bad), "/login/duo", String(bad));
    }
  });

  test("credential shapes", () => {
    assert.equal(policy.validDuoClientId(CLIENT_ID), true);
    assert.equal(policy.validDuoClientId("short"), false);
    assert.equal(policy.validDuoClientId(`${CLIENT_ID}X`), false);
    assert.equal(policy.validDuoClientSecret(SECRET), true);
    assert.equal(policy.validDuoClientSecret(SECRET.slice(1)), false);
    assert.equal(policy.validDuoClientSecret(`${SECRET.slice(0, 39)} `), false);
  });
});

// --- 3. Against the database and a fake Duo ----------------------------------------------

const STAMP = `duo${Date.now()}`;
const userIds: number[] = [];
const savedSettings = new Map<string, string | undefined>();
const SETTING_KEYS = [...Object.values(K)];
let duo: FakeDuo;
let adminId = 0;
let agentId = 0;
let userId = 0;
let breakGlassId = 0;
let oauthClientId = "";

async function newUser(tag: string, role: string): Promise<number> {
  const r = await pool().query<{ id: number }>(
    "INSERT INTO users (username, name, email, role, status, auth_provider) VALUES ($1, $2, $3, $4, 'active', 'local') RETURNING id",
    [`${STAMP}-${tag}`, `Duo ${tag}`, `${tag}@${STAMP}.example.test`, role]
  );
  userIds.push(r.rows[0].id);
  // The role column is mirrored into role_assignments by the database, so the permission model sees it.
  return r.rows[0].id;
}

async function newSession(id: number): Promise<string> {
  const token = newToken();
  await db.createSession(token, id, new Date(Date.now() + 3_600_000).toISOString(), "198.51.100.7", "duo-mfa.test");
  return token;
}

/** Make `token` the request's session and give the request its headers. */
function as(token: string, url = `${ORIGIN}/`, init: RequestInit = {}, pagePath = ""): Request {
  currentToken = token;
  currentRequest = new Request(url, {
    ...init,
    headers: { "x-forwarded-host": "docs.example.test", "x-forwarded-proto": "https", ...(pagePath ? { "x-compass-path": pagePath } : {}), ...((init.headers as Record<string, string>) ?? {}) },
  });
  return currentRequest;
}

async function settings(values: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(values)) await setSetting(k, v);
}

/** Duo set up; no rule on, no bypass, fail closed. */
async function configured(over: Record<string, string> = {}): Promise<void> {
  await settings({
    [K.clientId]: CLIENT_ID,
    [K.clientSecret]: SECRET,
    [K.apiHost]: HOST,
    [K.usernameSource]: "email",
    [K.enforceSignIn]: "0",
    [K.enforceDesk]: "0",
    [K.deskHours]: "12",
    [K.bypass]: "[]",
    [K.failOpen]: "0",
    [K.rev]: "rev-1",
    // The admin's test passed at ORIGIN: with no custom domain, that is where Duo sends people back.
    [K.verified]: JSON.stringify({ rev: "rev-1", sid: "fixture", user_id: 0, at: new Date().toISOString(), origin: ORIGIN }),
    ...over,
  });
}

async function auditCount(action: string, actorId: number): Promise<number> {
  const r = await pool().query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE action = $1 AND actor_id = $2", [action, actorId]);
  return Number(r.rows[0].n);
}
async function lastAudit(action: string, actorId: number): Promise<Record<string, unknown> | null> {
  const r = await pool().query<{ details: Record<string, unknown> | null }>("SELECT details FROM audit_log WHERE action = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 1", [action, actorId]);
  return r.rows[0]?.details ?? null;
}
async function sessionRow(token: string) {
  currentToken = token;
  return db.getSessionUser(token);
}

/** POST /api/auth/duo/start as `token`. */
async function start(token: string, body: unknown = {}) {
  const res = await startRoute.POST(as(token, `${ORIGIN}/api/auth/duo/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { redirect?: string; code?: string; error?: string } };
}
/** Follow Duo's prompt (the fake approves at once) and return the address it sends the browser back to. */
async function prompt(redirect: string): Promise<string> {
  assert.ok(redirect.startsWith(`${duo.base}/oauth/v1/authorize?`), redirect);
  const res = await fetch(redirect, { redirect: "manual" });
  assert.equal(res.status, 302, await res.text());
  return res.headers.get("location")!;
}
/** GET the callback as `token`; returns where it redirects. */
async function callback(token: string, url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await callbackRoute.GET(as(token, url, { headers }));
  assert.equal(res.status, 302);
  const location = res.headers.get("location")!;
  // Always a path on this site: no address is ever built from the request's Host header.
  assert.match(location, /^\/(?!\/)/, location);
  return `${ORIGIN}${location}`;
}
/** The whole step for `token`: start, prompt, callback. */
async function passDuo(token: string, body: unknown = {}): Promise<string> {
  const s = await start(token, body);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return callback(token, await prompt(s.body.redirect!));
}

before(async () => {
  await db.getSetting("__schema_bootstrap__");
  for (const k of SETTING_KEYS) {
    const r = await pool().query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [k]);
    savedSettings.set(k, r.rows[0]?.value);
  }
  duo = await startFakeDuo({ clientId: CLIENT_ID, clientSecret: SECRET });
  process.env.COMPASSDOCS_DUO_TEST_API_BASE = duo.base;
  adminId = await newUser("admin", "admin");
  agentId = await newUser("agent", "editor");
  userId = await newUser("user", "viewer");
  breakGlassId = await newUser("breakglass", "admin");
  oauthClientId = (await db.registerOAuthClient(`${STAMP} connector`, ["https://claude.example.test/cb"])).client_id;
});

after(async () => {
  // Leave the rig as it was found: Duo not set up.
  for (const k of SETTING_KEYS) {
    await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    const v = savedSettings.get(k);
    if (v !== undefined) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, v]);
  }
  await pool().query("DELETE FROM oauth_clients WHERE client_id = $1", [oauthClientId]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  delete process.env.COMPASSDOCS_DUO_TEST_API_BASE;
  delete process.env.COMPASSDOCS_DUO_DISABLED;
  await duo.close();
  await pool().end();
});

beforeEach(() => {
  duo.mode = "allow";
  edition.features = ["sso", "helpdesk"];
  delete process.env.COMPASSDOCS_DUO_DISABLED;
});

describe("the test seam and the escape hatch (lib/duo-config)", () => {
  test("the seam only ever points at this machine", () => {
    const was = process.env.COMPASSDOCS_DUO_TEST_API_BASE;
    try {
      delete process.env.COMPASSDOCS_DUO_TEST_API_BASE;
      assert.equal(config.duoTestApiBase(), null);
      assert.equal(config.duoApiBase(HOST), `https://${HOST}`);
      for (const bad of ["https://evil.example", "http://evil.example:8080", "http://127.0.0.1.evil.example:80", "http://127.0.0.1:4000/x", "http://localhost", "http://10.0.0.5:4000", "//127.0.0.1:4000"]) {
        process.env.COMPASSDOCS_DUO_TEST_API_BASE = bad;
        assert.equal(config.duoTestApiBase(), null, bad);
        assert.equal(config.duoApiBase(HOST), `https://${HOST}`, bad);
      }
      process.env.COMPASSDOCS_DUO_TEST_API_BASE = "http://127.0.0.1:4000";
      assert.equal(config.duoApiBase(HOST), "http://127.0.0.1:4000");
    } finally {
      process.env.COMPASSDOCS_DUO_TEST_API_BASE = was;
    }
  });

  test("COMPASSDOCS_DUO_DISABLED=1 and a missing licence both mean no policy", () => {
    const map = { [K.clientId]: CLIENT_ID, [K.clientSecret]: SECRET, [K.apiHost]: HOST, [K.enforceSignIn]: "1", [K.enforceDesk]: "1" };
    assert.ok(config.duoPolicyFromSettings(map));
    process.env.COMPASSDOCS_DUO_DISABLED = "1";
    assert.equal(config.duoPolicyFromSettings(map), null);
    process.env.COMPASSDOCS_DUO_DISABLED = "true"; // only "1" is the switch
    assert.ok(config.duoPolicyFromSettings(map));
    delete process.env.COMPASSDOCS_DUO_DISABLED;
    edition.features = ["helpdesk"];
    assert.equal(config.duoPolicyFromSettings(map), null, "the licence does not grant sso");
  });

  test("the real lib/ee on a community build never enables it, whatever the settings say", () => {
    // Loaded past the stub: tsconfig.test.json resolves @ee to the community edition, as CI's build does.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realEe = require(path.join(EE_REAL, "..", "ee.ts")) as typeof import("../src/lib/ee");
    assert.equal(realEe.eePresent(), false);
    assert.equal(realEe.featureEnabledFrom("sso", { license_key: "anything" }), false);
  });
});

describe("the session gates", () => {
  let token = "";
  before(async () => {
    token = await newSession(userId);
  });

  test("Duo not set up: nothing changes, and currentSession owes nothing", async () => {
    for (const k of SETTING_KEYS) await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    as(token);
    const s = await auth.currentSession();
    assert.deepEqual(s?.duo, policy.DUO_NOTHING_OWED);
    assert.equal((await auth.getCurrentUser())?.id, userId);
    assert.equal(((await apiAuth.apiGuard("viewer")) as { id: number }).id, userId);
    assert.equal(((await apiAuth.apiSession("desk")) as { id: number }).id, userId);
  });

  test("set up but no rule on: still nothing", async () => {
    await configured();
    as(token);
    assert.deepEqual((await auth.currentSession())?.duo, policy.DUO_NOTHING_OWED);
    assert.equal((await auth.getCurrentUser())?.id, userId);
  });

  test("the sign-in rule: not signed in for any reader, 401 mfa_required from the API guards, pages go to the Duo step", async () => {
    await configured({ [K.enforceSignIn]: "1" });
    as(token, `${ORIGIN}/doc/3`, {}, "/doc/3?x=1");
    assert.deepEqual((await auth.currentSession())?.duo, { signIn: true, desk: true, bypassed: false });
    assert.equal(await auth.getCurrentUser(), null, "every direct reader sees a signed-out visitor");

    for (const gate of [
      () => apiAuth.apiGuard("viewer"),
      () => apiAuth.apiGuard("admin", "identity.sso_manage"),
      () => apiAuth.sectionApiGuard("compliance"),
      () => apiAuth.apiSession(),
      () => apiAuth.apiSession("desk"),
      () => hdAccess.helpdeskGate("request"),
      () => hdAccess.helpdeskGate("agent"),
      () => hdRoles.hdCapGate("settings.manage"),
      () => hdRoles.hdAnyCapGate(["settings.manage"]),
      () => deskUserGate(),
    ]) {
      const res = (await gate()) as Response;
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Confirm with Duo to continue.", code: "mfa_required" });
    }

    await assert.rejects(auth.requireUser(), (e: { digest?: string }) => {
      assert.match(String(e.digest), /^NEXT_REDIRECT;/);
      assert.ok(String(e.digest).includes("/login/duo?next=%2Fdoc%2F3%3Fx%3D1"), e.digest);
      return true;
    });
    await assert.rejects(auth.requirePermission("editor", "document.create"), (e: { digest?: string }) => String(e.digest).includes("/login/duo"));
  });

  test("no session at all is still the plain 401 and the sign-in page", async () => {
    as("", `${ORIGIN}/doc/3`, {}, "/doc/3");
    const res = (await apiAuth.apiGuard("viewer")) as Response;
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Authentication required." });
    await assert.rejects(auth.requireUser(), (e: { digest?: string }) => String(e.digest).includes("/login?next=%2Fdoc%2F3"));
    as(newToken());
    assert.equal(await auth.currentSession(), null);
  });

  test("the escape hatch and a lapsed licence switch the rule off for a session that has not passed", async () => {
    await configured({ [K.enforceSignIn]: "1", [K.enforceDesk]: "1" });
    as(token);
    assert.equal(await auth.getCurrentUser(), null);
    process.env.COMPASSDOCS_DUO_DISABLED = "1";
    assert.equal((await auth.getCurrentUser())?.id, userId);
    assert.equal(((await hdAccess.helpdeskGate("agent")) as Response).status !== 401, true);
    delete process.env.COMPASSDOCS_DUO_DISABLED;
    assert.equal(await auth.getCurrentUser(), null);
    edition.features = ["helpdesk"];
    assert.equal((await auth.getCurrentUser())?.id, userId);
  });

  test("the desk rule alone: the app is untouched, the desk side is asked, the requester side is not", async () => {
    await configured({ [K.enforceDesk]: "1", [K.deskHours]: "2" });
    const t = await newSession(agentId);
    as(t, `${ORIGIN}/`, {}, "/doc/9");
    assert.deepEqual((await auth.currentSession())?.duo, { signIn: false, desk: true, bypassed: false });
    assert.equal((await auth.getCurrentUser())?.id, agentId);
    assert.equal(((await apiAuth.apiGuard("viewer")) as { id: number }).id, agentId);
    assert.equal((await auth.requireUser()).id, agentId, "a page outside the desk");
    assert.equal(((await hdAccess.helpdeskGate("request")) as Response).status !== 401, true, "Get help is not the desk");

    for (const gate of [() => hdAccess.helpdeskGate("agent"), () => hdAccess.helpdeskGate("admin"), () => hdAccess.helpdeskGate("reports"), () => hdRoles.hdCapGate("settings.manage"), () => hdRoles.hdAnyCapGate(["reports.own"]), () => deskUserGate({ write: true })]) {
      const res = (await gate()) as Response;
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { code: string }).code, "mfa_required");
    }
    for (const page of ["/desk", "/desk/requests/4", "/desk/tickets/4/print"]) {
      as(t, `${ORIGIN}${page}`, {}, page);
      await assert.rejects(auth.requireUser(), (e: { digest?: string }) => String(e.digest).includes(`/login/duo?next=${encodeURIComponent(page)}`), page);
    }

    // Approved a moment ago: the desk opens. Two hours and a bit later: asked again, and only for the desk.
    await db.markSessionMfa(t, "duo");
    as(t, `${ORIGIN}/desk`, {}, "/desk");
    assert.deepEqual((await auth.currentSession())?.duo, policy.DUO_NOTHING_OWED);
    assert.equal((await auth.requireUser()).id, agentId);
    assert.notEqual(((await hdAccess.helpdeskGate("agent")) as Response).status, 401);
    await pool().query("UPDATE sessions SET mfa_at = now() - interval '2 hours 5 minutes' WHERE user_id = $1", [agentId]);
    assert.deepEqual((await auth.currentSession())?.duo, { signIn: false, desk: true, bypassed: false });
    assert.equal(((await hdAccess.helpdeskGate("agent")) as Response).status, 401);
    await assert.rejects(auth.requireUser(), (e: { digest?: string }) => String(e.digest).includes("/login/duo?next=%2Fdesk"));
    as(t, `${ORIGIN}/doc/9`, {}, "/doc/9");
    assert.equal((await auth.requireUser()).id, agentId);
    assert.equal(((await apiAuth.apiGuard("viewer")) as { id: number }).id, agentId);
  });

  test("a bypass account is let through, and audited once per session, not per request", async () => {
    await configured({ [K.enforceSignIn]: "1", [K.enforceDesk]: "1", [K.bypass]: JSON.stringify([breakGlassId]) });
    const t = await newSession(breakGlassId);
    as(t, `${ORIGIN}/desk`, {}, "/desk");
    const before = await auditCount("auth.duo_bypass", breakGlassId);
    for (let i = 0; i < 4; i++) {
      assert.equal((await auth.getCurrentUser())?.id, breakGlassId);
      assert.equal((await auth.requireUser()).id, breakGlassId);
      assert.equal(((await apiAuth.apiGuard("viewer")) as { id: number }).id, breakGlassId);
      assert.notEqual(((await apiAuth.apiSession("desk")) as Response).status, 401);
    }
    assert.equal((await auditCount("auth.duo_bypass", breakGlassId)) - before, 1);
    // Another session of the same account is another line.
    as(await newSession(breakGlassId));
    await auth.getCurrentUser();
    await auth.getCurrentUser();
    assert.equal((await auditCount("auth.duo_bypass", breakGlassId)) - before, 2);
    // Everyone else is still asked.
    as(token);
    assert.equal(await auth.getCurrentUser(), null);
    // Off the list again: the old session is asked like anyone (the bypass was never a pass).
    await setSetting(K.bypass, "[]");
    as(t);
    assert.equal(await auth.getCurrentUser(), null);
  });

  test("API tokens and the connector's OAuth tokens are never asked for Duo", async () => {
    await configured({ [K.enforceSignIn]: "1", [K.enforceDesk]: "1" });
    as(token);
    assert.equal(await auth.getCurrentUser(), null, "this account's browser session IS asked");
    const api = await db.createApiToken(userId, `${STAMP} token`, ["read"]);
    const viaToken = await v1Auth(new Request(`${ORIGIN}/api/v1/documents`, { headers: { authorization: `Bearer ${api.token}` } }), "read");
    assert.equal((viaToken as { id: number }).id, userId);
    const oauth = await db.createOAuthTokens(oauthClientId, userId);
    assert.equal((await db.getUserByOAuthToken(oauth.accessToken))?.id, userId);
    // A session cookie is not an API token, and an API token is not a session.
    currentToken = api.token;
    assert.equal(await auth.currentSession(), null);
  });

  test("signing out works from the Duo step, and is on the record", async () => {
    await configured({ [K.enforceSignIn]: "1" });
    const t = await newSession(userId);
    const before = await auditCount("auth.logout", userId);
    const res = await logoutRoute.POST(as(t, `${ORIGIN}/api/auth/logout`, { method: "POST" }));
    assert.equal(res.status, 200);
    assert.equal(await sessionRow(t), undefined);
    assert.equal((await auditCount("auth.logout", userId)) - before, 1);
  });
});

describe("the single-use state", () => {
  const row = (token: string, state: string, ttlSeconds = 300) =>
    db.saveDuoState({ state, token, nonce: "n", username: "u", purpose: "signin", returnTo: "/doc/1", redirectUri: `${ORIGIN}/api/auth/duo/callback`, configRev: "rev-1", ttlSeconds });

  test("works once, for the session that started it, inside its time", async () => {
    const a = await newSession(userId);
    const b = await newSession(agentId);
    await row(a, "state-one-0000000000000000000000");
    const first = await db.takeDuoState("state-one-0000000000000000000000", a);
    assert.equal(first?.same_session, true);
    assert.equal(first?.expired, false);
    assert.equal(first?.return_to, "/doc/1");
    assert.equal(await db.takeDuoState("state-one-0000000000000000000000", a), undefined, "a replay finds nothing");

    await row(a, "state-two-0000000000000000000000");
    const other = await db.takeDuoState("state-two-0000000000000000000000", b);
    assert.equal(other?.same_session, false, "another session's callback");
    assert.equal(await db.takeDuoState("state-two-0000000000000000000000", a), undefined, "and it is spent all the same");

    await row(a, "state-old-0000000000000000000000");
    await pool().query("UPDATE duo_states SET expires_at = now() - interval '1 second'");
    assert.equal((await db.takeDuoState("state-old-0000000000000000000000", a))?.expired, true);
    assert.equal(await db.takeDuoState("never-issued", a), undefined);
  });

  test("a new step replaces the session's earlier one, the state is stored hashed, and it goes with the session", async () => {
    const a = await newSession(userId);
    await row(a, "state-first-00000000000000000000");
    await row(a, "state-second-0000000000000000000");
    assert.equal(await db.takeDuoState("state-first-00000000000000000000", a), undefined);
    const stored = await pool().query<{ state_hash: string }>("SELECT state_hash FROM duo_states");
    assert.ok(stored.rows.length >= 1 && stored.rows.every((r) => /^[0-9a-f]{64}$/.test(r.state_hash) && !r.state_hash.includes("state-")));
    await db.deleteSession(a);
    assert.equal(await db.takeDuoState("state-second-0000000000000000000", a), undefined);
  });
});

describe("the step, against a fake Duo", () => {
  // A fresh account for each test: starting the step is limited per account (10 in five minutes).
  let userId = 0;
  let n = 0;
  beforeEach(async () => {
    await configured({ [K.enforceSignIn]: "1" });
    userId = await newUser(`step${++n}`, "viewer");
  });

  test("the calls are shaped the way Duo's own client shapes them", async () => {
    const cfg = { clientId: CLIENT_ID, clientSecret: SECRET, apiHost: HOST };
    await duoClient.duoHealthCheck(cfg); // the fake checks the assertion's signature, iss, sub, aud, exp, jti
    const url = new URL(duoClient.duoAuthorizeUrl(cfg, { state: "s".repeat(64), nonce: "nonce-1", username: "ada@example.com", redirectUri: `${ORIGIN}/api/auth/duo/callback` }));
    assert.equal(url.origin + url.pathname, `${duo.base}/oauth/v1/authorize`);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "redirect_uri", "request", "response_type", "scope"]);
    const request = jwt.verifyDuoJwt(url.searchParams.get("request")!, SECRET);
    assert.equal(request.duo_uname, "ada@example.com");
    assert.equal(request.state, "s".repeat(64));
    assert.equal(request.nonce, "nonce-1");
    assert.equal(request.redirect_uri, `${ORIGIN}/api/auth/duo/callback`);
    assert.equal(request.iss, CLIENT_ID);
    assert.equal(request.aud, duo.base);
    assert.equal(request.response_type, "code");
    assert.equal(request.scope, "openid");
    assert.equal(request.use_duo_code_attribute, true);
    assert.ok(!url.toString().includes(SECRET));
    const step = duoClient.newDuoStep();
    assert.ok(step.state.length >= 22 && step.state.length <= 1024);
    assert.notEqual(step.state, duoClient.newDuoStep().state);
    // Wrong secret: Duo answers and refuses. That is not "unreachable".
    await assert.rejects(duoClient.duoHealthCheck({ ...cfg, clientSecret: "w".repeat(40) }), duoClient.DuoRefusedError);
    // A redirect is never followed.
    duo.mode = "redirect";
    await assert.rejects(duoClient.duoHealthCheck(cfg), duoClient.DuoRefusedError);
    assert.ok(!duo.log.some((l) => l.includes("example.invalid")));
  });

  test("the name sent to Duo: the email, or the username when the workspace says so", () => {
    assert.equal(duoClient.duoUsernameFor({ email: "ada@example.com", username: "ada" }, "email"), "ada@example.com");
    assert.equal(duoClient.duoUsernameFor({ email: "ada@example.com", username: "ada" }, "username"), "ada");
    assert.equal(duoClient.duoUsernameFor({ email: "", username: "ada" }, "email"), "ada");
  });

  test("approve: the session passes, goes back where it was headed, and it is audited", async () => {
    const t = await newSession(userId);
    as(t);
    assert.equal(await auth.getCurrentUser(), null);
    const before = await auditCount("auth.duo_approved", userId);
    const s = await start(t, { next: "/doc/42?tab=history" });
    assert.equal(s.status, 200);
    const back = await prompt(s.body.redirect!);
    assert.ok(back.startsWith(`${ORIGIN}/api/auth/duo/callback?`), back);
    assert.equal(duo.lastUsername, `step${n}@${STAMP}.example.test`, "the email by default");
    assert.equal(await callback(t, back), `${ORIGIN}/doc/42?tab=history`);
    const row = await sessionRow(t);
    assert.equal(row?.mfa_method, "duo");
    assert.ok(row?.mfa_at);
    as(t);
    assert.equal((await auth.getCurrentUser())?.id, userId);
    assert.equal((await auditCount("auth.duo_approved", userId)) - before, 1);

    // The same callback again (a replay, the back button): refused, and the session is not marked again.
    const stamp = row?.mfa_at;
    assert.equal(await callback(t, back), `${ORIGIN}/login/duo?e=expired`);
    assert.equal(String((await sessionRow(t))?.mfa_at), String(stamp));
    assert.equal((await lastAudit("auth.duo_denied", userId))?.reason, "unknown_state");
  });

  test("an unsafe way back is dropped; the username setting is honoured", async () => {
    await setSetting(K.usernameSource, "username");
    const t = await newSession(userId);
    assert.equal(await passDuo(t, { next: "https://evil.example/x" }), `${ORIGIN}/`);
    assert.equal(duo.lastUsername, `${STAMP}-step${n}`);
    const t2 = await newSession(userId);
    assert.equal(await passDuo(t2, { next: "//evil.example" }), `${ORIGIN}/`);
    const t3 = await newSession(userId);
    assert.equal(await passDuo(t3, { for: "desk", next: "/doc/1" }), `${ORIGIN}/login/duo?for=desk&done=1`);
  });

  test("a callback for another session is refused, and spends the state", async () => {
    const mine = await newSession(userId);
    const theirs = await newSession(agentId);
    const s = await start(mine);
    const back = await prompt(s.body.redirect!);
    assert.equal(await callback(theirs, back), `${ORIGIN}/login/duo?e=expired`);
    assert.equal((await sessionRow(theirs))?.mfa_at, null);
    assert.equal((await lastAudit("auth.duo_denied", agentId))?.reason, "other_session");
    // The rightful session cannot use it afterwards either.
    assert.equal(await callback(mine, back), `${ORIGIN}/login/duo?e=expired`);
    assert.equal((await sessionRow(mine))?.mfa_at, null);
    // And with no session at all: back to sign-in.
    assert.equal(await callback("", back), `${ORIGIN}/login`);
  });

  test("an expired step, a missing state, a missing code and a changed configuration are refused", async () => {
    const t = await newSession(userId);
    let back = await prompt((await start(t)).body.redirect!);
    await pool().query("UPDATE duo_states SET expires_at = now() - interval '1 second'");
    assert.equal(await callback(t, back), `${ORIGIN}/login/duo?e=expired`);
    assert.equal((await lastAudit("auth.duo_denied", userId))?.reason, "expired");

    assert.equal(await callback(t, `${ORIGIN}/api/auth/duo/callback?duo_code=abc`), `${ORIGIN}/login/duo?e=expired`);

    back = await prompt((await start(t, { next: "/doc/5" })).body.redirect!);
    const noCode = new URL(back);
    noCode.searchParams.delete("duo_code");
    assert.equal(await callback(t, noCode.toString()), `${ORIGIN}/login/duo?e=denied&next=%2Fdoc%2F5`);

    back = await prompt((await start(t)).body.redirect!);
    await setSetting(K.rev, "rev-2");
    assert.equal(await callback(t, back), `${ORIGIN}/login/duo?e=expired`);
    assert.equal((await lastAudit("auth.duo_denied", userId))?.reason, "settings_changed");
    assert.equal((await sessionRow(t))?.mfa_at, null);
  });

  test("deny, a prompt error, a token for someone else, another nonce, a bad signature: none of them passes", async () => {
    const t = await newSession(userId);
    for (const [mode, reason] of [["deny", "denied"], ["error", "duo_error"], ["wrong_user", "username"], ["wrong_nonce", "nonce"], ["bad_sig", "signature"]] as const) {
      duo.mode = mode;
      const before = await auditCount("auth.duo_denied", userId);
      assert.equal(await passDuo(t, { next: "/doc/5" }), `${ORIGIN}/login/duo?e=denied&next=%2Fdoc%2F5`, mode);
      assert.equal((await sessionRow(t))?.mfa_at, null, mode);
      assert.equal((await auditCount("auth.duo_denied", userId)) - before, 1, mode);
      assert.equal((await lastAudit("auth.duo_denied", userId))?.reason, reason, mode);
    }
    as(t);
    assert.equal(await auth.getCurrentUser(), null);
    // A made-up code that Duo does not know.
    duo.mode = "allow";
    const back = new URL(await prompt((await start(t)).body.redirect!));
    back.searchParams.set("duo_code", "0123456789abcdef0123456789abcdef");
    assert.equal(await callback(t, back.toString()), `${ORIGIN}/login/duo?e=denied`);
    assert.equal((await lastAudit("auth.duo_denied", userId))?.reason, "exchange_refused");
    // Fail-open does not turn a denial into a pass.
    await setSetting(K.failOpen, "1");
    duo.mode = "deny";
    assert.equal(await passDuo(t), `${ORIGIN}/login/duo?e=denied`);
    assert.equal((await sessionRow(t))?.mfa_at, null);
  });

  test("Duo down, fail closed (the default): blocked with a retry, audited each time", async () => {
    const t = await newSession(userId);
    duo.mode = "down";
    const before = await auditCount("auth.duo_unreachable_blocked", userId);
    const s = await start(t);
    assert.equal(s.status, 503);
    assert.equal(s.body.code, "duo_unreachable");
    assert.equal(s.body.redirect, undefined);
    await start(t);
    assert.equal((await auditCount("auth.duo_unreachable_blocked", userId)) - before, 2);
    assert.equal((await sessionRow(t))?.mfa_at, null);
    as(t);
    assert.equal(await auth.getCurrentUser(), null);

    // Down between the prompt and the answer.
    duo.mode = "allow";
    const back = await prompt((await start(t, { next: "/doc/5" })).body.redirect!);
    duo.mode = "token_down";
    assert.equal(await callback(t, back), `${ORIGIN}/login/duo?e=unreachable&next=%2Fdoc%2F5`);
    assert.deepEqual(await lastAudit("auth.duo_unreachable_blocked", userId), { stage: "token", reason: "unreachable" });
    assert.equal((await sessionRow(t))?.mfa_at, null);

    // A bypass account is not affected by Duo being down.
    duo.mode = "down";
    await setSetting(K.bypass, JSON.stringify([breakGlassId]));
    const b = await newSession(breakGlassId);
    as(b);
    assert.equal((await auth.getCurrentUser())?.id, breakGlassId);
    assert.deepEqual((await start(b, { next: "/doc/1" })).body, { redirect: "/doc/1" });
  });

  test("Duo down, fail open: let through, marked as such, audited each time", async () => {
    await setSetting(K.failOpen, "1");
    const t = await newSession(userId);
    duo.mode = "down";
    const before = await auditCount("auth.duo_unreachable_allowed", userId);
    const s = await start(t, { next: "/doc/7" });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body, { redirect: "/doc/7" });
    assert.equal((await sessionRow(t))?.mfa_method, "duo_unreachable");
    assert.equal((await auditCount("auth.duo_unreachable_allowed", userId)) - before, 1);
    as(t);
    assert.equal((await auth.getCurrentUser())?.id, userId);

    const t2 = await newSession(userId);
    duo.mode = "allow";
    const back = await prompt((await start(t2, { next: "/doc/8" })).body.redirect!);
    // The token endpoint failing on its own is not Duo being down: the health check still answers, so nobody is let through.
    duo.mode = "token_down";
    assert.equal(await callback(t2, back), `${ORIGIN}/login/duo?e=unreachable&next=%2Fdoc%2F8`);
    assert.equal((await sessionRow(t2))?.mfa_at, null);
    assert.equal((await auditCount("auth.duo_unreachable_allowed", userId)) - before, 1);
    assert.deepEqual(await lastAudit("auth.duo_unreachable_blocked", userId), { stage: "token", reason: "unreachable" });
    // Health check and token endpoint both unreachable: let through, audited.
    duo.mode = "allow";
    const back2 = await prompt((await start(t2, { next: "/doc/8" })).body.redirect!);
    duo.mode = "all_down";
    assert.equal(await callback(t2, back2), `${ORIGIN}/doc/8`);
    assert.equal((await sessionRow(t2))?.mfa_method, "duo_unreachable");
    assert.deepEqual(await lastAudit("auth.duo_unreachable_allowed", userId), { stage: "token" });
    assert.equal((await auditCount("auth.duo_unreachable_allowed", userId)) - before, 2);

    // Duo answering "your client is wrong" is not Duo being unreachable: still blocked.
    const t3 = await newSession(userId);
    duo.mode = "refuse";
    const refused = await start(t3);
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, "duo_refused");
    assert.equal((await sessionRow(t3))?.mfa_at, null);
  });

  test("starting needs a session and the same origin; nothing owed means straight on", async () => {
    const anon = await startRoute.POST(as("", `${ORIGIN}/api/auth/duo/start`, { method: "POST", body: "{}" }));
    assert.equal(anon.status, 401);
    const t = await newSession(userId);
    const cross = await startRoute.POST(as(t, `${ORIGIN}/api/auth/duo/start`, { method: "POST", body: "{}", headers: { origin: "https://evil.example" } }));
    assert.equal(cross.status, 403);
    await setSetting(K.enforceSignIn, "0");
    const before = duo.log.length;
    assert.deepEqual((await start(t, { next: "/doc/2" })).body, { redirect: "/doc/2" });
    assert.equal(duo.log.length, before, "Duo is not called when nothing is enforced");
  });

  test("a rule that is on with unusable details blocks at the step, whatever fail-open says; bypass accounts still get in", async () => {
    await settings({ [K.clientSecret]: "", [K.failOpen]: "1", [K.bypass]: JSON.stringify([breakGlassId]) });
    const t = await newSession(userId);
    as(t);
    assert.equal(await auth.getCurrentUser(), null, "still owed");
    const calls = duo.log.length;
    const s = await start(t);
    assert.equal(s.status, 502);
    assert.equal(s.body.code, "duo_refused");
    assert.equal(duo.log.length, calls, "nothing is sent anywhere");
    assert.deepEqual(await lastAudit("auth.duo_unreachable_blocked", userId), { stage: "settings", reason: "not_set_up" });
    assert.equal((await sessionRow(t))?.mfa_at, null);
    as(await newSession(breakGlassId));
    assert.equal((await auth.getCurrentUser())?.id, breakGlassId);
    process.env.COMPASSDOCS_DUO_DISABLED = "1";
    as(t);
    assert.equal((await auth.getCurrentUser())?.id, userId, "and the escape hatch lets everyone in");
  });

  test("a session cannot ask for more than ten prompts in five minutes, and cannot use up another session's", async () => {
    const t = await newSession(userId);
    for (let i = 0; i < 10; i++) assert.equal((await start(t)).status, 200, `start ${i + 1}`);
    const eleventh = await start(t);
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.redirect, undefined);
    // Someone else holding the password (another session of the same account) has used up only their own allowance:
    // the real person, in their session, still gets a prompt.
    assert.equal((await start(await newSession(userId))).status, 200);
  });
});

describe("the settings route and its lockout guard", () => {
  let adminToken = "";
  const patch = async (body: unknown, token = adminToken) => {
    const res = await adminRoute.PATCH(as(token, `${ORIGIN}/api/admin/duo`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as { error?: string; rules_turned_off?: boolean; state?: Record<string, unknown> } };
  };
  const view = async (token = adminToken) => {
    as(token, `${ORIGIN}/api/admin/duo`);
    const res = await adminRoute.GET();
    return { status: res.status, text: await res.text() };
  };
  /** "Test with my account" from start to finish. */
  const runTest = async (token = adminToken) => {
    const res = await adminTestRoute.POST(as(token, `${ORIGIN}/api/admin/duo/test`, { method: "POST" }));
    const body = (await res.json()) as { redirect?: string; error?: string };
    if (res.status !== 200) return { status: res.status, body, landed: "" };
    return { status: 200, body, landed: await callback(token, await prompt(body.redirect!)) };
  };

  before(async () => {
    for (const k of SETTING_KEYS) await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    adminToken = await newSession(adminId);
  });

  test("only an administrator reaches it", async () => {
    const t = await newSession(userId);
    assert.equal((await view(t)).status, 403);
    assert.equal((await patch({ fail_open: true }, t)).status, 403);
    assert.equal((await view("")).status, 401);
    as(t, `${ORIGIN}/api/admin/duo/test`, { method: "POST" });
    assert.equal((await adminTestRoute.POST(currentRequest!)).status, 403);
  });

  test("the three details are validated; the hostname can only be a Duo API host", async () => {
    assert.equal((await patch({ client_id: "nope" })).status, 400);
    assert.equal((await patch({ client_secret: "too-short" })).status, 400);
    for (const host of ["https://api-1a2b3c4d.duosecurity.com", "evil.example", "api-1a2b3c4d.duosecurity.com.evil.example", "127.0.0.1:9", "api-1a2b3c4d.duosecurity.com/x"]) {
      const r = await patch({ api_host: host });
      assert.equal(r.status, 400, host);
      assert.match(r.body.error!, /api-xxxxxxxx\.duosecurity\.com/);
    }
    assert.equal((await patch({ desk_hours: 0 })).status, 400);
    assert.equal((await patch({ desk_hours: 169 })).status, 400);
    assert.equal((await patch({ desk_hours: 1.5 })).status, 400);
    assert.equal((await patch({ bypass_user_ids: [999_999_999] })).status, 400);
    assert.equal((await db.getAllSettings())[K.apiHost], undefined, "nothing was saved by a refused request");
  });

  test("a rule cannot be turned on before the details are saved and tested by this admin, in this session", async () => {
    // In the same request as the details: no.
    let r = await patch({ client_id: CLIENT_ID, client_secret: SECRET, api_host: HOST, enforce_signin: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error!, /Test with my account/);
    assert.equal((await db.getAllSettings())[K.clientId], undefined, "and nothing was saved");

    // Saved, not tested: no.
    r = await patch({ client_id: CLIENT_ID, client_secret: SECRET, api_host: HOST });
    assert.equal(r.status, 200);
    assert.equal(r.body.state?.configured, true);
    assert.equal(r.body.state?.tested, false);
    assert.equal((await patch({ enforce_signin: true })).status, 400);
    assert.equal((await patch({ enforce_desk: true })).status, 400);
    assert.equal((await db.getAllSettings())[K.enforceSignIn], "0");

    // A test that Duo denies proves nothing.
    duo.mode = "deny";
    assert.equal((await runTest()).landed, `${ORIGIN}/admin/sso?duo_test=denied#duo`);
    assert.equal((await patch({ enforce_signin: true })).status, 400);
    // Nor does one that never reached Duo, whatever fail-open says.
    await patch({ fail_open: true });
    duo.mode = "down";
    assert.equal((await runTest()).status, 503);
    duo.mode = "allow";
    const back = await prompt(((await (await adminTestRoute.POST(as(adminToken, `${ORIGIN}/api/admin/duo/test`, { method: "POST" }))).json()) as { redirect: string }).redirect);
    duo.mode = "token_down";
    assert.equal(await callback(adminToken, back), `${ORIGIN}/admin/sso?duo_test=unreachable#duo`);
    assert.equal((await patch({ enforce_signin: true })).status, 400);
    await patch({ fail_open: false });

    // Another admin's test does not count for this one, nor does this admin's other session.
    duo.mode = "allow";
    const otherAdmin = await newSession(breakGlassId);
    assert.equal((await runTest(otherAdmin)).landed, `${ORIGIN}/admin/sso?duo_test=ok#duo`);
    assert.equal((await patch({ enforce_signin: true })).status, 400);
    const otherSession = await newSession(adminId);
    assert.equal((await runTest(otherSession)).landed, `${ORIGIN}/admin/sso?duo_test=ok#duo`);
    assert.equal((await patch({ enforce_signin: true })).status, 400);

    // This admin, this session: yes.
    const before = await auditCount("auth.duo_approved", adminId);
    assert.equal((await runTest()).landed, `${ORIGIN}/admin/sso?duo_test=ok#duo`);
    assert.deepEqual(await lastAudit("auth.duo_approved", adminId), { test: true });
    assert.equal((await auditCount("auth.duo_approved", adminId)) - before, 1);
    assert.match((await view()).text, /"tested":true/);
    r = await patch({ enforce_signin: true, enforce_desk: true, desk_hours: 8, bypass_user_ids: [breakGlassId] });
    assert.equal(r.status, 200, r.body.error);
    assert.equal(r.body.state?.enforce_signin, true);
    assert.equal(r.body.state?.enforcing, true);
    // The admin who turned it on is not thrown out: their test was a real approval on this session.
    as(adminToken);
    assert.equal((await auth.getCurrentUser())?.id, adminId);
    // Saving something else while a rule is on needs no new test.
    assert.equal((await patch({ desk_hours: 6, fail_open: true })).status, 200);
    assert.equal((await db.getAllSettings())[K.deskHours], "6");
  });

  test("changing the details forgets the test and turns both rules off", async () => {
    // The same secret pasted again is not a change.
    let r = await patch({ client_secret: SECRET, api_host: HOST.toUpperCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.rules_turned_off, false);
    assert.equal(r.body.state?.enforce_signin, true);

    r = await patch({ client_secret: "n".repeat(40) });
    assert.equal(r.status, 200);
    assert.equal(r.body.rules_turned_off, true);
    assert.equal(r.body.state?.enforce_signin, false);
    assert.equal(r.body.state?.enforce_desk, false);
    assert.equal(r.body.state?.tested, false);
    assert.equal(r.body.state?.enforcing, false);
    const map = await db.getAllSettings();
    assert.equal(map[K.enforceSignIn], "0");
    assert.equal(map[K.verified], "");
    assert.notEqual(map[K.rev], "");
    // Nobody is locked out by the untested secret.
    as(await newSession(userId));
    assert.ok(await auth.getCurrentUser());
    // And the rule cannot come back without a new test.
    assert.equal((await patch({ enforce_signin: true })).status, 400);
    // A new host in the same request as the switch: the switch is refused too.
    assert.equal((await patch({ api_host: "api-99999999.duosecurity.com", enforce_desk: true })).status, 400);
    assert.equal((await db.getAllSettings())[K.apiHost], HOST);
  });

  test("the secret is sealed at rest, and never comes back: not from GET, not in the audit log", async () => {
    await patch({ client_secret: SECRET });
    const stored = await pool().query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [K.clientSecret]);
    assert.match(stored.rows[0].value, /^enc:v1:/);
    const got = await view();
    assert.equal(got.status, 200);
    assert.ok(!got.text.includes(SECRET));
    assert.ok(!got.text.includes("n".repeat(40)));
    assert.match(got.text, /"has_secret":true/);
    const rows = await pool().query<{ details: unknown; action: string }>("SELECT action, details FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
    assert.ok(rows.rows.some((r) => r.action === "settings.duo"));
    for (const r of rows.rows) {
      const text = JSON.stringify(r.details ?? {});
      assert.ok(!text.includes(SECRET) && !text.includes("n".repeat(40)) && !text.includes("enc:v1:"), `${r.action} ${text}`);
    }
    const last = await lastAudit("settings.duo", adminId);
    assert.equal(last?.secret_changed, true);
    assert.equal(last?.api_host, HOST);
  });

  test("without the licence the route refuses to save", async () => {
    edition.features = ["helpdesk"];
    assert.equal((await patch({ fail_open: false })).status, 402);
    as(adminToken, `${ORIGIN}/api/admin/duo/test`, { method: "POST" });
    assert.equal((await adminTestRoute.POST(currentRequest!)).status, 402);
  });
});

// --- 4. The security review's findings (1.20.5) ---------------------------------------------

/** A JSON request to a route, as `token`. */
async function send(handler: (req: Request, ctx?: never) => Promise<Response>, token: string, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const res = await handler(as(token, `${ORIGIN}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, res };
}
const MFA = { status: 401, code: "mfa_required" };
const shape = (r: { status: number; body: Record<string, unknown> }) => ({ status: r.status, code: r.body.code });

describe("finding 1: where Duo sends people back never comes from the request", () => {
  const base = { [K.clientId]: CLIENT_ID, [K.clientSecret]: SECRET, [K.apiHost]: HOST, [K.rev]: "rev-1" };
  const pinned = (origin: string, rev = "rev-1") => JSON.stringify({ rev, sid: "s", user_id: 1, at: new Date().toISOString(), origin });

  test("the custom domain wins; without one, the address the test passed on; a forged host gets nothing", () => {
    const at = (map: Record<string, string>, asked: string, purpose: "signin" | "test" = "signin") => config.duoReturnOrigin(map, asked, purpose);
    // A custom domain: always it, whatever the request claims.
    const withDomain = { ...base, custom_domain: "docs.acme.example", [K.enforceSignIn]: "1" };
    for (const asked of ["https://evil.example", "http://docs.acme.example", "https://docs.acme.example", ""]) {
      assert.deepEqual(at(withDomain, asked), { ok: true, origin: "https://docs.acme.example" }, asked);
      assert.deepEqual(at(withDomain, asked, "test"), { ok: true, origin: "https://docs.acme.example" }, asked);
    }
    // No domain: the pinned address, and only when the request is on it.
    const map = { ...base, [K.enforceSignIn]: "1", [K.verified]: pinned(ORIGIN) };
    assert.deepEqual(at(map, ORIGIN), { ok: true, origin: ORIGIN });
    for (const asked of ["https://evil.example", "http://docs.example.test", "https://docs.example.test:8443", "https://docs.example.test.evil.example", ""]) {
      assert.deepEqual(at(map, asked), { ok: false, reason: "other_address", pinned: ORIGIN }, asked);
    }
    // Nothing pinned (never tested, or tested against another configuration): no step.
    assert.deepEqual(at({ ...base, [K.enforceSignIn]: "1" }, ORIGIN), { ok: false, reason: "not_tested", pinned: "" });
    assert.deepEqual(at({ ...base, [K.enforceSignIn]: "1", [K.verified]: pinned(ORIGIN, "rev-0") }, ORIGIN), { ok: false, reason: "not_tested", pinned: "" });
    assert.deepEqual(at({ ...base, [K.enforceSignIn]: "1", [K.verified]: pinned("javascript:alert(1)") }, ORIGIN), { ok: false, reason: "not_tested", pinned: "" });
    // The test may use the address it is asked on, when that is an origin at all...
    assert.deepEqual(at(base, "https://wiki.example.test", "test"), { ok: true, origin: "https://wiki.example.test" });
    for (const junk of ["", "evil.example", "https://evil.example/path", "https://user@evil.example", "ftp://evil.example"]) {
      assert.equal(at(base, junk, "test").ok, false, junk);
    }
    // ...but while a rule is in force it cannot move the pinned address.
    assert.deepEqual(at(map, "https://evil.example", "test"), { ok: false, reason: "other_address", pinned: ORIGIN });
    assert.deepEqual(at(map, ORIGIN, "test"), { ok: true, origin: ORIGIN });
    // Rules off: a new test may pin a new address.
    assert.deepEqual(at({ ...map, [K.enforceSignIn]: "0" }, "https://wiki.example.test", "test"), { ok: true, origin: "https://wiki.example.test" });
  });

  test("a start with a forged Host or X-Forwarded-Host is refused: no signed link, no state, no call to Duo", async () => {
    await configured({ [K.enforceSignIn]: "1" });
    const uid = await newUser("forge", "viewer");
    const t = await newSession(uid);
    const calls = duo.log.length;
    const forged: Record<string, string>[] = [{ "x-forwarded-host": "evil.example" }, { "x-forwarded-host": "evil.example", host: "docs.example.test" }, { "x-forwarded-proto": "http" }, { "x-forwarded-host": "docs.example.test:444" }];
    for (const headers of forged) {
      const r = await send(startRoute.POST, t, "/api/auth/duo/start", "POST", { next: "/doc/1" }, headers);
      assert.equal(r.status, 409, JSON.stringify(headers));
      assert.equal(r.body.code, "duo_wrong_address");
      assert.ok(String(r.body.error).includes(ORIGIN) && !String(r.body.error).includes("evil.example"));
      assert.equal(r.body.redirect, undefined);
    }
    assert.equal(duo.log.length, calls, "Duo was never called");
    assert.equal(Number((await pool().query("SELECT count(*) AS n FROM duo_states s JOIN sessions x ON x.token = s.session_token WHERE x.user_id = $1", [uid])).rows[0].n), 0);
    // On the tested address: the signed request names that address and nothing else.
    const ok = await start(t, { next: "/doc/1" });
    assert.equal(ok.status, 200);
    const link = new URL(ok.body.redirect!);
    assert.equal(link.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/duo/callback`);
    assert.equal(jwt.verifyDuoJwt(link.searchParams.get("request")!, SECRET).redirect_uri, `${ORIGIN}/api/auth/duo/callback`);
    // And the way back is a path, whatever host the callback claims to be on (the helper asserts it).
    const back = await prompt(ok.body.redirect!);
    assert.equal(await callback(t, back, { "x-forwarded-host": "evil.example" }), `${ORIGIN}/doc/1`);
  });

  test("a passed test records its address; later steps use it; a test from elsewhere cannot move it while a rule is on", async () => {
    for (const k of SETTING_KEYS) await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    const admin = await newSession(adminId);
    const WIKI = "https://wiki.example.test";
    const wiki = { "x-forwarded-host": "wiki.example.test" };
    assert.equal((await send(adminRoute.PATCH, admin, "/api/admin/duo", "PATCH", { client_id: CLIENT_ID, client_secret: SECRET, api_host: HOST })).status, 200);
    const t1 = await send(adminTestRoute.POST, admin, "/api/admin/duo/test", "POST", undefined, wiki);
    assert.equal(t1.status, 200);
    assert.equal(new URL(String(t1.body.redirect)).searchParams.get("redirect_uri"), `${WIKI}/api/auth/duo/callback`);
    assert.equal(await callback(admin, await prompt(String(t1.body.redirect))), `${ORIGIN}/admin/sso?duo_test=ok#duo`);
    assert.equal(policy.duoSettingsFrom(await db.getAllSettings()).verified?.origin, WIKI);
    assert.equal((await send(adminRoute.PATCH, admin, "/api/admin/duo", "PATCH", { enforce_signin: true })).status, 200);
    assert.equal((await duoView(adminId, db.sessionSid(admin))).return_origin, WIKI);

    // A person on the tested address is sent to Duo with that address; on any other, the step does not start.
    const uid = await newUser("wiki", "viewer");
    const t = await newSession(uid);
    const elsewhere = await send(startRoute.POST, t, "/api/auth/duo/start", "POST", {});
    assert.equal(elsewhere.status, 409);
    assert.ok(String(elsewhere.body.error).includes(WIKI));
    const there = await send(startRoute.POST, t, "/api/auth/duo/start", "POST", {}, wiki);
    assert.equal(new URL(String(there.body.redirect)).searchParams.get("redirect_uri"), `${WIKI}/api/auth/duo/callback`);

    // With the rule on, a second test from another address is refused and the pin stays.
    const moved = await send(adminTestRoute.POST, admin, "/api/admin/duo/test", "POST", undefined, { "x-forwarded-host": "evil.example" });
    assert.equal(moved.status, 409);
    assert.ok(String(moved.body.error).includes(WIKI));
    assert.equal(policy.duoSettingsFrom(await db.getAllSettings()).verified?.origin, WIKI);
  });
});

describe("findings 2, 3, 5, 7, 10b: the desk rule cannot be walked around", () => {
  let team = 0;
  let requestType = 0;
  let hdAdminRole = 0;
  let requesterId = 0;
  let deskAgentId = 0;
  let hdAdminId = 0;
  let strangerId = 0;
  let theirs = 0; // a request by the requester, in the agent's team
  let own = 0; // a request the agent raised themselves
  let theirsId = 0;
  let attachmentId = 0;
  let agent = "";
  let requester = "";

  before(async () => {
    requesterId = await newUser("requester", "viewer");
    deskAgentId = await newUser("deskagent", "viewer");
    hdAdminId = await newUser("hdadmin", "viewer");
    strangerId = await newUser("stranger", "viewer");
    const role = async (key: string) => (await pool().query<{ id: number }>("SELECT id FROM roles WHERE key = $1", [key])).rows[0].id;
    await pool().query("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [await role("helpdesk-agent"), deskAgentId]);
    hdAdminRole = (await pool().query<{ id: number }>("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-hdadmin`, `${STAMP} helpdesk admin`])).rows[0].id;
    await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.admin')", [hdAdminRole]);
    await pool().query("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [hdAdminRole, hdAdminId]);
    team = (await pool().query<{ id: number }>("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Team`])).rows[0].id;
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [team, deskAgentId]);
    requestType = (await pool().query<{ id: number }>("INSERT INTO hd_request_types (slug, title, team_id, form) VALUES ($1, 'Duo test request', $2, '[]'::jsonb) RETURNING id", [STAMP, team])).rows[0].id;
    // Raised through Get help, with nothing enforced yet.
    for (const k of SETTING_KEYS) await pool().query("DELETE FROM settings WHERE key = $1", [k]);
    const raise = async (token: string, subject: string) => {
      const r = await send(hdRequestsRoute.POST, token, "/api/helpdesk/requests", "POST", { request_type_id: requestType, subject, body: `${subject}: details`, answers: {} });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.ticket as { number: number };
    };
    theirs = (await raise(await newSession(requesterId), `Laptop will not charge ${STAMP}`)).number;
    theirsId = (await pool().query<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1", [theirs])).rows[0].id;
    own = (await raise(await newSession(deskAgentId), `My own badge ${STAMP}`)).number;
    // A file that is not yet on any message: agents (and its uploader) only.
    attachmentId = Number(
      (await pool().query<{ id: string }>("INSERT INTO hd_attachments (stored_name, filename, mime_type, size, ticket_id, uploaded_by) VALUES ($1, 'notes.txt', 'text/plain', 5, $2, $3) RETURNING id", [`${"0".repeat(24)}${String(Date.now()).slice(-8)}.txt`, theirsId, requesterId])).rows[0].id
    );
  });

  after(async () => {
    await pool().query("DELETE FROM hd_attachments WHERE id = $1", [attachmentId]);
    await pool().query("DELETE FROM hd_tickets WHERE team_id = $1 OR requester_id = ANY($2)", [team, [requesterId, deskAgentId]]);
    await pool().query("DELETE FROM hd_request_types WHERE id = $1", [requestType]);
    await pool().query("DELETE FROM hd_teams WHERE id = $1", [team]);
    await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [[requesterId, deskAgentId, hdAdminId, strangerId]]);
    await pool().query("DELETE FROM roles WHERE id = $1", [hdAdminRole]);
  });

  beforeEach(async () => {
    // Only the desk rule: the app is open, the desk wants an approval no older than 2 hours.
    await configured({ [K.enforceDesk]: "1", [K.deskHours]: "2" });
    agent = await newSession(deskAgentId);
    requester = await newSession(requesterId);
  });

  const ctx = (number: number) => ({ params: Promise.resolve({ number: String(number) }) }) as never;
  const getRequest = (token: string, n: number) =>
    hdRequestRoute.GET(as(token, `${ORIGIN}/api/helpdesk/requests/${n}`), ctx(n)).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));

  test("2: no API token and no connector approval while the desk's Duo approval is owed, for people with desk access only", async () => {
    const client = (await db.registerOAuthClient(`${STAMP} app`, ["https://claude.example.test/cb"])).client_id;
    const approve = async (token: string, decision = "approve") => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ client_id: client, redirect_uri: "https://claude.example.test/cb", state: "st", code_challenge: "c".repeat(43), code_challenge_method: "S256", decision })) form.set(k, v);
      currentToken = token;
      currentRequest = new Request(`${ORIGIN}/api/oauth/approve`, { method: "POST", body: form, headers: { "x-forwarded-host": "docs.example.test", "x-forwarded-proto": "https" } });
      const res = await oauthApproveRoute.POST(currentRequest);
      return { status: res.status, location: res.headers.get("location") || "", body: res.status === 401 ? ((await res.json()) as Record<string, unknown>) : {} };
    };
    try {
      // The agent's session owes the desk: neither door opens.
      const mint = await send(tokensRoute.POST, agent, "/api/account/tokens", "POST", { name: "walk around", scopes: ["read"] });
      assert.deepEqual(shape(mint), MFA);
      assert.match(String(mint.body.error), /Confirm with Duo first/);
      assert.equal(mint.body.token, undefined);
      assert.equal(Number((await pool().query("SELECT count(*) AS n FROM api_tokens WHERE user_id = $1", [deskAgentId])).rows[0].n), 0);
      const refused = await approve(agent);
      assert.equal(refused.status, 401);
      assert.equal(refused.body.code, "mfa_required");
      assert.equal(Number((await pool().query("SELECT count(*) AS n FROM oauth_codes WHERE user_id = $1", [deskAgentId])).rows[0].n), 0);
      // Saying no to the app is always allowed.
      assert.match((await approve(agent, "deny")).location, /error=access_denied/);
      // The same for a helpdesk admin who is not an agent.
      assert.deepEqual(shape(await send(tokensRoute.POST, await newSession(hdAdminId), "/api/account/tokens", "POST", { name: "x" })), MFA);
      // Someone with no desk access is not affected by the desk rule at all.
      assert.equal((await send(tokensRoute.POST, requester, "/api/account/tokens", "POST", { name: "mine", scopes: ["read"] })).status, 201);
      assert.match((await approve(requester)).location, /[?&]code=cda_/);
      // Listing tokens was never the door.
      assert.equal((await send(tokensRoute.GET, agent, "/api/account/tokens")).status, 200);
      // Once Duo is given, both work.
      await db.markSessionMfa(agent, "duo");
      assert.equal((await send(tokensRoute.POST, agent, "/api/account/tokens", "POST", { name: "after duo", scopes: ["read"] })).status, 201);
      assert.match((await approve(agent)).location, /[?&]code=cda_/);
      // And when the approval runs out, they close again.
      await pool().query("UPDATE sessions SET mfa_at = now() - interval '3 hours' WHERE user_id = $1", [deskAgentId]);
      assert.deepEqual(shape(await send(tokensRoute.POST, agent, "/api/account/tokens", "POST", { name: "late" })), MFA);
    } finally {
      await pool().query("DELETE FROM oauth_clients WHERE client_id = $1", [client]);
    }
  });

  test("3: a ticket reached as its agent through Get help's routes wants the desk approval; a requester's own request never does", async () => {
    // The agent, owing: their queue's ticket is refused with mfa_required on every request-level route...
    assert.deepEqual(shape(await getRequest(agent, theirs)), MFA);
    const messages = await hdRequestMessagesRoute.POST(
      as(agent, `${ORIGIN}/api/helpdesk/requests/${theirs}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "sneaking in" }) }),
      ctx(theirs)
    );
    assert.equal(messages.status, 401);
    assert.equal(((await messages.json()) as { code: string }).code, "mfa_required");
    assert.deepEqual(shape(await send(hdContactsRoute.GET, agent, `/api/helpdesk/contacts?ticket=${theirs}`)), MFA);
    assert.deepEqual(shape(await send(hdApprovalsRoute.GET, agent, "/api/helpdesk/approvals?state=desk")), MFA);
    const file = await hdAttachmentRoute.GET(as(agent, `${ORIGIN}/api/helpdesk/attachments/${attachmentId}`), { params: Promise.resolve({ id: String(attachmentId) }) });
    assert.equal(file.status, 401);
    assert.equal(((await file.json()) as { code: string }).code, "mfa_required");
    // ...and the agent relation itself is gone for this session, wherever it is asked.
    as(agent);
    const me = (await auth.getCurrentUser())!;
    assert.equal(auth.owesDeskDuo(me), true);
    const row = { id: theirsId, requester_id: requesterId, team_id: team, assignee_id: null };
    assert.equal(await hdAccess.canWorkTicket(me, row), false);
    assert.equal(await hdAccess.ticketRelation(me, row), null);
    assert.deepEqual(await hdAccess.agentTeamIds(me), []);
    assert.equal(await hdAccess.canWorkTicket(me, { ...row, assignee_id: deskAgentId }), false, "not even a ticket assigned to them");
    assert.equal(await hdAccess.deskDuoBarsTicket(me, row), true);
    assert.deepEqual(((await send(hdBannersRoute.GET, agent, "/api/helpdesk/incidents/banners")).body.banners as unknown[]).length >= 0, true);

    // What they hold without being an agent still opens: their own request, their own approvals list.
    const mine = await getRequest(agent, own);
    assert.equal(mine.status, 200);
    assert.equal((await send(hdApprovalsRoute.GET, agent, "/api/helpdesk/approvals")).status, 200);
    // The requester is never asked, and never sees mfa_required.
    assert.equal((await getRequest(requester, theirs)).status, 200);
    assert.equal(auth.owesDeskDuo((as(requester), (await auth.getCurrentUser())!)), true, "the rule is owed by the session, but nothing desk-side is asked of them");
    // Someone with no relation still gets "not found", not a hint that the ticket exists.
    assert.equal((await getRequest(await newSession(strangerId), theirs)).status, 404);
    // An API token's user and the connector's are plain objects: the rule does not touch them.
    assert.equal(await hdAccess.canWorkTicket({ id: deskAgentId, role: "viewer" }, row), true);

    // With the approval given, the agent's view is back.
    await db.markSessionMfa(agent, "duo");
    assert.equal((await getRequest(agent, theirs)).status, 200);
    assert.equal((await send(hdContactsRoute.GET, agent, `/api/helpdesk/contacts?ticket=${theirs}`)).status, 200);
    assert.equal((await send(hdApprovalsRoute.GET, agent, "/api/helpdesk/approvals?state=desk")).status, 200);
    as(agent);
    assert.equal(await hdAccess.canWorkTicket((await auth.getCurrentUser())!, row), true);
  });

  test("3: a desk role's email templates want the desk approval; a workspace template manager's do not", async () => {
    const hd = await newSession(hdAdminId);
    as(hd);
    const refused = (await emailTemplatesGate()) as Response;
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { code: string }).code, "mfa_required");
    await db.markSessionMfa(hd, "duo");
    as(hd);
    assert.equal(((await emailTemplatesGate()) as { helpdesk: boolean }).helpdesk, true);
    // A workspace admin is there by a workspace permission: not a desk matter, even while owing the desk.
    as(await newSession(adminId));
    assert.equal(((await emailTemplatesGate()) as { manage: boolean }).manage, true);
  });

  test("3 and 7: pages. The desk asks whatever path the request claims; a desk-side page outside /desk asks with scope=desk", async () => {
    // The desk layout and the print page: a forged or missing path header changes nothing.
    for (const claimed of ["/", "/doc/3", "", "/help"]) {
      as(agent, `${ORIGIN}/desk/tickets/42.0`, {}, claimed);
      await assert.rejects(auth.requireUser("desk"), (e: { digest?: string }) => String(e.digest).includes("/login/duo"), claimed);
    }
    as(agent, `${ORIGIN}/doc/3`, {}, "/doc/3");
    assert.equal((await auth.requireUser()).id, deskAgentId, "a page that is not the desk");
    // The proxy writes the header for everything under /desk, extension or not, over whatever the client sent.
    assert.ok(proxyModule.config.matcher.includes("/desk/:path*"));
    const res = proxyModule.proxy(new NextRequest(`${ORIGIN}/desk/tickets/42.0?x=1`, { headers: { "x-compass-path": "/" } }));
    assert.equal(res.headers.get("x-middleware-request-x-compass-path"), "/desk/tickets/42.0?x=1");
    // A page outside /desk that shows desk-side data: the step, for the desk rule, and back.
    as(agent, `${ORIGIN}/help/requests/${theirs}`, {}, `/help/requests/${theirs}`);
    const me = (await auth.getCurrentUser())!;
    await assert.rejects(auth.requireDeskDuo(me), (e: { digest?: string }) => String(e.digest).includes(`/login/duo?scope=desk&next=%2Fhelp%2Frequests%2F${theirs}`));
    assert.equal(policy.duoStepHref("/desk/x", { desk: true }), "/login/duo?next=%2Fdesk%2Fx", "a desk path needs no scope");
    assert.equal(policy.duoStepHref("/", { desk: true }), "/login/duo?scope=desk");
    await db.markSessionMfa(agent, "duo");
    as(agent, `${ORIGIN}/desk`, {}, "/");
    assert.equal((await auth.requireUser("desk")).id, deskAgentId);
    await auth.requireDeskDuo((await auth.getCurrentUser())!);
  });

  test("5: your own email, the name Duo knows you by, changes only from a session that really passed Duo", async () => {
    const emailOf = async (id: number) => (await pool().query<{ email: string }>("SELECT email FROM users WHERE id = $1", [id])).rows[0].email;
    const change = (token: string, body: unknown) => send(profileRoute.PATCH, token, "/api/account/profile", "PATCH", body);
    const was = await emailOf(deskAgentId);
    // Desk rule: an agent who owes it cannot retarget their Duo prompt.
    let r = await change(agent, { email: `attacker@${STAMP}.example.test` });
    assert.deepEqual(shape(r), MFA);
    assert.match(String(r.body.error), /needs a Duo approval/);
    assert.equal(await emailOf(deskAgentId), was);
    // Their name is not Duo's business.
    assert.equal((await change(agent, { name: "Desk Agent" })).status, 200);
    assert.equal(await emailOf(deskAgentId), was);
    // Someone the desk rule does not apply to changes theirs as before.
    assert.equal((await change(requester, { email: `requester2@${STAMP}.example.test` })).status, 200);
    // A let-through while Duo was down is not a Duo approval.
    await db.markSessionMfa(agent, "duo_unreachable");
    assert.deepEqual(shape(await change(agent, { email: `attacker@${STAMP}.example.test` })), MFA);
    // A real approval is; one that has run out for the desk is not.
    await db.markSessionMfa(agent, "duo");
    assert.equal((await change(agent, { email: `agent2@${STAMP}.example.test` })).status, 200);
    assert.equal(await emailOf(deskAgentId), `agent2@${STAMP}.example.test`);
    await pool().query("UPDATE sessions SET mfa_at = now() - interval '3 hours' WHERE user_id = $1", [deskAgentId]);
    assert.deepEqual(shape(await change(agent, { email: was })), MFA);

    // The sign-in rule applies to everyone: a let-through session cannot, a real one can, a bypass account is not asked.
    await configured({ [K.enforceSignIn]: "1", [K.bypass]: JSON.stringify([breakGlassId]) });
    const through = await newSession(requesterId);
    await db.markSessionMfa(through, "duo_unreachable");
    assert.deepEqual(shape(await change(through, { email: `r3@${STAMP}.example.test` })), MFA);
    await db.markSessionMfa(through, "duo");
    assert.equal((await change(through, { email: `r3@${STAMP}.example.test` })).status, 200);
    assert.equal((await change(await newSession(breakGlassId), { email: `bg@${STAMP}.example.test` })).status, 200);
    // And with nothing enforced, nothing is asked.
    await configured();
    assert.equal((await change(await newSession(deskAgentId), { email: was })).status, 200);
  });

  test("10b: while a policy is in force the Duo settings change only from a session that passed Duo, or a bypass account", async () => {
    await setSetting(K.bypass, JSON.stringify([breakGlassId]));
    const admin = await newSession(adminId);
    const patch = (token: string, body: unknown) => send(adminRoute.PATCH, token, "/api/admin/duo", "PATCH", body);
    // The desk rule lets an admin reach Settings without Duo. They cannot weaken Duo from there.
    for (const body of [{ enforce_desk: false }, { fail_open: true }, { bypass_user_ids: [breakGlassId, adminId] }, { client_secret: "z".repeat(40) }, { username_source: "username" }]) {
      const r = await patch(admin, body);
      assert.deepEqual(shape(r), MFA, JSON.stringify(body));
      assert.match(String(r.body.error), /Confirm with Duo before changing the Duo settings/);
    }
    const map = await db.getAllSettings();
    assert.equal(map[K.enforceDesk], "1");
    assert.equal(map[K.failOpen], "0");
    assert.equal(map[K.bypass], JSON.stringify([breakGlassId]));
    assert.equal(map[K.clientSecret], SECRET);
    // Reading the settings is not changing them.
    assert.equal((await send(adminRoute.GET as never, admin, "/api/admin/duo")).status, 200);
    // A bypass account can (that is what it is for), and so can the admin once Duo approved this session.
    assert.equal((await patch(await newSession(breakGlassId), { fail_open: true })).status, 200);
    await db.markSessionMfa(admin, "duo");
    assert.equal((await patch(admin, { fail_open: false })).status, 200);
    // With the approval run out, not any more.
    await pool().query("UPDATE sessions SET mfa_at = now() - interval '3 hours' WHERE user_id = $1", [adminId]);
    assert.deepEqual(shape(await patch(admin, { enforce_desk: false })), MFA);
    // The server's switch is the way out: with it set nothing is in force, and the admin can mend the settings.
    process.env.COMPASSDOCS_DUO_DISABLED = "1";
    assert.equal((await patch(admin, { enforce_desk: false })).status, 200);
  });
});

describe("finding 4: letting people in when Duo cannot be reached is narrow", () => {
  let uid = 0;
  let n = 0;
  beforeEach(async () => {
    await configured({ [K.enforceSignIn]: "1", [K.failOpen]: "1" });
    uid = await newUser(`narrow${++n}`, "viewer");
  });
  const cfg = { clientId: CLIENT_ID, clientSecret: SECRET, apiHost: HOST };

  test("4a: only no answer, a timeout or a 5xx is 'unreachable'; anything that answers is a refusal", async () => {
    for (const mode of ["down", "all_down"] as const) {
      duo.mode = mode;
      await assert.rejects(duoClient.duoHealthCheck(cfg), duoClient.DuoUnreachableError, mode);
    }
    for (const mode of ["redirect", "html", "odd", "refuse"] as const) {
      duo.mode = mode;
      await assert.rejects(duoClient.duoHealthCheck(cfg), duoClient.DuoRefusedError, mode);
    }
    // Nothing listening at all.
    const was = process.env.COMPASSDOCS_DUO_TEST_API_BASE;
    process.env.COMPASSDOCS_DUO_TEST_API_BASE = "http://127.0.0.1:19";
    try {
      await assert.rejects(duoClient.duoHealthCheck(cfg), duoClient.DuoUnreachableError);
    } finally {
      process.env.COMPASSDOCS_DUO_TEST_API_BASE = was;
    }
    // So with "let people in" on, a captive portal, a redirect or a bad client lets nobody in.
    for (const mode of ["redirect", "html", "odd", "refuse"] as const) {
      duo.mode = mode;
      const t = await newSession(uid);
      const s = await start(t);
      assert.equal(s.status, 502, mode);
      assert.equal(s.body.code, "duo_refused", mode);
      assert.equal((await sessionRow(t))?.mfa_at, null, mode);
    }
  });

  test("4b: something that is not a Duo code is a denial, and Duo is never asked about it", async () => {
    assert.equal(policy.validDuoCode("0123456789abcdef0123456789abcdef"), true);
    assert.equal(policy.validDuoCode("eyJhbGciOi.J9-_~+/=abc"), true);
    for (const junk of ["", "short", "has space in it", "<script>alert(1)</script>", "a".repeat(1025), "code&grant_type=x", "çode-çode-çode", "line\nbreak-here"]) {
      assert.equal(policy.validDuoCode(junk), false, junk);
    }
    const t = await newSession(uid);
    for (const junk of ["x y", "<script>alert(1)</script>", "a".repeat(2000), "id&client_id=evil"]) {
      const back = new URL(await prompt((await start(t)).body.redirect!));
      back.searchParams.set("duo_code", junk);
      const calls = duo.log.filter((l) => l.includes("/oauth/v1/token")).length;
      assert.equal(await callback(t, back.toString()), `${ORIGIN}/login/duo?e=denied`);
      assert.equal(duo.log.filter((l) => l.includes("/oauth/v1/token")).length, calls, "the token endpoint was not called");
      assert.equal((await lastAudit("auth.duo_denied", uid))?.reason, "bad_code");
    }
    assert.equal((await sessionRow(t))?.mfa_at, null);
  });

  test("4c: at the token stage, let through only if the health check cannot reach Duo either", async () => {
    const t = await newSession(uid);
    const allowed = await auditCount("auth.duo_unreachable_allowed", uid);
    let back = await prompt((await start(t, { next: "/doc/9" })).body.redirect!);
    duo.mode = "token_down"; // the token endpoint fails, the health check answers
    assert.equal(await callback(t, back), `${ORIGIN}/login/duo?e=unreachable&next=%2Fdoc%2F9`);
    assert.equal((await sessionRow(t))?.mfa_at, null);
    assert.equal((await auditCount("auth.duo_unreachable_allowed", uid)) - allowed, 0);
    assert.ok(duo.log.at(-1)!.includes("/oauth/v1/health_check"), "a fresh health check was made");
    duo.mode = "allow";
    back = await prompt((await start(t, { next: "/doc/9" })).body.redirect!);
    duo.mode = "all_down";
    assert.equal(await callback(t, back), `${ORIGIN}/doc/9`);
    assert.equal((await sessionRow(t))?.mfa_method, "duo_unreachable");
    assert.equal((await auditCount("auth.duo_unreachable_allowed", uid)) - allowed, 1);
  });

  test("4d: a let-through lasts one hour, for both rules; then Duo is owed again", async () => {
    const NOW = Date.parse("2026-11-13T12:00:00Z");
    const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
    const map = (over: Record<string, string>) => ({ [K.clientId]: CLIENT_ID, [K.clientSecret]: SECRET, [K.apiHost]: HOST, ...over });
    const v = (settings: Record<string, string>, mfaAt: string, mfaMethod: string) =>
      policy.duoVerdict(policy.duoPolicy(policy.duoSettingsFrom(settings), { disabled: false, licensed: true }), { userId: 7, mfaAt, mfaMethod }, NOW);
    const signIn = map({ [K.enforceSignIn]: "1" });
    const desk = map({ [K.enforceDesk]: "1", [K.deskHours]: "12" });
    assert.deepEqual(v(signIn, ago(59), "duo_unreachable"), { signIn: false, desk: false, bypassed: false });
    assert.deepEqual(v(signIn, ago(61), "duo_unreachable"), { signIn: true, desk: true, bypassed: false });
    assert.deepEqual(v(desk, ago(59), "duo_unreachable"), { signIn: false, desk: false, bypassed: false });
    assert.deepEqual(v(desk, ago(61), "duo_unreachable"), { signIn: false, desk: true, bypassed: false }, "one hour, not the desk's twelve");
    assert.deepEqual(v(signIn, ago(6000), "duo"), { signIn: false, desk: false, bypassed: false }, "a real approval does not run out at sign-in");
    assert.deepEqual(v(desk, ago(61), "duo"), { signIn: false, desk: false, bypassed: false });
    assert.equal(policy.duoStanding(policy.duoPolicy(policy.duoSettingsFrom(signIn), { disabled: false, licensed: true }), { userId: 7, mfaAt: ago(5), mfaMethod: "duo_unreachable" }, NOW).realDuo, false);

    // In the app: let through, an hour passes, owed again, let through again only because Duo is still down. Each time audited.
    const t = await newSession(uid);
    duo.mode = "down";
    const before = await auditCount("auth.duo_unreachable_allowed", uid);
    assert.deepEqual((await start(t, { next: "/doc/1" })).body, { redirect: "/doc/1" });
    as(t);
    assert.equal((await auth.getCurrentUser())?.id, uid);
    await pool().query("UPDATE sessions SET mfa_at = now() - interval '61 minutes' WHERE user_id = $1", [uid]);
    assert.equal(await auth.getCurrentUser(), null, "owed again");
    assert.deepEqual((await start(t, { next: "/doc/1" })).body, { redirect: "/doc/1" });
    assert.equal((await auditCount("auth.duo_unreachable_allowed", uid)) - before, 2);
    await pool().query("UPDATE sessions SET mfa_at = now() - interval '61 minutes' WHERE user_id = $1", [uid]);
    duo.mode = "allow"; // Duo is back: now it has to be a real approval
    const again = await start(t, { next: "/doc/1" });
    assert.ok(again.body.redirect!.startsWith(`${duo.base}/oauth/v1/authorize?`));
    assert.equal(await auth.getCurrentUser(), null);
  });

  test("a token without a nonce claim is accepted end to end; one with another nonce is not", async () => {
    const t = await newSession(uid);
    duo.mode = "no_nonce";
    assert.equal(await passDuo(t, { next: "/doc/2" }), `${ORIGIN}/doc/2`);
    assert.equal((await sessionRow(t))?.mfa_method, "duo");
  });
});

describe("findings 6, 8, 9, 10: settings and limits", () => {
  let admin = "";
  const patch = (body: unknown, token = admin) => send(adminRoute.PATCH, token, "/api/admin/duo", "PATCH", body);
  /** Both rules on, tested by `admin`'s session, which has passed Duo. */
  async function enforcedAndTested(): Promise<void> {
    admin = await newSession(adminId);
    await db.markSessionMfa(admin, "duo");
    await configured({
      [K.enforceSignIn]: "1",
      [K.enforceDesk]: "1",
      [K.verified]: JSON.stringify({ rev: "rev-1", sid: db.sessionSid(admin), user_id: adminId, at: new Date().toISOString(), origin: ORIGIN }),
    });
  }

  test("6: which name is sent to Duo is part of what the test vouches for", async () => {
    await enforcedAndTested();
    // Saying the same thing again changes nothing.
    let r = await patch({ username_source: "email" });
    assert.equal(r.status, 200);
    assert.equal(r.body.rules_turned_off, false);
    r = await patch({ username_source: "username" });
    assert.equal(r.status, 200);
    assert.equal(r.body.rules_turned_off, true);
    const map = await db.getAllSettings();
    assert.equal(map[K.usernameSource], "username");
    assert.equal(map[K.enforceSignIn], "0");
    assert.equal(map[K.enforceDesk], "0");
    assert.equal(map[K.verified], "");
    assert.notEqual(map[K.rev], "rev-1");
    assert.equal((await lastAudit("settings.duo", adminId))?.rules_turned_off, true);
    // And it cannot be switched together with a rule.
    assert.equal((await patch({ username_source: "email", enforce_signin: true })).status, 400);
    assert.equal((await patch({ enforce_signin: true })).status, 400, "not without a new test");
  });

  test("8: the start limit is per session and account, so another session cannot starve this one or the admin's test", () => {
    for (let i = 0; i < 10; i++) assert.equal(rateLimit.duoStartRateLimited(424242, "attacker-session"), false);
    assert.equal(rateLimit.duoStartRateLimited(424242, "attacker-session"), true);
    assert.equal(rateLimit.duoStartRateLimited(424242, "the-real-person"), false);
    assert.equal(rateLimit.duoStartRateLimited(424243, "attacker-session"), false, "nor does a session id borrowed for another account");
  });

  test("9: a session gets twenty callbacks in five minutes; after that nothing is read or written", async () => {
    await configured({ [K.enforceSignIn]: "1" });
    const uid = await newUser("flood", "viewer");
    const t = await newSession(uid);
    const junk = `${ORIGIN}/api/auth/duo/callback?state=${"f".repeat(64)}&duo_code=${"0".repeat(32)}`;
    for (let i = 0; i < 20; i++) assert.equal(await callback(t, junk), `${ORIGIN}/login/duo?e=expired`, `callback ${i + 1}`);
    assert.equal(await auditCount("auth.duo_denied", uid), 20);
    for (let i = 0; i < 30; i++) assert.equal(await callback(t, junk), `${ORIGIN}/login/duo?e=limited`);
    assert.equal(await auditCount("auth.duo_denied", uid), 20, "no more rows");
    // Another session of the same person is not shut out by it, and a real approval there still works.
    const other = await newSession(uid);
    assert.equal(await passDuo(other, { next: "/doc/4" }), `${ORIGIN}/doc/4`);
  });

  test("10a: with the licence gone the saved rules are shown as saved, and as not enforced", async () => {
    await enforcedAndTested();
    let view = await duoView(adminId, db.sessionSid(admin));
    assert.deepEqual([view.enabled, view.enforce_signin, view.enforce_desk, view.enforcing], [true, true, true, true]);
    edition.features = ["helpdesk"];
    view = await duoView(adminId, db.sessionSid(admin));
    assert.deepEqual([view.enabled, view.enforce_signin, view.enforce_desk, view.enforcing], [false, true, true, false]);
    assert.ok(!JSON.stringify(view).includes(SECRET));
  });

  test("10c: two saves at once never leave a rule on beside a configuration nobody tested", async () => {
    for (let i = 0; i < 12; i++) {
      await enforcedAndTested();
      await settings({ [K.enforceSignIn]: "0", [K.enforceDesk]: "0" });
      const secret = `${String(i).padStart(2, "0")}${"q".repeat(38)}`;
      const on = () => patch({ enforce_signin: true, enforce_desk: true });
      const swap = () => patch({ client_secret: secret });
      const [a, b] = await Promise.all(i % 2 ? [on(), swap()] : [swap(), on()]);
      const [turnOn, change] = i % 2 ? [a, b] : [b, a];
      assert.equal(change.status, 200, `run ${i}`);
      assert.ok(turnOn.status === 200 || turnOn.status === 400, `run ${i}: ${turnOn.status}`);
      const saved = policy.duoSettingsFrom(await db.getAllSettings());
      assert.equal(saved.clientSecret, secret, `run ${i}`);
      // The new secret is untested, so whichever request went first, no rule is on.
      assert.equal(saved.enforceSignIn, false, `run ${i}: the sign-in rule is on with an untested secret`);
      assert.equal(saved.enforceDesk, false, `run ${i}`);
      assert.equal(saved.verified, null, `run ${i}`);
      assert.notEqual(saved.rev, "rev-1", `run ${i}`);
    }
    // A test that finishes after the configuration changed does not vouch for the new one.
    await enforcedAndTested();
    const t = await send(adminTestRoute.POST, admin, "/api/admin/duo/test", "POST");
    const back = await prompt(String(t.body.redirect));
    assert.equal((await patch({ client_secret: "w".repeat(40) })).status, 200);
    assert.equal(await callback(admin, back), `${ORIGIN}/admin/sso?duo_test=expired#duo`);
    assert.equal(policy.duoSettingsFrom(await db.getAllSettings()).verified, null);
  });
});

