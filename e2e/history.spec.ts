import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.2 (item D6): version history — pick two versions and the compare
// header follows; Restore posts and the document carries the older text.

test("pick two versions to compare, then restore one", async ({ page }) => {
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E history ${Date.now()}`, type: "knowledge", status: "draft", content: "Version one body.", tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    for (const [n, note] of [
      ["Version two body.", "second"],
      ["Version three body.", "third"],
    ] as const) {
      const put = await api(page, `/api/documents/${docId}`, {
        method: "PUT",
        body: { content: n, status: "draft", versionNote: note },
      });
      expect(put.status).toBe(200);
    }

    await page.goto(`/doc/${docId}/history`);
    // Default: previous vs current.
    await expect(page.getByText(/Original v2 → modified v3/)).toBeVisible();
    // The radios have spoken names and the header follows the pick.
    await page.getByRole("radio", { name: "Original: version 1" }).check();
    await expect(page.getByText(/Original v1 → modified v3/)).toBeVisible();
    await page.getByRole("radio", { name: "Modified: version 2" }).check();
    await expect(page.getByText(/Original v1 → modified v2/)).toBeVisible();
    await expect(page.getByText("Current", { exact: true })).toBeVisible();

    // Restore v1: asks first, then the document is v1's text again.
    const row = page.getByRole("listitem").filter({ hasText: "v1" }).first();
    await row.getByRole("button", { name: "Restore" }).click();
    const dialog = page.getByRole("dialog", { name: /restore version 1/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Restore" }).click();
    await page.waitForURL(`**/doc/${docId}`);
    await expect(page.locator("article")).toContainText("Version one body.");
    const after = await api(page, `/api/documents/${docId}`);
    expect((after.body?.doc ?? after.body)?.content).toBe("Version one body.");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.11.0 (A6): restoring older text over a confirmed document asks the same
// question as saving. Through the API: without ack_policy the restore is
// answered 428 with the numbers the question shows and nothing is written; a
// bad policy or a short reason is 400; with the decision it lands, and the
// History tab records it from source "restore". Restoring the confirmed
// version itself asks nothing. Read confirmation is entitlement-gated
// (policy_ack): the case skips itself on the community build.
test("restoring over a confirmed document asks first (428), then restores with the decision", async ({ page }) => {
  await login(page, ADMIN);
  const V1 = "Expense claims are paid within 30 days. Receipts are required over 20.";
  const V2 = "Expense claims are paid within 14 days. Receipts are required over 20.";
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E restore decision ${Date.now()}`, type: "policy", status: "published", content: V1, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const required = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const v1 = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    expect(v1).toBeTruthy();

    // A material edit asks everyone again: the marker moves to v2, which the
    // admin then confirms, so a confirmation is at stake.
    const edited = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: V2, status: "published", ack_policy: "reset", ack_reason: "The payment deadline changed; everyone must re-read", versionNote: "Deadline shortened" },
    });
    expect(edited.status).toBe(200);
    expect(edited.body?.ack_outcome?.reset).toBe(true);
    const v2 = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    expect(v2).toBeTruthy();
    expect(v2).not.toBe(v1);
    const confirmed = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v2 } });
    expect(confirmed.status).toBe(200);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // Restoring v1 over the confirmed v2 without a decision: 428, and the
    // document is untouched.
    const undecided = await api(page, `/api/documents/${docId}/versions/${v1}/restore`, { method: "POST", body: { label: "1" } });
    expect(undecided.status).toBe(428);
    expect(undecided.body?.decision_required).toBe(true);
    expect(undecided.body?.confirmations).toBe(1);
    expect(undecided.body?.eligible).toBeGreaterThanOrEqual(1);
    expect(undecided.body?.baseline).toBe("v2");
    expect(["keep", "reset"]).toContain(undecided.body?.suggested);
    expect(typeof undecided.body?.change?.pct).toBe("number");
    expect(undecided.body?.change?.numbersChanged).toBeGreaterThanOrEqual(1);
    expect(undecided.body?.error).toContain("requires read confirmation");
    const untouched = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(untouched?.content, "a refused restore writes nothing").toBe(V2);

    // A short reason and a bad policy are refused the same way.
    const short = await api(page, `/api/documents/${docId}/versions/${v1}/restore`, {
      method: "POST",
      body: { label: "1", ack_policy: "keep", ack_reason: "revert" },
    });
    expect(short.status).toBe(400);
    expect(short.body?.error).toBe("ack_reason is required when the text of a confirmed policy changes.");
    const bad = await api(page, `/api/documents/${docId}/versions/${v1}/restore`, {
      method: "POST",
      body: { label: "1", ack_policy: "auto", ack_reason: "ten characters or more" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toBe('ack_policy must be "keep" or "reset".');
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content).toBe(V2);

    // With the decision the restore lands: v1's text is current again, the
    // confirmation still counts, and the ledger row is a keep from source
    // "restore" with the reason.
    const restored = await api(page, `/api/documents/${docId}/versions/${v1}/restore`, {
      method: "POST",
      body: { label: "1", ack_policy: "keep", ack_reason: "Reverting the shortened deadline; the published rule stands" },
    });
    expect(restored.status).toBe(200);
    expect(restored.body?.doc?.content).toBe(V1);
    expect(restored.body?.ack_outcome?.policy).toBe("keep");
    expect(restored.body?.ack_outcome?.reset).toBe(false);
    expect(restored.body?.ack_outcome?.substantive).toBe(true);
    const after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "a keep leaves the confirmation standing").toBe(1);
    expect(after.body?.version_id, "a keep never moves the marker").toBe(v2);
    expect(after.body?.last_decision?.outcome).toBe("kept");
    expect(after.body?.last_decision?.source).toBe("restore");
    expect(after.body?.last_decision?.reason).toBe("Reverting the shortened deadline; the published rule stands");

    // Restoring the confirmed version itself is no question: the text equals
    // what people confirmed, so the call lands without ack_policy and takes
    // no decision.
    const back = await api(page, `/api/documents/${docId}/versions/${v2}/restore`, { method: "POST", body: { label: "2" } });
    expect(back.status).toBe(200);
    expect(back.body?.doc?.content).toBe(V2);
    expect(back.body?.ack_outcome?.substantive).toBe(false);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.last_decision?.source).toBe("restore");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.11.0 (A6), the page itself: Restore on an older version of a confirmed
