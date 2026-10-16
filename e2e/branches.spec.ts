import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

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
