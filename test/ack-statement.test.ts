// The confirmation statement and the typed signature on the record (C2,
// 1.12.0). The row stores the statement the server served, never the
// client's; a policy that requires a signature answers 409 until the typed
// name matches and a local account's password checks out, then stores the
// name and how the signer was identified; the password reaches neither the
// row nor the audit entry; and the per-policy settings route validates
// what it is sent, answers what the document now holds and writes one
// ack.settings_changed row per real change. Wave 2 (G1 + G3 UI) added the
// re-confirmation fields and the replacement to the same route: the G1/G3
// test covers their validation, the next date scheduled from the marker,
// the replacement's rules and the audit details. 1.13.0 (settings-ui) added
// the audience (D1), the deadline rule with "Also move existing deadlines"
// (E1) and the reminder cadence with the owner (E2): the last test covers
// their validation, the preview, the rows a save opens and closes, the
// moves and the per-key audit rows.
//
// The route handlers are called directly, the way test/ack-tokens.test.ts
// does it: next/headers resolves to a stub that serves the request under
// test (its session cookie), and lib/ee resolves to a stub that grants
// policy_ack, because the community `@ee` stub advertises no features and
// the licence check would otherwise answer 402 before anything here runs.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-statement.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  listVersions,
  recordAcknowledgement,
  getCurrentAck,
  ackStatusForDocument,
  getAckSettings,
  updateAckSettings,
  getAckRecert,
  getPolicySettings,
  hasOpenAssignment,
  assignmentDueDates,
  createSession,
} from "../src/lib/db";
import { addMonths } from "../src/lib/ack-recert";
import { readComplianceSettings } from "../src/lib/compliance-settings";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-statement.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-statement.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;

  // lib/ee as a licensed enterprise build sees it: policy_ack is on.
  const edition = { present: true, features: ["policy_ack"] };
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
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, req: Request, id: number): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve({ id: String(id) }) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

const CLIENT_IP = "203.0.113.21";
/** A second address for the lockout: the throttle is per username+IP, so the rest of the file never meets the lock. */
const LOCKOUT_IP = "203.0.113.22";
const USER_AGENT = `AckStatementTest/1.0 (${"x".repeat(320)})`;

function sessionRequest(url: string, session: string, body?: unknown, method = "POST", ip = CLIENT_IP): Request {
  return new Request(url, {
    method,
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
      "user-agent": USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Everything the console printed while `run` ran, so a test can assert the
 * password reached no log line (invariant 1 covers logs, not only rows).
 */
async function withConsoleSpy<T>(run: () => Promise<T>): Promise<{ result: T; seen: string[] }> {
  const seen: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => {
      seen.push(a.map(String).join(" "));
      orig[k](...a);
    };
  }
  try {
    return { result: await run(), seen };
  } finally {
    Object.assign(console, orig);
  }
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `ackstmt-${Date.now()}`;
const PASSWORD = "Attest!Me12345";
let spaceId = 0;
let adminId = 0;
let viewerId = 0;
let adminSession = "";
let viewerSession = "";
const docIds: number[] = [];

/** The settings row is read for the default statement; the lock keeps the settings suites from flipping it mid-test. */
const SETTINGS_LOCK = 728342;
let lockClient: PoolClient | null = null;

async function newPolicy(title: string): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: `${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  // Both null: leave the columns alone rather than reading the workspace
  // settings row, which another test file may be writing.
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  return { id: doc.id, v1: (await listVersions(doc.id))[0].id };
}

async function row(docId: number, userId: number) {
  const r = await pool().query(
    `SELECT statement_text, signed_name, identity_proof, user_agent, ip FROM acknowledgements
     WHERE document_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`,
    [docId, userId]
  );
  return r.rows[0];
}

async function auditRows(action: string, docId: number) {
  const r = await pool().query<{ details: Record<string, unknown>; ip: string | null }>(
    "SELECT details, ip FROM audit_log WHERE action = $1 AND actor_id = $2 AND target_id = $3 ORDER BY id",
    [action, adminId, String(docId)]
  );
  return r.rows;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
  lockClient = client;

  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Statement ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const creds = hashPassword(PASSWORD);
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES
       ($1, 'Stmt Admin', $2, 'admin', 'active', $5, $6),
       ($3, 'Stmt Viewer', $4, 'viewer', 'active', $5, $6)
     RETURNING id`,
    [`${STAMP}-admin`, `${STAMP}-admin@example.test`, `${STAMP}-viewer`, `${STAMP}-viewer@example.test`, creds.hash, creds.salt]
  );
  adminId = users.rows[0].id;
  viewerId = users.rows[1].id;
  adminSession = newToken();
  viewerSession = newToken();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await createSession(adminSession, adminId, expires);
  await createSession(viewerSession, viewerId, expires);
});

