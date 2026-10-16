import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// Strict-mode approval loop: editor's change to published content queues a
// change request; the admin approves it; the editor is notified in-app.
test("editor edit queues a change request; approval notifies the author", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");

  // A published doc to edit.
  const spaces = await api(adminPage, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(adminPage, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title: "E2E Approval Target",
      type: "sop",
      status: "published",
      content: "Original content.",
      summary: "",
      tags: [],
    },
  });
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();

  // Editor edits it → 200 with pending change request (strict mode default).
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);
  const edit = await api(editorPage, `/api/documents/${docId}`, {
    method: "PUT",
    body: {
      title: "E2E Approval Target",
      content: "Edited by the e2e editor.",
      status: "published",
    },
  });
  expect(edit.status).toBe(200);
  expect(edit.body?.pending).toBe(true);
  const crId = edit.body?.changeRequestId;
  expect(crId).toBeTruthy();

  // Admin approves; the doc's live content updates.
  const approve = await api(adminPage, `/api/change-requests/${crId}`, {
    method: "PATCH",
    body: { action: "approve", note: "e2e approve" },
  });
  expect(approve.status).toBe(200);
  const after = await api(adminPage, `/api/documents/${docId}`);
  expect(JSON.stringify(after.body)).toContain("Edited by the e2e editor.");

  // The author hears about the decision in their inbox.
  const inbox = await api(editorPage, "/api/notifications");
  expect(inbox.status).toBe(200);
  expect(JSON.stringify(inbox.body.items)).toContain("cr_resolved");

  await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
  await adminCtx.close();
  await editorCtx.close();
});

