import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.7.2: undo instead of "are you sure", the shared Modal, the editor's
// link popover.

async function createDoc(page: import("@playwright/test").Page, title: string): Promise<number> {
  const spaces = await api(page, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(page, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title,
      type: "knowledge",
      status: "published",
      content: `# ${title}\n\nBody.`,
      summary: "e2e",
      tags: ["e2e"],
    },
  });
  expect(created.status).toBe(201);
  return created.body?.doc?.id ?? created.body?.document?.id;
}

test("Move to Trash does not ask; the toast's Undo restores the document", async ({ page }) => {
  await login(page, ADMIN);
  const id = await createDoc(page, `E2E Undo ${Date.now()}`);
  await page.goto(`/doc/${id}`);
  await page.getByRole("button", { name: "Move document to Trash" }).first().click();
  await expect(page).toHaveURL(/\/spaces\//);
  const toast = page.locator('[role="status"]').getByText(/moved to the trash/i);
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator('[role="status"]').getByText(/^Restored\./)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/doc/${id}$`));
  await api(page, `/api/documents/${id}`, { method: "DELETE" });
});

test("a trashed document is listed in the Trash and Restore says so", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E Trashed ${Date.now()}`;
  const id = await createDoc(page, title);
  await page.goto(`/doc/${id}`);
  await page.getByRole("button", { name: "Move document to Trash" }).first().click();
  await expect(page).toHaveURL(/\/spaces\//);
  await page.goto("/trash");
  const row = page.locator("tr", { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(page.locator('[role="status"]').getByText(/^Restored "/)).toBeVisible();
  await expect(row).toHaveCount(0);
  await api(page, `/api/documents/${id}`, { method: "DELETE" });
  await api(page, `/api/trash/${id}`, { method: "DELETE" });
});

test("the analytics drill-down is a modal: named, Escape closes, focus returns", async ({ page }) => {
  await login(page, ADMIN);
  // Make sure something has been viewed in the period.
  const id = await createDoc(page, `E2E Viewed ${Date.now()}`);
  await page.goto(`/doc/${id}`);
  await page.goto("/analytics");
  const trigger = page.getByRole("button", { name: /E2E Viewed/ }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /analytics/i });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await api(page, `/api/documents/${id}`, { method: "DELETE" });
});

test("the editor's Link button opens an anchored panel; Escape closes it", async ({ page }) => {
  await login(page, ADMIN);
  const id = await createDoc(page, `E2E Link ${Date.now()}`);
  await page.goto(`/doc/${id}/edit`);
  await page.getByRole("button", { name: "Link", exact: true }).first().click();
  const url = page.getByLabel("Link URL");
  await expect(url).toBeVisible();
  await expect(url).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(url).toHaveCount(0);
  page.once("dialog", (d) => void d.accept());
  await api(page, `/api/documents/${id}`, { method: "DELETE" });
});
