import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.1 (item D2): the editor's properties sit in a sticky rail beside the
// text at Wide and Full, the toolbar keeps one height wherever the caret
// is, and the Markdown pane grows with the document.

const CONTENT = `Intro paragraph.\n\n## First section\n\n${"Lorem ipsum dolor sit amet. ".repeat(20)}\n\n## Second section\n\nMore text.\n`;

test("properties beside the editor at Wide, above it at Normal; no extra aside", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E editor layout ${Date.now()}`, type: "knowledge", status: "draft", content: CONTENT, tags: [] },
    });
    docId = made.body?.doc?.id;

    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    await page.goto(`/doc/${docId}/edit`);
    const editor = page.locator(".tiptap").first();
    await editor.waitFor({ state: "visible", timeout: 15000 });
    const space = page.locator('label:has(span:text-is("Space")) select');
    const eb = (await editor.boundingBox())!;
    const sb = (await space.boundingBox())!;
    expect(sb.x, "the Space control is to the right of the text").toBeGreaterThan(eb.x + eb.width);
    expect(sb.y, "and level with it, not above it").toBeLessThan(eb.y + 200);
    await expect(page.getByLabel("Summary")).toBeVisible();
    await expect(page.getByLabel(/Change note/)).toBeVisible();
    // The rail is not an <aside>: the sidebar stays the one aside the
    // specs locate.
    expect(await page.locator("aside").count()).toBe(1);

    // Scrolling a long document keeps the properties on screen.
    for (let i = 0; i < 40; i++) await editor.press("End");
    await page.locator("#main").evaluate((el) => el.scrollTo(0, 1200));
    await page.waitForTimeout(200);
    await expect(space).toBeInViewport();
    await expect(page.getByRole("button", { name: /save/i }).first()).toBeInViewport();

    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "normal" } });
    await page.goto(`/doc/${docId}/edit`);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    const eb2 = (await editor.boundingBox())!;
    const sb2 = (await page.locator('label:has(span:text-is("Space")) select').boundingBox())!;
    expect(sb2.y, "at Normal the properties sit above the text").toBeLessThan(eb2.y);
  } finally {
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the toolbar keeps its height as the caret moves, and the Markdown pane grows", async ({ page }) => {
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E toolbar ${Date.now()}`, type: "knowledge", status: "draft", content: CONTENT, tags: [] },
    });
    docId = made.body?.doc?.id;
    await page.goto(`/doc/${docId}/edit`);
    const editor = page.locator(".tiptap").first();
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(1000);
    const context = page.locator('[aria-label="Tools for the current block"]');
    await expect(context).toBeVisible();
    const toolbar = context.locator("..");
    await editor.locator("p").first().click();
    const inParagraph = (await toolbar.boundingBox())!;
    await expect(context).toContainText(/appear here/);
    await editor.locator("h2").first().click();
    await expect(context).toContainText("Highlight");
    const inHeading = (await toolbar.boundingBox())!;
    expect(inHeading.height, "the toolbar never changes height").toBe(inParagraph.height);
    const text = editor.locator("p").first();
    const before = (await text.boundingBox())!.y;
    await editor.locator("p").first().click();
    await expect(context).toContainText(/appear here/);
    expect((await text.boundingBox())!.y, "the text does not shift").toBe(before);

    // Markdown: the pane is as tall as its content.
    await page.getByRole("button", { name: "Markdown" }).click();
    const ta = page.locator("textarea");
    await ta.waitFor();
    const short = (await ta.boundingBox())!.height;
    await ta.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\n" + "Another line.\n".repeat(40));
    await page.waitForTimeout(200);
    const tall = (await ta.boundingBox())!.height;
    expect(tall, "the textarea grew with the document").toBeGreaterThan(short + 300);
    const overflow = await ta.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow, "nothing scrolls inside the pane").toBeLessThanOrEqual(2);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
