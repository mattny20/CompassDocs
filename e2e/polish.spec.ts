import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.7.3: single-key shortcuts can be turned off, one password minimum,
// relative times carry the exact time, named swatches, a visitor 404.

test("single-key shortcuts off: '/' does nothing, Ctrl+K still opens the palette", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/account/preferences");
  const toggle = page.getByRole("switch", { name: "Single-key shortcuts" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // Fresh page: the account value must drive it, not the tab.
  await page.goto("/");
  await page.locator("h1").first().waitFor();
  await page.locator("body").press("/");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
  await page.locator("body").press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Back on.
  await page.goto("/account/preferences");
  await page.getByRole("switch", { name: "Single-key shortcuts" }).click();
  await page.goto("/");
  await page.locator("h1").first().waitFor();
  await page.locator("body").press("/");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

test("one password minimum: the API refuses 7 characters everywhere", async ({ page }) => {
  await login(page, ADMIN);
  const change = await api(page, "/api/auth/change-password", {
    method: "POST",
    body: { currentPassword: ADMIN.password, newPassword: "short77" },
  });
  expect(change.status).toBe(400);
  expect(change.body?.error).toMatch(/8 characters/);
  const create = await api(page, "/api/admin/users", {
    method: "POST",
    body: { username: `e2e-pw-${Date.now()}`, password: "short77", role: "viewer" },
  });
  expect(create.status).toBe(400);
  expect(create.body?.error).toMatch(/8 characters/);
});

test("the security form says the minimum under the field", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/account/security");
  const field = page.getByLabel("New password", { exact: true });
  const describedBy = await field.getAttribute("aria-describedby");
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(/at least 8/i);
});

test("relative times are <time> elements with the exact time behind them", async ({ page }) => {
  await login(page, ADMIN);
  const spaces = await api(page, "/api/admin/spaces");
  const slug = spaces.body?.spaces?.[0]?.slug ?? spaces.body?.[0]?.slug;
  await page.goto(`/spaces/${slug}`);
  // The table view carries the Updated column.
  await page.getByText("Table", { exact: true }).first().click();
  const t = page.locator("time[datetime][data-tt]").first();
  await expect(t).toBeVisible();
  expect(await t.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await t.getAttribute("data-tt")).toMatch(/\d{4}|\d{1,2}:\d{2}/);
});

test("accent swatches are named and announce the pressed one", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/workspace");
  const group = page.getByRole("group", { name: "Accent color" });
  const pressed = group.locator('button[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveAttribute("aria-label", /.+/);
});

test("a visitor's dead link gets a neutral 404 with Sign in", async ({ page }) => {
  await page.goto("/share/definitely-not-a-token");
  await expect(page.locator("h1")).toHaveText(/not found|isn.t here/i);
  await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  await expect(page.getByText(/trash|colleague/i)).toHaveCount(0);
});