// 1.11.0 (A6), API level: a change request on a confirmed document carries the
// submitter's recommendation (ack_policy / ack_reason); approving without a
// decision of the approver's own applies it; the approver may override it;
// a request with no recommendation is answered 428 until the approver
// decides; the decision row shows both sides; the author's notice says what
// the decision did. Read confirmation is entitlement-gated (policy_ack): the
// case skips itself on the community build.
test("a change request on a confirmed document carries the recommendation; the approver decides", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);

  const BASE = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to finance.";
  const EDITORIAL = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to the finance team.";
  const MATERIAL = "Expense claims are paid within 14 days. Receipts are required over 20. Claims go to the finance team.";
  const THIRD = "Expense claims are paid within 14 days. Receipts are required over 20. Claims go to the finance team by email.";

  const spaces = await api(adminPage, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(adminPage, "/api/documents", {
    method: "POST",
    body: { space_id: spaceId, title: `E2E approval decision ${Date.now()}`, type: "policy", status: "published", content: BASE, summary: "", tags: [] },
  });
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();
  try {
    const required = await api(adminPage, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(adminPage, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);
    expect((await api(adminPage, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // 1. The editor recommends an editorial fix; the live document and its
    //    confirmations are untouched while the request waits.
    const edit1 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: EDITORIAL, status: "published", ack_policy: "keep", ack_reason: "fixed the name of the finance team", versionNote: "Team name" },
    });
    expect(edit1.status).toBe(200);
    expect(edit1.body?.pending).toBe(true);
    const cr1 = edit1.body?.changeRequestId;
    expect(cr1).toBeTruthy();
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content).toBe(BASE);
    expect((await api(adminPage, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // A bad recommendation is refused before anything is queued.
    const badSubmit = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: EDITORIAL, status: "published", ack_policy: "auto", ack_reason: "ten characters or more" },
    });
    expect(badSubmit.status).toBe(400);

    // 2. Approving without a decision of the approver's own applies the
    //    recommendation: kept, from source "approval", both sides on the row.
    const approve1 = await api(adminPage, `/api/change-requests/${cr1}`, { method: "PATCH", body: { action: "approve", note: "Agreed" } });
    expect(approve1.status).toBe(200);
    expect(approve1.body?.ack_outcome?.policy).toBe("keep");
    expect(approve1.body?.ack_outcome?.reset).toBe(false);
    expect(approve1.body?.ack_outcome?.source).toBe("approval");
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content).toBe(EDITORIAL);
    let summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.current, "a keep leaves the confirmation standing").toBe(1);
    expect(summary?.version_id, "a keep never moves the marker").toBe(v1);
    expect(summary?.last_decision?.outcome).toBe("kept");
    expect(summary?.last_decision?.source).toBe("approval");
    expect(summary?.last_decision?.submitted_policy).toBe("keep");
    expect(summary?.last_decision?.submitted_by_name).toBe("E2E Editor");
    expect(summary?.last_decision?.decided_by_name).toBeTruthy();
    expect(summary?.last_decision?.decided_by).not.toBe(summary?.last_decision?.submitted_by);
    expect(summary?.last_decision?.reason, "the submitter's reason, since the approver gave none").toBe("fixed the name of the finance team");

    // 3. The editor recommends keep again; the approver overrides with reset.
    //    The row keeps the recommendation beside the outcome and the
    //    approver's reason.
    const edit2 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: MATERIAL, status: "published", ack_policy: "keep", ack_reason: "small wording change only", versionNote: "Deadline" },
    });
    expect(edit2.body?.pending).toBe(true);
    const cr2 = edit2.body?.changeRequestId;
    const shortOverride = await api(adminPage, `/api/change-requests/${cr2}`, {
      method: "PATCH",
      body: { action: "approve", ack_policy: "reset", ack_reason: "deadline" },
    });
    expect(shortOverride.status, "a reset needs a reason of 10 characters").toBe(400);
    const approve2 = await api(adminPage, `/api/change-requests/${cr2}`, {
      method: "PATCH",
      body: { action: "approve", ack_policy: "reset", ack_reason: "The payment deadline moved from 30 to 14 days; everyone must re-read" },
    });
    expect(approve2.status).toBe(200);
    expect(approve2.body?.ack_outcome?.policy).toBe("reset");
    expect(approve2.body?.ack_outcome?.reset).toBe(true);
    expect(approve2.body?.ack_outcome?.confirmations_reset).toBe(1);
    summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.current).toBe(0);
    expect(summary?.version_id).not.toBe(v1);
    expect(summary?.last_decision?.outcome).toBe("reset");
    expect(summary?.last_decision?.submitted_policy, "the recommendation is kept for the record").toBe("keep");
    expect(summary?.last_decision?.reason, "the approver's reason wins").toBe("The payment deadline moved from 30 to 14 days; everyone must re-read");

    // 4. A request with no recommendation: approving without a decision is
    //    answered 428 with the numbers the question shows, the request stays
    //    pending, and the decision then lands it.
    const v3 = summary?.version_id;
    expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v3 } })).status).toBe(200);
    const edit3 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: THIRD, status: "published", versionNote: "By email" },
    });
    expect(edit3.body?.pending).toBe(true);
    const cr3 = edit3.body?.changeRequestId;
    const undecided = await api(adminPage, `/api/change-requests/${cr3}`, { method: "PATCH", body: { action: "approve" } });
    expect(undecided.status).toBe(428);
    expect(undecided.body?.decision_required).toBe(true);
    expect(undecided.body?.confirmations).toBe(1);
    expect(undecided.body?.baseline).toMatch(/^v\d+$/);
    expect(["keep", "reset"]).toContain(undecided.body?.suggested);
    expect(typeof undecided.body?.change?.pct).toBe("number");
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content, "nothing was applied").toBe(MATERIAL);
    const approve3 = await api(adminPage, `/api/change-requests/${cr3}`, {
      method: "PATCH",
      body: { action: "approve", ack_policy: "keep", ack_reason: "Only the delivery channel was named; the rule is unchanged" },
    });
    expect(approve3.status).toBe(200);
    expect(approve3.body?.ack_outcome?.policy).toBe("keep");
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content).toBe(THIRD);
    const again = await api(adminPage, `/api/change-requests/${cr3}`, { method: "PATCH", body: { action: "approve" } });
    expect(again.status, "already reviewed").toBe(409);
    summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.last_decision?.outcome).toBe("kept");
    expect(summary?.last_decision?.submitted_policy).toBe("");
    expect(summary?.current).toBe(1);

    // The author's notices say what each decision did.
    const inbox = await api(editorPage, "/api/notifications");
    expect(inbox.status).toBe(200);
    const bodies = (inbox.body?.items ?? []).filter((n: { kind: string }) => n.kind === "cr_resolved").map((n: { body?: string | null }) => n.body ?? "");
    expect(bodies.some((b: string) => b.includes("Confirmations kept."))).toBe(true);
    expect(bodies.some((b: string) => b.includes("1 person asked to re-confirm."))).toBe(true);
  } finally {
    await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
    await adminCtx.close();
    await editorCtx.close();
  }
});

