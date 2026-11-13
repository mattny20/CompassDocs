import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Managed categories and sub-categories (1.20.6). Desk settings → Categories:
// a new category with two sub-categories, a name that is taken is refused in
// the dialog, a rename, archive and restore. On a ticket the category is a
// pick from that list (never typed), then a sub-category of it, each leaving
// a timeline line; a name that is not on the list is refused by the API.
// "Merge into…" moves a double's tickets to the kept category and removes the
// double. The automations editor offers the list as ticks and Selects.
// Licensed rig only: the community build asserts the licence gate. Everything
// it makes (a team, tickets, categories) carries its stamp and is removed
// afterwards; nothing else on the list is touched.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const SETTINGS = "/desk/settings/categories";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test("categories: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/categories")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/categories")).status).toBe(402);
});

test.describe("categories (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const HARDWARE = `Hardware ${stamp}`;
  const DOUBLE = `Hardwear ${stamp}`;
  const teamName = `E2E Categories ${stamp}`;
  let teamId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    // A ticket in the recycle bin still has its category: clear it first, so the category is unused.
    for (const n of new Set(tickets)) {
      await api(page, `/api/helpdesk/tickets/${n}`, { method: "PATCH", body: { category: "" } });
      await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    }
    const list = await api(page, "/api/helpdesk/admin/categories");
    for (const c of list.body?.categories ?? []) if (String(c.name).includes(stamp)) await api(page, `/api/helpdesk/admin/categories/${c.id}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  async function newTicket(page: Page, subject: string): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "The screen flickers when it is docked.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    tickets.push(t.body.ticket.number);
    return t.body.ticket.number as number;
  }
  const mineOf = async (page: Page) => ((await api(page, "/api/helpdesk/admin/categories")).body.categories as { id: number; name: string; archived: boolean; subcategories: { id: number; name: string }[] }[]).filter((c) => c.name.includes(stamp));

  test("Desk settings → Categories: add a category and sub-categories, a taken name is refused, rename, archive and restore", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(SETTINGS);
    await slow(page.getByRole("heading", { level: 1, name: "Categories" })).toBeVisible({ timeout: 120_000 });
    await slow(page.getByRole("link", { name: /^Categories/ })).toHaveAttribute("aria-current", "page");

    // A new category.
    const create = page.getByRole("dialog", { name: "New category" });
    // The busy dev rig may still be hydrating: click until the dialog opens.
    await expect(async () => {
      await page.getByRole("button", { name: "New category" }).first().click();
      await expect(create).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await create.getByLabel("Name").fill(HARDWARE);
    const [made] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/categories") && r.request().method() === "POST", { timeout: 120_000 }),
      create.getByRole("button", { name: "Add category" }).click(),
    ]);
    expect(made.status()).toBe(201);
    const hw = page.locator(`[data-testid="hd-category-row"][data-category="${HARDWARE}"]`);
    await slow(hw).toBeVisible({ timeout: 120_000 });
    await expect(hw).toContainText("Not used yet");

    // The same name again, in another case: refused in the dialog, nothing is sent.
    await page.getByRole("button", { name: "New category" }).first().click();
    await slow(create).toBeVisible();
    await create.getByLabel("Name").fill(HARDWARE.toUpperCase());
    await create.getByRole("button", { name: "Add category" }).click();
    await expect(create.getByText(`There is already a category called "${HARDWARE.toUpperCase()}".`)).toBeVisible();
    await create.getByRole("button", { name: "Cancel" }).click();
    await expect(create).toHaveCount(0);

    // Two sub-categories.
    for (const sub of ["Laptop", "Monitor"]) {
      const dialog = page.getByRole("dialog", { name: `New sub-category of ${HARDWARE}` });
      await hw.getByRole("button", { name: `Add a sub-category to ${HARDWARE}` }).click();
      await slow(dialog).toBeVisible();
      await dialog.getByLabel("Name").fill(sub);
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/categories") && r.request().method() === "POST", { timeout: 120_000 }),
        dialog.getByRole("button", { name: "Add sub-category" }).click(),
      ]);
      expect(res.status()).toBe(201);
      await slow(hw.locator(`[data-subcategory="${sub}"]`)).toBeVisible({ timeout: 120_000 });
    }

    // Rename a sub-category.
    const rename = page.getByRole("dialog", { name: "Rename Monitor" });
    await hw.getByRole("button", { name: "Rename Monitor" }).click();
    await slow(rename).toBeVisible();
    await rename.getByLabel("Name").fill("Screen");
    await rename.getByRole("button", { name: "Rename" }).click();
    await slow(hw.locator('[data-subcategory="Screen"]')).toBeVisible({ timeout: 120_000 });
    await expect(hw.locator('[data-subcategory="Monitor"]')).toHaveCount(0);

    // Archive it from the row's menu, then restore it.
    await hw.getByRole("button", { name: `More actions for ${HARDWARE}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    const archive = page.getByRole("dialog", { name: `Archive ${HARDWARE}?` });
    await slow(archive).toBeVisible();
    await archive.getByRole("button", { name: "Archive" }).click();
    // (The chip reads ", Archived" to a screen reader, so the row's name is a sentence.)
    await slow(hw.getByText("Archived").first()).toBeVisible({ timeout: 120_000 });
    expect((await mineOf(page)).find((c) => c.name === HARDWARE)?.archived).toBe(true);
    const offered = (await api(page, "/api/helpdesk/v1/categories")).status;
    expect(offered, "the REST API is for tokens, not sessions").toBe(401);
    await hw.getByRole("button", { name: `More actions for ${HARDWARE}` }).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await slow(hw.getByText("Archived")).toHaveCount(0, { timeout: 120_000 });
    expect((await mineOf(page)).find((c) => c.name === HARDWARE)?.subcategories.map((s) => s.name)).toEqual(["Laptop", "Screen"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-categories-1440-light.png`, fullPage: true });
  });

  test("on a ticket the category is picked from the list, then a sub-category; the API refuses a name that is not on it", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await mineOf(page)).map((c) => c.name), "the first test made the category").toContain(HARDWARE);
    const number = await newTicket(page, "Monitor flickers on the dock");
    await page.goto(`/desk/tickets/${number}`);
    const category = page.getByTestId("ticket-category");
    await slow(category).toBeVisible({ timeout: 120_000 });
    await expect(category).toHaveText("None");
    await expect(page.getByTestId("ticket-subcategory")).toHaveCount(0);

    // A menu of the list, nothing to type in.
    const menu = page.getByRole("menu", { name: "Category", exact: true });
    await expect(async () => {
      await category.click();
      await expect(menu).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(menu.getByRole("textbox")).toHaveCount(0);
    // The list may still be on its way: its entries and the link for people who manage it arrive together.
    await slow(menu.getByRole("menuitemradio", { name: new RegExp(`^${HARDWARE}`) })).toBeVisible({ timeout: 60_000 });
    await slow(menu.getByRole("menuitem", { name: "Manage categories" })).toBeVisible({ timeout: 60_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-category-picker-1440-light.png`, fullPage: false });
    const [picked] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      menu.getByRole("menuitemradio", { name: new RegExp(`^${HARDWARE}`) }).click(),
    ]);
    expect(picked.status(), JSON.stringify(await picked.json())).toBe(200);
    expect(picked.request().postDataJSON()).toEqual({ category: HARDWARE });
    await slow(category).toHaveText(HARDWARE, { timeout: 120_000 });

    // Its sub-categories are offered next.
    const sub = page.getByTestId("ticket-subcategory");
    await slow(sub).toBeVisible({ timeout: 120_000 });
    await sub.click();
    const subMenu = page.getByRole("menu", { name: "Sub-category", exact: true });
    await slow(subMenu).toBeVisible();
    await expect(subMenu.getByRole("menuitemradio")).toHaveText([/^None/, /^Laptop/, /^Screen/]);
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      subMenu.getByRole("menuitemradio", { name: /^Screen/ }).click(),
    ]);
    await slow(sub).toHaveText("Screen", { timeout: 120_000 });
    await slow(page.getByText(`set the category to ${HARDWARE}`).first()).toBeVisible({ timeout: 120_000 });
    await slow(page.getByText("set the sub-category to Screen").first()).toBeVisible({ timeout: 120_000 });
    const after = (await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket;
    expect([after.category, after.subcategory]).toEqual([HARDWARE, "Screen"]);

    // Nothing invents a category: a name that is not on the list is a 400 that names the allowed ones.
    const refused = await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { category: `Typed ${stamp}` } });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("category_not_listed");
    expect(refused.body.error).toContain(`"Typed ${stamp}" is not a category on the list. Categories: `);
    expect(refused.body.allowed).toContain(HARDWARE);
    expect((await mineOf(page)).map((c) => c.name)).not.toContain(`Typed ${stamp}`);
    const stale = await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { subcategory: "Tablet" } });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe("subcategory_not_listed");
  });

  test("Merge into…: a double's tickets move to the kept category and the double is removed", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const made = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: DOUBLE } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const number = await newTicket(page, "Dock has no power");
    expect((await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { category: DOUBLE } })).status).toBe(200);

    await page.goto(SETTINGS);
    const double = page.locator(`[data-testid="hd-category-row"][data-category="${DOUBLE}"]`);
    await slow(double).toBeVisible({ timeout: 120_000 });
    await expect(double).toContainText("1 ticket");
    // Delete says it is in use and offers the merge.
    await expect(async () => {
      await double.getByRole("button", { name: `More actions for ${DOUBLE}` }).click();
      await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const inUse = page.getByRole("dialog", { name: `${DOUBLE} is still in use` });
    await slow(inUse).toBeVisible();
    await inUse.getByRole("button", { name: "Merge into…" }).click();
    const dialog = page.getByRole("dialog", { name: `Merge ${DOUBLE} into…` });
    await slow(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(dialog.getByText("Pick a category.")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Merge into" }).selectOption({ label: HARDWARE });
    await expect(dialog.getByText(`1 ticket moves from ${DOUBLE} to ${HARDWARE}.`)).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-categories-merge-1440-light.png`, fullPage: false });
    const [merged] = await Promise.all([
      page.waitForResponse((r) => /\/api\/helpdesk\/admin\/categories\/\d+\/merge$/.test(r.url()) && r.request().method() === "POST", { timeout: 120_000 }),
      dialog.getByRole("button", { name: `Merge into ${HARDWARE}` }).click(),
    ]);
    expect(merged.status(), JSON.stringify(await merged.json())).toBe(200);
    await slow(double).toHaveCount(0, { timeout: 120_000 });
    expect((await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.category).toBe(HARDWARE);
    expect((await mineOf(page)).map((c) => c.name)).toEqual([HARDWARE]);
  });

  test("the automations editor ticks categories from the list and sets one from a Select", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/automations");
    await slow(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible({ timeout: 120_000 });
    const editor = page.getByRole("dialog", { name: "New rule" });
    await expect(async () => {
      await page.getByRole("button", { name: "New rule" }).first().click();
      await expect(editor).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    const checks = editor.getByTestId("category-checks");
    await slow(checks.getByRole("checkbox", { name: HARDWARE, exact: true })).toBeVisible({ timeout: 120_000 });
    await checks.getByRole("checkbox", { name: `${HARDWARE}, Laptop` }).check();
    await expect(checks.getByRole("textbox")).toHaveCount(0);
    const set = editor.getByRole("combobox", { name: "Set the category" });
    await set.selectOption({ label: HARDWARE });
    await editor.getByRole("combobox", { name: "Set the sub-category" }).selectOption({ label: "Screen" });
    await expect(editor.getByRole("textbox", { name: /category/i })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-automations-category-1440-light.png`, fullPage: false });
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);
  });
});
