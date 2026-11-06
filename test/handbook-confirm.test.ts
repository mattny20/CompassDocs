// Confirm the whole handbook (1.18.0, H4). One POST confirms every policy
// in the handbook that is waiting for the caller, each against its current
// version and exactly as the policy's own card does: the same
// acknowledgements row (written by recordAcknowledgement), the same
// document.acknowledge audit echo (plus via/handbook_id), nothing for a
// policy already confirmed or one that does not ask this person, and the
// handbook-level record (handbook_confirmations + handbook.confirmed) once
// nothing is left waiting. Every refusal (no tick, a stale page, a wrong
// signature, a draft, the switch off, the licence) writes nothing.
//
// The route handlers are called directly, the way test/ack-statement.test.ts
// does it: next/headers resolves to a stub serving the request under test,
// and lib/ee to a stub that grants policy_ack (the community `@ee` stub
// advertises no features); the last test takes the feature away.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-confirm.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  listVersions,
  recordAcknowledgement,
  updateAckSettings,
  createSession,
  setSpaceGroups,
} from "../src/lib/db";
import { hasOpenAssignment, reconcilePoliciesForHandbook } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.handbook-confirm.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.handbook-confirm.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
/** lib/ee as a licensed enterprise build sees it; the licence test empties `features`. */
const edition = { present: true, features: ["policy_ack"] as string[] };
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

const CLIENT_IP = "203.0.113.41";
const USER_AGENT = "HandbookConfirmTest/1.0";

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

/** Everything the console printed while `run` ran, so a test can assert the password reached no log line. */
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

const STAMP = `hbconfirm-${Date.now()}`;
const PASSWORD = "Handbook!Sign123";
// A private space granted to this file's own group (reader, other): its
// policies ask only them, never the accounts of the files running beside
// this one (an internal space's switch-on would enrol every account).
let spaceId = 0;
let ownGroupId = 0;
let readerId = 0;
let otherId = 0;
let readerSession = "";
let otherSession = "";
// A private space neither reader can open, and the two people of the
// handbook-grant tests: `outsider` is in the handbook's audience group,
// `stranger` is in nothing.
let closedSpaceId = 0;
let groupId = 0;
let outsiderId = 0;
let strangerId = 0;
let outsiderSession = "";
let strangerSession = "";
let uploadDirectory = "";
const docIds: number[] = [];
const handbookIds: number[] = [];

