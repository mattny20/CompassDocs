// The token invariant (H2, 1.11.0): a personal API token (cdk_, the v1 API
// and the connector) or an OAuth access token (cdo_, the connector) may edit
// a policy, and from 1.11.0 must decide keep or reset when it does, but can
// never confirm one. Attestation is cookie-session only: POST
// /api/documents/[id]/ack and POST .../ack/reconfirm resolve the person from
// the session cookie through apiGuard and never read Authorization, so a
// bearer is answered 401 however valid it is, while the same bearer is
// accepted by GET /api/v1/documents/[id] and by the connector in the same
// test; and the connector offers no tool that confirms. This file pins all of
// that so no later convenience change lets a token confirm.
//
// The second describe is the other half of the sentence: the v1 PATCH and
// the connector's update_doc decide before they write (the shared pre-flight
// in lib/ack-decision): 428 and the decision_required result until the
// caller says keep or reset with a reason, 400 for a bad policy or a short
// reason, never for a metadata-only change, and the publish of a drifted
// draft asks like an edit. The third is the keep side's reason rule: it
// follows Program settings' "Require a reason for editorial fixes too" on
// every path (v1, the connector, merge, restore and the review route, the
// last three driven through their handlers with a session cookie minted
// here), a reset always needs its ten characters, and a stored
// recommendation the rule would refuse counts as none (428, never a 400 to
// an approver who sent no reason). The fourth is the side doors: an image
// placed by add_image or a drop link is exactly one image line whatever the
// alt or the file name carries. The fifth is the import guard: a published
// policy, or a paused one the zip would publish, is left unchanged and named
// unless overwrite_policies is on, the result counts the policies whose
// readers will be asked again, and an overwrite's decision is echoed to the
// audit log with the importer and their address.
//
// The route handlers are called directly. They read the request scope
// through next/headers, which exists only inside Next's server, so this file
// resolves next/headers to a stub that serves the headers of the request
// under test (the Authorization header included, so the invariant is
// exercised, not bypassed) and finds whatever cookies that request carries:
// none for the token cases, the admin's session cookie for the app routes.
// `@ee` is a bundler alias (next.config.js) and resolves to the community
// stub here. Both are wired before the routes load (they are imported inside
// the tests), and nothing else in the graph needs Next.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PoolClient } from "pg";
import JSZip from "jszip";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  getDocument,
  updateDocument,
  setAckRequired,
  listVersions,
  listAckDecisions,
  ackSummary,
  recordAcknowledgement,
  getCurrentAck,
  createChangeRequest,
  getChangeRequest,
  createSession,
  createApiToken,
  registerOAuthClient,
  createOAuthTokens,
  getUserByApiToken,
  getUserByOAuthToken,
} from "../src/lib/db";
import { ACK_DECISION_ERROR, ACK_REASON_ERROR, ACK_POLICY_ERROR } from "../src/lib/ack-decision";
import { importFromZip, IMPORT_POLICY_SKIPPED } from "../src/lib/transfer";
import { createUploadTicket, imageAltText } from "../src/lib/image-intake";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

/** The request the stubbed next/headers serves; set by call() below. */
let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-tokens.virtual.js");
const EE_STUB = path.join(__dirname, "..", "src", "ee-stub", "index.ts");
{
  const stub = new Module(HEADERS_STUB);
  stub.filename = HEADERS_STUB;
  stub.loaded = true;
  stub.exports = {
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
  require.cache[HEADERS_STUB] = stub;
  const loader = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@ee") return EE_STUB;
    return resolveFilename.call(this, request, ...rest);
  };
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
/** A handler whose params are not just {id}: the restore route ({id, vid}) and the drop link ({token}). */
type AnyHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Call a route handler the way Next would, with this request in scope. */
async function call(handler: Handler, req: Request, id: number): Promise<{ status: number; body: any }> {
  return callWith(handler as AnyHandler, req, { id: String(id) });
}

async function callWith(handler: AnyHandler, req: Request, params: Record<string, string>): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve(params) });
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

/** The address every request here claims, so the audit rows can be checked for it. */
const CLIENT_IP = "203.0.113.9";

function jsonRequest(url: string, bearer: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: JSON.stringify(body),
  });
}

/** The app's own routes (merge, restore, the review queue) resolve the person from the session cookie, never a bearer. */
function sessionRequest(url: string, session: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `acktok-${Date.now()}`;
let spaceId = 0;
let adminId = 0;
let docId = 0;
let versionId = 0;
let apiToken = "";
let oauthToken = "";
let oauthClientId = "";
/** A signed-in session for the admin: the cookie the app's own routes read. */
let sessionToken = "";
const docIds: number[] = [];

/** The advisory lock the settings-touching describe shares with test/compliance-settings.test.ts and test/ack-revision.test.ts. */
const SETTINGS_LOCK = 728342;

const TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

/** A published policy with one confirmation on its first version. */
async function confirmedPolicy(title: string): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  await setAckRequired(doc.id, true, { editDefault: null });
  const v1 = (await listVersions(doc.id))[0].id;
  await recordAcknowledgement(doc.id, adminId, "", v1);
  return { id: doc.id, v1 };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Tokens ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Tok Admin', $2, 'admin', 'active') RETURNING id`,
    [`${STAMP}-admin`, `${STAMP}-admin@example.test`]
  );
  adminId = users.rows[0].id;
  const doc = await createDocument({
    space_id: spaceId,
    title: `${STAMP} policy`,
    type: "policy",
    status: "published",
    content: "Staff must follow the procedure described here.",
    summary: "",
    tags: [],
    author: "test",
  });
  docId = doc.id;
  docIds.push(docId);
  await setAckRequired(docId, true, { editDefault: null });
  versionId = (await listVersions(docId))[0].id;
  apiToken = (await createApiToken(adminId, `${STAMP} token`, ["read", "write"])).token;
  oauthClientId = (await registerOAuthClient(`${STAMP} client`, ["http://localhost/callback"])).client_id;
  oauthToken = (await createOAuthTokens(oauthClientId, adminId)).accessToken;
  sessionToken = newToken();
  await createSession(sessionToken, adminId, new Date(Date.now() + 3_600_000).toISOString());
  // The side doors store the file before they edit the document.
  process.env.COMPASSDOCS_UPLOAD_DIR = await mkdtemp(path.join(tmpdir(), "compass-acktok-"));
});

