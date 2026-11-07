import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";
import sharp from "sharp";
import { ADMIN, api, ensureUser, login } from "./helpers";

// The transparent desk with artwork (1.19.4 C5; mock-ups t1 to t5).
//
//   Appearance       Desk settings → Appearance: the library (built-ins, an
//                    upload), light and dark mode, Glass, Preview on this desk,
//                    Save (the setting is workspace-wide: held under an
//                    advisory lock and restored; the upload is removed).
//   My background    the user menu's "Desk background…": upload their own (only
//                    they see it), Glass and Subtle, None; the frosted panels
//                    and the scrim really paint (computed styles), light and
//                    dark, and the 390px phone keeps no sideways scroll.
//   Fallbacks        Increase contrast, Reduce transparency and a data saver
//                    keep the plain desk (the picture is never requested);
//                    paper gets the plain desk; the CompassDocs app and the
//                    portal never get the artwork.
//
// Everyone it signs in as is its own (stamped desk users); the agent's own
// artwork is removed afterwards. E2E_SHOTS=<dir> saves the screenshots.

const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
// The same key as test/helpdesk-appearance: one writer of the workspace's appearance at a time.
const LOCK = "helpdesk_appearance_settings_test";
/** Glass's panel layer, 0.355, as computed styles report it (the alpha is stored in 8 bits). */
const GLASS_PANEL = /, 0\.35\d\)$/;

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/me/appearance")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((e) => e.remove()));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** A built-in artwork as a 1920 × 1200 PNG on disk (what an agent might upload). */
async function builtinPng(dir: string, key: string): Promise<string> {
  const file = path.join(dir, `${key}.png`);
  const svg = await import("node:fs/promises").then((fs) => fs.readFile(path.join(__dirname, "..", "public", "desk-art", `${key}.svg`)));
  await writeFile(file, await sharp(svg).resize(1920, 1200, { fit: "cover" }).png().toBuffer());
  return file;
}

/** Upload Aurora as the signed-in person's own artwork through the route (uploading chooses it). */
async function uploadOwn(page: Page): Promise<number> {
  const png = (await sharp(path.join(__dirname, "..", "public", "desk-art", "aurora.svg")).resize(1920, 1200).png().toBuffer()).toString("base64");
  return page.evaluate(async (b64) => {
    const form = new FormData();
    form.append("file", new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "aurora.png", { type: "image/png" }));
    return (await fetch("/api/helpdesk/me/appearance/art", { method: "POST", body: form })).status;
  }, png);
}

/** Close the toasts before a screenshot. */
async function dismissToasts(page: Page) {
  if (!SHOTS) return;
  // Always the first one left: .all() hands out positional locators, and the second goes stale
  // once the first toast is gone (a click on it would then wait out the whole test).
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  for (let i = 0; i < 5 && (await dismiss.count()) > 0; i++) await dismiss.first().click({ timeout: 5_000 }).catch(() => {});
}

/** For the desk shots: All open with its first ticket, no toast, no focus ring. */
async function deskScene(page: Page) {
  if (!SHOTS) return;
  await page.goto("/desk?view=open");
  const first = page.locator("#main a[href^='/desk/tickets/']").first();
  // Best effort, never a hang: the scene is for the picture, the assertions are elsewhere.
  if (await first.waitFor({ timeout: 60_000 }).then(() => true, () => false)) {
    await first.click({ timeout: 30_000 }).catch(() => {});
    await page.waitForURL(/\/desk\/tickets\//, { timeout: 60_000 }).catch(() => {});
    await page.locator("#ticket-subject").waitFor({ timeout: 60_000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The desk root's data attributes and a panel's / the top bar's painted background. */
async function painted(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-testid=desk-root]")!;
    const header = root.querySelector("header")!;
    const layer = root.querySelector(".desk-art-layer")!;
    return {
      light: root.hasAttribute("data-art-light"),
      dark: root.hasAttribute("data-art-dark"),
      header: getComputedStyle(header).backgroundColor,
      blur: getComputedStyle(header).backdropFilter,
      layer: getComputedStyle(layer).display,
      scrim: getComputedStyle(layer, "::after").backgroundColor,
      img: getComputedStyle(layer, "::before").backgroundImage,
      // The secondary ink over the artwork (desk-look.css: slate-600's value).
      secondary: getComputedStyle(root.querySelector(".text-slate-500") ?? root).color,
    };
  });
}

test("appearance: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here");
  expect((await api(page, "/api/helpdesk/admin/appearance")).status).toBe(402);
});