async function newDoc(title: string, opts: { required?: boolean; type?: "policy" | "sop" | "knowledge"; space?: number } = {}) {
  const doc = await createDocument({
    space_id: opts.space ?? spaceId,
    title: `${STAMP} ${title}`,
    type: opts.type ?? "policy",
    status: "published",
    content: `${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  if (opts.required !== false) await switchOn(doc.id, { editDefault: null, recertMonths: null });
  return { id: doc.id, title: doc.title };
}

const latestVersion = async (docId: number) => (await listVersions(docId))[0].id;

/** What the confirm page posts back about itself (1.18.2): the statement beside the box and the contents fingerprint. */
const shownBy = (view: { statement: string; handbook: { fingerprint: string } }) => ({
  statement: view.statement,
  fingerprint: view.handbook.fingerprint,
});

/**
 * A published workspace handbook with one section holding `docs` in order.
 * Its audience is always chosen groups (this file's own, unless `groups`
 * names others): a published handbook's readers are in its policies'
 * audience (lib/db ACK_DOC_VISIBILITY), and an everyone handbook would
 * enrol every account in the shared database at the next reconcile.
 */
async function newHandbook(
  title: string,
  docs: number[],
  opts: { confirmWhole?: boolean; signature?: boolean; status?: "draft" | "published"; groups?: number[] } = {}
): Promise<number> {
  const hb = await fixtureQuery(
    `INSERT INTO handbooks (title, status, audience, confirm_whole, require_signature, created_by_name, published_at)
     VALUES ($1, $2, 'groups', $3, $4, 'test', now()) RETURNING id`,
    [`${STAMP} ${title}`, opts.status ?? "published", opts.confirmWhole === false ? 0 : 1, opts.signature ? 1 : 0]
  );
  const id = hb.rows[0].id as number;
  handbookIds.push(id);
  for (const g of opts.groups ?? [ownGroupId]) {
    await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [id, g]);
  }
  const sec = await pool().query(
    "INSERT INTO handbook_sections (handbook_id, title, position) VALUES ($1, 'Policies', 0) RETURNING id",
    [id]
  );
  for (const [i, docId] of docs.entries()) {
    await pool().query(
      "INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, $4)",
      [id, sec.rows[0].id, docId, i]
    );
  }
  return id;
}

async function ackRows(docId: number, userId: number) {
  const r = await pool().query(
    `SELECT version_id, statement_text, signed_name, identity_proof, user_agent, ip, reached_end
     FROM acknowledgements WHERE document_id = $1 AND user_id = $2 ORDER BY id`,
    [docId, userId]
  );
  return r.rows;
}

async function auditRows(action: string, target: number | string, actor = readerId) {
  const r = await pool().query<{ details: Record<string, any>; ip: string | null; target_type: string }>(
    "SELECT details, ip, target_type FROM audit_log WHERE action = $1 AND actor_id = $2 AND target_id = $3 ORDER BY id",
    [action, actor, String(target)]
  );
  return r.rows;
}

async function handbookRecords(handbookId: number, userId = readerId) {
  const r = await pool().query(
    "SELECT fingerprint, items, policies_confirmed, signed_name, ip, user_agent FROM handbook_confirmations WHERE handbook_id = $1 AND user_id = $2 ORDER BY id",
    [handbookId, userId]
  );
  return r.rows;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Handbook Confirm ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const creds = hashPassword(PASSWORD);
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES
       ($1, 'Hb Reader', $2, 'viewer', 'active', $5, $6),
       ($3, 'Hb Other', $4, 'viewer', 'active', $5, $6)
     RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}-reader@example.test`, `${STAMP}-other`, `${STAMP}-other@example.test`, creds.hash, creds.salt]
  );
  readerId = users.rows[0].id;
  otherId = users.rows[1].id;
  readerSession = newToken();
  otherSession = newToken();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  await createSession(readerSession, readerId, expires);
  await createSession(otherSession, otherId, expires);
  const own = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Handbook staff`]);
  ownGroupId = own.rows[0].id;
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)", [ownGroupId, readerId, otherId]);
  await setSpaceGroups(spaceId, [ownGroupId]);

  const closed = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔒', '', 'private') RETURNING id`,
    [`Handbook Confirm Closed ${STAMP}`, `${STAMP}-closed`]
  );
  closedSpaceId = closed.rows[0].id;
  const more = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES
       ($1, 'Hb Outsider', $2, 'viewer', 'active', $5, $6),
       ($3, 'Hb Stranger', $4, 'viewer', 'active', $5, $6)
     RETURNING id`,
    [`${STAMP}-outsider`, `${STAMP}-outsider@example.test`, `${STAMP}-stranger`, `${STAMP}-stranger@example.test`, creds.hash, creds.salt]
  );
  outsiderId = more.rows[0].id;
  strangerId = more.rows[1].id;
  const g = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Handbook readers`]);
  groupId = g.rows[0].id;
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, outsiderId]);
  outsiderSession = newToken();
  strangerSession = newToken();
  await createSession(outsiderSession, outsiderId, expires);
  await createSession(strangerSession, strangerId, expires);
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hbconfirm-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
});

after(async () => {
  const userIds = [readerId, otherId, outsiderId, strangerId];
  await pool().query("DELETE FROM handbook_confirmations WHERE handbook_id = ANY($1) OR user_id = ANY($2)", [handbookIds, userIds]);
  await pool().query("DELETE FROM handbooks WHERE id = ANY($1)", [handbookIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM doc_views WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1) OR space_id = $2", [docIds, spaceId]);
  await pool().query("DELETE FROM documents WHERE space_id = $1", [closedSpaceId]);
  await pool().query("DELETE FROM policy_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM group_members WHERE group_id = ANY($1)", [[groupId, ownGroupId]]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [[groupId, ownGroupId]]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[spaceId, closedSpaceId]]);
  if (uploadDirectory) await rm(uploadDirectory, { recursive: true, force: true });
});

// --- The tests ----------------------------------------------------------------------