after(async () => {
  await pool().query("DELETE FROM sessions WHERE user_id = $1", [adminId]);
  await pool().query("DELETE FROM api_tokens WHERE user_id = $1", [adminId]);
  await pool().query("DELETE FROM oauth_tokens WHERE user_id = $1", [adminId]);
  await pool().query("DELETE FROM oauth_clients WHERE client_id = $1", [oauthClientId]);
  // Before the users and the documents: reviewed_by has no ON DELETE.
  await pool().query("DELETE FROM change_requests WHERE document_id = ANY($1) OR created_by = $2", [docIds, adminId]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = $2", [docIds, adminId]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = $1", [adminId]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1) OR space_id = $2", [docIds, spaceId]);
  await pool().query("DELETE FROM users WHERE id = $1", [adminId]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

/** One JSON-RPC tools/call through the connector, as the e2e helper does it. */
async function mcpCall(bearer: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const mcp = await import("../src/app/api/mcp/route");
  currentRequest = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-forwarded-for": CLIENT_IP },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  try {
    const res = await mcp.POST(currentRequest);
    assert.equal(res.status, 200);
    const body = await res.json();
    return { isError: body.result?.isError === true, out: JSON.parse(body.result?.content?.[0]?.text ?? "null") };
  } finally {
    currentRequest = null;
  }
}

async function confirmations(): Promise<number> {
  const r = await pool().query("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [docId]);
  return r.rows[0].n;
}

// --- The invariant ---------------------------------------------------------------

describe("tokens may edit a policy and must decide; tokens can never confirm one", () => {
  test("a personal API token is accepted by the v1 API and refused by the confirmation routes", async () => {
    // The token is real: the v1 API resolves its owner and serves the policy
    // (with the 1.11.0 standing), so the 401s below are the invariant, not a
    // bad fixture.
    assert.equal((await getUserByApiToken(apiToken))?.id, adminId);
    const v1 = await import("../src/app/api/v1/documents/[id]/route");
    const read = await call(
      v1.GET as Handler,
      new Request(`http://localhost/api/v1/documents/${docId}`, {
        headers: { authorization: `Bearer ${apiToken}` },
      }),
      docId
    );
    assert.equal(read.status, 200);
    assert.equal(read.body.document.ack_required, true);
    assert.equal(read.body.document.ack_edit_default, "ask");
    // The audience is every active account that can see an internal space,
    // which in the shared test database is more than this file's admin.
    assert.equal(read.body.document.ack.confirmations, 0);
    assert.ok(read.body.document.ack.eligible >= 1);
    assert.equal(read.body.document.ack.version, "v1");

    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const confirm = await call(
      ack.POST as Handler,
      jsonRequest(`http://localhost/api/documents/${docId}/ack`, apiToken, { version_id: versionId, reached_end: true }),
      docId
    );
    assert.equal(confirm.status, 401, "a cdk_ bearer never confirms");
    assert.equal(confirm.body.error, "Authentication required.");

    const reconfirm = await import("../src/app/api/documents/[id]/ack/reconfirm/route");
    const reask = await call(
      reconfirm.POST as Handler,
      jsonRequest(`http://localhost/api/documents/${docId}/ack/reconfirm`, apiToken, {
        reason: "Section 4 now applies to contractors too",
      }),
      docId
    );
    assert.equal(reask.status, 401, "a cdk_ bearer never re-asks either");
    assert.equal(reask.body.error, "Authentication required.");
    assert.equal(await confirmations(), 0, "nothing was recorded");
  });

  test("an OAuth access token (the connector's) is refused by the confirmation routes too", async () => {
    assert.equal((await getUserByOAuthToken(oauthToken))?.id, adminId);
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const confirm = await call(
      ack.POST as Handler,
      jsonRequest(`http://localhost/api/documents/${docId}/ack`, oauthToken, { version_id: versionId }),
      docId
    );
    assert.equal(confirm.status, 401, "a cdo_ bearer never confirms");
    const reconfirm = await import("../src/app/api/documents/[id]/ack/reconfirm/route");
    const reask = await call(
      reconfirm.POST as Handler,
      jsonRequest(`http://localhost/api/documents/${docId}/ack/reconfirm`, oauthToken, {
        reason: "Section 4 now applies to contractors too",
      }),
      docId
    );
    assert.equal(reask.status, 401, "a cdo_ bearer never re-asks either");
    assert.equal(await confirmations(), 0, "nothing was recorded");
  });

  test("the connector accepts both tokens and offers no tool that confirms", async () => {
    const mcp = await import("../src/app/api/mcp/route");
    for (const bearer of [apiToken, oauthToken]) {
      currentRequest = new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      try {
        const res = await mcp.POST(currentRequest);
        assert.equal(res.status, 200, "the connector accepts the token");
        const names: string[] = ((await res.json()).result?.tools ?? []).map((t: { name: string }) => t.name);
        assert.ok(names.includes("update_doc"), "update_doc is offered (and must decide, H2)");
        const confirming = names.filter((n) => /ack|confirm|attest|reconfirm/i.test(n));
        assert.deepEqual(confirming, [], "no connector tool confirms, re-confirms or attests");
      } finally {
        currentRequest = null;
      }
    }
  });
});

// --- The decision (H2) -----------------------------------------------------------

describe("the v1 API and the connector decide before they write", () => {
  test("v1 PATCH: 428 until the caller says keep or reset, 400 for a bad policy or reason, never for metadata", async () => {
    const policy = await confirmedPolicy(`${STAMP} v1 patch`);
    const v1 = await import("../src/app/api/v1/documents/[id]/route");
    const patch = (body: Record<string, unknown>) =>
      call(v1.PATCH as Handler, jsonRequest(`http://localhost/api/v1/documents/${policy.id}`, apiToken, body, "PATCH"), policy.id);
    const edited = TEXT.replace("Clause 1: staff", "Clause 1: all staff and contractors");

    // Undecided: refused with the standing and the measured change, verbatim
    // from the helper, and the document is untouched.
    const undecided = await patch({ content: edited });
    assert.equal(undecided.status, 428);
    assert.equal(undecided.body.error, ACK_DECISION_ERROR);
    assert.equal(undecided.body.decision_required, true);
    assert.equal(undecided.body.confirmations, 1);
    assert.ok(undecided.body.eligible >= 1);
    assert.equal(undecided.body.baseline, "v1");
    assert.equal(typeof undecided.body.change.pct, "number");
    assert.equal(typeof undecided.body.change.wordsChanged, "number");
    assert.ok(["keep", "reset"].includes(undecided.body.suggested));
    assert.equal((await getDocument(policy.id))!.content, TEXT, "a refused PATCH writes nothing");

    // A policy without a usable reason, and a policy that is not keep or reset.
    const noReason = await patch({ content: edited, ack_policy: "keep" });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error, ACK_REASON_ERROR);
    const badPolicy = await patch({ content: edited, ack_policy: "auto", ack_reason: "ten characters or more" });
    assert.equal(badPolicy.status, 400);
    assert.equal(badPolicy.body.error, ACK_POLICY_ERROR);
    assert.equal((await getDocument(policy.id))!.content, TEXT);

    // Metadata only: never refused, confirmations untouched, and the response
    // carries the standing like GET does. The one exception is a bad
    // ack_policy value, refused before the substantive gate as PUT refuses
    // it (decision 2), so 'auto' on a tag-only PATCH is still a 400.
    const taggedBad = await patch({ tags: ["e2e"], ack_policy: "auto" });
    assert.equal(taggedBad.status, 400);
    assert.equal(taggedBad.body.error, ACK_POLICY_ERROR);
    const tagged = await patch({ tags: ["e2e", "read-confirmation"], ack_policy: "keep" });
    assert.equal(tagged.status, 200, "a real policy with no reason on a metadata-only change is not refused");
    assert.deepEqual(tagged.body.document.tags, ["e2e", "read-confirmation"]);
    assert.equal(tagged.body.ack_outcome.changed, true);
    assert.equal(tagged.body.ack_outcome.substantive, false);
    assert.equal(tagged.body.document.ack.confirmations, 1);

    // Decided: keep leaves the confirmation standing and records why.
    const kept = await patch({ content: edited, ack_policy: "keep", ack_reason: "Named contractors explicitly; no new obligation" });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.ack_outcome.policy, "keep");
    assert.equal(kept.body.ack_outcome.reset, false);
    assert.equal(kept.body.ack_outcome.source, "api");
    assert.equal(kept.body.document.ack.confirmations, 1);
    assert.ok(await getCurrentAck(policy.id, adminId), "the confirmation still counts");
    const keptRow = (await listAckDecisions(policy.id))[0];
    assert.equal(keptRow.outcome, "kept");
    assert.equal(keptRow.source, "api");
    assert.equal(keptRow.decided_by, adminId);
    assert.equal(keptRow.reason, "Named contractors explicitly; no new obligation");

    // Decided: reset asks everyone again.
    const reset = await patch({
      content: `${edited}\n\nClause 31: expense claims over 75 need a receipt.`,
      ack_policy: "reset",
      ack_reason: "Receipts are now required over 75",
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ack_outcome.reset, true);
    assert.equal(reset.body.ack_outcome.confirmations_reset, 1);
    assert.equal(reset.body.document.ack.confirmations, 0);
    assert.equal(await getCurrentAck(policy.id, adminId), undefined, "the confirmation lapsed");
  });

  test("v1 PATCH: a draft never refuses, publishing a drifted draft does (the publish-of-drift rule)", async () => {
    const policy = await confirmedPolicy(`${STAMP} v1 publish`);
    const v1 = await import("../src/app/api/v1/documents/[id]/route");
    const patch = (body: Record<string, unknown>) =>
      call(v1.PATCH as Handler, jsonRequest(`http://localhost/api/v1/documents/${policy.id}`, apiToken, body, "PATCH"), policy.id);

    // Unpublish (metadata), edit the draft twice: the marker waits.
    assert.equal((await patch({ status: "draft" })).status, 200);
    const drifted = TEXT.replace("Clause 2:", "Clause 2 (amended):");
    assert.equal((await patch({ content: drifted })).status, 200, "a draft edit is never refused");
    assert.equal((await patch({ content: `${drifted}\n\nClause 31: new.` })).status, 200);
    assert.ok(await getCurrentAck(policy.id, adminId), "nothing lapsed while the document was a draft");

    // The publish is the transition the decision is taken at.
    const undecided = await patch({ status: "published" });
    assert.equal(undecided.status, 428);
    assert.equal(undecided.body.baseline, "v1");
    assert.equal((await getDocument(policy.id))!.status, "draft", "a refused publish stays a draft");
    const published = await patch({ status: "published", ack_policy: "reset", ack_reason: "Clause 2 amended and a clause added" });
    assert.equal(published.status, 200);
    assert.equal(published.body.document.status, "published");
    assert.equal(published.body.ack_outcome.reset, true);
    assert.equal((await listAckDecisions(policy.id))[0].source, "api");
  });

  test("MCP update_doc: decision_required with the numbers and a hint until ack_policy and ack_reason arrive", async () => {
    const policy = await confirmedPolicy(`${STAMP} mcp`);
    const edited = TEXT.replace("Clause 1: staff", "Clause 1: all staff and contractors");

    const undecided = await mcpCall(apiToken, "update_doc", { id: policy.id, markdown: edited });
    assert.equal(undecided.isError, false, "a question, not a failure");
    assert.equal(undecided.out.ok, false);
    assert.equal(undecided.out.decision_required, true);
    assert.equal(undecided.out.confirmations, 1);
    assert.ok(undecided.out.eligible >= 1);
    assert.equal(typeof undecided.out.change.pct, "number");
    assert.ok(["keep", "reset"].includes(undecided.out.suggested));
    assert.equal(
      undecided.out.hint,
      "Ask the person whether this is an editorial fix or a material change and why, then call update_doc again with ack_policy and ack_reason."
    );
    assert.equal((await getDocument(policy.id))!.content, TEXT, "nothing was saved");

    const short = await mcpCall(apiToken, "update_doc", { id: policy.id, markdown: edited, ack_policy: "reset", ack_reason: "typo" });
    assert.equal(short.out.ok, false);
    assert.equal(short.out.error, ACK_REASON_ERROR);

    // Metadata only passes without a policy; a bad value is refused all the
    // same (decision 2), as the v1 API and PUT refuse it.
    const taggedBad = await mcpCall(apiToken, "update_doc", { id: policy.id, tags: ["mcp"], ack_policy: "auto" });
    assert.equal(taggedBad.out.ok, false);
    assert.equal(taggedBad.out.error, ACK_POLICY_ERROR);
    const tagged = await mcpCall(apiToken, "update_doc", { id: policy.id, tags: ["mcp"] });
    assert.equal(tagged.out.ok, true);
    assert.ok(await getCurrentAck(policy.id, adminId));

    const decided = await mcpCall(apiToken, "update_doc", {
      id: policy.id,
      markdown: edited,
      ack_policy: "keep",
      ack_reason: "Named contractors explicitly; no new obligation",
    });
    assert.equal(decided.out.ok, true);
    assert.equal((await getDocument(policy.id))!.content, edited);
    const row = (await listAckDecisions(policy.id))[0];
    assert.equal(row.outcome, "kept");
    assert.equal(row.source, "mcp");
    assert.equal(row.decided_by, adminId);

    // publish: true on a drifted draft is the same question.
    assert.equal((await mcpCall(apiToken, "update_doc", { id: policy.id, publish: false })).out.ok, true);
    await pool().query("UPDATE documents SET status = 'draft' WHERE id = $1", [policy.id]);
    const draftEdit = await mcpCall(apiToken, "update_doc", { id: policy.id, markdown: `${edited}\n\nClause 31: new.` });
    assert.equal(draftEdit.out.ok, true, "a draft edit is never refused");
    const publishing = await mcpCall(apiToken, "update_doc", { id: policy.id, publish: true });
    assert.equal(publishing.out.decision_required, true);
    assert.equal((await getDocument(policy.id))!.status, "draft");
    const live = await mcpCall(apiToken, "update_doc", {
      id: policy.id,
      publish: true,
      ack_policy: "reset",
      ack_reason: "A clause was added while the draft was edited",
    });
    assert.equal(live.out.ok, true);
    assert.equal(live.out.status, "published");
    assert.equal(await getCurrentAck(policy.id, adminId), undefined, "everyone is asked again");
    // The connector's audit rows carry the caller's address like every
    // other path's (the decision echo and the document row alike).
    const echoed = await pool().query(
      "SELECT ip FROM audit_log WHERE action = 'ack.confirmations_reset' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [String(policy.id)]
    );
    assert.equal(echoed.rows[0]?.ip, CLIENT_IP, "the decision echo names the address");
    const edited2 = await pool().query(
      "SELECT ip FROM audit_log WHERE action = 'document.publish' AND target_id = $1 AND details->>'via' = 'mcp' ORDER BY id DESC LIMIT 1",
      [String(policy.id)]
    );
    assert.equal(edited2.rows[0]?.ip, CLIENT_IP, "the connector's own row too");
  });
});

// --- The keep side's reason follows Program settings (decision 1) -------------------

describe("a keep's reason follows Program settings on every path; a reset always needs one", () => {
  const admin = { id: 0, name: "Tok Admin" };
  const EDITED = TEXT.replace("Clause 1: staff", "Clause 1: all staff and contractors");
  let savedDefaults: string | undefined;
  // The settings row is shared with test/compliance-settings.test.ts and
  // test/ack-revision.test.ts, and node:test runs files in parallel: the
  // lock is held on one dedicated connection for the whole describe.
  let lockClient: PoolClient | null = null;

  before(async () => {
    admin.id = adminId;
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
    lockClient = client;
    savedDefaults = await getSetting("ack_defaults");
  });
  after(async () => {
    if (savedDefaults === undefined) await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    else await setSetting("ack_defaults", savedDefaults);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  async function keepReasonRequired(value: boolean) {
    await setSetting("ack_defaults", JSON.stringify({ edit_default: "ask", keep_reason_required: value }));
  }

  /** A draft branch of the policy with its own text, as the branch route makes one. */
  async function branchOf(policyId: number, content: string): Promise<number> {
    const source = (await getDocument(policyId))!;
    const branch = await createDocument({
      space_id: source.space_id,
      title: source.title,
      type: source.type,
      status: "draft",
      content,
      summary: source.summary,
      tags: source.tags,
      author: "Tok Admin",
      branch_of: source.id,
    });
    docIds.push(branch.id);
    return branch.id;
  }

  /** The policy with a second, confirmed version, so restoring v1 over it is a question. */
  async function policyOnV2(title: string): Promise<{ id: number; v1: number; v2: number }> {
    const policy = await confirmedPolicy(title);
    const moved = await updateDocument(policy.id, {
      content: EDITED,
      versionNote: "Contractors named",
      ackPolicy: "reset",
      ackReason: "Contractors are now covered by clause 1",
      ackActor: admin,
      ackSource: "edit",
    });
    assert.equal(moved!.ack_outcome!.reset, true);
    const v2 = (await listVersions(policy.id))[0].id;
    await recordAcknowledgement(policy.id, adminId, "", v2);
    return { id: policy.id, v1: policy.v1, v2 };
  }

  async function request(policyId: number, content: string, extra: { ack_policy?: unknown; ack_reason?: unknown } = {}) {
    return createChangeRequest({
      document_id: policyId,
      kind: "edit",
      title: (await getDocument(policyId))!.title,
      content,
      summary: "",
      tags: [],
      type: "policy",
      target_status: "published",
      note: "Reworded the first clause",
      created_by: adminId,
      ack_policy: extra.ack_policy,
      ack_reason: extra.ack_reason,
    });
  }

  test("with the setting off a keep with an empty reason lands on v1, the connector, merge, restore and the review route; a reset with none is still 400", async () => {
    await keepReasonRequired(false);
    const v1 = await import("../src/app/api/v1/documents/[id]/route");
    const merge = await import("../src/app/api/documents/[id]/merge/route");
    const restore = await import("../src/app/api/documents/[id]/versions/[vid]/restore/route");
    const review = await import("../src/app/api/change-requests/[id]/route");

    // v1 PATCH.
    const p1 = await confirmedPolicy(`${STAMP} keep off v1`);
    const resetShort = await call(
      v1.PATCH as Handler,
      jsonRequest(`http://localhost/api/v1/documents/${p1.id}`, apiToken, { content: EDITED, ack_policy: "reset", ack_reason: "" }, "PATCH"),
      p1.id
    );
    assert.equal(resetShort.status, 400, "a reset always needs its reason");
    assert.equal(resetShort.body.error, ACK_REASON_ERROR);
    const kept = await call(
      v1.PATCH as Handler,
      jsonRequest(`http://localhost/api/v1/documents/${p1.id}`, apiToken, { content: EDITED, ack_policy: "keep", ack_reason: "" }, "PATCH"),
      p1.id
    );
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.ack_outcome.policy, "keep");
    assert.equal(kept.body.ack_outcome.reset, false);
    assert.ok(await getCurrentAck(p1.id, adminId));
    assert.equal((await listAckDecisions(p1.id))[0].reason, "", "whatever was given is recorded");

    // The connector.
    const p2 = await confirmedPolicy(`${STAMP} keep off mcp`);
    const mcpReset = await mcpCall(apiToken, "update_doc", { id: p2.id, markdown: EDITED, ack_policy: "reset", ack_reason: "" });
    assert.equal(mcpReset.out.ok, false);
    assert.equal(mcpReset.out.error, ACK_REASON_ERROR);
    const mcpKept = await mcpCall(apiToken, "update_doc", { id: p2.id, markdown: EDITED, ack_policy: "keep", ack_reason: "" });
    assert.equal(mcpKept.out.ok, true, JSON.stringify(mcpKept.out));
    assert.ok(await getCurrentAck(p2.id, adminId));
    assert.equal((await listAckDecisions(p2.id))[0].source, "mcp");

    // Merge, through the handler with the admin's session.
    const p3 = await confirmedPolicy(`${STAMP} keep off merge`);
    const b3 = await branchOf(p3.id, EDITED);
    const mergeReset = await call(
      merge.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${b3}/merge`, sessionToken, { ack_policy: "reset", ack_reason: "" }),
      b3
    );
    assert.equal(mergeReset.status, 400, JSON.stringify(mergeReset.body));
    assert.equal(mergeReset.body.error, ACK_REASON_ERROR);
    const merged = await call(
      merge.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${b3}/merge`, sessionToken, { ack_policy: "keep", ack_reason: "" }),
      b3
    );
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.ack_outcome.policy, "keep");
    assert.equal(merged.body.ack_outcome.source, "merge");
    assert.equal((await getDocument(p3.id))!.content, EDITED);
    assert.ok(await getCurrentAck(p3.id, adminId));
    assert.equal((await listAckDecisions(p3.id))[0].source, "merge");

    // Restore, the same way: v1 back over the confirmed v2.
    const p4 = await policyOnV2(`${STAMP} keep off restore`);
    const restoreReset = await callWith(
      restore.POST as unknown as AnyHandler,
      sessionRequest(`http://localhost/api/documents/${p4.id}/versions/${p4.v1}/restore`, sessionToken, { ack_policy: "reset", ack_reason: "" }),
      { id: String(p4.id), vid: String(p4.v1) }
    );
    assert.equal(restoreReset.status, 400, JSON.stringify(restoreReset.body));
    assert.equal(restoreReset.body.error, ACK_REASON_ERROR);
    const restored = await callWith(
      restore.POST as unknown as AnyHandler,
      sessionRequest(`http://localhost/api/documents/${p4.id}/versions/${p4.v1}/restore`, sessionToken, {
        label: "1",
        ack_policy: "keep",
        ack_reason: "",
      }),
      { id: String(p4.id), vid: String(p4.v1) }
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.ack_outcome.policy, "keep");
    assert.equal(restored.body.ack_outcome.source, "restore");
    assert.equal((await getDocument(p4.id))!.content, TEXT);
    assert.ok(await getCurrentAck(p4.id, adminId));
    assert.match((await listVersions(p4.id))[0].note, /^Restored version 1 from \d{4}-\d{2}-\d{2}$/, "no note sent: the default version note");

    // The review route: the approver's own keep with no reason, and a stored
    // keep with a four-character reason, both apply.
    const p5 = await confirmedPolicy(`${STAMP} keep off review`);
    const cr5 = await request(p5.id, EDITED);
    const approveReset = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr5}`, sessionToken, { action: "approve", ack_policy: "reset", ack_reason: "" }, "PATCH"),
      cr5
    );
    assert.equal(approveReset.status, 400, JSON.stringify(approveReset.body));
    assert.equal(approveReset.body.error, ACK_REASON_ERROR);
    assert.equal((await getChangeRequest(cr5))!.status, "pending");
    const approved = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr5}`, sessionToken, { action: "approve", ack_policy: "keep", ack_reason: "" }, "PATCH"),
      cr5
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.ack_outcome.policy, "keep");
    assert.ok(await getCurrentAck(p5.id, adminId));
    const p6 = await confirmedPolicy(`${STAMP} keep off stored`);
    const cr6 = await request(p6.id, EDITED, { ack_policy: "keep", ack_reason: "typo" });
    const storedKeep = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr6}`, sessionToken, { action: "approve" }, "PATCH"),
      cr6
    );
    assert.equal(storedKeep.status, 200, JSON.stringify(storedKeep.body));
    assert.equal(storedKeep.body.ack_outcome.policy, "keep");
    assert.equal((await listAckDecisions(p6.id))[0].reason, "typo", "the submitter's reason, as they gave it");
  });

  test("with the setting on the same keep is 400 on every path, and a stored recommendation the rule refuses counts as none: 428, never a 400 to an approver who sent no reason", async () => {
    await keepReasonRequired(true);
    const v1 = await import("../src/app/api/v1/documents/[id]/route");
    const merge = await import("../src/app/api/documents/[id]/merge/route");
    const restore = await import("../src/app/api/documents/[id]/versions/[vid]/restore/route");
    const review = await import("../src/app/api/change-requests/[id]/route");

    const p1 = await confirmedPolicy(`${STAMP} keep on v1`);
    const patched = await call(
      v1.PATCH as Handler,
      jsonRequest(`http://localhost/api/v1/documents/${p1.id}`, apiToken, { content: EDITED, ack_policy: "keep", ack_reason: "" }, "PATCH"),
      p1.id
    );
    assert.equal(patched.status, 400);
    assert.equal(patched.body.error, ACK_REASON_ERROR);
    assert.equal((await getDocument(p1.id))!.content, TEXT);

    const mcpKeep = await mcpCall(apiToken, "update_doc", { id: p1.id, markdown: EDITED, ack_policy: "keep", ack_reason: "" });
    assert.equal(mcpKeep.out.ok, false);
    assert.equal(mcpKeep.out.error, ACK_REASON_ERROR);

    const b1 = await branchOf(p1.id, EDITED);
    const merged = await call(
      merge.POST as Handler,
      sessionRequest(`http://localhost/api/documents/${b1}/merge`, sessionToken, { ack_policy: "keep", ack_reason: "" }),
      b1
    );
    assert.equal(merged.status, 400, JSON.stringify(merged.body));
    assert.equal(merged.body.error, ACK_REASON_ERROR);
    assert.equal((await getDocument(b1))!.deleted_at, null, "a refused merge leaves the branch where it was");

    const p2 = await policyOnV2(`${STAMP} keep on restore`);
    const restored = await callWith(
      restore.POST as unknown as AnyHandler,
      sessionRequest(`http://localhost/api/documents/${p2.id}/versions/${p2.v1}/restore`, sessionToken, { ack_policy: "keep", ack_reason: "" }),
      { id: String(p2.id), vid: String(p2.v1) }
    );
    assert.equal(restored.status, 400, JSON.stringify(restored.body));
    assert.equal(restored.body.error, ACK_REASON_ERROR);
    assert.equal((await getDocument(p2.id))!.content, EDITED);
    // The dialog's note is the version note (A6): `note` on the body.
    const withNote = await callWith(
      restore.POST as unknown as AnyHandler,
      sessionRequest(`http://localhost/api/documents/${p2.id}/versions/${p2.v1}/restore`, sessionToken, {
        label: "1",
        note: "Reverting the contractors clause; the published rule stands",
        ack_policy: "keep",
        ack_reason: "Reverting the contractors clause; the published rule stands",
      }),
      { id: String(p2.id), vid: String(p2.v1) }
    );
    assert.equal(withNote.status, 200, JSON.stringify(withNote.body));
    assert.equal((await listVersions(p2.id))[0].note, "Reverting the contractors clause; the published rule stands");
    assert.equal((await listAckDecisions(p2.id))[0].reason, "Reverting the contractors clause; the published rule stands");

    // The review route: the approver's keep with no reason is 400; a stored
    // keep with a short reason (the v1 and MCP branches store it unchecked)
    // is no recommendation for the pre-flight, so an approval that sends
    // nothing is 428 with the numbers and the request stays pending; the
    // approver's own decision then lands it. A stored reset with a short
    // reason is the same.
    const p3 = await confirmedPolicy(`${STAMP} keep on review`);
    const cr3 = await request(p3.id, EDITED, { ack_policy: "keep", ack_reason: "typo" });
    const ownKeep = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr3}`, sessionToken, { action: "approve", ack_policy: "keep", ack_reason: "" }, "PATCH"),
      cr3
    );
    assert.equal(ownKeep.status, 400, JSON.stringify(ownKeep.body));
    assert.equal(ownKeep.body.error, ACK_REASON_ERROR);
    const asked = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr3}`, sessionToken, { action: "approve" }, "PATCH"),
      cr3
    );
    assert.equal(asked.status, 428, JSON.stringify(asked.body));
    assert.equal(asked.body.error, ACK_DECISION_ERROR);
    assert.equal(asked.body.decision_required, true);
    assert.equal(asked.body.confirmations, 1);
    assert.equal(asked.body.baseline, "v1");
    assert.equal((await getChangeRequest(cr3))!.status, "pending");
    assert.equal((await getDocument(p3.id))!.content, TEXT, "nothing was applied");
    const p4 = await confirmedPolicy(`${STAMP} keep on stored reset`);
    const cr4 = await request(p4.id, EDITED, { ack_policy: "reset", ack_reason: "short" });
    const askedReset = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr4}`, sessionToken, { action: "approve" }, "PATCH"),
      cr4
    );
    assert.equal(askedReset.status, 428, JSON.stringify(askedReset.body));
    const decided = await call(
      review.PATCH as Handler,
      sessionRequest(`http://localhost/api/change-requests/${cr4}`, sessionToken, {
        action: "approve",
        ack_policy: "keep",
        ack_reason: "Named contractors explicitly; no new obligation",
      }, "PATCH"),
      cr4
    );
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.ack_outcome.policy, "keep");
    assert.equal((await getChangeRequest(cr4))!.status, "approved");
    const [row] = await listAckDecisions(p4.id);
    assert.equal(row.submitted_policy, "reset", "the recommendation stays on the row");
    assert.equal(row.reason, "Named contractors explicitly; no new obligation");
    assert.equal((await listVersions(p4.id))[0].note, "Named contractors explicitly; no new obligation — approved by Tok Admin", "the approver's reason is the version note");
    // The approval's audit row says what was applied, in the scheduler's words.
    const approveRow = await pool().query(
      "SELECT details, ip FROM audit_log WHERE action = 'change_request.approve' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [String(cr4)]
    );
    assert.deepEqual(approveRow.rows[0]?.details, { ack_policy: "keep", confirmations_reset: 0, submitted_policy: "reset" });
    assert.equal(approveRow.rows[0]?.ip, CLIENT_IP);
  });
});

