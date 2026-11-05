import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN, login, api, ensureUser } from "./helpers";

// The dashboard's Quick links tile (1.17.0): a person pins a link from the
// Links page, adds one of their own, reorders and removes pins; a click on
// a curated link is counted (the Links manager's 30-day count) without
// touching its href; a link created this week carries "New"; a person with
// nothing to show sees an invitation instead of an empty card.

const STAMP = Date.now();
const VIEWER = { username: "e2e_quicklinks", password: "E2eQuickLinks!12345" };
const ALPHA = `E2E QL Alpha ${STAMP}`;
const BETA = `E2E QL Beta ${STAMP}`;
const OWN = `E2E QL Own ${STAMP}`;
const ALPHA_URL = `https://ql-alpha-${STAMP}.example.com/`;
const BETA_URL = `https://ql-beta-${STAMP}.example.com/`;
const OWN_URL = `https://ql-own-${STAMP}.example.com/start`;

async function viewerPage(browser: Browser, admin: Page): Promise<Page> {
  await ensureUser(admin, VIEWER, "viewer", "Quick Links Viewer");
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  // The links point at example.com hosts: answer them locally so a click
  // opens a blank tab instead of going out to the network.
  await ctx.route(/ql-[a-z]+-\d+\.example\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>ok</title>" })
  );
  const page = await ctx.newPage();
  await login(page, VIEWER);
  // Start from no pins, whatever an earlier run left behind.
  const mine = await api(page, "/api/quick-links");
  for (const p of mine.body?.pinned ?? []) await api(page, `/api/quick-links/${p.pinId}`, { method: "DELETE" });
  return page;
}

function tile(page: Page) {
  return page.locator('[data-dashboard-section="quick_links"]');
}

