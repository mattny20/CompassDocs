import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.11.0 (H2): a v1 or MCP edit to the text of a policy people have
// confirmed must say keep or reset. The policy below is created through the
// session API, the admin confirms it there, and every edit goes through the
// bearer token. Read confirmation is entitlement-gated (policy_ack): the flow
// skips itself when the requirement answers 402 and runs in full on the EE
// rig, like e2e/acknowledgements.spec.ts.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const CLAUSES = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);
const DECISION_ERROR =
  'This document requires read confirmation. Pass ack_policy "keep" (editorial fix) or "reset" (material change), with ack_reason.';
const REASON_ERROR = "ack_reason is required when the text of a confirmed policy changes.";
const POLICY_ERROR = 'ack_policy must be "keep" or "reset".';
const MCP_HINT =
  "Ask the person whether this is an editorial fix or a material change and why, then call update_doc again with ack_policy and ack_reason.";

async function mintToken(page: Page, name: string): Promise<{ token: string; id: number }> {
  const minted = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name, scopes: ["read", "write"] },
  });
  expect(minted.status).toBe(201);
  return { token: minted.body.token as string, id: minted.body.record.id as number };
}

/** A published policy the admin has confirmed; "unlicensed" on the community build. */
async function confirmedPolicy(page: Page, title: string): Promise<{ id: number } | "unlicensed"> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: CLAUSES, tags: [] },
  });
  expect(made.status, "policy created").toBe(201);
  const id = made.body?.doc?.id as number;
  const required = await api(page, `/api/documents/${id}/ack`, { method: "PATCH", body: { required: true } });
  if (required.status === 402) {
    await api(page, `/api/documents/${id}`, { method: "DELETE" });
    return "unlicensed";
  }
  expect(required.status).toBe(200);
  const summary = await api(page, `/api/documents/${id}/ack`);
  const confirmed = await api(page, `/api/documents/${id}/ack`, {
    method: "POST",
    body: { version_id: summary.body.latest_version_id, reached_end: true },
  });
  expect(confirmed.status, "the admin confirms through the session").toBe(200);
  return { id };
}

function v1(request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: (id: number) => request.get(`/api/v1/documents/${id}`, { headers }),
    patch: (id: number, data: Record<string, unknown>) => request.patch(`/api/v1/documents/${id}`, { headers, data }),
  };
}

async function mcp(request: APIRequestContext, token: string, tool: string, args: Record<string, unknown>) {
  const res = await request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { isError: body.result?.isError === true, out: JSON.parse(body.result?.content?.[0]?.text ?? "null") };
}