// document opens the editor's question instead of the plain confirm, titled
// for the version, with the two cards, the measurement against the confirmed
// text, the note prefilled with what the version note will say, and a primary
// that says what will happen; the answer lands as a decision from source
// "restore". Licensed builds only.
test("restoring an older version of a confirmed document asks the question from the page", async ({ page }) => {
  await login(page, ADMIN);
  const V1 = "Expense claims are paid within 30 days. Receipts are required over 20.";
  const V2 = "Expense claims are paid within 14 days. Receipts are required over 20.";
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E restore question ${Date.now()}`, type: "policy", status: "published", content: V1, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const required = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(required.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(required.status).toBe(200);
    const edited = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: V2, status: "published", ack_policy: "reset", ack_reason: "The payment deadline changed; everyone must re-read", versionNote: "Deadline shortened" },
    });
    expect(edited.status).toBe(200);
    const v2 = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: v2 } })).status).toBe(200);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    await page.goto(`/doc/${docId}/history`);
    await expect(page.getByText(/Original v1 → modified v2/)).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "v1" }).first();
    await row.getByRole("button", { name: "Restore" }).click();

    // The question, not the plain confirm: the version in the title, the
    // numbers, the two cards, the hint and the prefilled note.
    const dialog = page.getByRole("dialog", { name: "Restore version 1 of a confirmed document?" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog", { name: /^Restore version 1\?$/ })).toHaveCount(0);
    await expect(dialog.getByText(/^1 of \d+ (person has|people have) confirmed version 2 of/)).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Editorial fix/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Material change/ })).toBeVisible();
    await expect(dialog.getByText(/^(Looks editorial|Looks material|Borderline)/)).toBeVisible();
    await expect(dialog.getByLabel("Change note")).toHaveValue(/^Restored version 1 from \d{4}-\d{2}-\d{2}$/);
    // The primary follows the selection.
    await dialog.getByRole("radio", { name: /^Material change/ }).check();
    await expect(dialog.getByRole("button", { name: "Restore and ask 1 person to re-confirm" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^Editorial fix/ }).check();
    const keep = dialog.getByRole("button", { name: "Restore. Keep confirmations" });
    await expect(keep).toBeVisible();
    // Escape cancels and nothing is written.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content, "Cancel restores nothing").toBe(V2);

    // Asked again, answered: the older text is current, the confirmation
    // stands, and the ledger row is a keep from source "restore".
    await row.getByRole("button", { name: "Restore" }).click();
    const again = page.getByRole("dialog", { name: "Restore version 1 of a confirmed document?" });
    await expect(again).toBeVisible();
    await again.getByRole("radio", { name: /^Editorial fix/ }).check();
    await again.getByLabel("Change note").fill("Reverting the shortened deadline; the published rule stands");
    await again.getByRole("button", { name: "Restore. Keep confirmations" }).click();
    await page.waitForURL(`**/doc/${docId}`);
    await expect(page.locator("article")).toContainText("within 30 days");
    const after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "a keep leaves the confirmation standing").toBe(1);
    expect(after.body?.last_decision?.outcome).toBe("kept");
    expect(after.body?.last_decision?.source).toBe("restore");
    expect(after.body?.last_decision?.reason).toBe("Reverting the shortened deadline; the published rule stands");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
