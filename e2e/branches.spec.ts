import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// 1.11.0 (A6): the branch banner's merge. A merge sends the source's
// updated_at the page rendered with, so a source saved while the branch was
// open is refused with "The live document changed since this branch was
// created. Review it before merging." instead of overwritten. Merging into a
// confirmed document whose text differs from the confirmed version opens the
// editor's question ("Merge this branch into a confirmed document?") with
// the two cards and a note prefilled from the branch, and the answer lands as
// a decision from source "merge". Read confirmation is entitlement-gated
// (policy_ack): the case skips itself on the community build.

test("merging a branch: a stale base is refused, a confirmed target asks, and the decision is recorded", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E merge question ${Date.now()}`;
  const V1 = "Expense claims are paid within 30 days. Receipts are required over 20.";
  const LIVE_EDIT = "Expense claims are paid within 30 days. Receipts are required over 20. Keep every receipt.";
  const BRANCH = "Expense claims are paid within 14 days. Receipts are required over 20. Keep every receipt.";
  let docId: number | undefined;
  let branchId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title, type: "policy", status: "published", content: V1, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const required = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);

    // A branch with its own text.
    const branched = await api(page, `/api/documents/${docId}/branch`, { method: "POST" });
    expect(branched.status, "branch created").toBe(200);
    branchId = branched.body?.branch?.id;
    expect(branchId).toBeTruthy();
    const drafted = await api(page, `/api/documents/${branchId}`, {
      method: "PUT",
      body: { content: BRANCH, status: "draft", versionNote: "Deadline shortened on the branch" },
    });
    expect(drafted.status).toBe(200);

    // The banner renders with the source as it is now; then the live
    // document is saved behind its back (an editorial fix, so the
    // confirmation still stands).
    await page.goto(`/doc/${branchId}`);
    await expect(page.getByText("This is a draft branch of")).toBeVisible();
    const liveEdit = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: LIVE_EDIT, status: "published", ack_policy: "keep", ack_reason: "Added a reminder to keep receipts", versionNote: "Receipts reminder" },
    });
    expect(liveEdit.status).toBe(200);
    expect(liveEdit.body?.ack_outcome?.reset).toBe(false);

    // The stale merge is refused and nothing is written.
    const merge = page.getByRole("button", { name: "Merge into original" });
    await merge.click();
    await expect(
      page.getByText("The live document changed since this branch was created. Review it before merging.")
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content, "a refused merge writes nothing").toBe(LIVE_EDIT);
    expect((await api(page, `/api/documents/${branchId}`)).status, "the branch is still live").toBe(200);

    // Reloaded, the banner carries the new updated_at: the merge is a
    // decision now (the branch's text differs from the confirmed version),
    // so the question opens from the route's answer.
    await page.reload();
    await page.getByRole("button", { name: "Merge into original" }).click();
    const dialog = page.getByRole("dialog", { name: "Merge this branch into a confirmed document?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^1 of \d+ (person has|people have) confirmed version 1 of/)).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Editorial fix/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Material change/ })).toBeVisible();
    await expect(dialog.getByText(/^(Looks editorial|Looks material|Borderline)/)).toBeVisible();
    await expect(dialog.getByLabel("Change note")).toHaveValue(`Merged branch "${title}"`);
    await dialog.getByRole("radio", { name: /^Editorial fix/ }).check();
    await expect(dialog.getByRole("button", { name: "Merge. Keep confirmations" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Material change/ }).check();
    const reset = dialog.getByRole("button", { name: "Merge and ask 1 person to re-confirm" });
    await expect(reset).toBeVisible();
    await dialog.getByLabel("Change note").fill("The payment deadline moved from 30 to 14 days; everyone must re-read");
    await reset.click();

    // The merge landed: the source carries the branch's text, the branch is
    // gone, the confirmation was reset and the ledger row is from "merge".
    await page.waitForURL(`**/doc/${docId}`);
    await expect(page.locator("article")).toContainText("within 14 days");
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content).toBe(BRANCH);
    expect((await api(page, `/api/documents/${branchId}`)).status, "the branch left the live set").toBe(404);
    const after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "everyone was asked again").toBe(0);
    expect(after.body?.last_decision?.outcome).toBe("reset");
    expect(after.body?.last_decision?.source).toBe("merge");
    expect(after.body?.last_decision?.reason).toBe("The payment deadline moved from 30 to 14 days; everyone must re-read");
    // The branch is in the Trash; purging it cleans up.
    const purged = await api(page, `/api/trash/${branchId}`, { method: "DELETE" });
    expect(purged.status, "the branch was in the Trash").toBe(200);
    branchId = undefined;
  } finally {
    if (branchId) await api(page, `/api/documents/${branchId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.11.0 (A6), the queued merge: without publish rights the banner's merge
// becomes a change request, and on a confirmed source it asks the
// submit-mode question first ("Submit changes to a confirmed document?") so
// the request carries the submitter's recommendation and reason; the review
// queue shows them, and approving applies the recommendation with both sides
// on the decision row. Licensed builds only.
test("a merge that queues for review asks the submit question, and the request carries the recommendation", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);

  const title = `E2E merge submit ${Date.now()}`;
  const V1 = "Expense claims are paid within 30 days. Receipts are required over 20.";
  const BRANCH = "Expense claims are paid within 14 days. Receipts are required over 20.";
  const REASON = "The payment deadline moved from 30 to 14 days; everyone must re-read";
  let docId: number | undefined;
  let branchId: number | undefined;
  try {
    const made = await api(adminPage, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title, type: "policy", status: "published", content: V1, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const required = await api(adminPage, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(adminPage, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(adminPage, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);
    expect((await api(adminPage, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // The editor drafts on a branch of the confirmed document.
    const branched = await api(editorPage, `/api/documents/${docId}/branch`, { method: "POST" });
    expect(branched.status, "branch created").toBe(200);
    branchId = branched.body?.branch?.id;
    expect(branchId).toBeTruthy();
    const drafted = await api(editorPage, `/api/documents/${branchId}`, {
      method: "PUT",
      body: { content: BRANCH, status: "draft", versionNote: "Deadline shortened on the branch" },
    });
    expect(drafted.status).toBe(200);

    // The banner offers a submission, and the submission asks: the note
    // prefilled from the branch, a primary that recommends.
    await editorPage.goto(`/doc/${branchId}`);
    await expect(editorPage.getByText("This is a draft branch of")).toBeVisible();
    await editorPage.getByRole("button", { name: "Submit merge for review" }).click();
    const dialog = editorPage.getByRole("dialog", { name: "Submit changes to a confirmed document?" });
    await expect(dialog).toBeVisible();
    await expect(editorPage.getByRole("dialog", { name: "Submit this branch to the review queue?" })).toHaveCount(0);
    await expect(dialog.getByText(/^1 of \d+ (person has|people have) confirmed version 1 of/)).toBeVisible();
    await expect(dialog.getByText(/^(Looks editorial|Looks material|Borderline)/)).toBeVisible();
    await expect(dialog.getByLabel("Change note")).toHaveValue(`Merged branch "${title}"`);
    await dialog.getByRole("radio", { name: /^Editorial fix/ }).check();
    await expect(dialog.getByRole("button", { name: "Submit. Recommend keeping confirmations" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Material change/ }).check();
    await expect(dialog.getByRole("button", { name: "Submit. Recommend re-confirmation" })).toBeVisible();
    await dialog.getByLabel("Change note").fill(REASON);
    await dialog.getByRole("button", { name: "Submit. Recommend re-confirmation" }).click();
    await expect(editorPage.getByText("Merge submitted for review — an approver or admin will apply it.")).toBeVisible();
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content, "a queued merge changes nothing yet").toBe(V1);
    expect((await api(adminPage, `/api/documents/${branchId}`)).status, "the branch stays open until the request is decided").toBe(200);
    expect((await api(adminPage, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // The review queue shows the recommendation; approving without an
    // override applies it, and the decision row records both sides.
    await adminPage.goto("/review");
    const card = adminPage.getByRole("article", { name: title });
    await expect(card.getByText("Resets 1 confirmation")).toBeVisible();
    await expect(card.getByText(`E2E Editor recommends: material change. "${REASON}"`)).toBeVisible();
    await card.getByRole("button", { name: "Approve" }).click();
    const approve = adminPage.getByRole("dialog", { name: "Approve changes to a confirmed document?" });
    await expect(approve).toBeVisible();
    await expect(approve.getByRole("radio", { name: /^Material change/ })).toBeChecked();
    await expect(approve.getByLabel("Change note")).toHaveValue(REASON);
    await approve.getByRole("button", { name: "Approve and ask 1 person to re-confirm" }).click();
    await expect(adminPage.locator('[role="status"]').getByText("Approved. 1 person will be asked to re-confirm.")).toBeVisible();
    expect((await api(adminPage, `/api/documents/${docId}`)).body?.doc?.content, "the branch's text is live").toBe(BRANCH);
    const after = await api(adminPage, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "everyone was asked again").toBe(0);
    expect(after.body?.last_decision?.outcome).toBe("reset");
    expect(after.body?.last_decision?.source).toBe("approval");
    expect(after.body?.last_decision?.submitted_policy).toBe("reset");
    expect(after.body?.last_decision?.submitted_by_name).toBe("E2E Editor");
    expect(after.body?.last_decision?.reason).toBe(REASON);
  } finally {
    // The branch may be live or already in the Trash; either way the source goes last.
    if (branchId) await api(adminPage, `/api/documents/${branchId}`, { method: "DELETE" });
    if (docId) await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
    await adminCtx.close();
    await editorCtx.close();
  }
});

// 1.11.0 (A6), API level, the same shape as the restore case in
// e2e/history.spec.ts: POST /api/documents/{id}/merge on a confirmed source
// whose branch text differs from the confirmed version is answered 428 with
// the numbers and writes nothing; a short reason and a bad policy are 400;
// after a 428 the live document saved behind the question makes the decided
// POST with the old base_updated_at a 409, not a merge; with keep the merge
// lands as a kept row from source "merge" with the note as the version
// note; and a branch whose text equals the source (only its tags differ)
// lands without a question. Licensed builds only.
test("merging through the API: 428, both 400s, the 428-then-409 race, a keep from source merge, and a metadata-only merge", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E merge api ${Date.now()}`;
  const V1 = "Expense claims are paid within 30 days. Receipts are required over 20.";
  const BRANCH = "Expense claims are paid within 30 days. Receipts are required over 20. Keep every receipt.";
  const LIVE_EDIT = "Expense claims are paid within 30 days. Receipts are required over 20. Claims go to finance.";
  const REASON = "Added a reminder to keep receipts; the rule is unchanged";
  let docId: number | undefined;
  const branches: number[] = [];
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title, type: "policy", status: "published", content: V1, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const required = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v1 } })).status).toBe(200);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    const branchWith = async (body: Record<string, unknown>): Promise<number> => {
      const branched = await api(page, `/api/documents/${docId}/branch`, { method: "POST" });
      expect(branched.status, "branch created").toBe(200);
      const id = branched.body?.branch?.id as number;
      expect(id).toBeTruthy();
      branches.push(id);
      expect((await api(page, `/api/documents/${id}`, { method: "PUT", body: { status: "draft", ...body } })).status).toBe(200);
      return id;
    };
    const merge = (id: number, body: Record<string, unknown> = {}) => api(page, `/api/documents/${id}/merge`, { method: "POST", body });

    // Undecided: 428 with the numbers, nothing written, the branch still open.
    const first = await branchWith({ content: BRANCH, versionNote: "Receipts reminder on the branch" });
    const undecided = await merge(first);
    expect(undecided.status).toBe(428);
    expect(undecided.body?.decision_required).toBe(true);
    expect(undecided.body?.confirmations).toBe(1);
    expect(undecided.body?.eligible).toBeGreaterThanOrEqual(1);
    expect(undecided.body?.baseline).toBe("v1");
    expect(["keep", "reset"]).toContain(undecided.body?.suggested);
    expect(typeof undecided.body?.change?.pct).toBe("number");
    expect(undecided.body?.error).toContain("requires read confirmation");
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content, "a refused merge writes nothing").toBe(V1);
    expect((await api(page, `/api/documents/${first}`)).status, "the branch is still live").toBe(200);

    // A short reason and a bad policy are refused the same way.
    const short = await merge(first, { ack_policy: "keep", ack_reason: "revert" });
    expect(short.status).toBe(400);
    expect(short.body?.error).toBe("ack_reason is required when the text of a confirmed policy changes.");
    const bad = await merge(first, { ack_policy: "auto", ack_reason: "ten characters or more" });
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toBe('ack_policy must be "keep" or "reset".');
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content).toBe(V1);

    // The race: the question opened against this updated_at, the live
    // document was saved meanwhile, so the answer with the old
    // base_updated_at is 409 and nothing is merged.
    const base = (await api(page, `/api/documents/${docId}`)).body?.doc?.updated_at;
    expect(base).toBeTruthy();
    const liveEdit = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: LIVE_EDIT, status: "published", ack_policy: "keep", ack_reason: "Named the finance team; no new obligation", versionNote: "Finance named" },
    });
    expect(liveEdit.status).toBe(200);
    const stale = await merge(first, { ack_policy: "keep", ack_reason: REASON, base_updated_at: base });
    expect(stale.status).toBe(409);
    expect(stale.body?.conflict).toBe(true);
    expect(stale.body?.error).toBe("The live document changed since this branch was created. Review it before merging.");
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content, "a stale merge writes nothing").toBe(LIVE_EDIT);
    expect((await api(page, `/api/documents/${first}`)).status).toBe(200);

    // Decided against the current updated_at: the merge lands as a keep
    // from source "merge", the note is the version note, the confirmation
    // stands and the marker stays on v1.
    const current = (await api(page, `/api/documents/${docId}`)).body?.doc?.updated_at;
    const merged = await merge(first, { ack_policy: "keep", ack_reason: REASON, note: "Receipts reminder", base_updated_at: current });
    expect(merged.status).toBe(200);
    expect(merged.body?.doc?.content).toBe(BRANCH);
    expect(merged.body?.ack_outcome?.policy).toBe("keep");
    expect(merged.body?.ack_outcome?.reset).toBe(false);
    expect(merged.body?.ack_outcome?.substantive).toBe(true);
    let after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "a keep leaves the confirmation standing").toBe(1);
    expect(after.body?.version_id, "a keep never moves the marker").toBe(v1);
    expect(after.body?.last_decision?.outcome).toBe("kept");
    expect(after.body?.last_decision?.source).toBe("merge");
    expect(after.body?.last_decision?.reason).toBe(REASON);
    expect((await api(page, `/api/documents/${first}`)).status, "the merged branch left the live set").toBe(404);
    await page.goto(`/doc/${docId}/history`);
    await expect(page.getByRole("listitem").filter({ hasText: "Receipts reminder" }).first(), "the note is the version note").toBeVisible();

    // A branch whose text equals the source lands without a question: only
    // its tags differ, so nothing is decided and nobody is asked.
    const second = await branchWith({ content: BRANCH, tags: ["receipts"] });
    const metadata = await merge(second);
    expect(metadata.status).toBe(200);
    expect(metadata.body?.ack_outcome?.substantive).toBe(false);
    expect(metadata.body?.ack_outcome?.reset).toBe(false);
    expect(metadata.body?.doc?.tags).toContain("receipts");
    after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current).toBe(1);
    expect(after.body?.last_decision?.source, "no new decision row").toBe("merge");
    expect(after.body?.last_decision?.reason).toBe(REASON);
  } finally {
    // Merged branches are in the Trash (purge); an unmerged one is live (delete).
    for (const id of branches) {
      const purged = await api(page, `/api/trash/${id}`, { method: "DELETE" });
      if (purged.status !== 200) await api(page, `/api/documents/${id}`, { method: "DELETE" });
    }
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