after(async () => {
  const userIds = [adminId, viewerId];
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM doc_views WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1) OR space_id = $2", [docIds, spaceId]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

// --- The row ----------------------------------------------------------------------

describe("the row stores what the server served", () => {
  test("statement_text is the statement the server serves (the workspace default, or the policy's own), never the client's; user_agent is bounded; an unsigned row is unsigned", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const defaultStatement = (await readComplianceSettings()).compliance_statement_default;

    const plain = await newPolicy(`${STAMP} default statement`);
    const confirmed = await call(
      ack.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${plain.id}/ack`, adminSession, {
        version_id: plain.v1,
        reached_end: true,
        statement: "I promise nothing at all.",
        signed_name: "Somebody Else",
      }),
      plain.id
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.signed_name, null, "no signature was asked for, none is recorded");
    let stored = await row(plain.id, adminId);
    assert.equal(stored.statement_text, defaultStatement, "the workspace default, as served");
    assert.equal(stored.signed_name, null);
    assert.equal(stored.identity_proof, "");
    assert.equal(stored.user_agent, USER_AGENT.slice(0, 300), "the header, cut at 300 characters");
    assert.equal(stored.ip, CLIENT_IP);

    const custom = "I have read this policy and will comply with it.";
    const own = await newPolicy(`${STAMP} own statement`);
    assert.deepEqual(await updateAckSettings(own.id, { statement: custom }), { statement: custom, signature: false });
    const confirmedOwn = await call(
      ack.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${own.id}/ack`, adminSession, { version_id: own.v1 }),
      own.id
    );
    assert.equal(confirmedOwn.status, 200);
    stored = await row(own.id, adminId);
    assert.equal(stored.statement_text, custom, "the policy's own statement");

    // The roster carries all three, null while pending.
    const roster = await ackStatusForDocument(own.id);
    const mine = roster.find((r) => r.id === adminId);
    assert.deepEqual([mine?.statement_text, mine?.signed_name, mine?.identity_proof], [custom, null, ""]);
    const pending = roster.find((r) => r.id === viewerId);
    assert.deepEqual([pending?.statement_text, pending?.signed_name, pending?.identity_proof], [null, null, null]);
  });

  test("a 1.11.x-shaped recordAcknowledgement call takes the column defaults: '' statement, no name, '' proof, '' agent", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} legacy shape`);
    assert.deepEqual(await recordAcknowledgement(id, viewerId, "10.0.0.9", v1), { recorded: true, stale: false });
    const stored = await row(id, viewerId);
    assert.deepEqual(stored, { statement_text: "", signed_name: null, identity_proof: "", user_agent: "", ip: "10.0.0.9" });
    assert.equal((await getCurrentAck(id, viewerId))?.signed_name, null);
  });
});

// --- The signature -----------------------------------------------------------------

describe("a policy that requires a typed signature", () => {
  test("409 without a matching name, 409 with a wrong password (audited as a failed sign-in), then a signed row with identity_proof 'password'; the password reaches neither the row, the audit entry nor a log line", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const { id, v1 } = await newPolicy(`${STAMP} signature`);
    assert.deepEqual(await updateAckSettings(id, { signature: true }), { statement: null, signature: true });
    const url = `http://localhost/api/documents/${id}/ack`;

    const { result: signed, seen } = await withConsoleSpy(async () => {
      const unsigned = await call(ack.POST as Handler, sessionRequest(url, adminSession, { version_id: v1 }), id);
      assert.equal(unsigned.status, 409);
      assert.equal(unsigned.body.error, "Type your full name exactly as it appears on your account (Stmt Admin).");
      assert.equal(unsigned.body.stale, undefined, "not the stale shape: the page must not reload");

      const wrongName = await call(
        ack.POST as Handler,
        sessionRequest(url, adminSession, { version_id: v1, signed_name: "Somebody Else", password: PASSWORD }),
        id
      );
      assert.equal(wrongName.status, 409);
      assert.match(wrongName.body.error, /^Type your full name/);
      assert.equal((await auditRows("auth.login_failed", id)).length, 0, "a wrong name is not a password guess");

      const wrongPassword = await call(
        ack.POST as Handler,
        sessionRequest(url, adminSession, { version_id: v1, signed_name: "stmt admin", password: "not-it" }),
        id
      );
      assert.equal(wrongPassword.status, 409);
      assert.equal(wrongPassword.body.error, "Password check failed. Re-enter your account password to sign.");
      assert.equal(await row(id, adminId), undefined, "nothing was recorded by the refusals");
      // The miss is on the record as the sign-in form records one, against
      // the policy, with the address; the lock did not engage on one miss.
      const failed = await auditRows("auth.login_failed", id);
      assert.equal(failed.length, 1, "one auth.login_failed row for the one wrong password");
      assert.deepEqual(failed[0].details, { via: "attestation" });
      assert.equal(failed[0].ip, CLIENT_IP);
      assert.equal((await auditRows("auth.lockout", id)).length, 0);

      return call(
        ack.POST as Handler,
        sessionRequest(url, adminSession, { version_id: v1, reached_end: true, signed_name: "  Stmt Admin ", password: PASSWORD }),
        id
      );
    });
    assert.ok(
      !seen.some((s) => s.includes(PASSWORD) || s.includes("not-it")),
      `the password never reaches a log line:\n${seen.join("\n")}`
    );
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.signed_name, "Stmt Admin", "the name as typed, trimmed");
    const stored = await row(id, adminId);
    assert.equal(stored.signed_name, "Stmt Admin");
    assert.equal(stored.identity_proof, "password");
    assert.doesNotMatch(JSON.stringify(stored), /Attest!Me/, "the password is never stored");
    assert.equal((await getCurrentAck(id, adminId))?.signed_name, "Stmt Admin");
    const mine = (await ackStatusForDocument(id)).find((r) => r.id === adminId);
    assert.deepEqual([mine?.signed_name, mine?.identity_proof], ["Stmt Admin", "password"]);

    const audits = await auditRows("document.acknowledge", id);
    assert.equal(audits.length, 1, "one audit row for the one recorded confirmation");
    assert.equal(audits[0].details.signed_name, "Stmt Admin");
    assert.equal(audits[0].details.identity_proof, "password");
    assert.equal(audits[0].details.user_agent, USER_AGENT.slice(0, 300));
    assert.doesNotMatch(JSON.stringify(audits[0].details), /Attest!Me|not-it/, "the password never reaches the audit row");

    // The lockout, on an address of its own: the fifth wrong password locks
    // the username+address pair and writes auth.lockout beside the fifth
    // auth.login_failed; the right password is then 429 and records
    // nothing more. No row anywhere carries a password.
    const guess = (password: string) =>
      call(
        ack.POST as Handler,
        sessionRequest(url, adminSession, { version_id: v1, signed_name: "Stmt Admin", password }, "POST", LOCKOUT_IP),
        id
      );
    for (let i = 0; i < 5; i++) {
      const r = await guess(`wrong-${i}`);
      assert.equal(r.status, 409, `guess ${i + 1} is a plain refusal`);
      assert.equal((await auditRows("auth.lockout", id)).length, i === 4 ? 1 : 0, `guess ${i + 1}: the lock engages on the fifth`);
    }
    const lockedOut = await guess(PASSWORD);
    assert.equal(lockedOut.status, 429);
    assert.match(lockedOut.body.error, /^Too many failed attempts/);
    const failures = await auditRows("auth.login_failed", id);
    assert.equal(failures.length, 6, "the first miss and the five guesses; the refusal under the lock is not a miss");
    assert.ok(failures.every((r) => r.details.via === "attestation"));
    assert.equal(failures[5].ip, LOCKOUT_IP);
    const lockouts = await auditRows("auth.lockout", id);
    assert.deepEqual([lockouts[0].details, lockouts[0].ip], [{ minutes: 15 }, LOCKOUT_IP]);
    assert.doesNotMatch(JSON.stringify([...failures, ...lockouts]), /Attest!Me|not-it|wrong-/, "no password in the auth rows");
    assert.equal((await auditRows("document.acknowledge", id)).length, 1, "the confirmation was recorded once");
  });
});

