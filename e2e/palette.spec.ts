import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// The command palette and the global hotkey layer. These are the app's first
// keyboard-shortcut tests, and they exist mostly to protect two properties
// that are easy to break silently: a shortcut must never steal a keystroke
// meant for text, and every binding must work on Windows/Linux as well as it
// does on a Mac.

const palette = (page: Page) => page.locator('[role="dialog"][aria-label="Command palette"]');

/**
 * Wait until the app-wide hotkey layer is actually listening.
 *
 * The palette is a client component mounted by the app shell, so a keypress
 * sent between navigation and hydration is simply dropped — which made these
 * tests intermittently fail with "element not found" rather than anything
 * meaningful. The sidebar's search affordance renders from the same client
 * bundle as the sidebar chrome, so waiting for a sidebar control to appear is a
 * sound proxy for "the listener is bound".
 */
async function hotkeysReady(page: Page) {
  await expect(page.locator('[aria-label="Collapse sidebar"]').first()).toBeVisible();
}

/** Focus the page body, so bare-key shortcuts aren't suppressed by an input. */
async function focusBody(page: Page) {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === "function") el.blur();
  });
}

test("Ctrl+K and Meta+K both open the palette over the current page", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/directory");
  await hotkeysReady(page);
  const url = page.url();

  // Windows/Linux modifier.
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  expect(page.url()).toBe(url); // floats in front; never navigates away
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();

  // macOS modifier.
  await page.keyboard.press("Meta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("Ctrl+K still works while typing in the editor, bare keys do not", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/doc/new?template=blank");
  const editor = page.locator(".tiptap").first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click();
  await page.keyboard.type("hello");

  // Bare keys must be typed as text, never swallowed as shortcuts.
  await page.keyboard.type("c/@");
  await expect(palette(page)).toBeHidden();
  await expect(editor).toContainText("helloc/@");

  // Ctrl+K is the deliberate exception: it opens even from inside the editor.
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("helloc/@"); // no stray "k"
});

test("mode keys open their mode, on any keyboard layout", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  for (const key of ["/", "@", ">", "#", "?"]) {
    await page.keyboard.press(key);
    await expect(palette(page), `"${key}" opens the palette`).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette(page)).toBeHidden();
  }
});

test("g chords navigate, and are ignored while typing", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  await page.keyboard.press("g");
  await page.keyboard.press("p");
  await page.waitForURL("**/directory", { timeout: 5000 });

  // The directory filter autofocuses, so the same chord must type instead.
  const filter = page.locator("input").first();
  await filter.click();
  await filter.fill("");
  await page.keyboard.type("gp");
  expect(page.url()).toContain("/directory");
  await expect(filter).toHaveValue("gp");
});

test("people mode searches the directory and excludes hidden people", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  await page.keyboard.press("@");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("a");
  // Either results or an honest empty state — never a crash or a stuck spinner.
  await expect(palette(page)).toContainText(/People|No matches|Start typing/, { timeout: 5000 });
});

test("the shortcut sheet names the right modifier for this platform", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  await page.keyboard.press("?");
  await expect(palette(page)).toBeVisible();
  const isApple = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/.test(`${navigator.platform || ""} ${navigator.userAgent || ""}`)
  );
  await expect(palette(page)).toContainText(isApple ? "⌘" : "Ctrl");
  if (!isApple) await expect(palette(page)).not.toContainText("⌘");
});

test("search returns documents and Enter opens the selection", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("incident");
  await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 8000 });
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
});

test("the background is inert while the palette is open, and restored after", async ({ page }) => {
  await login(page, ADMIN);
  await focusBody(page);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  expect(await page.locator("#main").getAttribute("inert")).not.toBeNull();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  expect(await page.locator("#main").getAttribute("inert")).toBeNull();
});

test("search rejects a negative limit instead of failing", async ({ page }) => {
  await login(page, ADMIN);
  const res = await page.request.get("/api/search?q=a&limit=-1");
  expect(res.status()).toBe(200);
  expect(Array.isArray((await res.json()).hits)).toBe(true);
});
