import { test, expect, type Page } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// 1.18.0: the handbook editor and list. /handbooks lists the handbooks the
// person can read (and drafts they edit) with New handbook for whoever may
// create one; /handbooks/new takes the details and opens the editor, where
// "Add policies" ticks published documents onto the end of Contents, the
// arrows reorder across section edges, sections are added, renamed and
// removed, each policy's "Where people find it" is chosen from a menu, one
// Save (Ctrl/⌘+S) keeps it all, Publish / Unpublish are named actions and
// Delete asks. The editor fits a 375px phone without scrolling sideways.
// Once published, a Handbook-only policy is out of a reader's space page
// and search, and marked for the people who edit the space.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Purpose\n\nShort policy text for the handbook editor spec.";
const VIEWER = { username: "e2e_hb_editor_viewer", password: "E2eHbViewer!12345" };

async function makePolicy(page: Page, title: string): Promise<number> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: BODY, tags: [] },
  });
  expect(made.status, "policy created").toBe(201);
  const id = made.body?.doc?.id;
  expect(id, "policy id").toBeTruthy();
  return id;
}

/** The Contents card's policy titles, in reading order. */
async function contentsOrder(page: Page): Promise<string[]> {
  const card = page.locator("section", { has: page.getByRole("heading", { name: /^Contents/ }) });
  return card.locator("li[data-doc]").evaluateAll((els) => els.map((el) => el.getAttribute("data-title") ?? ""));
}

