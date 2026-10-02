import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// The settings console frame (1.5.1): the section is the page's only h1,
// the layout above it is an eyebrow, and the rail stays in view while a
// long page scrolls.

test("a settings page has one h1 — the section — and a sticky rail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ADMIN);

  await page.goto("/admin/users");
  const h1 = page.locator("h1");
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveText(/Users & roles/);
  // The eyebrow is not a heading.
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);

  // Rail rows share the recipe: current page carries aria-current.
  const rail = page.getByRole("navigation", { name: "Settings sections" }).last();
  await expect(rail.getByRole("link", { name: "Users & roles" })).toHaveAttribute("aria-current", "page");

  // Scroll a long page to the bottom: the rail's first entry is still on
  // screen because the rail is sticky and self-scrolling.
  await page.goto("/admin/workspace");
  await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(150);
  const system = rail.getByRole("link", { name: "System" });
  const box = await system.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

// 1.8.0: settings search reaches pages and cards; Notifications has tabs.

test("settings search finds a card and Enter opens it", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin");
  const box = page.getByLabel("Search settings");
  await box.fill("timezone");
  const row = page.getByRole("link", { name: /Date & time.*Workspace/ });
  await expect(row).toBeVisible();
  await box.press("Enter");
  await expect(page).toHaveURL(/\/admin\/workspace#date-time$/);
  await expect(page.locator("#date-time")).toBeVisible();
});

test("settings search clears on Escape and lists sub-pages", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin");
  const box = page.getByLabel("Search settings");
  await box.fill("offices");
  await expect(page.getByRole("link", { name: /Offices.*Directory/ })).toBeVisible();
  await box.press("Escape");
  await expect(box).toHaveValue("");
});

test("Notifications is one section with two tabs and one h1", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/notifications/templates");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Notifications");
  const tabs = page.getByRole("navigation", { name: "Notification settings" });
  await expect(tabs.getByRole("link", { name: "Email templates" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Channels" }).click();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
  await expect(page.locator("#webhooks")).toBeVisible();
});