// 1.11.0 (A6), the review queue itself: the card says what approving does to
// the readers' confirmations (the chip beside "Edit"), shows the submitter's
// recommendation and reason, and replaces the preview with "Changes vs live"
// (the rendered diff with the one-sentence measurement). Approve on a request
// that changes the text of a confirmed document opens the editor's question
// with the recommendation pre-selected and the note prefilled; the approver's
// override lands on the decision row beside the recommendation. A request
// with no recommendation asks too (the guess pre-selects a card), and a
// metadata-only request says so and never asks. Licensed builds only.
test("the review card shows the chip, the recommendation and the diff; Approve asks, and the override is recorded", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);

  const title = `E2E review card ${Date.now()}`;
  const BASE = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to finance.";
  const EDITORIAL = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to the finance team.";
  const THIRD = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to the finance team by email.";
  const OVERRIDE = "Claims now go to a new mailbox; everyone must read the new address";
  const KEEP_REASON = "Only the delivery channel was named; the rule is unchanged";

  const spaces = await api(adminPage, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(adminPage, "/api/documents", {
    method: "POST",
    body: { space_id: spaceId, title, type: "policy", status: "published", content: BASE, summary: "", tags: [] },
  });
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();
  // Each request is an <article> named by its title.
  const card = () => adminPage.getByRole("article", { name: title });
  try {
    const required = await api(adminPage, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(adminPage, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);

    // 1. An editorial recommendation: the chip, the line and the diff.
    const edit1 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: EDITORIAL, status: "published", ack_policy: "keep", ack_reason: "fixed the name of the finance team", versionNote: "Team name" },
    });
    expect(edit1.body?.pending).toBe(true);

    await adminPage.goto("/review");
    await expect(adminPage.locator("h1")).toContainText("Review queue");
    await expect(card().getByText("Keeps 1 confirmation (editorial)")).toBeVisible();
    await expect(card().getByText('E2E Editor recommends: editorial fix. "fixed the name of the finance team"')).toBeVisible();
    await expect(card().getByText("Preview proposed content")).toHaveCount(0);
    const disclosure = card().getByText("Changes vs live");
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    await expect(card().getByText(/^(Looks editorial|Looks material|Borderline)/)).toBeVisible();
    await expect(card().locator("article")).toContainText("the finance team");

    // Approve opens the question with the recommendation pre-selected and
    // the note prefilled; the approver overrides it.
    await card().getByRole("button", { name: "Approve" }).click();
    const dialog = adminPage.getByRole("dialog", { name: "Approve changes to a confirmed document?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(new RegExp(`^1 of \\d+ (person has|people have) confirmed version \\d+ of`))).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Editorial fix/ })).toBeChecked();
    await expect(dialog.getByLabel("Change note")).toHaveValue("fixed the name of the finance team");
    await expect(dialog.getByRole("button", { name: "Approve. Keep confirmations" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Material change/ }).check();
    const reset = dialog.getByRole("button", { name: "Approve and ask 1 person to re-confirm" });
    await expect(reset).toBeVisible();
    await dialog.getByLabel("Change note").fill(OVERRIDE);
    await reset.click();
    await expect(dialog).toHaveCount(0);
    await expect(adminPage.locator('[role="status"]').getByText("Approved. 1 person will be asked to re-confirm.")).toBeVisible();
    await expect(card()).toHaveCount(0);

    let summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.current, "the override reset the confirmation").toBe(0);
    expect(summary?.last_decision?.outcome).toBe("reset");
    expect(summary?.last_decision?.submitted_policy, "the recommendation stays on the row").toBe("keep");
    expect(summary?.last_decision?.reason, "the approver's reason wins").toBe(OVERRIDE);
    expect(summary?.last_decision?.source).toBe("approval");
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content).toBe(EDITORIAL);

    // 2. No recommendation: the chip says a decision is needed, Approve
    //    asks with the guess pre-selected, and a keep is kept.
    const v2 = summary?.version_id;
    expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v2 } })).status).toBe(200);
    const edit2 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: THIRD, status: "published", versionNote: "By email" },
    });
    expect(edit2.body?.pending).toBe(true);
    await adminPage.goto("/review");
    await expect(card().getByText("Decision needed. 1 confirmation")).toBeVisible();
    await expect(card().getByText(/recommends:/)).toHaveCount(0);
    await card().getByRole("button", { name: "Approve" }).click();
    const ask = adminPage.getByRole("dialog", { name: "Approve changes to a confirmed document?" });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole("radio", { checked: true })).toHaveCount(1);
    await ask.getByRole("radio", { name: /^Editorial fix/ }).check();
    await ask.getByLabel("Change note").fill(KEEP_REASON);
    await ask.getByRole("button", { name: "Approve. Keep confirmations" }).click();
    await expect(adminPage.locator('[role="status"]').getByText("Approved. Confirmations kept.")).toBeVisible();
    summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.current, "a keep leaves the confirmation standing").toBe(1);
    expect(summary?.last_decision?.outcome).toBe("kept");
    expect(summary?.last_decision?.submitted_policy).toBe("");
    expect(summary?.last_decision?.reason).toBe(KEEP_REASON);

    // 3. Metadata only: the chip says confirmations are unaffected, and
    //    Approve applies without a question.
    const edit3 = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: THIRD, status: "published", summary: "Who pays, and when" },
    });
    expect(edit3.body?.pending).toBe(true);
    await adminPage.goto("/review");
    await expect(card().getByText("Metadata only. Confirmations unaffected")).toBeVisible();
    await card().getByRole("button", { name: "Approve" }).click();
    await expect(adminPage.locator('[role="status"]').getByText("Approved.", { exact: true })).toBeVisible();
    await expect(adminPage.getByRole("dialog")).toHaveCount(0);
    summary = (await api(adminPage, `/api/documents/${docId}/ack`)).body;
    expect(summary?.current, "nothing happened to the confirmation").toBe(1);
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.summary).toBe("Who pays, and when");

    // 4. The editor's own submission from the editor: Submit for review on a
    //    confirmed document opens the submit-mode question ("Submit changes
    //    to a confirmed document?"), and the answer rides on the request as
    //    the recommendation, which the card shows the approver.
    const SUBMIT_REASON = "Claims may also be phoned in; everyone must know the new channel";
    await editorPage.goto(`/doc/${docId}/edit`);
    const tiptap = editorPage.locator(".tiptap").first();
    await tiptap.waitFor({ state: "visible", timeout: 15000 });
    await editorPage.waitForTimeout(1500);
    await tiptap.locator("p").last().click();
    await editorPage.keyboard.press("End");
    await editorPage.keyboard.type(" Claims may also be phoned in.");
    await editorPage.getByRole("button", { name: "Submit for review" }).click();
    const submit = editorPage.getByRole("dialog", { name: "Submit changes to a confirmed document?" });
    await expect(submit).toBeVisible();
    await expect(submit.getByText(/^1 of \d+ (person has|people have) confirmed version \d+ of/)).toBeVisible();
    await expect(submit.getByRole("radio", { name: /^Editorial fix/ })).toBeVisible();
    await submit.getByRole("radio", { name: /^Material change/ }).check();
    await expect(submit.getByRole("button", { name: "Submit. Recommend re-confirmation" })).toBeVisible();
    await submit.getByLabel("Change note").fill(SUBMIT_REASON);
    await submit.getByRole("button", { name: "Submit. Recommend re-confirmation" }).click();
    await expect(submit).toHaveCount(0);
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content, "a submission changes nothing yet").toBe(THIRD);
    await adminPage.goto("/review");
    await expect(card().getByText("Resets 1 confirmation")).toBeVisible();
    await expect(card().getByText(`E2E Editor recommends: material change. "${SUBMIT_REASON}"`)).toBeVisible();
    // Declined, so nothing is left pending on the document the cleanup deletes.
    await card().getByRole("button", { name: "Reject" }).click();
    await expect(card()).toHaveCount(0);
  } finally {
    await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
    await adminCtx.close();
    await editorCtx.close();
  }
});

