import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// Account settings live inside the app shell (1.5.2): the sidebar stays,
// the section is the page's h1, and the width control re-flows the page
// without a reload.

test("account pages keep the shell and the width choice re-flows at once", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/account/preferences");
  await expect(page).toHaveTitle(/^Preferences — /);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect(page.locator("h1")).toHaveText(/Preferences/);
  await expect(
    page.getByRole("navigation", { name: "Account settings" }).getByRole("link", { name: "Preferences" })
  ).toHaveAttribute("aria-current", "page");

  const container = page.locator("[data-page-width]").first();
  const group = page.getByRole("radiogroup", { name: "Page width preference" });
  await group.getByRole("radio", { name: "Normal" }).click();
  await expect(container).toHaveAttribute("data-page-width", "normal");
  // Persisted to the account, not just this render.
  await page.reload();
  await expect(page.locator("[data-page-width]").first()).toHaveAttribute("data-page-width", "normal");

  // Keyboard: arrows move the choice like a native radio.
  await group.getByRole("radio", { name: "Normal" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(container).toHaveAttribute("data-page-width", "wide");
  await expect(group.getByRole("radio", { name: "Wide" })).toHaveAttribute("aria-checked", "true");
});

test("the standalone password page sends an unforced user to Security inside the shell", async ({
  page,
}) => {
  await login(page, ADMIN);
  await page.goto("/account/password");
  await page.waitForURL("**/account/security");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect(page.locator("h1")).toHaveText(/Security/);
});