// --- The settings route ------------------------------------------------------------

describe("GET and PATCH /api/documents/[id]/ack-settings", () => {
  test("GET answers the policy's values and the workspace default; PATCH validates, answers what the document now holds and audits one row per change", async () => {
    const route = await import("../src/app/api/documents/[id]/ack-settings/route");
    const { id } = await newPolicy(`${STAMP} settings`);
    const url = `http://localhost/api/documents/${id}/ack-settings`;
    const defaultStatement = (await readComplianceSettings()).compliance_statement_default;

    const initial = await call(route.GET as Handler, sessionRequest(url, adminSession, undefined, "GET"), id);
    assert.equal(initial.status, 200);
    const {
      marker,
      recert_default,
      effective_at,
      // 1.13.0's keys are covered by the last test; here only their presence.
      audience_mode,
      rules,
      exclude_stewards,
      assign_new_members,
      due_days,
      due_at,
      remind_before_days,
      remind_every_days,
      escalate_after_days,
      nudge_every_days,
      owner_user_id,
      owner_name,
      requested_by,
      defaults,
      inherited,
      ...rest
    } = initial.body;
    assert.deepEqual(rest, {
      statement: null,
      statement_default: defaultStatement,
      signature: false,
      recert_months: null,
      next_recert_at: null,
      superseded_by: null,
      superseded_by_title: null,
    });
    assert.deepEqual(
      [audience_mode, rules, exclude_stewards, assign_new_members, due_days, due_at],
      ["space", [], false, true, null, null],
      "a fresh policy: space mode, no rule"
    );
    assert.deepEqual(
      [remind_before_days, remind_every_days, escalate_after_days, nudge_every_days, owner_user_id, owner_name, requested_by],
      [null, null, null, null, null, null, null]
    );
    assert.equal(defaults.space.id, spaceId);
    assert.equal(typeof inherited.values.due_days, "number");
    assert.match(String(effective_at), /^\d{4}-\d{2}-\d{2}$/, "the switch-on dated the policy (G1)");
    assert.ok(!Number.isNaN(new Date(marker).getTime()), "the marker travels for the first-cycle date");
    assert.ok([null, 6, 12, 24].includes(recert_default), `the workspace default is one of the options: ${recert_default}`);

    const refused = async (body: unknown, fragment: RegExp) => {
      const r = await call(route.PATCH as Handler, sessionRequest(url, adminSession, body, "PATCH"), id);
      assert.equal(r.status, 400, `${JSON.stringify(body)} is refused`);
      assert.match(r.body.error, fragment, `${JSON.stringify(body)}: ${r.body.error}`);
    };
    await refused({ signature: "yes" }, /'signature' must be true or false\./);
    await refused({ statement: 42 }, /'statement' must be text\./);
    await refused({ statement: "x".repeat(501) }, /Keep the statement under 500 characters\./);
    await refused({ statement: "ok", frobnicate: 12 }, /Unknown setting "frobnicate"\./);
    await refused(
      {},
      /^Send one of: statement, signature, recert_months, next_recert_at, effective_at, superseded_by, audience_mode, rules, exclude_stewards, assign_new_members, due_days, due_at, move_existing, remind_before_days, remind_every_days, escalate_after_days, nudge_every_days, owner_user_id\.$/
    );
    await refused([], /Invalid request\./);
    assert.deepEqual(await getAckSettings(id), { statement: null, signature: false }, "a refused body changes nothing");
    assert.equal((await auditRows("ack.settings_changed", id)).length, 0);

    const custom = "I have read this policy and will comply with it.";
    const set = await call(
      route.PATCH as Handler,
      sessionRequest(url, adminSession, { statement: `  ${custom}  `, signature: true }, "PATCH"),
      id
    );
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.ok, true);
    assert.deepEqual(
      [set.body.statement, set.body.statement_default, set.body.signature],
      [custom, defaultStatement, true],
      "the answer is what the document now holds"
    );
    assert.deepEqual(await getAckSettings(id), { statement: custom, signature: true });
    let audits = await auditRows("ack.settings_changed", id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].details.statement_changed, true);
    assert.equal(audits[0].details.signature, true);
    assert.equal(audits[0].ip, CLIENT_IP);

    // The same values again: no change, no row. A subset touches only what it names.
    const again = await call(route.PATCH as Handler, sessionRequest(url, adminSession, { statement: custom, signature: true }, "PATCH"), id);
    assert.equal(again.status, 200);
    assert.equal((await auditRows("ack.settings_changed", id)).length, 1, "a no-op PATCH writes no audit row");
    const onlySignature = await call(route.PATCH as Handler, sessionRequest(url, adminSession, { signature: false }, "PATCH"), id);
    assert.equal(onlySignature.body.statement, custom, "the statement stayed");
    assert.equal(onlySignature.body.signature, false);
    audits = await auditRows("ack.settings_changed", id);
    assert.equal(audits.length, 2);
    assert.deepEqual([audits[1].details.statement_changed, audits[1].details.signature], [false, false]);

    // A blank statement clears the override: the card is back on the default.
    const cleared = await call(route.PATCH as Handler, sessionRequest(url, adminSession, { statement: "   " }, "PATCH"), id);
    assert.equal(cleared.body.statement, null);
    const nulled = await call(route.PATCH as Handler, sessionRequest(url, adminSession, { statement: null }, "PATCH"), id);
    assert.equal(nulled.status, 200, "null is an explicit clear");
    assert.equal((await auditRows("ack.settings_changed", id)).length, 3, "the clear was one change; null on null was none");

    // A viewer holds neither document.ack_require nor compliance.program_manage.
    const viewer = await call(route.GET as Handler, sessionRequest(url, viewerSession, undefined, "GET"), id);
    assert.equal(viewer.status, 403);
    const viewerPatch = await call(route.PATCH as Handler, sessionRequest(url, viewerSession, { signature: true }, "PATCH"), id);
    assert.equal(viewerPatch.status, 403);
    assert.equal((await getAckSettings(id))?.signature, false);
    const anonymous = await call(route.GET as Handler, new Request(url), id);
    assert.equal(anonymous.status, 401);
  });

  test("the re-confirmation fields (G1) and the replacement (G3): validated per field, the next date scheduled from the marker, the replacement checked, each change audited once", async () => {
    const route = await import("../src/app/api/documents/[id]/ack-settings/route");
    const { id } = await newPolicy(`${STAMP} recert and lifecycle`);
    const other = await newPolicy(`${STAMP} the replacement`);
    const url = `http://localhost/api/documents/${id}/ack-settings`;
    const patch = (body: unknown) => call(route.PATCH as Handler, sessionRequest(url, adminSession, body, "PATCH"), id);
    const refused = async (body: unknown, fragment: RegExp) => {
      const r = await patch(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} is refused`);
      assert.match(r.body.error, fragment, `${JSON.stringify(body)}: ${r.body.error}`);
    };
    const audits = async () => auditRows("ack.settings_changed", id);

    // The interval: any whole number of months from 1 to 60 through the
    // API (the Select offers four); the first cycle is dated from the
    // marker, and a value out of range or a past date is refused.
    await refused({ recert_months: 0 }, /^Re-confirm every 1 to 60 months, or never\.$/);
    await refused({ recert_months: 61 }, /^Re-confirm every 1 to 60 months, or never\.$/);
    await refused({ recert_months: "12" }, /^Re-confirm every 1 to 60 months, or never\.$/);
    await refused({ next_recert_at: "2020-01-01" }, /^The next re-confirmation date cannot be in the past\.$/);
    await refused({ next_recert_at: "not a date" }, /^Enter the next re-confirmation as a date\.$/);
    await refused({ effective_at: "2026-02-31" }, /^Enter the effective date as a date\.$/);
    assert.equal((await audits()).length, 0, "nothing refused is on the record");

    const marker = new Date((await getAckRecert(id))!.ack_revision_at);
    const seven = await patch({ recert_months: 7 });
    assert.equal(seven.status, 200, JSON.stringify(seven.body));
    assert.equal(seven.body.recert_months, 7);
    assert.equal(
      new Date(seven.body.next_recert_at).getTime(),
      addMonths(marker, 7).getTime(),
      "the first cycle is the marker plus the interval"
    );
    assert.equal((await audits()).length, 1);
    let row = (await audits())[0];
    assert.equal(row.details.recert_months, 7);
    assert.equal(typeof row.details.next_recert_at, "string");
    assert.equal(row.details.statement_changed, undefined, "the statement was not in the patch");

    // The same interval again: nothing moved, no row. A later date is kept
    // as sent; the effective date is independent of the cycle.
    assert.equal((await patch({ recert_months: 7 })).status, 200);
    assert.equal((await audits()).length, 1, "a no-op PATCH writes no audit row");
    const later = new Date(Date.UTC(marker.getUTCFullYear() + 2, 0, 15));
    const moved = await patch({ next_recert_at: later.toISOString().slice(0, 10), effective_at: "2026-01-01" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(new Date(moved.body.next_recert_at).getTime(), later.getTime(), "a date-only input is midnight UTC");
    assert.equal(moved.body.effective_at, "2026-01-01");
    assert.equal(moved.body.recert_months, 7, "the interval stayed");
    assert.equal((await audits()).length, 2);
    row = (await audits())[1];
    assert.equal(row.details.effective_at, "2026-01-01");

    // Never clears the next date, leaves the effective date.
    const never = await patch({ recert_months: null });
    assert.equal(never.status, 200);
    assert.deepEqual([never.body.recert_months, never.body.next_recert_at, never.body.effective_at], [null, null, "2026-01-01"]);
    assert.deepEqual(
      [(await getAckRecert(id))!.ack_recert_months, (await getAckRecert(id))!.ack_next_recert_at],
      [null, null]
    );
    assert.equal((await audits()).length, 3);

    // A next date needs an interval to fire on: with none stored and none
    // in the body it is refused by name, not stored silently; the interval
    // in the same body counts.
    const laterYmd = later.toISOString().slice(0, 10);
    await refused({ next_recert_at: laterYmd }, /^Set an interval before a next re-confirmation date\.$/);
    await refused({ recert_months: null, next_recert_at: laterYmd }, /^Set an interval before a next re-confirmation date\.$/);
    assert.equal((await audits()).length, 3, "a refused date is not on the record");
    const withInterval = await patch({ recert_months: 6, next_recert_at: laterYmd });
    assert.equal(withInterval.status, 200, JSON.stringify(withInterval.body));
    assert.deepEqual([withInterval.body.recert_months, new Date(withInterval.body.next_recert_at).getTime()], [6, later.getTime()]);
    assert.equal((await audits()).length, 4);
    assert.equal((await patch({ recert_months: null })).status, 200);
    assert.equal((await audits()).length, 5);

    // The replacement: a published document the caller can see, never the
    // policy itself; the audit row carries the move; null clears it.
    await refused({ superseded_by: 0 }, /^'superseded_by' must be a document id or null\.$/);
    await refused({ superseded_by: "x" }, /^'superseded_by' must be a document id or null\.$/);
    await refused({ superseded_by: id }, /^A policy cannot be replaced by itself\.$/);
    await refused({ superseded_by: 2_000_000_000 }, /^The replacement must be a published document you can see\.$/);
    assert.equal((await audits()).length, 5, "a refused replacement is not on the record");
    // Beside other fields, the replacement is judged first: a refusal
    // leaves the statement, the signature and the interval untouched too,
    // and nothing is on the record.
    await refused(
      { statement: "Changed anyway?", signature: true, recert_months: 9, superseded_by: 2_000_000_000 },
      /^The replacement must be a published document you can see\.$/
    );
    assert.deepEqual(await getAckSettings(id), { statement: null, signature: false }, "the statement and signature did not move");
    assert.equal((await getAckRecert(id))!.ack_recert_months, null, "nor the interval");
    assert.equal((await audits()).length, 5, "and nothing is on the record");
    const replaced = await patch({ superseded_by: other.id });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.superseded_by, other.id);
    assert.equal(replaced.body.superseded_by_title, `${STAMP} the replacement`);
    assert.equal((await audits()).length, 6);
    row = (await audits())[5];
    assert.deepEqual(
      [row.details.superseded_by_changed, row.details.superseded_by_from, row.details.superseded_by_to],
      [true, null, other.id]
    );
    assert.equal((await patch({ superseded_by: other.id })).status, 200);
    assert.equal((await audits()).length, 6, "the same replacement again: no row");
    const cleared = await patch({ superseded_by: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.superseded_by, cleared.body.superseded_by_title], [null, null]);
    assert.equal((await audits()).length, 7);

    // One PATCH may carry every card's fields; the GET answers them all.
    const all = await patch({ statement: "Read and understood.", recert_months: 12, superseded_by: other.id });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const got = await call(route.GET as Handler, sessionRequest(url, adminSession, undefined, "GET"), id);
    assert.deepEqual(
      [got.body.statement, got.body.recert_months, got.body.superseded_by, got.body.superseded_by_title],
      ["Read and understood.", 12, other.id, `${STAMP} the replacement`]
    );
    assert.equal(new Date(got.body.next_recert_at).getTime(), addMonths(marker, 12).getTime());
    assert.equal((await audits()).length, 8, "one row for the one PATCH, however many fields it moved");
  });

  test("1.13.0: the audience (D1), the deadline (E1) and the reminders (E2) ride on the same route: validated per field, the audience previewed and saved with its rows, a fixed date moving every open deadline, the cadence audited per key", async () => {
    const route = await import("../src/app/api/documents/[id]/ack-settings/route");
    const { id } = await newPolicy(`${STAMP} audience deadline reminders`);
    const url = `http://localhost/api/documents/${id}/ack-settings`;
    const get = (qs = "") => call(route.GET as Handler, sessionRequest(`${url}${qs}`, adminSession, undefined, "GET"), id);
    const patch = (body: unknown) => call(route.PATCH as Handler, sessionRequest(url, adminSession, body, "PATCH"), id);
    const refused = async (body: unknown, fragment: RegExp) => {
      const r = await patch(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} is refused`);
      assert.match(r.body.error, fragment, `${JSON.stringify(body)}: ${r.body.error}`);
    };
    const dueRow = async (userId: number) => {
      const r = await pool().query<{ cycle_started_at: string; assigned_at: string; due_at: string | null }>(
        "SELECT cycle_started_at, assigned_at, due_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
        [id, userId]
      );
      return r.rows[0];
    };

    // GET: the cascade twice, with and without the policy's own layer; a
    // fresh policy has nothing of its own, so the two agree.
    const initial = await get();
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.defaults.values, initial.body.inherited.values);
    assert.ok(["built-in", "workspace"].includes(initial.body.inherited.origin.due_days), "no space or policy layer yet");

    // The preview: counted, never written. Space mode holds everyone active
    // who can see the internal space (this file's two people among the
    // accounts the other files insert); a user rule names one person.
    const everyone = await get("?preview=1");
    assert.equal(everyone.status, 200);
    assert.ok(everyone.body.count >= 2, `space mode counts this file's two people: ${everyone.body.count}`);
    assert.equal(everyone.body.no_access, 0);
    const one = await get(
      `?preview=1&audience_mode=targeted&rules=${encodeURIComponent(JSON.stringify([{ kind: "user", ref: viewerId }]))}`
    );
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.count, one.body.no_access, one.body.sample], [1, 0, ["Stmt Viewer"]]);
    assert.equal((await get("?preview=1&audience_mode=nope")).status, 400);
    assert.equal((await get("?preview=1&rules=%7B")).status, 400);
    assert.equal(await hasOpenAssignment(id, adminId), true, "the preview wrote nothing");
    assert.equal((await get()).body.audience_mode, "space");

    // The audience: refusals before any write; a targeted save closes the
    // rows the rules do not name; back to space mode re-opens them.
    await refused({ audience_mode: "both" }, /^'audience_mode' must be space or targeted\.$/);
    await refused({ rules: "x" }, /^'rules' must be a list of rules\.$/);
    await refused({ exclude_stewards: "yes" }, /^'exclude_stewards' must be true or false\.$/);
    await refused({ audience_mode: "targeted", rules: [] }, /^Name at least one group, person or role\.$/);
    await refused(
      { audience_mode: "targeted", rules: [{ kind: "user", ref: viewerId, effect: "exclude" }] },
      /^Name at least one group, person or role\.$/
    );
    assert.equal((await auditRows("ack.audience_set", id)).length, 0, "nothing refused is on the record");
    const targeted = await patch({ audience_mode: "targeted", rules: [{ kind: "user", ref: viewerId }], assign_new_members: false });
    assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
    assert.deepEqual(
      [targeted.body.audience_mode, targeted.body.rules, targeted.body.exclude_stewards, targeted.body.assign_new_members],
      ["targeted", [{ kind: "user", ref: String(viewerId), effect: "include" }], false, false]
    );
    assert.equal(targeted.body.added, 0);
    assert.ok(targeted.body.closed >= 1, `everyone the rule does not name is closed: ${targeted.body.closed}`);
    assert.equal(await hasOpenAssignment(id, viewerId), true);
    assert.equal(await hasOpenAssignment(id, adminId), false);
    let audienceAudits = await auditRows("ack.audience_set", id);
    assert.equal(audienceAudits.length, 1);
    assert.deepEqual(
      [audienceAudits[0].details.mode, audienceAudits[0].details.added, audienceAudits[0].details.closed],
      ["targeted", 0, targeted.body.closed]
    );
    const back = await patch({ audience_mode: "space" });
    assert.equal(back.status, 200);
    assert.ok(back.body.reopened >= 1, "back to space mode: the closed rows re-open");
    assert.equal(await hasOpenAssignment(id, adminId), true);
    audienceAudits = await auditRows("ack.audience_set", id);
    assert.equal(audienceAudits.length, 2);

    // The deadline: the numbers judged; a change to the days applies to
    // future assignments unless asked; a fixed date moves every open row
    // by itself; the same rule again moves nothing and writes nothing.
    await refused({ due_days: 0 }, /^'due_days' must be a whole number from 1 to 365, or null to inherit\.$/);
    await refused({ due_at: "2020-01-01" }, /^The deadline cannot be in the past\.$/);
    await refused({ due_at: "soon" }, /^'due_at' must be a date \(YYYY-MM-DD\), or null\.$/);
    await refused({ move_existing: "yes" }, /^'move_existing' must be true or false\.$/);
    const before = (await assignmentDueDates(id, [viewerId])).get(viewerId);
    assert.ok(before, "the switch-on dated the row");
    const thirty = await patch({ due_days: 30 });
    assert.equal(thirty.status, 200, JSON.stringify(thirty.body));
    assert.deepEqual([thirty.body.due_days, thirty.body.due_at, thirty.body.moved], [30, null, 0]);
    assert.deepEqual([thirty.body.defaults.origin.due_days, thirty.body.defaults.values.due_days], ["policy", 30]);
    assert.notEqual(thirty.body.inherited.origin.due_days, "policy", "the inherited resolution leaves the policy's layer out");
    assert.equal((await assignmentDueDates(id, [viewerId])).get(viewerId), before, "the days apply to future assignments");
    let dueAudits = await auditRows("ack.due_set", id);
    assert.equal(dueAudits.length, 1);
    assert.deepEqual(
      [dueAudits[0].details.due_days, dueAudits[0].details.due_at, dueAudits[0].details.moved_existing, dueAudits[0].details.moved],
      [30, null, false, 0]
    );
    assert.equal((await auditRows("ack.due_moved", id)).length, 0);
    const moved = await patch({ move_existing: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(moved.body.moved >= 1, `every open row moved: ${moved.body.moved}`);
    // The move anchors on the later of the row's cycle start and its
    // assignment: a row from the switch-on carries the policy's cycle (the
    // marker, a moment before the row was written), so the anchor is the
    // assignment; a re-asked row's fresh cycle is later than that.
    const movedRow = await dueRow(viewerId);
    assert.equal(
      new Date(movedRow.due_at!).getTime(),
      Math.max(new Date(movedRow.cycle_started_at).getTime(), new Date(movedRow.assigned_at).getTime()) + 30 * 86_400_000,
      "the later of the row's cycle start and its assignment, plus the days"
    );
    dueAudits = await auditRows("ack.due_set", id);
    assert.equal(dueAudits.length, 2);
    assert.deepEqual([dueAudits[1].details.moved_existing, dueAudits[1].details.moved], [true, moved.body.moved]);
    assert.equal((await auditRows("ack.due_moved", id)).length, 1, "the move itself is ack.due_moved");
    const day = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const fixed = await patch({ due_at: day, due_days: null });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.deepEqual([fixed.body.due_days, fixed.body.due_at], [null, day]);
    assert.ok(fixed.body.moved >= 1, "a fixed date moves every open deadline without being asked");
    const [y, m, d] = day.split("-").map(Number);
    const fixedRow = await dueRow(viewerId);
    assert.ok(
      Math.abs(new Date(fixedRow.due_at!).getTime() - Date.UTC(y, m - 1, d, 23, 59, 59, 999)) <= 14 * 3_600_000,
      `the row is due at the end of that day in the workspace's zone: ${fixedRow.due_at}`
    );
    assert.equal((await auditRows("ack.due_moved", id)).length, 2);
    assert.equal((await auditRows("ack.due_set", id)).length, 3);
    const same = await patch({ due_at: day });
    assert.deepEqual([same.status, same.body.moved], [200, 0], "the same date again moves nothing");
    assert.equal((await auditRows("ack.due_set", id)).length, 3, "and writes no row");

    // The cadence and the owner: per key, audited as ack.defaults_set at
    // the policy layer (as the space and the workspace layers are); the
    // inherited resolution keeps the number a blank field shows.
    await refused({ remind_every_days: 0 }, /^'remind_every_days' must be a whole number from 1 to 365, or null to inherit\.$/);
    await refused({ nudge_every_days: 366 }, /^'nudge_every_days' must be a whole number from 0 to 365, or null to inherit\.$/);
    await refused({ owner_user_id: "me" }, /^'owner_user_id' must be a user id, or null for nobody\.$/);
    await refused({ owner_user_id: 2_000_000_000 }, /^Owner not found\.$/);
    assert.equal((await auditRows("ack.defaults_set", id)).length, 0);
    const cadence = await patch({ remind_before_days: 5, nudge_every_days: 0, owner_user_id: viewerId });
    assert.equal(cadence.status, 200, JSON.stringify(cadence.body));
    assert.deepEqual(
      [
        cadence.body.remind_before_days,
        cadence.body.remind_every_days,
        cadence.body.nudge_every_days,
        cadence.body.owner_user_id,
        cadence.body.owner_name,
      ],
      [5, null, 0, viewerId, "Stmt Viewer"]
    );
    assert.deepEqual(
      [cadence.body.defaults.origin.remind_before_days, cadence.body.defaults.values.remind_before_days, cadence.body.defaults.origin.owner_user_id],
      ["policy", 5, "policy"]
    );
    assert.notEqual(cadence.body.inherited.origin.remind_before_days, "policy");
    assert.equal(cadence.body.defaults.origin.remind_every_days, cadence.body.inherited.origin.remind_every_days, "a blank key resolves the same both ways");
    const keyAudits = await auditRows("ack.defaults_set", id);
    assert.deepEqual(
      keyAudits.map((r) => [r.details.scope, r.details.space_id, r.details.key, r.details.from, r.details.to]),
      [
        ["policy", spaceId, "remind_before_days", null, 5],
        ["policy", spaceId, "nudge_every_days", null, 0],
        ["policy", spaceId, "owner_user_id", null, viewerId],
      ],
      "one row per key that moved"
    );
    assert.equal((await patch({ remind_before_days: 5, owner_user_id: viewerId })).status, 200);
    assert.equal((await auditRows("ack.defaults_set", id)).length, 3, "the same values again: no row");
    const cleared = await patch({ remind_before_days: null, owner_user_id: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual(
      [cleared.body.remind_before_days, cleared.body.owner_user_id, cleared.body.owner_name, cleared.body.defaults.origin.remind_before_days],
      [null, null, null, cleared.body.inherited.origin.remind_before_days]
    );
    assert.equal((await auditRows("ack.defaults_set", id)).length, 5);

    // The settings row holds what the route answered; the C2/G1/G3 audit
    // row was never written by any of this (no statement, signature,
    // interval or replacement moved).
    const stored = await getPolicySettings(id);
    assert.deepEqual([stored?.due_days, stored?.due_at, stored?.nudge_every_days, stored?.owner_user_id], [null, day, 0, null]);
    assert.equal((await auditRows("ack.settings_changed", id)).length, 0);
  });

  test("1.13.0: the deadline rule is written before the audience, so a row the same PATCH opens (rules + due_days in one call) takes the rule as that PATCH set it, and the move runs after both", async () => {
    const route = await import("../src/app/api/documents/[id]/ack-settings/route");
    const { id } = await newPolicy(`${STAMP} rule before audience`);
    const url = `http://localhost/api/documents/${id}/ack-settings`;
    const patch = (body: unknown) => call(route.PATCH as Handler, sessionRequest(url, adminSession, body, "PATCH"), id);
    const dueOf = async (userId: number) => {
      const r = await pool().query<{ due_at: string | null }>(
        "SELECT due_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [id, userId]
      );
      return r.rows[0]?.due_at ?? null;
    };
    const DAY = 86_400_000;
    const initial = await call(route.GET as Handler, sessionRequest(url, adminSession, undefined, "GET"), id);
    const joinerDays: number = initial.body.defaults.values.new_joiner_days;
    // A fixed date well apart from the joiner days, so the two instants can never coincide below.
    const day = new Date(Date.now() + (joinerDays + 20) * DAY).toISOString().slice(0, 10);
    const [y, m, d] = day.split("-").map(Number);
    const fixedEnd = Date.UTC(y, m - 1, d, 23, 59, 59, 999);

    // A fixed date (moves every open row to its end), then an audience that closes the admin's row.
    const fixed = await patch({ due_at: day });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.ok(fixed.body.moved >= 1);
    const narrowed = await patch({ audience_mode: "targeted", rules: [{ kind: "user", ref: viewerId }] });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.equal(await hasOpenAssignment(id, adminId), false);
    assert.equal(await dueOf(adminId), null);

    // One PATCH carries the rule back to days (the date cleared) and the
    // admin re-admitted. The rule is written first, so the row the save
    // re-opens is dated by the rule as it now stands (the days from the
    // cascade: a person added to an audience gets the new-joiner days,
    // counted from the re-open), never by the fixed date the same PATCH
    // removed, which is what the audience-first order gave; and nothing
    // asked for a move, so the viewer's open row keeps its date.
    const both = await patch({ rules: [{ kind: "user", ref: viewerId }, { kind: "user", ref: adminId }], due_at: null, due_days: 30 });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual([both.body.due_days, both.body.due_at, both.body.moved, both.body.added, both.body.reopened], [30, null, 0, 0, 1]);
    const adminDue = new Date((await dueOf(adminId))!).getTime();
    assert.ok(Math.abs(adminDue - fixedEnd) > 2 * DAY, `not the fixed date the PATCH removed: ${new Date(adminDue).toISOString()} vs ${day}`);
    assert.ok(
      Math.abs(adminDue - (Date.now() + joinerDays * DAY)) < 5 * 60_000,
      `the re-opened row is due the new-joiner days (${joinerDays}) from the re-open: ${new Date(adminDue).toISOString()}`
    );
    const viewerDue = new Date((await dueOf(viewerId))!).getTime();
    assert.ok(Math.abs(viewerDue - fixedEnd) <= 14 * 3_600_000, "an open row is not moved by a change to the days unless asked");
    const dueAudits = await auditRows("ack.due_set", id);
    const last = dueAudits[dueAudits.length - 1];
    assert.deepEqual(
      [last.details.due_days, last.details.due_at, last.details.moved_existing, last.details.moved],
      [30, null, false, 0],
      "the rule change is audited with no move"
    );
    assert.equal((await auditRows("ack.audience_set", id)).length, 2, "and the audience save is audited once more");

    // Asked to move as well, in the same call as an audience change: the move
    // runs after the save, so the row it opens is among the rows it dates.
    const moved = await patch({ rules: [{ kind: "user", ref: viewerId }], move_existing: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(await hasOpenAssignment(id, adminId), false);
    const again = await patch({ rules: [{ kind: "user", ref: viewerId }, { kind: "user", ref: adminId }], due_days: 45, move_existing: true });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.due_days, again.body.reopened], [45, 1]);
    assert.ok(again.body.moved >= 2, `both open rows moved, the re-opened one included: ${again.body.moved}`);
    const cycleOf = async (userId: number) =>
      (await pool().query<{ cycle_started_at: string; assigned_at: string }>("SELECT cycle_started_at, assigned_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [id, userId])).rows[0];
    const adminRow = await cycleOf(adminId);
    const anchor = Math.max(new Date(adminRow.cycle_started_at).getTime(), new Date(adminRow.assigned_at).getTime());
    assert.ok(
      Math.abs(new Date((await dueOf(adminId))!).getTime() - (anchor + 45 * DAY)) < 5 * 60_000,
      "the re-opened row is dated by the move from its own anchor plus the days the PATCH set"
    );
  });
});