test.describe("transparent desk (licensed)", () => {
  const stamp = Date.now().toString(36);
  const LEAD = { username: `e2e_c5_lead_${stamp}`, password: "E2eC5Lead!12345" };
  const AGENT = { username: `e2e_c5_agent_${stamp}`, password: "E2eC5Agent!12345" };
  let db: Client;
  let dir = "";
  let saved: string | undefined;
  const uploaded: number[] = [];

  async function deskUser(page: Page, u: { username: string; password: string }, name: string, role: "admin" | "manager") {
    await ensureUser(page, u, "viewer", name);
    const id = (await db.query("SELECT id FROM users WHERE username = $1", [u.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [id]
    );
    await db.query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, role]);
    return id;
  }

  async function signedIn(browser: Browser, u: { username: string; password: string }, opts: { scheme?: "light" | "dark"; width?: number; height?: number } = {}) {
    const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, colorScheme: opts.scheme ?? "light" });
    const page = await ctx.newPage();
    await login(page, u);
    return { ctx, page };
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
    dir = await mkdtemp(path.join(tmpdir(), "e2e-desk-art-"));
    // The workspace's appearance is shared: one writer at a time (this lock, also taken by the unit
    // test), the stored value restored in afterAll. "Let agents choose their own" is off by default,
    // so it is switched on here for the agents' tests.
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK]);
    saved = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_appearance'")).rows[0]?.value;
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('helpdesk_appearance', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify({ light: "none", dark: "none", level: "glass", agents_choose: true })]
    );
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    if (saved === undefined) await db.query("DELETE FROM settings WHERE key = 'helpdesk_appearance'");
    else await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_appearance', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [saved]);
    // The agent's own artwork goes through the route, so its files are deleted too; the rows are swept after.
    if ((await db.query("SELECT 1 FROM hd_desk_art WHERE owner_user_id = (SELECT id FROM users WHERE username = $1)", [AGENT.username])).rowCount) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await login(p, AGENT).catch(() => {});
      await api(p, "/api/helpdesk/me/appearance/art", { method: "DELETE" }).catch(() => {});
      await ctx.close();
    }
    // Library uploads the lead left (a timed-out test's finally can't reach its closed page): through the route, files and all.
    const left = await db.query("SELECT id FROM hd_desk_art WHERE owner_user_id IS NULL AND created_by = (SELECT id FROM users WHERE username = $1)", [LEAD.username]);
    if (left.rowCount) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await login(p, LEAD).catch(() => {});
      for (const r of left.rows) await api(p, `/api/helpdesk/admin/appearance/art/${r.id}`, { method: "DELETE" }).catch(() => {});
      await ctx.close();
    }
    await db.query("DELETE FROM hd_desk_art WHERE owner_user_id IN (SELECT id FROM users WHERE username = ANY($1))", [[LEAD.username, AGENT.username]]);
    await db.query("DELETE FROM hd_desk_look WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))", [[LEAD.username, AGENT.username]]);
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK]);
    await db.end();
  });

  test("Appearance: upload to the library, choose per mode, Glass, Preview, Save; restored afterwards", async ({ page, browser }) => {
    test.setTimeout(900_000);
    await deskUser(page, LEAD, "Lena Lead", "admin");
    // The describe holds the appearance lock; this test's own changes are undone in finally.
    const start = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_appearance'")).rows[0]?.value as string;
    let ctx: Awaited<ReturnType<typeof signedIn>>["ctx"] | null = null;
    try {
      const signed = await signedIn(browser, LEAD);
      ctx = signed.ctx;
      const p = signed.page;
      await p.goto("/desk/settings/appearance");
      await expect(p.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible({ timeout: 120_000 });
      const rail = p.getByRole("navigation", { name: "Desk settings" });
      await expect(rail.getByRole("link", { name: /^Appearance/ })).toBeVisible();
      const library = p.getByTestId("appearance-library");
      for (const label of ["Aurora", "Night ridge", "Sunrise"]) await expect(library).toContainText(`${label} (built in)`);

      // Upload: acts at once; refused pictures say why.
      const small = path.join(dir, "small.jpg");
      await writeFile(small, await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#7c3aed" } }).jpeg().toBuffer());
      await p.locator("input[type=file]").setInputFiles(small);
      await expect(p.getByText(/That image is 1280 × 720 pixels/)).toBeVisible({ timeout: 60_000 });
      const brand = path.join(dir, "Fernwood brand.png");
      await writeFile(brand, await sharp(path.join(__dirname, "..", "public", "desk-art", "aurora.svg")).resize(2400, 1500).png().toBuffer());
      await p.locator("input[type=file]").setInputFiles(brand);
      await expect(library).toContainText("Fernwood brand (uploaded)", { timeout: 60_000 });
      const id = (await db.query("SELECT id FROM hd_desk_art WHERE owner_user_id IS NULL AND created_by = (SELECT id FROM users WHERE username = $1) ORDER BY id DESC LIMIT 1", [LEAD.username])).rows[0].id as number;
      uploaded.push(id);

      await p.getByLabel("Light mode").selectOption(`upload:${id}`);
      // A bright picture in dark mode is dimmed hard so text keeps 4.5:1, and the page says so.
      await p.getByLabel("Dark mode").selectOption("builtin:sunrise");
      await expect(p.getByText("In dark mode the desk covers Sunrise 78% so text stays readable.")).toBeVisible();
      await p.getByLabel("Dark mode").selectOption("builtin:night-ridge");
      await expect(p.getByText(/In dark mode the desk covers/)).toHaveCount(0);
      await p.getByRole("radiogroup", { name: "Transparency" }).getByRole("radio", { name: "Glass" }).click();
      await p.getByRole("button", { name: "Preview" }).click();
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      const look = await painted(p);
      expect(look.layer).toBe("block");
      // 0.355, as the browser keeps it (alpha in 8 bits: 91/255).
      expect(look.header).toMatch(GLASS_PANEL);
      expect(look.blur).toContain("blur(18px)");
      await dismissToasts(p);
      await shot(p, "t4-appearance-settings-1440-light");

      // Layers with artwork on (review C5 finding 10). A short window, unsaved changes: the Save row is
      // pinned at the bottom, right where the top bar's menus open. They must be on top of it.
      await p.setViewportSize({ width: 1440, height: 420 });
      const onTop = (sel: string, el: import("@playwright/test").Locator) =>
        el.evaluate((node, s) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!hit?.closest(s);
        }, sel);
      await expect(p.getByText("Unsaved changes")).toBeVisible();
      // The upload toasts (fixed bottom-right, z-50: above everything by design) are still up in a fast
      // build and sit over the menu's lower rows in this short window; this checks the desk's own layers.
      const dismiss = p.getByRole("button", { name: "Dismiss" });
      while ((await dismiss.count()) > 0) await dismiss.first().click();
      await p.getByRole("button", { name: /^Lena Lead:/ }).click();
      const row = p.getByRole("menuitem", { name: "Desk background…" });
      expect(await onTop('[role="menu"]', row), "the user menu is above the pinned Save row").toBe(true);
      await row.click();
      const mine = p.getByRole("dialog", { name: "My desk background" });
      const glass = mine.getByRole("radio", { name: "Glass" });
      // Taller than this window: the panel scrolls inside itself (the desk shell never scrolls).
      await glass.scrollIntoViewIfNeeded();
      await expect(glass).toBeInViewport();
      const box = await mine.boundingBox();
      expect(box!.y + box!.height, "the panel ends inside the window").toBeLessThanOrEqual(420);
      expect(await onTop('[role="dialog"]', glass), "My desk background is above the pinned Save row").toBe(true);
      await p.keyboard.press("Escape");
      // A modal (confirm before removing the upload) covers the top bar, not the other way round.
      await p.getByRole("button", { name: "Remove Fernwood brand" }).click();
      const confirm = p.getByRole("dialog", { name: /Remove Fernwood brand/ });
      await expect(confirm).toBeVisible();
      expect(await p.evaluate(() => !document.elementFromPoint(720, 26)?.closest("header")), "the modal is above the top bar").toBe(true);
      await p.keyboard.press("Escape");
      await expect(confirm).toHaveCount(0);
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.getByRole("button", { name: "Save" }).click();
      await expect(p.getByText("Appearance saved.")).toBeVisible();
      const s = JSON.parse((await db.query("SELECT value FROM settings WHERE key = 'helpdesk_appearance'")).rows[0].value);
      expect(s).toEqual({ light: `upload:${id}`, dark: "builtin:night-ridge", level: "glass", agents_choose: true });
      const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.appearance.changed' AND actor_id = (SELECT id FROM users WHERE username = $1)", [LEAD.username]);
      expect(audit.rowCount).toBe(1);

      // After a reload the saved look paints straight away (no Preview), and the page's dark mode shows Night ridge.
      await p.reload();
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      expect((await painted(p)).img).toContain(`/api/helpdesk/appearance/art/${id}`);
      const dark = await signedIn(browser, LEAD, { scheme: "dark" });
      await dark.page.goto("/desk/settings/appearance");
      await expect(dark.page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible({ timeout: 120_000 });
      await expect.poll(async () => (await painted(dark.page)).dark, { timeout: 60_000 }).toBe(true);
      expect((await painted(dark.page)).img).toContain("/desk-art/night-ridge.svg");
      expect((await painted(dark.page)).scrim).toMatch(/, 0\.51\d?\)$/);
      await shot(dark.page, "t4-appearance-settings-1440-dark");
      await dark.ctx.close();
    } finally {
      // Never let a closed browser skip the restore below.
      await ctx?.close().catch(() => {});
      await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_appearance'", [start]);
      for (const id of uploaded) await api(page, `/api/helpdesk/admin/appearance/art/${id}`, { method: "DELETE" }).catch(() => {});
    }
  });

  // Generous budgets: the shared dev server serves several builders' runs at once.
  test("My desk background: their own artwork, only theirs; Glass and Subtle in light mode", async ({ page, browser }) => {
    test.setTimeout(600_000);
    // A manager sees every queue, so the desk behind the glass has tickets on it.
    await deskUser(page, AGENT, "Ana Kowalski", "manager");
    const { ctx, page: p } = await signedIn(browser, AGENT);
    try {
      await p.goto("/desk");
      await expect(p.locator("#main")).toBeVisible({ timeout: 120_000 });
      await p.getByRole("button", { name: /^Ana Kowalski:/ }).click();
      await p.getByRole("menuitem", { name: "Desk background…" }).click();
      const panel = p.getByRole("dialog", { name: "My desk background" });
      await expect(panel).toBeVisible();
      await expect(p.getByRole("menu", { name: "Your availability" })).toHaveCount(0);
      await expect(panel).toContainText("Only you see this.");
      await panel.locator("input[type=file]").setInputFiles(await builtinPng(dir, "aurora"));
      await expect(p.getByText("Your artwork is on your desk. Only you see it.")).toBeVisible({ timeout: 60_000 });
      await expect(panel.getByRole("radio", { name: "My own" })).toBeChecked();
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      const own = await db.query("SELECT id FROM hd_desk_art WHERE owner_user_id = (SELECT id FROM users WHERE username = $1)", [AGENT.username]);
      expect((await painted(p)).img).toContain(`/api/helpdesk/appearance/art/${own.rows[0].id}`);
      // Nobody else can fetch it.
      expect((await api(page, `/api/helpdesk/appearance/art/${own.rows[0].id}`)).status).toBe(404);
      await p.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await deskScene(p);
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      expect((await painted(p)).secondary).toBe("rgb(71, 85, 105)");
      await shot(p, "t1-desk-glass-1440-light");

      // Subtle.
      await p.getByRole("button", { name: /^Ana Kowalski:/ }).click();
      await p.getByRole("menuitem", { name: "Desk background…" }).click();
      await panel.getByRole("radio", { name: "Subtle" }).click();
      await expect.poll(async () => (await painted(p)).header, { timeout: 30_000 }).toMatch(/0\.6\)$/);
      await panel.locator("input[type=file]").setInputFiles(await builtinPng(dir, "sunrise"));
      await expect(p.getByText("Your artwork is on your desk. Only you see it.").first()).toBeVisible({ timeout: 60_000 });
      await expect.poll(async () => (await painted(p)).img, { timeout: 60_000 }).not.toContain(`/art/${own.rows[0].id}?`);
      await p.keyboard.press("Escape");
      await deskScene(p);
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      await shot(p, "t2-desk-subtle-1440-light");
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test("My desk background in dark mode: Night ridge, Glass, the panel; None is the plain desk", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await deskUser(page, AGENT, "Ana Kowalski", "manager");
    const d = await signedIn(browser, AGENT, { scheme: "dark" });
    try {
      await d.page.goto("/desk");
      await expect(d.page.locator("#main")).toBeVisible({ timeout: 120_000 });
      await deskScene(d.page);
      await d.page.getByRole("button", { name: /^Ana Kowalski:/ }).click();
      await d.page.getByRole("menuitem", { name: "Desk background…" }).click();
      const dpanel = d.page.getByRole("dialog", { name: "My desk background" });
      await dpanel.locator("input[type=file]").setInputFiles(await builtinPng(dir, "night-ridge"));
      await expect(d.page.getByText("Your artwork is on your desk. Only you see it.")).toBeVisible({ timeout: 60_000 });
      await dpanel.getByRole("radio", { name: "Glass" }).click();
      await expect.poll(async () => (await painted(d.page)).dark, { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => (await painted(d.page)).header, { timeout: 30_000 }).toMatch(GLASS_PANEL);
      await d.page.waitForTimeout(800);
      await shot(d.page, "t5-my-background-1440-dark");
      await d.page.keyboard.press("Escape");
      await deskScene(d.page);
      await expect.poll(async () => (await painted(d.page)).dark, { timeout: 60_000 }).toBe(true);
      expect((await painted(d.page)).secondary).toBe("rgb(176, 187, 204)");
      await shot(d.page, "t3-desk-glass-1440-dark");
      // None: the plain desk.
      await d.page.getByRole("button", { name: /^Ana Kowalski:/ }).click();
      await d.page.getByRole("menuitem", { name: "Desk background…" }).click();
      // The choice is saved, then shown (a controlled radio): click, then wait for it.
      await dpanel.getByRole("radio", { name: "None" }).click();
      await expect(dpanel.getByRole("radio", { name: "None" })).toBeChecked();
      await expect.poll(async () => (await painted(d.page)).dark, { timeout: 30_000 }).toBe(false);
      expect((await painted(d.page)).layer).toBe("none");
      await dpanel.getByRole("radio", { name: "My own" }).click();
      await expect(dpanel.getByRole("radio", { name: "My own" })).toBeChecked();
      await expect.poll(async () => (await painted(d.page)).dark, { timeout: 60_000 }).toBe(true);
    } finally {
      await d.ctx.close().catch(() => {});
    }
  });

  test("My desk background on a phone: the panel fits, nothing scrolls sideways", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await deskUser(page, AGENT, "Ana Kowalski", "manager");
    const m = await signedIn(browser, AGENT, { width: 390, height: 844 });
    try {
      // Their own artwork (the tests above leave one; a retried worker may have cleaned it up).
      if (!(await db.query("SELECT 1 FROM hd_desk_art WHERE owner_user_id = (SELECT id FROM users WHERE username = $1)", [AGENT.username])).rowCount) {
        expect(await uploadOwn(m.page)).toBe(201);
      }
      await m.page.goto("/desk");
      await expect(m.page.locator("#main")).toBeVisible({ timeout: 120_000 });
      await expect.poll(async () => (await painted(m.page)).light, { timeout: 60_000 }).toBe(true);
      await m.page.getByRole("button", { name: /^Ana Kowalski:/ }).click();
      await m.page.getByRole("menuitem", { name: "Desk background…" }).click();
      const mpanel = m.page.getByRole("dialog", { name: "My desk background" });
      await expect(mpanel).toBeVisible();
      const box = await mpanel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(await m.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await shot(m.page, "t5-my-background-390-light");
    } finally {
      await m.ctx.close().catch(() => {});
    }
  });

  test("fallbacks: Increase contrast, Reduce transparency, data saver and paper keep the plain desk; the app and portal never get it", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await deskUser(page, AGENT, "Ana Kowalski", "manager");
    const { ctx, page: p } = await signedIn(browser, AGENT);
    // Their own artwork, chosen (uploading one chooses it).
    expect(await uploadOwn(p)).toBe(201);
    const requested: string[] = [];
    p.on("request", (r) => r.url().includes("/api/helpdesk/appearance/art/") && requested.push(r.url()));
    try {
      await p.emulateMedia({ contrast: "more" });
      await p.goto("/desk");
      await expect(p.locator("#main")).toBeVisible({ timeout: 120_000 });
      await p.waitForTimeout(2000);
      expect((await painted(p)).light).toBe(false);
      expect(requested).toEqual([]);
      await p.emulateMedia({ contrast: "no-preference" });
      await expect.poll(async () => (await painted(p)).light, { timeout: 60_000 }).toBe(true);
      // Paper: the plain desk.
      await p.emulateMedia({ media: "print" });
      expect((await painted(p)).layer).toBe("none");
      await p.emulateMedia({ media: "screen" });

      // Reduce transparency (Chromium's emulation through the DevTools protocol).
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      await expect.poll(async () => (await painted(p)).light, { timeout: 30_000 }).toBe(false);
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });

      // The CompassDocs app and the portal: no desk root, no artwork.
      await p.goto("/");
      await expect(p.locator("[data-testid=desk-root]")).toHaveCount(0);
      await expect(p.locator(".desk-art-layer")).toHaveCount(0);
    } finally {
      await ctx.close();
    }

    // Data saver: the picture is never requested.
    const saver = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await saver.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true, addEventListener() {}, removeEventListener() {} } }));
    const sp = await saver.newPage();
    const asked: string[] = [];
    sp.on("request", (r) => r.url().includes("/api/helpdesk/appearance/art/") && asked.push(r.url()));
    await login(sp, AGENT);
    await sp.goto("/desk");
    await expect(sp.locator("#main")).toBeVisible({ timeout: 120_000 });
    await sp.waitForTimeout(2000);
    expect((await painted(sp)).light).toBe(false);
    expect(asked).toEqual([]);
    await saver.close();
  });
});
