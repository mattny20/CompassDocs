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
