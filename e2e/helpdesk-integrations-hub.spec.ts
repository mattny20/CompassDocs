import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Desk settings → Integrations as a hub (1.20.2): the tiles and their
// statuses for an admin, each tile opening its own page with the
// "← Integrations" back link, the old addresses (/desk/settings/assets,
// /chat, /claude, /api) landing on the new places, the settings menu
// without the four entries that moved, the alert sources at /alerts with
// their numeric addresses unchanged, and a role that opens no integration
// page reaching neither the hub nor its statuses. Then Microsoft Intune's
// own page: its app registration form, and an install that was using the
// directory sync app (seeded in the settings row, under the assets settings
// lock, restored after; nothing here calls Microsoft). Licensed rig only.

const AGENT = { username: "e2e_hub_agent", password: "E2eHubAgent!123" };
const HUB = "/desk/settings/integrations";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("integrations hub (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
  });
  test.afterAll(async () => {
    await db.query("DELETE FROM role_assignments WHERE user_id = (SELECT id FROM users WHERE username = $1) AND role_id = (SELECT id FROM roles WHERE key = 'helpdesk-agent')", [AGENT.username]);
    await db.query("DELETE FROM hd_agent_roles WHERE user_id = (SELECT id FROM users WHERE username = $1)", [AGENT.username]);
    await db.end();
  });

  test("tiles, statuses, each tile's page and back link, old addresses, the settings menu", async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    await page.goto(HUB);
    await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible({ timeout: 120_000 });
    for (const g of ["Assets", "Chat", "Claude", "Developers", "Alerts and monitoring"]) await expect(page.getByRole("heading", { level: 2, name: g, exact: true })).toBeVisible({ timeout: 60_000 });
    const tile = (key: string) => page.getByTestId(`hub-tile-${key}`);
    const all = ["snipe-it", "intune", "assets", "teams", "slack", "claude-connector", "claude-desk", "api-tokens", "webhooks", "alerts"];
    for (const k of all) await expect(tile(k)).toBeVisible();
    // The statuses are the real state: read the same data each page reads.
    const view = (await api(page, "/api/helpdesk/admin/assets")).body;
    const hub = (await api(page, "/api/helpdesk/admin/integrations/hub")).body.tiles;
    expect(Object.keys(hub).sort()).toEqual([...all].sort());
    expect(hub.intune.status).toBe(view.intune.on ? hub.intune.status : "not_set_up");
    expect(hub["snipe-it"].status === "not_set_up").toBe(!(view.snipeit.url && view.snipeit.key_set));
    const label: Record<string, string> = { connected: "Connected", not_set_up: "Not set up", attention: "Needs attention" };
    for (const k of all) {
      const st = hub[k].status as string;
      if (st === "none") await expect(tile(k)).not.toContainText(/Connected|Not set up|Needs attention/);
      else await expect(tile(k)).toContainText(label[st]);
    }
    await expect(tile("intune")).toContainText("Device management");
    await expect(tile("snipe-it").getByRole("link", { name: /^Docs/ })).toHaveAttribute("href", /docs\.compassdocs\.io\/helpdesk\/assets/);

    // Each tile opens its own page; the page leads back to the hub.
    const pages: [string, string, string][] = [
      ["snipe-it", `${HUB}/snipe-it`, "Snipe-IT"],
      ["intune", `${HUB}/intune`, "Microsoft Intune"],
      ["assets", `${HUB}/assets`, "Asset settings"],
      ["teams", `${HUB}/chat`, "Chat apps"],
      ["slack", `${HUB}/chat`, "Chat apps"],
      ["claude-connector", `${HUB}/claude-connector`, "Claude connector"],
      ["api-tokens", `${HUB}/api`, "API and webhooks"],
      ["webhooks", `${HUB}/api`, "API and webhooks"],
      ["alerts", `${HUB}/alerts`, "Alert sources"],
    ];
    for (const [key, path, h1] of pages) {
      await page.goto(HUB);
      await tile(key).getByRole("link", { name: /^(Open|Set up|Add a source)/ }).click({ timeout: 120_000 });
      await page.waitForURL((u) => u.pathname === path, { timeout: 120_000 });
      await expect(page.getByRole("heading", { level: 1, name: h1 }), key).toBeVisible({ timeout: 120_000 });
      const back = page.getByRole("link", { name: "Integrations", exact: true }).first();
      await expect(back, key).toHaveAttribute("href", HUB);
      // The settings menu keeps Integrations lit on every page under it.
      await expect(page.getByRole("navigation", { name: "Desk settings" }).getByRole("link", { name: /^Integrations/ })).toHaveAttribute("aria-current", "page");
    }
    await page.getByRole("link", { name: "Integrations", exact: true }).first().click();
    await page.waitForURL((u) => u.pathname === HUB);
    // Claude in the desk keeps its own page and its place in the menu.
    await tile("claude-desk").getByRole("link", { name: /^(Open|Set up)/ }).click();
    await page.waitForURL((u) => u.pathname === "/desk/settings/claude-desk", { timeout: 120_000 });

    // The settings menu: the four entries that moved are gone; Integrations and Claude in the desk stay.
    const rail = page.getByRole("navigation", { name: "Desk settings" });
    for (const gone of ["Assets", "Chat apps", "Claude connector", "API and webhooks"]) await expect(rail.getByRole("link", { name: new RegExp(`^${gone}`) })).toHaveCount(0);
    await expect(rail.getByRole("link", { name: /^Integrations/ })).toBeVisible();
    await expect(rail.getByRole("link", { name: /^Claude in the desk/ })).toBeVisible();

    // The old addresses land on the new places.
    for (const [old, to] of [
      ["/desk/settings/assets", HUB],
      ["/desk/settings/chat", `${HUB}/chat`],
      ["/desk/settings/claude", `${HUB}/claude-connector`],
      ["/desk/settings/api", `${HUB}/api`],
    ]) {
      await page.goto(old);
      await page.waitForURL((u) => u.pathname === to, { timeout: 120_000 });
    }
    // Alert sources keep their addresses: /new and a numeric id are theirs, a made-up word is not a page.
    await page.goto(`${HUB}/new`);
    await expect(page.getByRole("link", { name: "Alert sources", exact: true }).first()).toHaveAttribute("href", `${HUB}/alerts`, { timeout: 120_000 });
    expect((await page.request.get(`${HUB}/not-a-page`)).status()).toBe(404);

    // A phone: one column, nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(HUB);
    await expect(tile("alerts")).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    const a = await tile("snipe-it").boundingBox();
    const b = await tile("intune").boundingBox();
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
  });

  test("an agent who opens no integration page reaches neither the hub nor its statuses", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build");
    await ensureUser(page, AGENT, "viewer", "Hana Hub");
    const id = (await db.query("SELECT id FROM users WHERE username = $1", [AGENT.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [id]
    );
    await db.query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent') ON CONFLICT (user_id) DO UPDATE SET role = 'agent'", [id]);
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, AGENT);
    expect((await api(p, "/api/helpdesk/admin/integrations/hub")).status).toBe(403);
    for (const path of [HUB, `${HUB}/intune`, `${HUB}/snipe-it`, `${HUB}/api`, "/desk/settings/assets"]) {
      await p.goto(path);
      await expect(p.getByText(/is for helpdesk managers/), path).toBeVisible({ timeout: 120_000 });
      expect(new URL(p.url()).pathname, "no redirect before the capability check").toBe(path);
    }
    await ctx.close();
  });

  test("Microsoft Intune: its own app registration form, and an install that was on the directory sync app", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build");
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
    const saved = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0]?.value as string | undefined;
    const put = (intune: unknown) =>
      db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_assets', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
        JSON.stringify({ ...(saved ? JSON.parse(saved) : { snipeit: { url: "", key: "", on_solve: "nothing" }, agents_search_all: true, cache_source: "" }), intune }),
      ]);
    try {
      // Not set up: the form asks for Intune's own app registration, and nothing mentions directory sync being needed.
      await put({ on: false, cache_source: "", cred_tag: "" });
      await page.goto(`${HUB}/intune`);
      const card = page.getByTestId("assets-intune");
      await expect(card.getByTestId("assets-intune-line")).toHaveText("Enter the app registration Intune signs in with to start.", { timeout: 120_000 });
      await expect(card).toContainText("Not connected");
      const connect = card.getByRole("button", { name: "Connect", exact: true });
      await expect(connect).toBeDisabled();
      await card.getByLabel("Tenant").fill("contoso.onmicrosoft.com");
      await card.getByLabel("Application (client) ID").fill("not-a-guid");
      await card.getByLabel("Client secret").fill("typed-secret-value");
      await expect(connect).toBeEnabled();
      await expect(card).toContainText("give it only the DeviceManagementManagedDevices.Read.All application permission and grant admin consent");
      await expect(page.getByTestId("assets-intune-legacy")).toHaveCount(0);
      // The shape is checked before anything is sent to Microsoft: Test says what is wrong, in place.
      const [tested] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/assets/test") && r.request().method() === "POST", { timeout: 120_000 }),
        card.getByRole("button", { name: "Test connection" }).click(),
      ]);
      expect(await tested.json()).toEqual({ ok: false, error: "The application (client) ID is a GUID, as shown on the app registration's Overview page in Entra." });
      await expect(card.getByTestId("assets-intune-error")).toContainText("The application (client) ID is a GUID");
      expect((await db.query("SELECT value FROM settings WHERE key = 'helpdesk_assets'")).rows[0].value).not.toContain("typed-secret-value");

      // Connected before 1.20.2 through the directory sync app, which this rig does not have set up:
      // the page says so and asks for Intune's own; the hub's tile needs attention.
      await put({ on: true, cache_source: "11111111-2222-3333-4444-555555555555", cred_tag: "legacy" });
      await page.reload();
      await expect(card).toContainText("Needs attention", { timeout: 120_000 });
      await expect(card.getByTestId("assets-intune-line")).toContainText("The directory sync app it was using is no longer set up. Enter Intune's own app registration below.");
      const view = (await api(page, "/api/helpdesk/admin/assets")).body;
      expect([view.intune.on, view.intune.mode, view.intune.unavailable, view.intune.secret_set]).toEqual([true, null, "legacy_gone", false]);
      await page.goto(HUB);
      await expect(page.getByTestId("hub-tile-intune")).toContainText("Needs attention", { timeout: 120_000 });
      await expect(page.getByTestId("hub-tile-intune")).toContainText("Needs its own app registration.");
    } finally {
      if (saved === undefined) await db.query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
      else await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_assets'", [saved]);
      await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))");
    }
  });
});
