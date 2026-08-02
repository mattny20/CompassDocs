import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// The editor used to discard unsaved work silently: Ctrl+S did nothing, Save
// scrolled off-screen, and clicking the sidebar navigated away without a word.
// These tests exist so that can't come back quietly.

const SENTINEL = "UNSAVED SENTINEL";

async function openDirtyEditor(page: Page) {
  await page.goto("/doc/1/edit");
  const editor = page.locator(".tiptap").first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  // Let tiptap's markdown round-trip and the parent lookup settle, so we're
  // testing a genuinely user-made change rather than mount-time churn.
  await page.waitForTimeout(2000);
  await editor.click();
  await page.keyboard.type(SENTINEL);
  return editor;
}

test("Ctrl+S saves from inside the editor", async ({ page }) => {
  await login(page, ADMIN);
  await openDirtyEditor(page);
  await page.keyboard.press("Control+s");
  await page.waitForURL("**/doc/1", { timeout: 15000 });
  await expect(page.locator("body")).toContainText(SENTINEL);
});

test("leaving with unsaved changes asks first, and keeps the text if declined", async ({ page }) => {
  await login(page, ADMIN);
  const editor = await openDirtyEditor(page);

  const prompts: string[] = [];
  page.on("dialog", async (d) => {
    prompts.push(d.message());
    await d.dismiss();
  });
  await page.locator('aside a[href="/"]').first().click();
  await page.waitForTimeout(700);

  expect(prompts.join(" ")).toMatch(/unsaved/i);
  expect(page.url()).toContain("/doc/1/edit");
  await expect(editor).toContainText(SENTINEL);
});

test("a pristine editor never nags, and navigates freely", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/doc/1/edit");
  await page.locator(".tiptap").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(2000);

  const prompts: string[] = [];
  page.on("dialog", async (d) => {
    prompts.push(d.message());
    await d.dismiss();
  });
  await page.locator('aside a[href="/"]').first().click();
  await page.waitForTimeout(700);

  expect(prompts).toEqual([]);
  expect(page.url()).not.toContain("/edit");
});

test("Save stays on screen at the bottom of a long document", async ({ page }) => {
  await login(page, ADMIN);
  const editor = await openDirtyEditor(page);
  for (let i = 0; i < 25; i++) await page.keyboard.press("Enter");
  await page.keyboard.type("end of the document");
  await editor.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /save/i }).first()).toBeInViewport();
});

test("a missing document renders our own 404 inside the app shell", async ({ page }) => {
  await login(page, ADMIN);
  const res = await page.goto("/doc/999999");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText(/not found/i);
  // The point of the custom page: you are still in the app, with a way out.
  await expect(page.locator("aside").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /back to dashboard/i })).toBeVisible();
});