test("v1 PATCH on a confirmed policy: 428 until the caller decides, never for metadata; GET carries the standing; a drifted draft asks at publish", async ({
  page,
  request,
}) => {
  await login(page, ADMIN);
  const minted = await mintToken(page, `e2e-v1-ack-${stamp()}`);
  let docId: number | undefined;
  try {
    const policy = await confirmedPolicy(page, `E2E v1 ack ${stamp()}`);
    test.skip(policy === "unlicensed", "policy_ack is not licensed in this build; the EE rig runs the flow");
    if (policy === "unlicensed") return;
    docId = policy.id;
    const docs = v1(request, minted.token);

    // GET: the standing an integration needs before it edits.
    const read = await docs.get(docId);
    expect(read.status()).toBe(200);
    const before = (await read.json()).document;
    expect(before.ack_required).toBe(true);
    expect(before.ack_edit_default).toBe("ask");
    expect(before.ack.confirmations).toBe(1);
    expect(before.ack.eligible).toBeGreaterThanOrEqual(1);
    expect(before.ack.version).toBe("v1");

    // Undecided: 428 with the helper's body, verbatim, and nothing written.
    const edited = CLAUSES.replace("Clause 1: staff", "Clause 1: all staff and contractors");
    const undecided = await docs.patch(docId, { content: edited });
    expect(undecided.status()).toBe(428);
    const refusal = await undecided.json();
    expect(refusal.error).toBe(DECISION_ERROR);
    expect(refusal.decision_required).toBe(true);
    expect(refusal.confirmations).toBe(1);
    expect(refusal.baseline).toBe("v1");
    expect(typeof refusal.change.pct).toBe("number");
    expect(["keep", "reset"]).toContain(refusal.suggested);
    expect((await (await docs.get(docId)).json()).document.content).toBe(CLAUSES);

    // A policy without a reason, and a policy that is neither keep nor reset.
    const noReason = await docs.patch(docId, { content: edited, ack_policy: "keep" });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).error).toBe(REASON_ERROR);
    const badPolicy = await docs.patch(docId, { content: edited, ack_policy: "auto", ack_reason: "ten characters or more" });
    expect(badPolicy.status()).toBe(400);
    expect((await badPolicy.json()).error).toBe(POLICY_ERROR);

    // Metadata only never refuses and resets nobody.
    const tagged = await docs.patch(docId, { tags: ["e2e", "read-confirmation"] });
    expect(tagged.status()).toBe(200);
    const taggedBody = await tagged.json();
    expect(taggedBody.ack_outcome.substantive).toBe(false);
    expect(taggedBody.document.ack.confirmations).toBe(1);

    // Decided: 200 with the outcome; keep leaves the confirmation standing.
    const kept = await docs.patch(docId, {
      content: edited,
      ack_policy: "keep",
      ack_reason: "Named contractors explicitly; no new obligation",
    });
    expect(kept.status()).toBe(200);
    const keptBody = await kept.json();
    expect(keptBody.ack_outcome.policy).toBe("keep");
    expect(keptBody.ack_outcome.reset).toBe(false);
    expect(keptBody.document.ack.confirmations).toBe(1);
    const ledger = await api(page, `/api/documents/${docId}/ack`);
    expect(ledger.body.last_decision.outcome).toBe("kept");
    expect(ledger.body.last_decision.source).toBe("api");

    // Reset asks everyone again.
    const reset = await docs.patch(docId, {
      content: `${edited}\n\nClause 31: expense claims over 75 need a receipt.`,
      ack_policy: "reset",
      ack_reason: "Receipts are now required over 75",
    });
    expect(reset.status()).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.ack_outcome.reset).toBe(true);
    expect(resetBody.ack_outcome.confirmations_reset).toBe(1);
    expect(resetBody.document.ack.confirmations).toBe(0);

    // Publish-of-drift: unpublish (metadata), edit the draft freely, and the
    // publish is where the question is asked.
    expect((await docs.patch(docId, { status: "draft" })).status()).toBe(200);
    const live = (await (await docs.get(docId)).json()).document;
    expect((await docs.patch(docId, { content: `${live.content}\n\nClause 32: added while a draft.` })).status()).toBe(200);
    const publishing = await docs.patch(docId, { status: "published" });
    expect(publishing.status()).toBe(428);
    expect((await (await docs.get(docId)).json()).document.status).toBe("draft");
    const published = await docs.patch(docId, {
      status: "published",
      ack_policy: "reset",
      ack_reason: "A clause was added while the draft was edited",
    });
    expect(published.status()).toBe(200);
    expect((await published.json()).document.status).toBe("published");

    // The invariant: the same token edits a policy and cannot confirm one.
    // `request` carries no session cookie, so the bearer is all these calls
    // have, and the confirmation routes never read it.
    const summary = await api(page, `/api/documents/${docId}/ack`);
    const confirm = await request.post(`/api/documents/${docId}/ack`, {
      headers: { authorization: `Bearer ${minted.token}` },
      data: { version_id: summary.body.latest_version_id, reached_end: true },
    });
    expect(confirm.status(), "a token never confirms").toBe(401);
    const reask = await request.post(`/api/documents/${docId}/ack/reconfirm`, {
      headers: { authorization: `Bearer ${minted.token}` },
      data: { reason: "Section 4 now applies to contractors too" },
    });
    expect(reask.status(), "a token never re-asks").toBe(401);
    expect((await api(page, `/api/documents/${docId}/ack`)).body.current, "nothing was recorded").toBe(0);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await api(page, `/api/account/tokens/${minted.id}`, { method: "DELETE" });
  }
});