// 1.11.0, API level: holding change_request.decide on one space does not
// review for another. A custom role granted the key on a private space only
// can read the internal space's document but is answered 403 by
// PATCH /api/change-requests/{id} for a request against it, whatever the
// action (approve with a decision, approve without one, reject): not 428
// with the standing, not applied, and the request stays pending for a real
// reviewer. The check needs no licence, so the case runs on every build; on
// a licensed one the document is a confirmed policy, so the 403 is also
// what stops the 428 numbers leaking to a reviewer for another space.
test("a reviewer for another space cannot decide a request here: 403, the request stays pending", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);

  const suffix = `${Date.now()}`;
  const BASE = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to finance.";
  const EDITORIAL = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to the finance team.";
  const decider = { username: `e2e_decider_${suffix}`, password: "E2eDecider!12345" };
  let docId: number | undefined;
  let otherSpaceId: number | undefined;
  let deciderId: number | undefined;
  let deciderRole: number | undefined;
  try {
    const spaces = await api(adminPage, "/api/admin/spaces");
    const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
    const created = await api(adminPage, "/api/documents", {
      method: "POST",
      body: { space_id: spaceId, title: `E2E other-space decider ${suffix}`, type: "policy", status: "published", content: BASE, summary: "", tags: [] },
    });
    docId = created.body?.doc?.id ?? created.body?.document?.id;
    expect(docId).toBeTruthy();
    const required = await api(adminPage, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    const licensed = required.status === 200;
    if (licensed) {
      const v1 = (await api(adminPage, `/api/documents/${docId}/ack`)).body?.version_id;
      expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);
    }

    // A pending request against the document, with a recommendation.
    const edit = await api(editorPage, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: EDITORIAL, status: "published", ack_policy: "keep", ack_reason: "fixed the name of the finance team", versionNote: "Team name" },
    });
    expect(edit.status).toBe(200);
    expect(edit.body?.pending).toBe(true);
    const crId = edit.body?.changeRequestId;
    expect(crId).toBeTruthy();

    // A reviewer whose only change_request.decide is on another, private space.
    const otherSpace = await api(adminPage, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Decider Space ${suffix}`, slug: `e2e-decider-${suffix}`, description: "", visibility: "private" },
    });
    otherSpaceId = otherSpace.body?.space?.id ?? otherSpace.body?.id;
    expect(otherSpaceId, "the other space exists").toBeTruthy();
    const user = await api(adminPage, "/api/admin/users", {
      method: "POST",
      body: { ...decider, role: "viewer", name: "E2E Other-space Decider" },
    });
    expect(user.status, "decider created").toBe(201);
    deciderId = user.body?.user?.id;
    expect(deciderId).toBeTruthy();
    const role = await api(adminPage, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Decider ${suffix}`, description: "e2e: change_request.decide on one space", permissions: ["change_request.decide", "change_request.read"] },
    });
    expect(role.status).toBe(201);
    deciderRole = role.body?.id;
    const scoped = await api(adminPage, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: deciderRole, user_id: deciderId, space_id: otherSpaceId },
    });
    expect(scoped.status, "assigned in the other space only").toBe(201);

    const dctx = await browser.newContext();
    try {
      const dpage = await dctx.newPage();
      await login(dpage, decider);
      expect((await api(dpage, `/api/documents/${docId}`)).status, "the document is readable: an internal space").toBe(200);
      const approve = await api(dpage, `/api/change-requests/${crId}`, {
        method: "PATCH",
        body: { action: "approve", ack_policy: "keep", ack_reason: "Only the team's name changed; the rule is the same" },
      });
      expect(approve.status, "a decision from another space's reviewer").toBe(403);
      expect(approve.body?.error).toBe("You don't have permission for that.");
      const undecided = await api(dpage, `/api/change-requests/${crId}`, { method: "PATCH", body: { action: "approve" } });
      expect(undecided.status, "no 428 and no numbers for them either").toBe(403);
      expect(undecided.body?.decision_required).toBeUndefined();
      const reject = await api(dpage, `/api/change-requests/${crId}`, { method: "PATCH", body: { action: "reject", note: "no" } });
      expect(reject.status, "nor a rejection").toBe(403);
    } finally {
      await dctx.close();
    }

    // Nothing changed hands, and a real reviewer can still decide it.
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content, "the request was not applied").toBe(BASE);
    if (licensed) expect((await api(adminPage, `/api/documents/${docId}/ack`)).body?.current).toBe(1);
    const approved = await api(adminPage, `/api/change-requests/${crId}`, {
      method: "PATCH",
      body: { action: "approve", ack_policy: "keep", ack_reason: "Only the team's name changed; the rule is the same" },
    });
    expect(approved.status, "still pending for the admin").toBe(200);
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content).toBe(EDITORIAL);
  } finally {
    if (deciderRole) await api(adminPage, `/api/admin/rbac/roles/${deciderRole}`, { method: "DELETE" });
    if (deciderId) await api(adminPage, `/api/admin/users/${deciderId}`, { method: "DELETE" });
    if (otherSpaceId) await api(adminPage, `/api/admin/spaces/${otherSpaceId}`, { method: "DELETE" });
    if (docId) await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
    await adminCtx.close();
    await editorCtx.close();
  }
});
