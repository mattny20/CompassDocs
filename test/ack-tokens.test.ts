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
// draft asks like an edit. The third is the import guard: a published policy
// is left unchanged and named unless overwrite_policies is on, and the result
// counts the policies whose readers will be asked again.
//
// The route handlers are called directly. They read the request scope
// through next/headers, which exists only inside Next's server, so this file
// resolves next/headers to a stub that serves the headers of the request
// under test (the Authorization header included, so the invariant is
// exercised, not bypassed) and finds whatever cookies that request carries,
// which is none. `@ee` is a bundler alias (next.config.js) and resolves to
// the community stub here. Both are wired before the routes load (they are
// imported inside the tests), and nothing else in the graph needs Next.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import JSZip from "jszip";
import {
  pool,
  getSetting,
  createDocument,
  getDocument,
  setAckRequired,
  listVersions,
  listAckDecisions,
  recordAcknowledgement,
  getCurrentAck,
  createApiToken,
  registerOAuthClient,
  createOAuthTokens,
  getUserByApiToken,
  getUserByOAuthToken,
} from "../src/lib/db";
import { ACK_DECISION_ERROR, ACK_REASON_ERROR, ACK_POLICY_ERROR } from "../src/lib/ack-decision";
import { importFromZip, IMPORT_POLICY_SKIPPED } from "../src/lib/transfer";
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

/** Call a route handler the way Next would, with this request in scope. */
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

function jsonRequest(url: string, bearer: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
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
const docIds: number[] = [];

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
});

after(async () => {
  await pool().query("DELETE FROM api_tokens WHERE user_id = $1", [adminId]);
  await pool().query("DELETE FROM oauth_tokens WHERE user_id = $1", [adminId]);
  await pool().query("DELETE FROM oauth_clients WHERE client_id = $1", [oauthClientId]);
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
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
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
    // carries the standing like GET does.
    const tagged = await patch({ tags: ["e2e", "read-confirmation"] });
    assert.equal(tagged.status, 200);
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

    // Metadata only passes without a policy.
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
  });
});

// --- The import guard (H2 / G2) ----------------------------------------------------

describe("the import guard", () => {
  async function zipWith(docs: { title: string; content: string }[]): Promise<Buffer> {
    const zip = new JSZip();
    for (const d of docs) {
      zip.file(
        `documents/${STAMP}/${d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
        `---\ntitle: "${d.title}"\ntype: policy\nstatus: published\nspace: ${STAMP}\n---\n${d.content}`
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

    const allowed = await importFromZip(buf, importer, { overwritePolicies: true });
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

    // Nothing changed: the second allowed import is not a re-ask.
    const again = await importFromZip(buf, importer, { overwritePolicies: true });
    assert.equal(again.reconfirm_requested, 0);
  });
});