describe("confirm the whole handbook", () => {
  test("GET says where each policy stands; POST confirms exactly the outstanding ones as their cards would, then records the handbook once", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const toConfirm = await newDoc("Paid Time Off");
    const confirmed = await newDoc("Code of Conduct");
    const updated = await newDoc("Access Control");
    const info = await newDoc("Office guide", { required: false, type: "knowledge" });
    // Confirmed on its own page, before the handbook.
    assert.deepEqual(await recordAcknowledgement(confirmed.id, readerId, "10.0.0.1", await latestVersion(confirmed.id)), {
      recorded: true,
      stale: false,
    });
    // Confirmed, then changed with a reset: "Updated since you confirmed".
    await recordAcknowledgement(updated.id, readerId, "10.0.0.1", await latestVersion(updated.id));
    await updateDocument(updated.id, {
      content: "Access Control: the procedure changed.",
      author: "test",
      ackPolicy: "reset",
      ackReason: "The procedure changed for everyone.",
    });
    const hb = await newHandbook("Employee Handbook", [confirmed.id, toConfirm.id, updated.id, info.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;

    const got = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    const standings = Object.fromEntries(got.body.items.map((i: any) => [i.doc_id, i.standing]));
    assert.deepEqual(standings, {
      [confirmed.id]: "confirmed",
      [toConfirm.id]: "to_confirm",
      [updated.id]: "updated",
      [info.id]: "info",
    });
    assert.deepEqual(got.body.counts, { total: 4, confirmed: 1, to_confirm: 1, updated: 1, info: 1, outstanding: 2 });
    assert.equal(
      got.body.statement,
      // Three policies and a knowledge document: the statement names the mix (1.18.2).
      `I have read and understood all 4 documents in ${STAMP} Employee Handbook (3 policies and 1 other document), and I agree to follow them.`
    );
    assert.equal(got.body.signature.required, false);
    assert.equal(got.body.confirmed, null);
    const versions = Object.fromEntries(
      got.body.items.filter((i: any) => i.version_id !== null && i.standing !== "confirmed").map((i: any) => [i.doc_id, i.version_id])
    );
    assert.equal(versions[updated.id], await latestVersion(updated.id), "the newest version, as the card cites it");

    // No tick: refused, nothing written.
    const unticked = await call(route.POST as Handler, sessionRequest(url, readerSession, { versions }), hb);
    assert.equal(unticked.status, 400);
    assert.equal(unticked.body.error, "Tick the statement to confirm the handbook.");
    assert.equal((await ackRows(toConfirm.id, readerId)).length, 0);

    // A page drawn before a version that no longer is the newest: stale, nothing written.
    const stalePage = await call(
      route.POST as Handler,
      sessionRequest(url, readerSession, { agreed: true, versions: { ...versions, [updated.id]: versions[updated.id] - 1 }, ...shownBy(got.body) }),
      hb
    );
    assert.equal(stalePage.status, 409);
    assert.equal(stalePage.body.stale, true);
    assert.equal((await ackRows(toConfirm.id, readerId)).length, 0, "the stale check runs before the first write");
    // A page that left an outstanding policy out is stale too.
    const partial = await call(
      route.POST as Handler,
      sessionRequest(url, readerSession, { agreed: true, versions: { [toConfirm.id]: versions[toConfirm.id] }, ...shownBy(got.body) }),
      hb
    );
    assert.equal(partial.status, 409);
    assert.equal(partial.body.stale, true);

    const posted = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(got.body) }), hb);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.deepEqual(posted.body, { ok: true, confirmed: 2, outstanding: 0, stale: [], handbook_confirmed: true });

    // The rows: one each for the two outstanding policies, of their newest
    // version, carrying the statement the reader ticked; nothing for the
    // confirmed policy (still its one row) or the guide.
    for (const doc of [toConfirm, updated]) {
      const rows = await ackRows(doc.id, readerId);
      const last = rows[rows.length - 1];
      assert.equal(last.version_id, await latestVersion(doc.id));
      assert.equal(last.statement_text, got.body.statement);
      assert.equal(last.signed_name, null);
      assert.equal(last.identity_proof, "");
      assert.equal(last.user_agent, USER_AGENT);
      assert.equal(last.ip, CLIENT_IP);
      assert.equal(last.reached_end, 0);
      const audits = await auditRows("document.acknowledge", doc.id);
      assert.equal(audits.length, 1, "one audit echo per recorded row");
      assert.equal(audits[0].details.via, "handbook");
      assert.equal(audits[0].details.handbook_id, hb);
      assert.equal(audits[0].details.version_id, last.version_id);
      assert.match(String(audits[0].details.content_sha256), /^[0-9a-f]{64}$/);
    }
    assert.equal((await ackRows(updated.id, readerId)).length, 2, "the lapsed row and the new one");
    assert.equal((await ackRows(confirmed.id, readerId)).length, 1, "a confirmed policy is not written again");
    assert.equal((await auditRows("document.acknowledge", confirmed.id)).length, 0);
    assert.equal((await ackRows(info.id, readerId)).length, 0, "a policy that does not ask is never written");

    // The handbook-level record and its audit row.
    const records = await handbookRecords(hb);
    assert.equal(records.length, 1);
    assert.equal(records[0].policies_confirmed, 2);
    assert.equal(records[0].ip, CLIENT_IP);
    assert.equal(records[0].items.length, 4);
    const hbAudit = await auditRows("handbook.confirmed", hb);
    assert.equal(hbAudit.length, 1);
    assert.equal(hbAudit[0].target_type, "handbook");
    assert.equal(hbAudit[0].details.fingerprint, records[0].fingerprint);
    assert.equal(hbAudit[0].details.confirmed, 2);

    // Now: everything counts, the record is there, a second submit writes nothing.
    const after = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(after.body.counts.outstanding, 0);
    assert.ok(after.body.confirmed?.at, "the done state's date");
    const again = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions: {} }), hb);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "You have already confirmed this handbook as it stands.");
    assert.equal((await handbookRecords(hb)).length, 1);
  });

  test("a signature is asked once for the batch: a wrong name or password writes nothing (the miss is audited against the handbook); the right one signs every row", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const signedPolicy = await newDoc("Data Classification");
    assert.deepEqual(await updateAckSettings(signedPolicy.id, { signature: true }), { statement: null, signature: true });
    const plain = await newDoc("Remote Work");
    const hb = await newHandbook("Security Handbook", [signedPolicy.id, plain.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;

    const got = await call(route.GET as Handler, sessionRequest(url, otherSession, undefined, "GET"), hb);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.signature, {
      required: true,
      policies: [signedPolicy.title],
      handbook: false,
      local_account: true,
    });
    const versions = { [signedPolicy.id]: await latestVersion(signedPolicy.id), [plain.id]: await latestVersion(plain.id) };
    const post = (extra: Record<string, unknown>) =>
      call(route.POST as Handler, sessionRequest(url, otherSession, { agreed: true, versions, ...shownBy(got.body), ...extra }), hb);

    const { result: signed, seen } = await withConsoleSpy(async () => {
      const unsigned = await post({});
      assert.equal(unsigned.status, 409);
      assert.equal(unsigned.body.error, "Type your full name exactly as it appears on your account (Hb Other).");
      const wrongPassword = await post({ signed_name: "hb other", password: "not-it" });
      assert.equal(wrongPassword.status, 409);
      assert.equal(wrongPassword.body.error, "Password check failed. Re-enter your account password to sign.");
      assert.equal((await ackRows(plain.id, otherId)).length, 0, "nothing was recorded by the refusals");
      const failed = await auditRows("auth.login_failed", hb, otherId);
      assert.equal(failed.length, 1, "one failed sign-in for the one wrong password");
      assert.equal(failed[0].target_type, "handbook");
      assert.deepEqual(failed[0].details, { via: "attestation" });
      return post({ signed_name: "  Hb Other ", password: PASSWORD });
    });
    assert.ok(!seen.some((s) => s.includes(PASSWORD) || s.includes("not-it")), "the password never reaches a log line");
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.confirmed, 2);
    for (const doc of [signedPolicy, plain]) {
      const [row] = await ackRows(doc.id, otherId);
      assert.equal(row.signed_name, "Hb Other", "a signed batch signs every row it writes");
      assert.equal(row.identity_proof, "password");
      assert.doesNotMatch(JSON.stringify(row), /Handbook!Sign|not-it/);
      const [echo] = await auditRows("document.acknowledge", doc.id, otherId);
      assert.equal(echo.details.signed_name, "Hb Other");
      assert.doesNotMatch(JSON.stringify(echo.details), /Handbook!Sign|not-it/);
    }
    const [record] = await handbookRecords(hb, otherId);
    assert.equal(record.signed_name, "Hb Other");
  });

  test("the handbook's own signature switch asks for one even when no policy does", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const doc = await newDoc("Expenses");
    const hb = await newHandbook("Finance Handbook", [doc.id], { signature: true });
    const url = `http://localhost/api/handbooks/${hb}/confirm`;
    const got = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(got.body.signature.required, true);
    assert.deepEqual(got.body.signature.policies, []);
    const versions = { [doc.id]: await latestVersion(doc.id) };
    const unsigned = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(got.body) }), hb);
    assert.equal(unsigned.status, 409);
    assert.equal(unsigned.body.stale, undefined, "refused for the signature, not as stale");
    assert.equal((await ackRows(doc.id, readerId)).length, 0);
  });

  test("refusals that write nothing: a draft handbook (404), the switch off (400), no licence (402)", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const doc = await newDoc("Refund Approval");
    const versions = { [doc.id]: await latestVersion(doc.id) };
    const body = { agreed: true, versions };

    const draft = await newHandbook("Draft Handbook", [doc.id], { status: "draft" });
    const draftRes = await call(route.POST as Handler, sessionRequest(`http://localhost/api/handbooks/${draft}/confirm`, readerSession, body), draft);
    assert.equal(draftRes.status, 404);

    const off = await newHandbook("Read-only Handbook", [doc.id], { confirmWhole: false });
    const offRes = await call(route.POST as Handler, sessionRequest(`http://localhost/api/handbooks/${off}/confirm`, readerSession, body), off);
    assert.equal(offRes.status, 400);
    assert.equal(offRes.body.error, "This handbook doesn't ask for a confirmation.");

    const live = await newHandbook("Licensed Handbook", [doc.id]);
    edition.features = [];
    try {
      const url = `http://localhost/api/handbooks/${live}/confirm`;
      assert.equal((await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), live)).status, 402);
      assert.equal((await call(route.POST as Handler, sessionRequest(url, readerSession, body), live)).status, 402);
    } finally {
      edition.features = ["policy_ack"];
    }
    assert.equal((await ackRows(doc.id, readerId)).length, 0);
    assert.equal((await handbookRecords(draft)).length + (await handbookRecords(off)).length + (await handbookRecords(live)).length, 0);
  });
});

