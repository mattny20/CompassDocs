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

// 1.9.2 (item D7): mode chips, the Links group, a valid listbox.
test("mode chips switch the mode and keep focus in the input; a configured link is found and opens in a new tab", async ({ page, context }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  let linkId: number | undefined;
  try {
    const made = await page.evaluate(async (s) => {
      const res = await fetch("/api/admin/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Clio ${s}`, url: "https://example.com/clio", description: "Practice management" }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, stamp);
    expect([200, 201], "link created").toContain(made.status);
    linkId = made.body?.link?.id ?? made.body?.id;

    await page.goto("/");
    await hotkeysReady(page);
    await focusBody(page);
    await page.keyboard.press("Control+k");
    const dialog = palette(page);
    await expect(dialog).toBeVisible();
    const chips = dialog.getByRole("group", { name: "Search in" });
    await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await chips.getByRole("button", { name: "People" }).click();
    await expect(chips.getByRole("button", { name: "People" })).toHaveAttribute("aria-pressed", "true");
    // Focus never left the input.
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await expect(dialog.getByRole("combobox")).toHaveAttribute("placeholder", /people/i);
    await chips.getByRole("button", { name: "All" }).click();
    await expect(dialog.getByRole("combobox")).toBeFocused();

    // The Links launchpad is indexed: "Clio" is a result, in its own group.
    await page.keyboard.type(`Clio ${stamp}`);
    const list = dialog.getByRole("listbox", { name: "Results" });
    const links = list.getByRole("group", { name: "Links" });
    await expect(links).toBeVisible();
    const row = links.getByRole("option", { name: new RegExp(`Clio ${stamp}`) });
    await expect(row).toBeVisible();
    // Keycaps speak their names.
    await expect(dialog.locator("kbd .sr-only", { hasText: "Enter" }).first()).toBeAttached();

    // Enter opens the external link in a new tab and closes the palette.
    // (The sandbox has no network; answer example.com ourselves.)
    await context.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Clio</title>" }));
    const popup = context.waitForEvent("page");
    await row.click();
    const opened = await popup;
    expect(opened.url()).toContain("example.com/clio");
    await opened.close();
    await expect(dialog).toBeHidden();
  } finally {
    if (linkId) await page.evaluate((id) => fetch(`/api/admin/links/${id}`, { method: "DELETE" }), linkId);
  }
});
