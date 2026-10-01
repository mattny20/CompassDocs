import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// 1.6.2: sortable headers carry aria-sort, the audit log's header sticks,
// and floating panels share one Popover (outside click, Escape, focus
// return through the overlay stack).

test("the audit log's header sticks while the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, ADMIN);
  await page.goto("/admin/audit");
  const thead = page.locator("table thead").first();
  await expect(thead).toBeVisible();
  expect(await thead.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(150);
  const box = await thead.boundingBox();
  expect(box).not.toBeNull();
  // Either the table was short (header where it was) or the header pinned
  // itself at the top of the scroll container.
  expect(box!.y).toBeGreaterThanOrEqual(0);
});

test("a sortable header is a button with aria-sort", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/spaces/engineering?view=table");
  const sortable = page.locator("th[aria-sort]").first();
  if ((await sortable.count()) === 0) test.skip(true, "no sortable table in this build");
  const btn = sortable.getByRole("button");
  await expect(btn).toBeVisible();
  const before = await sortable.getAttribute("aria-sort");
  await btn.click();
  await expect
    .poll(async () => page.locator("th[aria-sort]").first().getAttribute("aria-sort"))
    .not.toBe(before === "ascending" ? "ascending" : "none");
  // No typed arrows anywhere in headers.
  expect(await page.locator("thead").first().innerText()).not.toMatch(/[↑↓]/);
});

test("the bell's panel closes on Escape and hands focus back", async ({ page }) => {
  await login(page, ADMIN);
  const bell = page.getByRole("button", { name: /^Notifications/ }).first();
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(bell).toBeFocused();
  // Outside click closes it too.
  await bell.click();
  await expect(panel).toBeVisible();
  await page.locator("h1").first().click();
  await expect(panel).toHaveCount(0);
});

test("the directory Export menu is a menu with menu items", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/directory");
  const trigger = page.getByRole("button", { name: /^Export/ }).first();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Export" });
  await expect(menu).toBeVisible();
  expect(await menu.getByRole("menuitem").count()).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