// --- A policy's own words on the whole-handbook page --------------------------------

describe("policies that ask in their own words", () => {
  test("listed under the handbook's statement, covered by the one tick, each stored on its own row; the rest store the handbook's", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const own = await newDoc("Information Security");
    const OWN = "I will **report** any security incident within one hour.";
    await updateAckSettings(own.id, { statement: OWN });
    const plain = await newDoc("Travel");
    const hb = await newHandbook("Own Words Handbook", [own.id, plain.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;

    const got = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body.own_statements, [{ doc_id: own.id, title: own.title, statement: OWN }]);
    const items = Object.fromEntries(got.body.items.map((i: any) => [i.doc_id, i.statement]));
    assert.equal(items[own.id], OWN);
    assert.equal(items[plain.id], null, "a policy on the default statement is not listed");

    const versions = { [own.id]: await latestVersion(own.id), [plain.id]: await latestVersion(plain.id) };
    const posted = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(got.body) }), hb);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.confirmed, 2);
    assert.equal((await ackRows(own.id, readerId))[0].statement_text, OWN, "its own words, as its card would store");
    assert.equal((await ackRows(plain.id, readerId))[0].statement_text, got.body.statement);

    // Confirmed now: nothing waiting asks in its own words.
    const after = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.deepEqual(after.body.own_statements, []);
  });
});