test("mcp update_doc on a confirmed policy: decision_required with a hint until ack_policy and ack_reason arrive", async ({
  page,
  request,
}) => {
  await login(page, ADMIN);
  const minted = await mintToken(page, `e2e-mcp-ack-${stamp()}`);
  let docId: number | undefined;
  try {
    const policy = await confirmedPolicy(page, `E2E mcp ack ${stamp()}`);
    test.skip(policy === "unlicensed", "policy_ack is not licensed in this build; the EE rig runs the flow");
    if (policy === "unlicensed") return;
    docId = policy.id;

    // read_doc says the document requires confirmation, with the standing.
    const readBack = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${minted.token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_doc", arguments: { id: docId } } },
    });
    expect((await readBack.json()).result.content[0].text).toContain("> read confirmation: required · 1 of ");

    const edited = CLAUSES.replace("Clause 1: staff", "Clause 1: all staff and contractors");
    const undecided = await mcp(request, minted.token, "update_doc", { id: docId, markdown: edited });
    expect(undecided.isError, "a question, not a failure").toBe(false);
    expect(undecided.out.ok).toBe(false);
    expect(undecided.out.decision_required).toBe(true);
    expect(undecided.out.confirmations).toBe(1);
    expect(undecided.out.hint).toBe(MCP_HINT);
    expect((await api(page, `/api/documents/${docId}`)).body.doc.content, "nothing was saved").toBe(CLAUSES);

    const short = await mcp(request, minted.token, "update_doc", { id: docId, markdown: edited, ack_policy: "reset", ack_reason: "typo" });
    expect(short.out.ok).toBe(false);
    expect(short.out.error).toBe(REASON_ERROR);

    const tagged = await mcp(request, minted.token, "update_doc", { id: docId, tags: ["mcp"] });
    expect(tagged.out.ok, "metadata only never asks").toBe(true);

    const decided = await mcp(request, minted.token, "update_doc", {
      id: docId,
      markdown: edited,
      ack_policy: "reset",
      ack_reason: "Contractors are now covered by clause 1",
    });
    expect(decided.out.ok).toBe(true);
    const after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body.current).toBe(0);
    expect(after.body.last_decision.outcome).toBe("reset");
    expect(after.body.last_decision.source).toBe("mcp");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await api(page, `/api/account/tokens/${minted.id}`, { method: "DELETE" });
  }
});

// The public REST API: token minting, scopes, and the auth matrix.
test("v1 tokens: scopes enforced, introspection works", async ({ page, request }) => {
  await login(page, ADMIN);

  const rw = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: "e2e-rw", scopes: ["read", "write"] },
  });
  const ro = await api(page, "/api/account/tokens", {
    method: "POST",
    body: { name: "e2e-ro", scopes: ["read"] },
  });
  expect(rw.status).toBe(201);
  expect(ro.status).toBe(201);

  // No token → 401.
  expect((await request.get("/api/v1/me")).status()).toBe(401);

  // Introspection reflects the token's scopes.
  const me = await request.get("/api/v1/me", {
    headers: { authorization: `Bearer ${ro.body.token}` },
  });
  expect(me.status()).toBe(200);
  expect((await me.json()).scopes).toEqual(["read"]);

  // Read-only token is refused by a write endpoint.
  const write = await request.post("/api/v1/documents", {
    headers: { authorization: `Bearer ${ro.body.token}` },
    data: { space: "engineering", title: "x", content: "y" },
  });
  expect(write.status()).toBe(403);

  // Read works; spaces listing responds.
  const spaces = await request.get("/api/v1/spaces", {
    headers: { authorization: `Bearer ${rw.body.token}` },
  });
  expect(spaces.status()).toBe(200);

  // Revoke both so reruns stay clean.
  for (const t of [rw, ro]) {
    await api(page, `/api/account/tokens/${t.body.record.id}`, { method: "DELETE" });
  }
});
