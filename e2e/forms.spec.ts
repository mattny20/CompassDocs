import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// 1.7.0: fields that assistive tech understands, form errors that are
// announced, and bounded numbers that validate inline.

test("a wrong password announces an alert on the login page", async ({ page }) => {
  await page.goto("/login");
  // Real labels now; the autocomplete selectors the helper uses still resolve.
  await expect(page.getByLabel("Username")).toBeVisible();
  await page.fill('input[autocomplete="username"]', ADMIN.username);
  await page.fill('input[autocomplete="current-password"]', "definitely-not-it");
  await page.click('button[type="submit"]');
  const alert = page.getByRole("alert").filter({ hasText: /password|sign in|invalid|incorrect/i });
  await expect(alert).toBeVisible();
});

test("5000 days shows an inline error, no success toast, and the field is marked invalid", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/workspace");
  const days = page.getByLabel(/^Days \(/);
  await expect(days).toBeVisible();
  const before = await days.inputValue();
  await days.fill("5000");
  const error = page.getByRole("alert").filter({ hasText: /between 0 and 3650/ });
  await expect(error).toBeVisible();
  await expect(days).toHaveAttribute("aria-invalid", "true");
  const describedBy = await days.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(/between 0 and 3650/);

  // Save refuses while a field is wrong (1.7.1: the shared Save row), so no
  // success toast can ever follow a clamped value.
  await expect(page.getByRole("button", { name: /^Save/ }).first()).toBeDisabled();
  await expect(page.locator('[role="status"]').getByText(/saved/i)).toHaveCount(0);

  // Back to a valid value: the error clears and the field is valid again.
  await days.fill(before || "30");
  await expect(error).toHaveCount(0);
  await expect(days).not.toHaveAttribute("aria-invalid", "true");
});

test("help text describes its control", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/account");
  const username = page.getByLabel("Username");
  const describedBy = await username.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(/permanent/i);
  // And the medium size caps the control well short of a wide page.
  const box = await username.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(28 * 16 + 2);
});

test("the add-user form validates inline before it talks to the server", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /username is required/i })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /at least 6 characters/i })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeFocused();
  await expect(page.locator('[role="status"]').getByText(/created/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
});