// --- The statement and contents the page showed (1.18.2) ------------------------------
//
// The page posts the statement beside the box and the contents fingerprint
// it was drawn with; the server compares both with its own before writing
// anything. Contents that changed under the page (a document added for
// information, a type changed: neither moves an outstanding policy's
// version) answer the same 409 { stale } as a changed version, so a stored
// statement is always the sentence the person ticked.

describe("the statement and contents the page showed", () => {
  test("a handbook of policies only stores the 1.18.0 sentence byte for byte; a statement the server would not store is stale", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const a = await newDoc("Pair one");
    const b = await newDoc("Pair two");
    const hb = await newHandbook("Policy Pair", [a.id, b.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;
    const got = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    // The literal 1.18.0 sentence (lib/handbook-confirm-shared at 1.18.0): "all 2 policies", never "both".
    const SENTENCE = `I have read and understood all 2 policies in ${STAMP} Policy Pair, and I agree to follow them.`;
    assert.equal(got.body.statement, SENTENCE);
    const versions = { [a.id]: await latestVersion(a.id), [b.id]: await latestVersion(b.id) };

    const tampered = await call(
      route.POST as Handler,
      sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(got.body), statement: "I agree." }),
      hb
    );
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.stale, true);
    assert.equal((await ackRows(a.id, readerId)).length, 0);

    const posted = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(got.body) }), hb);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(posted.body.handbook_confirmed, true);
    for (const doc of [a, b]) {
      const rows = await ackRows(doc.id, readerId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].statement_text, SENTENCE, "the stored words are the 1.18.0 sentence");
    }
  });

  test("a document added for information after the page was drawn: 409 stale and nothing written; the refreshed page confirms", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const policy = await newDoc("Expenses again");
    const guide = await newDoc("Expenses guide", { required: false, type: "knowledge" });
    const hb = await newHandbook("Grows Handbook", [policy.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;
    const drawn = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(drawn.body.statement, `I have read and understood the policy in ${STAMP} Grows Handbook, and I agree to follow it.`);
    const versions = { [policy.id]: await latestVersion(policy.id) };

    // Added between render and submit: it asks nobody, so no version is stale.
    const sec = (await pool().query("SELECT id FROM handbook_sections WHERE handbook_id = $1", [hb])).rows[0].id;
    await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, 1)", [hb, sec, guide.id]);

    const stale = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(drawn.body) }), hb);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.stale, true);
    assert.equal((await ackRows(policy.id, readerId)).length, 0, "nothing written");
    assert.equal((await handbookRecords(hb)).length, 0);
    assert.equal((await auditRows("document.acknowledge", policy.id)).length, 0);

    const fresh = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.notEqual(fresh.body.handbook.fingerprint, drawn.body.handbook.fingerprint);
    assert.equal(
      fresh.body.statement,
      `I have read and understood both documents in ${STAMP} Grows Handbook (1 policy and 1 other document), and I agree to follow them.`
    );
    const posted = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(fresh.body) }), hb);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal((await ackRows(policy.id, readerId))[0].statement_text, fresh.body.statement, "the words the refreshed page showed");
  });

  test("a type changed after the page was drawn (the fingerprint is unchanged): 409 stale, nothing written", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const policy = await newDoc("Retyped policy");
    const sop = await newDoc("Retyped SOP", { type: "sop" });
    const hb = await newHandbook("Retyped Handbook", [policy.id, sop.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;
    const drawn = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(
      drawn.body.statement,
      `I have read and understood both documents in ${STAMP} Retyped Handbook (1 policy and 1 SOP), and I agree to follow them.`
    );
    const versions = { [policy.id]: await latestVersion(policy.id), [sop.id]: await latestVersion(sop.id) };
    await pool().query("UPDATE documents SET type = 'policy' WHERE id = $1", [sop.id]);
    const fresh = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    assert.equal(fresh.body.handbook.fingerprint, drawn.body.handbook.fingerprint, "a type is not in the fingerprint");

    const stale = await call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...shownBy(drawn.body) }), hb);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.stale, true);
    assert.equal((await ackRows(policy.id, readerId)).length + (await ackRows(sop.id, readerId)).length, 0);
    assert.equal((await handbookRecords(hb)).length, 0);
  });

  test("a page from before 1.18.2: its fingerprint alone is checked when it sends one; without either it is stale", async () => {
    const route = await import("../src/app/api/handbooks/[id]/confirm/route");
    const policy = await newDoc("Old tab policy");
    const hb = await newHandbook("Old Tab Handbook", [policy.id]);
    const url = `http://localhost/api/handbooks/${hb}/confirm`;
    const got = await call(route.GET as Handler, sessionRequest(url, readerSession, undefined, "GET"), hb);
    const versions = { [policy.id]: await latestVersion(policy.id) };
    const post = (extra: Record<string, unknown>) =>
      call(route.POST as Handler, sessionRequest(url, readerSession, { agreed: true, versions, ...extra }), hb);

    const neither = await post({});
    assert.equal(neither.status, 409);
    assert.equal(neither.body.stale, true);
    const wrong = await post({ fingerprint: "0".repeat(64) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.stale, true);
    assert.equal((await ackRows(policy.id, readerId)).length, 0);
    const fingerprintOnly = await post({ fingerprint: got.body.handbook.fingerprint });
    assert.equal(fingerprintOnly.status, 200, JSON.stringify(fingerprintOnly.body));
    assert.equal((await ackRows(policy.id, readerId))[0].statement_text, got.body.statement);
  });
});

