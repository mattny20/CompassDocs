import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The bell's footer and the Notifications page (1.5.2).

test("the bell leads to the inbox page, which pages and marks all read", async ({ page }) => {
  await login(page, ADMIN);

  const bell = page.getByRole("button", { name: /^Notifications/ }).first();
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("link", { name: "Preferences" })).toHaveAttribute(
    "href",
    "/account/notifications"
  );
  await panel.getByRole("link", { name: "See all notifications" }).click();
  await page.waitForURL("**/notifications");
  await expect(page).toHaveTitle(/^Notifications — /);
  await expect(page.locator("h1")).toHaveText(/Notifications/);

  // Paging is opt-in and keeps the bell's shape.
  const first = await api(page, "/api/notifications");
  expect(first.status).toBe(200);
  expect(Array.isArray(first.body.items)).toBe(true);
  expect(typeof first.body.unread).toBe("number");
  if (first.body.items.length > 1) {
    const older = await api(page, `/api/notifications?before=${first.body.items[0].id}&limit=1`);
    expect(older.status).toBe(200);
    expect(older.body.items.length).toBe(1);
    expect(older.body.items[0].id).toBeLessThan(first.body.items[0].id);
  }

  // Either rows with a Mark-all-read control, or the empty state.
  const markAll = page.getByRole("button", { name: "Mark all read" });
  if (await markAll.count()) {
    await markAll.click();
    await expect(page.getByText("All read")).toBeVisible();
    await expect
      .poll(async () => (await api(page, "/api/notifications")).body.unread)
      .toBe(0);
  } else {
    await expect(page.getByText(/Nothing here yet|All read/)).toBeVisible();
  }
});