test.describe.serial("dashboard quick links", () => {
  test("a person with nothing to show is invited to add a link", async ({ page, browser }) => {
    await login(page, ADMIN);
    // The tile also shows links an admin featured and the workspace's
    // most-clicked ones, so a shared database may give this person
    // something to see. Only an empty workspace can assert the empty state.
    const all = await api(page, "/api/admin/links");
    const groups = (l: { group_ids?: number[] }) => (l.group_ids ?? []).length;
    const showsSomething = (all.body?.links ?? []).some(
      (l: { clicks?: number; dashboard_featured?: boolean; group_ids?: number[] }) =>
        groups(l) === 0 && ((l.clicks ?? 0) > 0 || l.dashboard_featured)
    );
    test.skip(showsSomething, "Featured or clicked links exist, so no viewer has an empty Quick links tile here.");

    const viewer = await viewerPage(browser, page);
    await viewer.goto("/");
    const t = tile(viewer);
    await expect(t.getByRole("heading", { name: "Quick links" })).toBeVisible();
    await expect(t.getByText("Pin the tools you use every day")).toBeVisible();
    await expect(t.getByText("Pinned by you")).toHaveCount(0);
    // The invitation's button opens the dialog.
    await t.getByRole("button", { name: "Add a quick link" }).last().click();
    await expect(viewer.getByRole("dialog", { name: "Add a quick link" })).toBeVisible();
    await viewer.context().close();
  });

  test("pin, add your own, reorder, remove; clicks are counted; New marks this week's links", async ({ page, browser }) => {
    await login(page, ADMIN);
    // Custom icon without a file: a letter tile, and no favicon fetch.
    const a = await api(page, "/api/admin/links", { method: "POST", body: { title: ALPHA, url: ALPHA_URL, icon_type: "custom" } });
    const b = await api(page, "/api/admin/links", { method: "POST", body: { title: BETA, url: BETA_URL, icon_type: "custom" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const alphaId: number = a.body.link.id;
    const betaId: number = b.body.link.id;
    const viewer = await viewerPage(browser, page);

    try {
      await viewer.goto("/");
      const t = tile(viewer);
      await expect(t.getByRole("heading", { name: "Quick links" })).toBeVisible();

      // ---- Pin a curated link from the dialog's first tab.
      await t.getByRole("button", { name: "Add a quick link" }).first().click();
      const dialog = viewer.getByRole("dialog", { name: "Add a quick link" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("radio", { name: "From the Links page" })).toHaveAttribute("aria-checked", "true");
      await dialog.getByRole("searchbox", { name: "Search links" }).fill(`Alpha ${STAMP}`);
      const pinAlpha = dialog.getByRole("button", { name: `Pin ${ALPHA}` });
      await expect(pinAlpha).toHaveAttribute("aria-pressed", "false");
      await expect(dialog.getByRole("button", { name: `Pin ${BETA}` })).toHaveCount(0);
      const pinned = viewer.waitForResponse((r) => r.url().endsWith("/api/quick-links") && r.request().method() === "POST");
      await pinAlpha.click();
      expect((await pinned).status()).toBe(201);
      await expect(pinAlpha).toHaveAttribute("aria-pressed", "true");
      await expect(pinAlpha).toContainText("Pinned");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();

      await expect(t.getByText("Pinned by you")).toBeVisible();
      const alphaRow = t.getByRole("link", { name: new RegExp(ALPHA) });
      await expect(alphaRow).toHaveAttribute("href", ALPHA_URL);
      await expect(alphaRow).toHaveAttribute("target", "_blank");
      await expect(alphaRow).toHaveAttribute("rel", "noopener noreferrer");

      // ---- Add one of your own, after the inline checks.
      await t.getByRole("button", { name: "Add a quick link" }).first().click();
      await dialog.getByRole("radio", { name: "Your own link" }).click();
      await dialog.getByRole("button", { name: "Add quick link" }).click();
      await expect(dialog.getByText("Give the link a name.")).toBeVisible();
      await dialog.getByLabel("Title").fill(OWN);
      await dialog.getByLabel("Address").fill("ftp://files.example.com");
      await dialog.getByRole("button", { name: "Add quick link" }).click();
      await expect(dialog.getByText("Only https:// and http:// addresses can be added.")).toBeVisible();
      await dialog.getByLabel("Address").fill("javascript:alert(1)");
      await dialog.getByRole("button", { name: "Add quick link" }).click();
      await expect(dialog.getByText("Only https:// and http:// addresses can be added.")).toBeVisible();
      await dialog.getByLabel("Address").fill(OWN_URL);
      await dialog.getByRole("button", { name: "Add quick link" }).click();
      await expect(dialog).toBeHidden();
      await expect(viewer.getByText(`Added “${OWN}” to your quick links.`)).toBeVisible();
      const ownRow = t.getByRole("link", { name: new RegExp(OWN) });
      await expect(ownRow).toHaveAttribute("href", OWN_URL);
      await expect(ownRow).toHaveAttribute("target", "_blank");
      await expect(ownRow).toContainText(`ql-own-${STAMP}.example.com`);

      // The server refuses what the form refuses.
      const bad = await api(viewer, "/api/quick-links", { method: "POST", body: { title: "x", url: "javascript:alert(1)" } });
      expect(bad.status).toBe(400);

      // ---- Reorder: the own link moves above Alpha and stays there.
      const titles = () =>
        t.locator("ul").first().locator("li").evaluateAll((lis) => lis.map((li) => li.textContent || ""));
      expect((await titles())[0]).toContain(ALPHA);
      await t.getByRole("button", { name: "Edit quick links" }).click();
      await expect(t.getByRole("button", { name: "Done" })).toBeFocused();
      const ordered = viewer.waitForResponse((r) => r.url().endsWith("/api/quick-links/order"));
      await t.getByRole("button", { name: `Move ${OWN} up` }).click();
      expect((await ordered).status()).toBe(200);
      // The pressed arrow is disabled at the top, so focus lands on its pair.
      await expect(t.getByRole("button", { name: `Move ${OWN} down` })).toBeFocused();
      await viewer.reload();
      await expect.poll(async () => (await titles())[0]).toContain(OWN);
      expect((await titles())[1]).toContain(ALPHA);

      // ---- Remove, with Undo; then remove for good.
      await t.getByRole("button", { name: "Edit quick links" }).click();
      const removed = viewer.waitForResponse((r) => /\/api\/quick-links\/\d+$/.test(r.url()) && r.request().method() === "DELETE");
      await t.getByRole("button", { name: `Remove ${OWN}` }).click();
      expect((await removed).status()).toBe(200);
      await expect(t.getByText(OWN)).toHaveCount(0);
      const toast = viewer.getByText(`Removed “${OWN}” from your quick links.`);
      await expect(toast).toBeVisible();
      const restored = viewer.waitForResponse((r) => r.url().endsWith("/api/quick-links/order"));
      await viewer.getByRole("button", { name: "Undo" }).click();
      await restored;
      await expect(t.getByText(OWN)).toBeVisible();
      await viewer.reload();
      await expect.poll(async () => (await titles())[0]).toContain(OWN);
      await t.getByRole("button", { name: "Edit quick links" }).click();
      await t.getByRole("button", { name: `Remove ${OWN}` }).click();
      await expect(t.getByText(OWN)).toHaveCount(0);
      await t.getByRole("button", { name: "Done" }).click();
      await viewer.reload();
      await expect(t.getByText(OWN)).toHaveCount(0);
      await expect(t.getByRole("link", { name: new RegExp(ALPHA) })).toBeVisible();

      // ---- A click on a curated link is counted; the href is the real one.
      const clicksOf = async (id: number) =>
        ((await api(page, "/api/admin/links")).body.links as { id: number; clicks: number }[]).find((l) => l.id === id)?.clicks ?? 0;
      expect(await clicksOf(alphaId)).toBe(0);
      const popup = viewer.context().waitForEvent("page");
      await t.getByRole("link", { name: new RegExp(ALPHA) }).click();
      const tab = await popup;
      await tab.waitForLoadState();
      expect(tab.url()).toBe(ALPHA_URL);
      await tab.close();
      await expect.poll(() => clicksOf(alphaId)).toBe(1);

      // ---- "New": a link featured on everyone's dashboard this week.
      const featured = await api(page, `/api/admin/links/${betaId}`, { method: "PATCH", body: { dashboard_featured: true } });
      expect(featured.status).toBe(200);
      await viewer.reload();
      await expect(t.getByText("From your admin")).toBeVisible();
      const betaRow = t.getByRole("link", { name: new RegExp(BETA) });
      await expect(betaRow).toBeVisible();
      await expect(betaRow.getByText("New", { exact: true })).toBeVisible();
      // Pinning a featured link moves it to the pins: never listed twice.
      await t.getByRole("button", { name: "Add a quick link" }).first().click();
      await dialog.getByRole("searchbox", { name: "Search links" }).fill(`Beta ${STAMP}`);
      await dialog.getByRole("button", { name: `Pin ${BETA}` }).click();
      await expect(dialog.getByRole("button", { name: `Pin ${BETA}` })).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(t.getByRole("link", { name: new RegExp(BETA) })).toHaveCount(1);
    } finally {
      await api(page, `/api/admin/links/${alphaId}`, { method: "DELETE" });
      await api(page, `/api/admin/links/${betaId}`, { method: "DELETE" });
      const mine = await api(viewer, "/api/quick-links");
      for (const p of mine.body?.pinned ?? []) await api(viewer, `/api/quick-links/${p.pinId}`, { method: "DELETE" });
      await viewer.context().close();
    }
  });
});