// --- The side doors (G2): one image line, whatever the alt carries ------------------

describe("the side doors place exactly one image line", () => {
  /** Twelve bytes that pass sniffImage as a PNG; the intakes validate the type by its magic, not its size. */
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  test("imageAltText keeps one line of plain words", () => {
    assert.equal(imageAltText("Diagram"), "Diagram");
    assert.equal(imageAltText("  Screenshot of the form  "), "Screenshot of the form");
    assert.equal(imageAltText("x](https://example.test/p.png) **Clause 31**.png"), "x https://example.test/p.png **Clause 31**.png");
    assert.equal(imageAltText("Diagram\n\n## New clause\n\nContractors are exempt"), "Diagram ## New clause Contractors are exempt");
    assert.equal(imageAltText("<img src=x>`code`\\"), "img src=x code");
    assert.equal(imageAltText(""), "image");
    assert.equal(imageAltText(undefined), "image");
    assert.equal(imageAltText("[]()"), "image");
    assert.equal(imageAltText("a".repeat(400)).length, 300);
  });

  test("add_image through the connector: an alt with blank lines and brackets becomes one inline image, the kept row unchanged", async () => {
    const policy = await confirmedPolicy(`${STAMP} add_image alt`);
    const before = (await getDocument(policy.id))!.content;
    const placed = await mcpCall(apiToken, "add_image", {
      doc_id: policy.id,
      data: PNG.toString("base64"),
      insert: "append",
      alt: "Diagram\n\n## New clause\n\n**Clause 31: contractors are exempt**](https://example.test/p.png)",
    });
    assert.equal(placed.isError, false, JSON.stringify(placed.out));
    assert.equal(placed.out.ok, true);
    assert.equal(placed.out.inserted, true);
    const attachmentId = placed.out.attachment_id;
    assert.ok(attachmentId);
    const expectedAlt = "Diagram ## New clause **Clause 31: contractors are exempt** https://example.test/p.png";
    assert.equal(placed.out.markdown, `![${expectedAlt}](/api/attachments/${attachmentId})`);
    const doc = (await getDocument(policy.id))!;
    assert.equal(doc.content, `${before}\n\n![${expectedAlt}](/api/attachments/${attachmentId})\n`, "one image line, no heading, no second image");
    // Kept, from source 'image', the standing unchanged.
    const [row] = await listAckDecisions(policy.id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.source, "image");
    assert.equal(row.decided_by, adminId);
    assert.equal(row.reason, "Added image");
    assert.equal((await ackSummary(policy.id)).current, 1);
    assert.ok(await getCurrentAck(policy.id, adminId));
    const echo = await pool().query(
      "SELECT details, ip FROM audit_log WHERE action = 'ack.confirmations_kept' AND target_id = $1 ORDER BY id DESC LIMIT 1",
      [String(policy.id)]
    );
    assert.equal(echo.rows[0]?.details?.source, "image");
    assert.equal(echo.rows[0]?.ip, CLIENT_IP, "the connector's decision echo carries the address");
  });

  test("a drop link: a hostile file name on a ticket with no alt becomes one inline image", async () => {
    const dropFile = (await import("../src/app/api/upload-tickets/[token]/route")).POST;
    const policy = await confirmedPolicy(`${STAMP} drop alt`);
    const before = (await getDocument(policy.id))!.content;
    const ticket = await createUploadTicket({ documentId: policy.id, userId: adminId, insert: "append", alt: "" });
    const form = new FormData();
    form.append("file", new File([PNG], "x](https://example.test/p.png) **Clause 31**.png", { type: "image/png" }));
    const dropped = await callWith(
      dropFile as unknown as AnyHandler,
      new Request(`http://localhost/api/upload-tickets/${ticket.token}`, { method: "POST", body: form }),
      { token: ticket.token }
    );
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    assert.equal(dropped.body.inserted, true);
    const attachmentId = Number(String(dropped.body.url).split("/").pop());
    const doc = (await getDocument(policy.id))!;
    assert.equal(
      doc.content,
      `${before}\n\n![x https://example.test/p.png **Clause 31**.png](/api/attachments/${attachmentId})\n`,
      "one image line, no second image, no bold clause"
    );
    const [row] = await listAckDecisions(policy.id);
    assert.equal(row.outcome, "kept");
    assert.equal(row.source, "ticket");
    assert.equal((await ackSummary(policy.id)).current, 1);
  });
});