// --- A reader the handbook lets in -----------------------------------------------------
//
// The outsider cannot open the private space; a published handbook whose
// audience group holds them contains its policy. Through that grant alone
// they are in the policy's audience (lib/db ACK_DOC_VISIBILITY), confirm it
// from the reader's bar (POST /ack with handbook_id), are tracked (POST
// /api/track) and load the images in its body (GET /api/attachments/[id]),
// and the handbook's own signature switch applies to that confirmation.
// The stranger, in no audience, is answered 404 everywhere and nothing is
// written.

describe("a reader the handbook lets in", () => {
  async function closedPolicy(title: string) {
    return newDoc(title, { space: closedSpaceId, required: false });
  }
  async function attach(docId: number): Promise<number> {
    const stored = `${randomBytes(16).toString("hex")}.png`;
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(path.join(uploadDirectory, stored), bytes);
    const r = await pool().query(
      "INSERT INTO attachments (document_id, filename, stored_name, mime_type, size) VALUES ($1, 'diagram.png', $2, 'image/png', $3) RETURNING id",
      [docId, stored, bytes.length]
    );
    return r.rows[0].id;
  }

  test("confirms, is tracked and loads the policy's images; the stranger gets 404 and nothing is written", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const track = await import("../src/app/api/track/route");
    const attachments = await import("../src/app/api/attachments/[id]/route");

    const policy = await closedPolicy("Board Conduct");
    const elsewhere = await closedPolicy("Board Minutes"); // same space, in no handbook
    const hb = await newHandbook("Board Handbook", [policy.id], { groups: [groupId] });
    const otherHb = await newHandbook("Unrelated Handbook", [], { groups: [groupId] });
    // Switched on after the handbook is published: the first audience
    // includes the people the handbook lets read it.
    await switchOn(policy.id, { editDefault: null, recertMonths: null });
    assert.equal(await hasOpenAssignment(policy.id, outsiderId), true, "the handbook's reader is in the policy's audience");
    assert.equal(await hasOpenAssignment(policy.id, strangerId), false, "nobody else outside the space is");

    // The image in the body.
    const image = await attach(policy.id);
    const otherImage = await attach(elsewhere.id);
    const imgUrl = (id: number) => `http://localhost/api/attachments/${id}`;
    const img = await call(attachments.GET as Handler, sessionRequest(imgUrl(image), outsiderSession, undefined, "GET"), image);
    assert.equal(img.status, 200, "the policy's own attachment loads");
    assert.equal(
      (await call(attachments.GET as Handler, sessionRequest(imgUrl(otherImage), outsiderSession, undefined, "GET"), otherImage)).status,
      404,
      "an attachment of a document no handbook opens to them does not"
    );
    assert.equal(
      (await call(attachments.GET as Handler, sessionRequest(imgUrl(image), strangerSession, undefined, "GET"), image)).status,
      404
    );

    // Reading time.
    const trackUrl = "http://localhost/api/track";
    const viewed = await call(track.POST as Handler, sessionRequest(trackUrl, outsiderSession, { docId: policy.id }), 0);
    assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
    assert.ok(Number.isInteger(viewed.body.viewId));
    assert.equal((await call(track.POST as Handler, sessionRequest(trackUrl, strangerSession, { docId: policy.id }), 0)).status, 404);
    assert.equal(
      (await call(track.POST as Handler, sessionRequest(trackUrl, outsiderSession, { docId: elsewhere.id }), 0)).status,
      404
    );

    // The confirmation.
    const ackUrl = `http://localhost/api/documents/${policy.id}/ack`;
    const version = await latestVersion(policy.id);
    const strangerPost = await call(
      ack.POST as Handler,
      sessionRequest(ackUrl, strangerSession, { version_id: version, handbook_id: hb }),
      policy.id
    );
    assert.equal(strangerPost.status, 404);
    const noHandbook = await call(ack.POST as Handler, sessionRequest(ackUrl, outsiderSession, { version_id: version }), policy.id);
    assert.equal(noHandbook.status, 400, "a reader the handbook lets in confirms from the handbook");
    const wrongHandbook = await call(
      ack.POST as Handler,
      sessionRequest(ackUrl, outsiderSession, { version_id: version, handbook_id: otherHb }),
      policy.id
    );
    assert.equal(wrongHandbook.status, 404, "a handbook that does not hold the policy grants nothing");
    assert.equal((await ackRows(policy.id, outsiderId)).length, 0);
    assert.equal((await ackRows(policy.id, strangerId)).length, 0);

    const confirmed = await call(
      ack.POST as Handler,
      sessionRequest(ackUrl, outsiderSession, { version_id: version, handbook_id: hb, reached_end: true }),
      policy.id
    );
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const [row] = await ackRows(policy.id, outsiderId);
    assert.equal(row.version_id, version);
    assert.equal(row.signed_name, null);
    const [echo] = await auditRows("document.acknowledge", policy.id, outsiderId);
    assert.equal(echo.details.via, "handbook");
    assert.equal(echo.details.handbook_id, hb);

    // The whole-handbook page agrees: confirmed, not "for information".
    const confirmRoute = await import("../src/app/api/handbooks/[id]/confirm/route");
    const view = await call(
      confirmRoute.GET as Handler,
      sessionRequest(`http://localhost/api/handbooks/${hb}/confirm`, outsiderSession, undefined, "GET"),
      hb
    );
    assert.equal(view.body.items[0].standing, "confirmed");

    // Unpublished, the handbook no longer opens the policy: the reconcile
    // closes the row, and the routes answer as for anyone outside.
    await pool().query("UPDATE handbooks SET status = 'draft' WHERE id = $1", [hb]);
    try {
      await reconcilePoliciesForHandbook(hb);
      assert.equal(await hasOpenAssignment(policy.id, outsiderId), false);
      assert.equal(
        (await call(attachments.GET as Handler, sessionRequest(imgUrl(image), outsiderSession, undefined, "GET"), image)).status,
        404
      );
      assert.equal((await call(track.POST as Handler, sessionRequest(trackUrl, outsiderSession, { docId: policy.id }), 0)).status, 404);
    } finally {
      await pool().query("UPDATE handbooks SET status = 'published' WHERE id = $1", [hb]);
    }
  });

  test("the handbook's \"Require a typed signature\" applies to a policy confirmed from its reader", async () => {
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const policy = await closedPolicy("Conflicts of Interest");
    const hb = await newHandbook("Signed Board Handbook", [policy.id], { groups: [groupId], signature: true });
    await switchOn(policy.id, { editDefault: null, recertMonths: null });
    const ackUrl = `http://localhost/api/documents/${policy.id}/ack`;
    const version = await latestVersion(policy.id);
    const post = (extra: Record<string, unknown>) =>
      call(ack.POST as Handler, sessionRequest(ackUrl, outsiderSession, { version_id: version, handbook_id: hb, ...extra }), policy.id);

    const unsigned = await post({});
    assert.equal(unsigned.status, 409, "the policy asks for no signature, the handbook does");
    assert.equal(unsigned.body.error, "Type your full name exactly as it appears on your account (Hb Outsider).");
    assert.equal((await post({ signed_name: "Hb Outsider", password: "not-it" })).status, 409);
    assert.equal((await ackRows(policy.id, outsiderId)).length, 0, "nothing recorded by the refusals");
    const signed = await post({ signed_name: " hb outsider ", password: PASSWORD });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const [row] = await ackRows(policy.id, outsiderId);
    assert.equal(row.signed_name, "hb outsider", "the typed name, trimmed, as the card stores it");
    assert.equal(row.identity_proof, "password");

    // A reader of the space who confirms in the same handbook signs too.
    const open = await newDoc("Whistleblowing");
    const openHb = await newHandbook("Signed Open Handbook", [open.id], { signature: true });
    const openUrl = `http://localhost/api/documents/${open.id}/ack`;
    const openVersion = await latestVersion(open.id);
    const inHandbook = await call(
      ack.POST as Handler,
      sessionRequest(openUrl, otherSession, { version_id: openVersion, handbook_id: openHb }),
      open.id
    );
    assert.equal(inHandbook.status, 409, "the switch applies to anyone confirming in the handbook");
    assert.equal((await ackRows(open.id, otherId)).length, 0);
  });
});
