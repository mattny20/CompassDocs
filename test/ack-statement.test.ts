// The confirmation statement and the typed signature on the record (C2,
// 1.12.0). The row stores the statement the server served, never the
// client's; a policy that requires a signature answers 409 until the typed
// name matches and a local account's password checks out, then stores the
// name and how the signer was identified; the password reaches neither the
// row nor the audit entry; and the per-policy settings route validates
// what it is sent, answers what the document now holds and writes one
// ack.settings_changed row per real change. Wave 2 (G1 + G3 UI) added the
// re-confirmation fields and the replacement to the same route: the last
// test covers their validation, the next date scheduled from the marker,
// the replacement's rules and the audit details.
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
const USER_AGENT = `AckStatementTest/1.0 (${"x".repeat(320)})`;

function sessionRequest(url: string, session: string, body?: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "x-forwarded-for": CLIENT_IP,
      "user-agent": USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  test("409 without a matching name, 409 with a wrong password, then a signed row with identity_proof 'password'; the password reaches neither the row nor the audit entry", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const { id, v1 } = await newPolicy(`${STAMP} signature`);
    assert.deepEqual(await updateAckSettings(id, { signature: true }), { statement: null, signature: true });
    const url = `http://localhost/api/documents/${id}/ack`;

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

    const wrongPassword = await call(
      ack.POST as Handler,
      sessionRequest(url, adminSession, { version_id: v1, signed_name: "stmt admin", password: "not-it" }),
      id
    );
    assert.equal(wrongPassword.status, 409);
    assert.equal(wrongPassword.body.error, "Password check failed. Re-enter your account password to sign.");
    assert.equal(await row(id, adminId), undefined, "nothing was recorded by the refusals");

    const signed = await call(
      ack.POST as Handler,
      sessionRequest(url, adminSession, { version_id: v1, reached_end: true, signed_name: "  Stmt Admin ", password: PASSWORD }),
      id
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
    const { marker, recert_default, effective_at, ...rest } = initial.body;
    assert.deepEqual(rest, {
      statement: null,
      statement_default: defaultStatement,
      signature: false,
      recert_months: null,
      next_recert_at: null,
      superseded_by: null,
      superseded_by_title: null,
    });
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
    await refused({}, /^Send one of: statement, signature, recert_months, next_recert_at, effective_at, superseded_by\.$/);
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

    // The replacement: a published document the caller can see, never the
    // policy itself; the audit row carries the move; null clears it.
    await refused({ superseded_by: 0 }, /^'superseded_by' must be a document id or null\.$/);
    await refused({ superseded_by: "x" }, /^'superseded_by' must be a document id or null\.$/);
    await refused({ superseded_by: id }, /^A policy cannot be replaced by itself\.$/);
    await refused({ superseded_by: 2_000_000_000 }, /^The replacement must be a published document you can see\.$/);
    assert.equal((await audits()).length, 3, "a refused replacement is not on the record");
    const replaced = await patch({ superseded_by: other.id });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.superseded_by, other.id);
    assert.equal(replaced.body.superseded_by_title, `${STAMP} the replacement`);
    assert.equal((await audits()).length, 4);
    row = (await audits())[3];
    assert.deepEqual(
      [row.details.superseded_by_changed, row.details.superseded_by_from, row.details.superseded_by_to],
      [true, null, other.id]
    );
    assert.equal((await patch({ superseded_by: other.id })).status, 200);
    assert.equal((await audits()).length, 4, "the same replacement again: no row");
    const cleared = await patch({ superseded_by: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.superseded_by, cleared.body.superseded_by_title], [null, null]);
    assert.equal((await audits()).length, 5);

    // One PATCH may carry every card's fields; the GET answers them all.
    const all = await patch({ statement: "Read and understood.", recert_months: 12, superseded_by: other.id });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const got = await call(route.GET as Handler, sessionRequest(url, adminSession, undefined, "GET"), id);
    assert.deepEqual(
      [got.body.statement, got.body.recert_months, got.body.superseded_by, got.body.superseded_by_title],
      ["Read and understood.", 12, other.id, `${STAMP} the replacement`]
    );
    assert.equal(new Date(got.body.next_recert_at).getTime(), addMonths(marker, 12).getTime());
    assert.equal((await audits()).length, 6, "one row for the one PATCH, however many fields it moved");
  });
});
