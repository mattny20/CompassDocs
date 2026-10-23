import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN, login, api, ensureUser } from "./helpers";

// 1.15.0: a directory export's download link. An admin copies it from the
// preset editor (or anyone from the Directory page's Export menu) and puts
// it in an email; whoever opens it signs in, lands on a page that downloads
// the file with their own session and says when it has, and goes back home
// from there. A link to a preset deleted since is said in words, not
// answered with the default preset.

const STAMP = Date.now();
// The visitor is a viewer of their own: the file is made for whoever opens
// the link, and the export rate limit is per person, so the admin's exports
// elsewhere in the run never count against this one.
const VIEWER = { username: "e2e_dl_viewer", password: "E2eDlViewer!12345" };

async function signIn(page: Page, user: { username: string; password: string }) {
  await page.fill('input[autocomplete="username"]', user.username);
  await page.fill('input[autocomplete="current-password"]', user.password);
  await page.click('button[type="submit"]');
}

/** Clear the viewer's forced password change once (login() does it), so the link flow below signs straight in. */
async function primeViewer(browser: Browser) {
  const ctx = await browser.newContext();
  try {
    await login(await ctx.newPage(), VIEWER);
  } finally {
    await ctx.close();
  }
}

async function withPreset(page: Page, extra: Record<string, unknown>, run: (id: string, name: string) => Promise<void>) {
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  const id = `e2e-link-${STAMP}-${Math.floor(Math.random() * 1000)}`;
  const name = `E2E Link ${id.slice(-8)}`;
  const saved = await api(page, "/api/admin/directory/export-presets", {
    method: "PUT",
    body: { presets: [...presets, { id, name, filename: id, ...extra }] },
  });
  expect(saved.status).toBe(200);
  expect(saved.body.presets.some((p: any) => p.id === id)).toBe(true);
  try {
    await run(id, name);
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
  }
}

test("a signed-out visitor signs in, the file downloads on the landing page, and Back to home goes home", async ({ page, browser }) => {
  await login(page, ADMIN);
  await ensureUser(page, VIEWER, "viewer", "E2E Download Viewer");
  await primeViewer(browser);
  await withPreset(page, {}, async (id) => {
    // The admin's Download link card hands out the page link, PDF by default.
    await page.goto("/admin/directory/export");
    await page.getByRole("button", { name: new RegExp(`E2E Link ${id.slice(-8)}`) }).click();
    const card = page.locator("section#link");
    await expect(card.getByRole("heading", { name: "Download link", exact: true })).toBeVisible();
    const link = card.getByRole("textbox", { name: "Link" });
    await expect(link).toHaveValue(new RegExp(`/directory/download/${id}$`));
    await card.getByRole("combobox", { name: "File" }).selectOption("csv");
    await expect(link).toHaveValue(new RegExp(`/directory/download/${id}\\?format=csv$`));
    await card.getByRole("button", { name: "Copy link" }).click();
    await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();

    // A fresh browser, signed out, opens the PDF link from "an email".
    const ctx = await browser.newContext({ acceptDownloads: true });
    const visitor = await ctx.newPage();
    try {
      await visitor.goto(`/directory/download/${id}`);
      await visitor.waitForURL(new RegExp(`/login\\?next=%2Fdirectory%2Fdownload%2F${id}$`));
      const download = visitor.waitForEvent("download");
      await signIn(visitor, VIEWER);
      await visitor.waitForURL(new RegExp(`/directory/download/${id}$`));
      await expect(visitor.getByRole("heading", { level: 1 })).toContainText(`E2E Link ${id.slice(-8)}`);
      const file = await download;
      expect(file.suggestedFilename()).toBe(`${id}.pdf`);
      const head = await new Promise<string>((resolve, reject) => {
        file.createReadStream().then((s) => {
          let buf = "";
          s.on("data", (c: Buffer) => { buf += c.toString("latin1"); if (buf.length >= 5) s.destroy(); });
          s.on("close", () => resolve(buf.slice(0, 5)));
          s.on("error", reject);
        }, reject);
      });
      expect(head).toBe("%PDF-");
      // The page says so, and the way home is the primary button now.
      const status = visitor.getByRole("status");
      await expect(status).toContainText("Downloaded");
      await expect(status).toContainText(`${id}.pdf`);
      await expect(visitor.getByRole("button", { name: "Download again" })).toBeVisible();
      // The direct link stays after the download, for a browser that blocked it.
      await expect(visitor.getByRole("link", { name: "Download it directly" })).toHaveAttribute("href", `/api/directory/export?preset=${id}&format=pdf&via=link`);
      await visitor.getByRole("link", { name: "Back to home" }).click();
      await visitor.waitForURL(/\/$/);
      // Back to the page shows the result again; it does not fetch a second copy.
      let again = false;
      visitor.on("request", (r) => { if (r.url().includes("/api/directory/export")) again = true; });
      await visitor.goBack();
      await visitor.waitForURL(new RegExp(`/directory/download/${id}$`));
      await expect(visitor.getByRole("status")).toContainText("Downloaded");
      await visitor.waitForTimeout(800);
      expect(again, "Back does not export the file again").toBe(false);

      // The CSV link, already signed in: straight to the file.
      const csv = visitor.waitForEvent("download");
      await visitor.goto(`/directory/download/${id}?format=csv`);
      expect((await csv).suggestedFilename()).toBe(`${id}.csv`);
      await expect(visitor.getByRole("status")).toContainText("Downloaded");
    } finally {
      await ctx.close();
    }

    // The audit row says the export came through a link.
    const log = await api(page, "/api/admin/audit?category=directory&limit=100");
    expect(log.status).toBe(200);
    const details = (log.body.rows as any[])
      .filter((r) => r.action === "directory.exported")
      .map((r) => (typeof r.details === "string" ? JSON.parse(r.details) : r.details))
      .filter((d) => d?.preset === id);
    // Distinct formats, not a row count: with tracing on (retain-on-failure)
    // Playwright fetches a response body a second time, which the server
    // audits as a second export. A visit without tracing makes one request.
    expect([...new Set(details.map((d) => d.format))].sort(), "both of the link's exports are in the audit log").toEqual(["csv", "pdf"]);
    expect(details.every((d) => d.via === "link")).toBe(true);
  });
});

