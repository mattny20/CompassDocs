import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// 1.7.1: the shared Save row (pristine disabled, dirty enabled, leave
// guard, Ctrl+S) and the themed confirm / prompt dialogs.

test("the Workspace save row: pristine disabled, edit enabled, leave prompts, Ctrl+S saves", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/workspace");
  const save = page.getByRole("button", { name: /^Save changes/ });
  await expect(save).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  const company = page.getByLabel("Company name");
  const original = await company.inputValue();
  await company.fill(`${original} (edited)`);
  await expect(save).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Leaving via the rail asks first; declining keeps the page.
  let asked = 0;
  page.once("dialog", async (d) => {
    asked++;
    expect(d.message()).toMatch(/unsaved changes/i);
    await d.dismiss();
  });
  await page.getByRole("link", { name: "System" }).first().click();
  await expect(page).toHaveURL(/\/admin\/workspace$/);
  expect(asked).toBe(1);

  // Ctrl+S saves and the row says so.
  await company.press("Control+s");
  await expect(page.locator('[role="status"]').getByText(/saved/i).last()).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // Put it back.
  await company.fill(original);
  await save.click();
  await expect(page.locator('[role="status"]').getByText(/saved/i).last()).toBeVisible();
});

test("a themed prompt: reset password is masked, validates, Escape returns focus", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/users");
  const trigger = page.getByRole("button", { name: "Reset password" }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /temporary password/i });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel("Temporary password");
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toBeFocused();
  await input.fill("abc");
  await dialog.getByRole("button", { name: "Set password" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/at least 8/i);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the role select asks before changing a role, and cancelling keeps it", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/users");
  const select = page.getByLabel(/^Role for E2E Editor/);
  await expect(select).toHaveValue("editor");
  await select.selectOption("viewer");
  const dialog = page.getByRole("dialog", { name: /change .* role/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(select).toHaveValue("editor");
});

test("type-to-confirm gates deleting a space that holds documents", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/admin/spaces");
  // Any E2E Drafts space holds at least one document.
  const row = page
    .locator("div", { has: page.getByText(/E2E Drafts/) })
    .filter({ has: page.getByRole("button", { name: "Delete" }) })
    .last();
  await row.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: /delete the space/i });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete space" });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByText(/type .* to confirm/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
