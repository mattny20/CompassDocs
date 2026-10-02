import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.3 (items D8–D11): the dashboard's compact Spaces grid and
// de-duplicated Latest list, the Ask page's first-run state, the search
// results grid with removable filter chips, and space cards that show the
// author with one segmented layout control.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test("the dashboard shows at most eight spaces, Latest never repeats a pick-up card, and rows carry a type badge", async ({ page }) => {
  await login(page, ADMIN);
  const s = stamp();
  let docId: number | undefined;
  try {
    // A fresh draft by the admin lands in the pick-up cards AND would be the
    // newest "latest" row — it must appear once.
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E dash dedupe ${s}`, type: "sop", status: "draft", content: "x", tags: [] },
    });
    docId = made.body?.doc?.id;
    await page.goto("/");
    const main = page.locator("#main");
    const spacesHeading = main.getByRole("heading", { name: "Spaces", exact: true });
    await expect(spacesHeading).toBeVisible();
    const spaces = spacesHeading.locator("..").locator("..").locator("a[href^='/spaces/']");
    expect(await spaces.count()).toBeLessThanOrEqual(8);
    expect(await main.getByRole("link", { name: new RegExp(`E2E dash dedupe ${s}`) }).count(), "shown once").toBe(1);
    const latest = main.getByRole("heading", { name: "Latest in your spaces" }).locator("..").locator("..");
    await expect(latest.getByRole("link").first()).toBeVisible();
    // Type badges, not clocks: every row names its type.
    const first = latest.getByRole("link").first();
    await expect(first.getByText(/^(SOP|Technical|Policy|Knowledge)$/)).toBeVisible();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("Ask has a first-run state; operators insert at the caret; a query in the URL hides it", async ({ page }) => {
  await login(page, ADMIN);
  const s = stamp();
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E ask grid ${s}`, type: "knowledge", status: "published", content: `Xylophone ${s} body text.`, tags: ["e2e"] },
    });
    docId = made.body?.doc?.id;

    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Try asking" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Search operators" })).toBeVisible();
    const input = page.getByLabel("Ask a question or search by keyword");
    await input.fill("deploy");
    await page.getByRole("button", { name: "type:" }).click();
    await expect(input).toHaveValue("deploy type:");
    await expect(input).toBeFocused();

    // Submitting remembers the question in this browser only.
    await input.fill(`Xylophone ${s}`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /matching document/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Try asking" })).toHaveCount(0);
    // Scoped to the results grid: the AI answer's Sources may link it too.
    const results = page.getByRole("heading", { name: /matching document/ }).locator("..");
    const hit = results.getByRole("link", { name: new RegExp(`E2E ask grid ${s}`) });
    await expect(hit).toBeVisible();
    await expect(hit.getByRole("heading")).toHaveText(`E2E ask grid ${s}`);

    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Your recent searches" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Xylophone ${s}` })).toBeVisible();

    // A query in the URL auto-runs; a filter chip removal re-runs without it.
    await page.goto(`/search?q=${encodeURIComponent(`type:knowledge Xylophone ${s}`)}`);
    await expect(page.getByRole("heading", { name: "Try asking" })).toHaveCount(0);
    await expect(hit).toBeVisible();
    await page.getByRole("button", { name: "Remove type filter" }).click();
    await expect(page.getByRole("button", { name: "Remove type filter" })).toHaveCount(0);
    await expect(input).toHaveValue(`Xylophone ${s}`);
    await expect(hit).toBeVisible();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("space cards show the author, not the space, under one segmented layout control", async ({ page }) => {
  await login(page, ADMIN);
  const s = stamp();
  let docId: number | undefined;
  try {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `E2E space card ${s}`, type: "knowledge", status: "published", content: "x", summary: "A card.", tags: [] },
    });
    docId = made.body?.doc?.id;
    const doc = (await api(page, `/api/documents/${docId}`)).body?.doc;
    await page.goto(`/spaces/${doc.space_slug}`);
    const layout = page.getByRole("radiogroup", { name: "Space layout" });
    await expect(layout).toBeVisible();
    await layout.getByRole("radio", { name: "Cards" }).click();
    await expect(layout.getByRole("radio", { name: "Cards" })).toHaveAttribute("aria-checked", "true");
    const card = page.getByRole("link", { name: new RegExp(`E2E space card ${s}`) });
    await expect(card).toBeVisible();
    await expect(card).toContainText(doc.author);
    await expect(card).not.toContainText(doc.space_name);
    await layout.getByRole("radio", { name: "Table" }).click();
    await expect(layout.getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