test.describe("handbook editor", () => {
  const made: { docs: number[]; handbooks: number[] } = { docs: [], handbooks: [] };

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const id of made.handbooks) await api(page, `/api/handbooks/${id}`, { method: "DELETE" });
    for (const id of made.docs) await api(page, `/api/documents/${id}`, { method: "DELETE" });
    await page.close();
  });

  test("create, fill, reorder, choose where people find it, publish and delete", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const s = stamp();
    const titleA = `HB editor A ${s}`;
    const titleB = `HB editor B ${s}`;
    const name = `E2E handbook ${s}`;
    await login(page, ADMIN);
    await ensureUser(page, VIEWER, "viewer", "E2E Handbook Viewer");
    await ensureUser(page, EDITOR, "editor", "E2E Editor");
    const docA = await makePolicy(page, titleA);
    const docB = await makePolicy(page, titleB);
    made.docs.push(docA, docB);

    // The list: the page title, and the one primary create action.
    await page.goto("/handbooks");
    await expect(page.getByRole("heading", { level: 1, name: "Handbooks" })).toBeVisible();
    await page.getByRole("link", { name: "New handbook" }).click();
    await expect(page).toHaveURL(/\/handbooks\/new$/);

    // A title is required, inline.
    await page.getByRole("button", { name: "Create handbook" }).click();
    await expect(page.getByText("Give the handbook a title.")).toBeVisible();
    await page.getByLabel("Title").fill(name);
    await page.getByRole("button", { name: "Create handbook" }).click();
    await expect(page).toHaveURL(/\/handbooks\/\d+\/edit$/);
    const id = Number(page.url().match(/handbooks\/(\d+)\/edit/)![1]);
    made.handbooks.push(id);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    // Add policies: search, tick B then A (ticking appends to the end).
    const search = page.getByRole("searchbox", { name: "Search documents" });
    await search.fill(s);
    const results = page.getByRole("list", { name: "Search results" });
    await results.getByRole("checkbox", { name: new RegExp(titleB) }).check();
    await results.getByRole("checkbox", { name: new RegExp(titleA) }).check();
    await expect.poll(() => contentsOrder(page)).toEqual([titleB, titleA]);
    await expect(page.getByText("2 selected")).toBeVisible();

    // Move A up: focus stays on the button that was pressed.
    const up = page.getByRole("button", { name: `Move ${titleA} up` });
    await up.click();
    // A is first now, so Move up is disabled and focus falls to its Move down, never to <body>.
    await expect(page.getByRole("button", { name: `Move ${titleA} down` })).toBeFocused();
    await expect.poll(() => contentsOrder(page)).toEqual([titleA, titleB]);

    // A second section; B crosses into it with Move down.
    await page.getByRole("button", { name: "Add section" }).click();
    const dialog = page.getByRole("dialog", { name: "Add section" });
    await dialog.getByLabel("Section name").fill("Security");
    await dialog.getByRole("button", { name: "Add section" }).click();
    await page.getByRole("button", { name: `Move ${titleB} down` }).click();
    await expect(page.getByRole("heading", { name: "2 · Security" })).toBeVisible();

    // Where people find it: Handbook only for A.
    await page.getByRole("button", { name: `Where people find ${titleA}: Space + handbook` }).click();
    await page.getByRole("menuitemradio", { name: /Only through handbooks/ }).click();
    await expect(page.getByRole("button", { name: `Where people find ${titleA}: Handbook only` })).toBeVisible();
    await expect(page.getByText("Handbook only takes effect once the handbook is published.")).toBeVisible();

    // One Save keeps it all; the keyboard shortcut is the same Save.
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.keyboard.press("Control+s");
    await expect(page.getByText("Handbook saved.")).toBeVisible();
    await page.reload();
    await expect.poll(() => contentsOrder(page)).toEqual([titleA, titleB]);
    await expect(page.getByRole("heading", { name: "2 · Security" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Where people find ${titleA}: Handbook only` })).toBeVisible();

    // Rename the first section.
    await page.getByRole("button", { name: /^Rename section Policies/ }).click();
    const rename = page.getByRole("dialog", { name: "Rename section" });
    await rename.getByLabel("Section name").fill("Working here");
    await rename.getByRole("button", { name: "Rename section" }).click();
    await expect(page.getByRole("heading", { name: "1 · Working here" })).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Handbook saved.")).toBeVisible();

    // Publish is a named action; the list shows it published.
    await page.getByRole("button", { name: "Publish handbook" }).click();
    await expect(page.getByText("Handbook published.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();

    // Handbook only, now in effect. A reader (not the author, no edit
    // rights) doesn't come across A in its space or in search; B, listed
    // in its space too, is the control.
    const searchIds = async (p: Page) => {
      const r = await api(p, `/api/search?q=${encodeURIComponent(s)}`);
      expect(r.status).toBe(200);
      return (r.body.hits as { id: number }[]).map((h) => h.id);
    };
    const viewerCtx = await browser.newContext();
    const editorCtx = await browser.newContext();
    try {
      const viewer = await viewerCtx.newPage();
      await login(viewer, VIEWER);
      await viewer.goto("/spaces/engineering");
      await expect(viewer.getByText(titleB, { exact: true }).first()).toBeVisible();
      await expect(viewer.getByText(titleA, { exact: true })).toHaveCount(0);
      await expect(viewer.getByRole("note").filter({ hasText: "handbook only" })).toHaveCount(0);
      const viewerHits = await searchIds(viewer);
      expect(viewerHits, "B is found").toContain(docB);
      expect(viewerHits, "A is not").not.toContain(docA);

      // Someone who edits the space still sees it, marked, and told why.
      const editor = await editorCtx.newPage();
      await login(editor, EDITOR);
      await editor.goto("/spaces/engineering");
      const card = editor.getByRole("link").filter({ hasText: titleA });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText("Handbook only");
      await expect(card).toContainText(`In ${name}`);
      await expect(editor.getByRole("link").filter({ hasText: titleB }).first()).not.toContainText("Handbook only");
      const notice = editor.getByRole("note").filter({ hasText: "handbook only" });
      await expect(notice).toContainText("because you edit this space");
      await expect(notice.getByRole("link", { name })).toHaveAttribute("href", `/handbooks/${id}`);
      expect(await searchIds(editor), "the space's editor finds A").toContain(docA);
    } finally {
      await viewerCtx.close();
      await editorCtx.close();
    }

    await page.goto("/handbooks");
    const row = page.getByRole("row", { name: new RegExp(name) });
    // The phone layout folds the status into the title cell; the desktop column is the visible one.
    await expect(row.getByText("Published", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(row.getByText("2 policies")).toBeVisible();
    await expect(row.getByRole("link", { name: `Print ${name}` })).toHaveAttribute("href", `/handbooks/${id}/print?print=1`);

    // Unpublish asks first.
    await row.getByRole("link", { name: `Edit ${name}` }).click();
    await page.getByRole("button", { name: "Unpublish" }).click();
    await page.getByRole("dialog", { name: "Unpublish this handbook?" }).getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByText("Handbook unpublished.")).toBeVisible();

    // Delete asks, then the list no longer has it.
    await page.getByRole("button", { name: "Delete handbook" }).click();
    await page.getByRole("dialog", { name: `Delete "${name}"?` }).getByRole("button", { name: "Delete handbook" }).click();
    await expect(page).toHaveURL(/\/handbooks$/);
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
    made.handbooks = made.handbooks.filter((h) => h !== id);
  });

  test("the editor fits a 375px phone", async ({ page }) => {
    // Sized before the first page, so the shell starts as a phone (the sidebar rail) rather than resizing into one.
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, ADMIN);
    const created = await api(page, "/api/handbooks", {
      method: "POST",
      body: { title: `E2E phone handbook ${stamp()}`, space_id: null, introduction: "", audience: "all", group_ids: [], confirm_whole: false, require_signature: false },
    });
    expect(created.status).toBeLessThan(300);
    const id = created.body?.handbook?.id;
    made.handbooks.push(id);
    await page.goto(`/handbooks/${id}/edit`);
    await expect(page.getByRole("heading", { name: /^Contents/ })).toBeVisible();
    // Hydrated: on a phone the shell has folded the sidebar to its rail.
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    // …and its width transition has finished.
    await expect.poll(() => page.locator("aside[data-app-sidebar]").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(80);
    const spill = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll("main *")]
        .filter((e) => e.getBoundingClientRect().right > w + 1)
        .map((e) => `${e.tagName}.${String((e as HTMLElement).className).slice(0, 60)}`);
      return { by: document.documentElement.scrollWidth - w, wide: wide.slice(0, 5) };
    });
    expect(spill.by, `no sideways scroll at 375px: ${spill.wide.join(", ")}`).toBeLessThanOrEqual(0);
  });
});
