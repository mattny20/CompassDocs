import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.0: the editor shares the reader's measure (decision D-4) and the table
// of contents lives in the rail at Wide and Full, marking the heading you are
// reading. reading-width.spec covers the reader itself; these are the two
// new surfaces.

const LONG = `Body text long enough to reach the measure. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(12)}`;

const SECTIONS = `${LONG}

## First section

${LONG}

| Region | Owner | Q1 | Q2 | Q3 | Q4 | Target | Variance | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EMEA North | A. Rahman | 1,240 | 1,380 | 1,410 | 1,502 | 5,400 | +132 | On track | Renewal cycle shifted |

## Second section

${LONG}

${LONG}

### A subsection

${LONG}

## Third section

${LONG}

${LONG}

${LONG}

## Last section

${LONG}
`;

test("the editor caps running text at the measure and keeps tables wide; the caret still lands", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E editor measure ${Date.now()}`, type: "technical", status: "draft", content: SECTIONS, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "full" } });

    await page.goto(`/doc/${docId}/edit`);
    const editor = page.locator(".tiptap").first();
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(1500);
    const column = (await editor.boundingBox())!.width;
    const para = editor.locator("> p").first();
    const paraBox = (await para.boundingBox())!;
    const table = editor.locator("> .tableWrapper, > table").first();
    const tableWidth = (await table.boundingBox())!.width;
    // The measure is 90ch at Full (~870px); the column beside the 1.9.1
    // properties rail is wider than that by a clear margin.
    expect(paraBox.width, "running text is capped inside the Full column").toBeLessThan(column - 60);
    expect(tableWidth, "the table keeps the column").toBeGreaterThan(paraBox.width + 40);

    // Clicking in the empty space to the right of a capped paragraph still
    // places the caret in that paragraph (at the end of its nearest line).
    const before = (await para.textContent()) ?? "";
    await page.mouse.click(paraBox.x + column - 40, paraBox.y + 12);
    await page.keyboard.type(" CARET");
    await expect(para).toContainText("CARET");
    expect(((await para.textContent()) ?? "").length).toBe(before.length + " CARET".length);
  } finally {
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the table of contents sits in the rail at Wide, marks the current heading, and lands deep links", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 900 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E toc ${Date.now()}`, type: "knowledge", status: "published", content: SECTIONS, tags: [] },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;

    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    await page.goto(`/doc/${docId}`);
    const toc = page.getByRole("navigation", { name: "Table of contents" });
    await expect(toc).toBeVisible();
    // Rail placement: the toc is inside the document rail (the second aside),
    // headed "On this page", and marks the first heading before any scroll.
    await expect(page.locator("aside").nth(1).getByRole("navigation", { name: "Table of contents" })).toBeVisible();
    await expect(toc.getByRole("button", { name: /On this page/ })).toBeVisible();
    await expect(toc.getByRole("link", { name: "First section" })).toHaveAttribute("aria-current", "location");
    await expect(toc.getByRole("link", { name: "A subsection" })).toBeVisible();

    // Scroll to the end: the last section is current.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(400);
    await expect(toc.getByRole("link", { name: "Last section" })).toHaveAttribute("aria-current", "location");
    await expect(toc.getByRole("link", { name: "First section" })).not.toHaveAttribute("aria-current", "location");

    // Clicking an entry jumps and the mark follows.
    await toc.getByRole("link", { name: "Second section" }).click();
    await page.waitForTimeout(400);
    await expect(toc.getByRole("link", { name: "Second section" })).toHaveAttribute("aria-current", "location");

    // A deep link lands on the heading even though ids are assigned on the
    // client after the page has loaded.
    await page.goto(`/doc/${docId}#third-section`);
    await page.waitForTimeout(800);
    const top = await page.locator("#third-section").evaluate((el) => el.getBoundingClientRect().top);
    expect(top, "the heading is near the top of the viewport").toBeGreaterThan(0);
    expect(top).toBeLessThan(200);
    await expect(toc.getByRole("link", { name: "Third section" })).toHaveAttribute("aria-current", "location");

    // Normal: no rail, so the toc is the card above the body.
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "normal" } });
    await page.goto(`/doc/${docId}`);
    await expect(page.getByRole("navigation", { name: "Table of contents" }).getByRole("button", { name: /^Table of contents/ })).toBeVisible();
  } finally {
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});