test("a link to a deleted preset says it no longer works; the API refuses it rather than serving the default", async ({ page }) => {
  await login(page, ADMIN);
  const dead = `e2e-gone-${STAMP}`;
  await page.goto(`/directory/download/${dead}`);
  await expect(page.getByText("This download link no longer works")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the directory" })).toHaveAttribute("href", "/directory");
  const res = await api(page, `/api/directory/export?preset=${dead}&format=pdf&via=link`);
  expect(res.status).toBe(404);
  expect(res.body.error).toMatch(/no longer works/);
  // Without via=link the route keeps its old answer: the default preset.
  const plain = await page.evaluate(async (dead) => (await fetch(`/api/directory/export?preset=${dead}&format=csv`)).status, dead);
  expect(plain).toBe(200);
});

test("a refusal is said in words with Try again, and Try again downloads", async ({ page }) => {
  await login(page, ADMIN);
  await withPreset(page, {}, async (id) => {
    let refused = false;
    await page.route(/\/api\/directory\/export\?/, async (route) => {
      if (refused) return route.continue();
      refused = true;
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many exports — wait a minute and try again." }) });
    });
    await page.goto(`/directory/download/${id}`);
    const status = page.getByRole("status");
    await expect(status).toContainText("The download didn’t start");
    await expect(status).toContainText("Too many exports");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Try again" }).click();
    expect((await download).suggestedFilename()).toBe(`${id}.pdf`);
    await expect(status).toContainText("Downloaded");
  });
});

test("the Directory page's Export menu copies a download link for any preset", async ({ page }) => {
  await login(page, ADMIN);
  await withPreset(page, { split_by: "office" }, async (id, name) => {
    await page.goto("/directory");
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Copy download link…" }).click();
    const dialog = page.getByRole("dialog", { name: "Copy a download link" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Export" }).selectOption({ label: name });
    // A preset split by office is a ZIP of PDFs; the file picker says so.
    const file = dialog.getByRole("combobox", { name: "File" });
    await expect(file.locator("option")).toHaveText(["ZIP of PDFs", "ZIP of CSVs", "Contact cards (.vcf)"]);
    const link = dialog.getByRole("textbox", { name: "Link" });
    await expect(link).toHaveValue(new RegExp(`^https?://[^/]+/directory/download/${id}$`));
    await file.selectOption("vcf");
    await expect(link).toHaveValue(new RegExp(`/directory/download/${id}\\?format=vcf$`));
    await dialog.getByRole("button", { name: "Copy link" }).click();
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
  });
});

test("a new preset saved from the editor takes its link id from its name", async ({ page }) => {
  await login(page, ADMIN);
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  const name = `E2E Front desk ${STAMP}`;
  try {
    await page.goto("/admin/directory/export");
    await page.getByRole("button", { name: "New preset" }).click();
    const card = page.locator("section#link");
    // Unsaved, it has no link yet.
    await expect(card).toContainText("Save this preset to get its link.");
    await page.getByRole("textbox", { name: "Preset name" }).fill(name);
    await page.getByRole("button", { name: "Save presets" }).click();
    await expect(page.getByText("Export presets saved.")).toBeVisible();
    await expect(card.getByRole("textbox", { name: "Link" })).toHaveValue(new RegExp(`/directory/download/e2e-front-desk-${STAMP}$`));
    // Renamed later, the id (and so the link) stays. Two toasts: the first
    // is still up when the second save lands.
    await page.getByRole("textbox", { name: "Preset name" }).fill(`${name} renamed`);
    await page.getByRole("button", { name: "Save presets" }).click();
    await expect(page.getByText("Export presets saved.")).toHaveCount(2);
    await expect(card.getByRole("textbox", { name: "Link" })).toHaveValue(new RegExp(`/directory/download/e2e-front-desk-${STAMP}$`));
    const stored = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
    expect(stored.find((p) => p.id === `e2e-front-desk-${STAMP}`)?.name).toBe(`${name} renamed`);
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
  }
});

test("a new preset never takes a deleted preset's id, so the old link stays dead", async ({ page }) => {
  await login(page, ADMIN);
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  const name = `E2E Retired ${STAMP}`;
  const old = `e2e-retired-${STAMP}`;
  try {
    // A preset with the id its name would give, then deleted.
    expect((await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets: [...presets, { id: old, name }] } })).status).toBe(200);
    expect((await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } })).status).toBe(200);

    // A new one with the same name, made in the editor after a reload.
    await page.goto("/admin/directory/export");
    await page.getByRole("button", { name: "New preset" }).click();
    const card = page.locator("section#link");
    await expect(card).toContainText("Save this preset to get its link.");
    await page.getByRole("textbox", { name: "Preset name" }).fill(name);
    await page.getByRole("button", { name: "Save presets" }).click();
    await expect(page.getByText("Export presets saved.")).toBeVisible();
    await expect(card.getByRole("textbox", { name: "Link" })).toHaveValue(new RegExp(`/directory/download/${old}-2$`));

    // The old link still says it no longer works.
    await page.goto(`/directory/download/${old}`);
    await expect(page.getByText("This download link no longer works")).toBeVisible();
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
  }
});