// --- The import guard (H2 / G2) ----------------------------------------------------

describe("the import guard", () => {
  async function zipWith(docs: { title: string; content: string; status?: "published" | "draft" }[]): Promise<Buffer> {
    const zip = new JSZip();
    for (const d of docs) {
      zip.file(
        `documents/${STAMP}/${d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
        `---\ntitle: "${d.title}"\ntype: policy\nstatus: ${d.status ?? "published"}\nspace: ${STAMP}\n---\n${d.content}`
      );
    }
    return zip.generateAsync({ type: "nodebuffer" });
  }

  test("a published policy is left unchanged and named unless overwrite_policies is on; the result counts the re-asks", async () => {
    const policy = await confirmedPolicy(`${STAMP} import`);
    const plainTitle = `${STAMP} plain`;
    const edited = TEXT.replace("Clause 3:", "Clause 3 (revised):");
    const buf = await zipWith([
      { title: `${STAMP} import`, content: edited },
      { title: plainTitle, content: "An ordinary document." },
    ]);
    const importer = { id: adminId, name: "Tok Admin" };

    const guarded = await importFromZip(buf, importer);
    assert.equal(guarded.created, 1, "the ordinary document is created");
    assert.equal(guarded.updated, 0);
    assert.equal(guarded.skipped, 1);
    assert.equal(guarded.policies_skipped, 1);
    assert.equal(guarded.reconfirm_requested, 0);
    assert.equal(guarded.errors.length, 1);
    assert.ok(guarded.errors[0].includes(`"${STAMP} import" ${IMPORT_POLICY_SKIPPED}`), guarded.errors[0]);
    assert.equal((await getDocument(policy.id))!.content, TEXT, "the policy is untouched");
    assert.ok(await getCurrentAck(policy.id, adminId));

    const allowed = await importFromZip(buf, importer, {
      overwritePolicies: true,
      audit: { actor: { id: adminId, name: "Tok Admin", role: "admin" }, ip: CLIENT_IP },
    });
    assert.equal(allowed.updated, 2, "both documents now update in place");
    assert.equal(allowed.policies_skipped, 0);
    assert.equal(allowed.reconfirm_requested, 1, "one policy will ask people to re-confirm");
    assert.equal((await getDocument(policy.id))!.content, edited);
    assert.equal(await getCurrentAck(policy.id, adminId), undefined, "the confirmation lapsed");
    const row = (await listAckDecisions(policy.id))[0];
    assert.equal(row.outcome, "reset");
    assert.equal(row.source, "import");
    assert.equal(row.decided_by, adminId);
    assert.equal(row.decided_by_name, "Tok Admin");
    assert.equal(row.reason, "Imported");
    // The decision is echoed to the audit log with the importer and their
    // address, as every other write path echoes its own (C1).
    const echo = await pool().query(
      "SELECT actor_id, actor_name, ip, details FROM audit_log WHERE action = 'ack.confirmations_reset' AND target_id = $1",
      [String(policy.id)]
    );
    assert.equal(echo.rows.length, 1, "one echo for the one reset");
    assert.equal(echo.rows[0].actor_id, adminId);
    assert.equal(echo.rows[0].actor_name, "Tok Admin");
    assert.equal(echo.rows[0].ip, CLIENT_IP);
    assert.equal(echo.rows[0].details.source, "import");
    assert.equal(echo.rows[0].details.version_id, (await listVersions(policy.id))[0].id);

    // Nothing changed: the second allowed import is not a re-ask, and no
    // second echo.
    const again = await importFromZip(buf, importer, { overwritePolicies: true, audit: { actor: { id: adminId, name: "Tok Admin" }, ip: null } });
    assert.equal(again.reconfirm_requested, 0);
    assert.equal(
      (await pool().query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.confirmations_reset' AND target_id = $1", [String(policy.id)])).rows[0].n,
      1
    );
  });

  test("a paused policy the zip would publish again needs the box too; a zip that keeps it a draft edits the draft", async () => {
    const policy = await confirmedPolicy(`${STAMP} import paused`);
    const importer = { id: adminId, name: "Tok Admin" };
    const edited = TEXT.replace("Clause 4:", "Clause 4 (revised):");
    // Unpublished with the requirement on: paused (G2), the confirmation kept.
    const down = await updateDocument(policy.id, { status: "draft", ackActor: importer, ackSource: "edit" });
    assert.equal(down!.ack_outcome!.substantive, false);
    assert.ok(await getCurrentAck(policy.id, adminId));

    // The zip says published with a changed body: that is the publish of a
    // drifted draft, skipped and counted until the box is ticked.
    const publishing = await zipWith([{ title: `${STAMP} import paused`, content: edited, status: "published" }]);
    const guarded = await importFromZip(publishing, importer);
    assert.equal(guarded.updated, 0);
    assert.equal(guarded.skipped, 1);
    assert.equal(guarded.policies_skipped, 1, "the paused policy is guarded like a live one");
    assert.equal(guarded.reconfirm_requested, 0);
    assert.ok(guarded.errors[0].includes(IMPORT_POLICY_SKIPPED), guarded.errors[0]);
    const untouched = (await getDocument(policy.id))!;
    assert.equal(untouched.status, "draft", "still paused");
    assert.equal(untouched.content, TEXT);
    assert.ok(await getCurrentAck(policy.id, adminId), "the confirmation still counts");

    // A zip that keeps it a draft edits the draft without the box: the
    // decision waits for the publish, as it does for every draft edit.
    const drafting = await zipWith([{ title: `${STAMP} import paused`, content: edited, status: "draft" }]);
    const drafted = await importFromZip(drafting, importer);
    assert.equal(drafted.updated, 1);
    assert.equal(drafted.policies_skipped, 0);
    assert.equal(drafted.reconfirm_requested, 0, "nothing decided while it is a draft");
    assert.equal((await getDocument(policy.id))!.content, edited);
    assert.equal((await getDocument(policy.id))!.status, "draft");
    assert.ok(await getCurrentAck(policy.id, adminId));

    // With the box the publish lands, the edit default decides ('ask':
    // everyone again), and the result counts it.
    const allowed = await importFromZip(publishing, importer, { overwritePolicies: true });
    assert.equal(allowed.updated, 1);
    assert.equal(allowed.reconfirm_requested, 1, "the publish of the drifted text asks everyone again");
    assert.equal((await getDocument(policy.id))!.status, "published");
    assert.equal(await getCurrentAck(policy.id, adminId), undefined, "the confirmation lapsed");
    assert.equal((await listAckDecisions(policy.id))[0].source, "import");
  });
});
