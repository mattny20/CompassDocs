import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// 1.6.3: live regions that are always there, a toast after a save, a copy
// button that announces, and targets you can hit.

test("the toast regions exist before any toast, and a save announces", async ({ page }) => {
  await login(page, ADMIN);
  await expect(page.locator('[role="status"][aria-live="polite"]').first()).toBeAttached();
  await expect(page.locator('[role="alert"][aria-live="assertive"]').first()).toBeAttached();

  await page.goto("/account");
  const name = page.getByLabel(/display name/i).first();
  const current = (await name.inputValue()) || "Administrator";
  // Save is disabled until something changed; change it, then change it back.
  for (const value of [`${current} (edited)`, current]) {
    await name.fill(value);
    await page.getByRole("button", { name: /^Save/ }).first().click();
    await expect(page.locator('[role="status"]').getByText(/saved/i)).toBeVisible();
    await expect(page.locator('[role="status"]').getByText(/saved/i)).toHaveCount(0, { timeout: 15000 });
  }
});

test("a copy button announces Copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, ADMIN);
  await page.goto("/account/tokens");
  const copy = page.getByRole("button", { name: /^Copy$/ }).first();
  await copy.click();
  await expect(page.getByRole("button", { name: /^Copied$/ }).first()).toBeVisible();
  await expect(copy).toHaveText(/Copy/, { timeout: 5000 });
});

test("toggles and icon buttons are at least 24px tall", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/public-site");
  const toggle = page.getByRole("switch").first();
  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(24);
  expect(box!.width).toBeGreaterThanOrEqual(40);
  const manage = page.getByRole("link", { name: "Manage spaces" }).first();
  const mb = await manage.boundingBox();
  expect(mb!.height).toBeGreaterThanOrEqual(24);
  expect(mb!.width).toBeGreaterThanOrEqual(24);
});
