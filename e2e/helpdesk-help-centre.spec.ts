import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, login } from "./helpers";

// The customer portal's help centre (Helpdesk 1.19.4, C3): with the portal
// and the help centre on, anyone (no sign-in) searches the chosen space's
// published documents with suggestions as they type, opens categories and
// articles, never reaches a draft, and a signed-in customer sees articles
// suggested under the new request's subject. The admin's Help centre tab
// lists the categories and the last 30 days.
//
// The portal and help centre settings are workspace keys: written under
// advisory lock 728661 (shared with the portal's unit test and spec) and
// restored afterwards. Every document, space, team, request type and
// contact is this spec's own. Licensed rig only (the helpdesk is
// Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
// A searchable word only this spec's documents hold (letters only).
const W = `hc${stamp.replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
const LOCK = 728661;
const customer = `riley.${stamp}@clientco.example`;

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

test.describe("portal help centre (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  const saved = new Map<string, string | null>();
  const ids = { space: 0, team: 0, type: 0, contact: 0, start: 0, billing: 0, ok: 0, invoice: 0, draft: 0 };

  let startedAt = new Date();
  test.beforeAll(async () => {
    startedAt = new Date();
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
  });

  test.afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === null) await db.query("DELETE FROM settings WHERE key = $1", [k]);
      else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    if (ids.contact) await db.query("DELETE FROM hd_portal_contacts WHERE id = $1", [ids.contact]);
    if (ids.type) await db.query("DELETE FROM hd_request_types WHERE id = $1", [ids.type]);
    if (ids.team) await db.query("DELETE FROM hd_teams WHERE id = $1", [ids.team]);
    if (ids.space) {
      await db.query("DELETE FROM documents WHERE space_id = $1", [ids.space]);
      await db.query("DELETE FROM spaces WHERE id = $1", [ids.space]);
    }
    await db.query("DELETE FROM hd_hc_searches WHERE q LIKE $1", [`%${W}%`]);
    // The tabs' journeys this spec's browsers made (random ids, no personal
    // data; only the help centre writes this table).
    await db.query("DELETE FROM hd_hc_journeys WHERE started_at >= $1", [startedAt]);
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
  });

  async function setSetting(key: string, value: string) {
    if (!saved.has(key)) {
      const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
      saved.set(key, r.rows[0]?.value ?? null);
    }
    await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  }

  async function seed() {
    ids.space = (await db.query("INSERT INTO spaces (slug, name, visibility) VALUES ($1, $2, 'internal') RETURNING id", [`hc-e2e-${stamp}`, `Customer guides ${W}`])).rows[0].id;
    ids.start = (await db.query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 0) RETURNING id", [ids.space, `Getting started ${W}`])).rows[0].id;
    ids.billing = (await db.query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 1) RETURNING id", [ids.space, `Billing ${W}`])).rows[0].id;
    const doc = async (title: string, category: number, status: string, content: string, summary = "") =>
      (
        await db.query("INSERT INTO documents (space_id, category_id, title, slug, status, content, summary, author) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [
          ids.space,
          category,
          title,
          `hc-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
          status,
          content,
          summary,
          "jane.author@corp.example",
        ])
      ).rows[0].id as number;
    ids.ok = await doc(`Exporting reports to CSV ${W}`, ids.start, "published", `Open the report and choose **Export**.\n\n<!-- internal: ask Sam -->\n\nIt downloads a spreadsheet.`, "Download any report as a spreadsheet.");
    ids.invoice = await doc(`Paying an invoice ${W}`, ids.billing, "published", "Pay by card or bank transfer.");
    ids.draft = await doc(`Exporting secrets draft ${W}`, ids.start, "draft", "Not ready.");
    ids.team = (await db.query("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`Help centre E2E ${stamp}`])).rows[0].id;
    ids.type = (await db.query("INSERT INTO hd_request_types (slug, title, team_id, form, position) VALUES ($1, $2, $3, '[]', 999) RETURNING id", [`hc-e2e-${stamp}`, `Product question ${W}`, ids.team])).rows[0].id;
    await setSetting(
      "helpdesk_portal",
      JSON.stringify({ enabled: true, types: [{ id: ids.type, team_id: null }], access: "anyone", domains: [], brand_name: "Acme Support", limits: {}, blocked_words: [], blocked_domains: [] })
    );
    await setSetting("helpdesk_portal_hc", JSON.stringify({ enabled: true, from_spaces: true, spaces: [ids.space], tagged: false, order: [], hidden: [], indexing: false }));
  }

  test("anyone searches and reads public articles; drafts never; a customer sees suggestions on the form; the admin tab", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await seed();

    // The dev rig compiles a route on its first visit: warm the help centre's pages first.
    for (const p of ["/support", `/support/articles/${ids.ok}`, `/support/categories/c${ids.start}`, "/support/search?q=x", "/support/new", `/support/api/help/search?q=${W}`]) {
      await page.request.get(p, { timeout: 180_000, maxRedirects: 0 }).catch(() => null);
    }

    // Someone with no session at all.
    const ctx = await browser.newContext();
    const cust = await ctx.newPage();
    await cust.goto("/support");
    await expect(cust.getByRole("heading", { level: 1, name: "How can we help?" })).toBeVisible();
    await expect(cust.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(cust.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Your requests" })).toBeVisible();
    const start = cust.getByRole("link", { name: new RegExp(`Getting started ${W}`) });
    await expect(start).toContainText("1 article");
    await expect(cust.getByRole("link", { name: "New request" })).toBeVisible();

    // Suggestions as you type: the published article, never the draft.
    await cust.getByRole("searchbox", { name: "Search the help centre" }).fill(`export ${W}`);
    const list = cust.getByRole("list", { name: "Suggested articles" });
    await expect(list.getByRole("link", { name: `Exporting reports to CSV ${W}` })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByText(`Exporting secrets draft ${W}`)).toHaveCount(0);
    await list.getByRole("link", { name: `Exporting reports to CSV ${W}` }).click();
    await expect(cust.getByRole("heading", { level: 1, name: `Exporting reports to CSV ${W}` })).toBeVisible({ timeout: 60_000 });
    await expect(cust.getByText("It downloads a spreadsheet.")).toBeVisible();
    await expect(cust.getByText("ask Sam")).toHaveCount(0);
    await expect(cust.getByText("jane.author@corp.example")).toHaveCount(0);

    // Searching rate-limited says so; it never reads as "no articles match".
    await cust.goto("/support");
    await cust.route("**/support/api/help/search?**", (r) => r.fulfill({ status: 429, json: { error: "Too many searches right now. Wait a moment and try again.", limited: true } }));
    await cust.getByRole("searchbox", { name: "Search the help centre" }).fill(`invoice ${W}`);
    await expect(cust.getByTestId("help-limited")).toHaveText(/Too many searches/, { timeout: 30_000 });
    await expect(cust.getByText("No articles match that yet")).toHaveCount(0);
    await cust.unroute("**/support/api/help/search?**");

    // Enter opens the results page.
    await cust.goto("/support");
    await cust.getByRole("searchbox", { name: "Search the help centre" }).fill(`export ${W}`);
    await cust.getByRole("searchbox", { name: "Search the help centre" }).press("Enter");
    const results = cust.getByRole("list", { name: "Search results" });
    await expect(results.getByRole("link").first()).toContainText(`Exporting reports to CSV ${W}`, { timeout: 60_000 });
    await expect(results.getByText(`Exporting secrets draft ${W}`)).toHaveCount(0);

    // A category page; the draft is a 404 by any address.
    await cust.goto(`/support/categories/c${ids.start}`);
    await expect(cust.getByRole("heading", { level: 1, name: `Getting started ${W}` })).toBeVisible();
    await expect(cust.getByText(`Exporting secrets draft ${W}`)).toHaveCount(0);
    const draft = await cust.goto(`/support/articles/${ids.draft}`);
    expect(draft?.status()).toBe(404);
    await expect(cust.getByRole("heading", { name: "Page not found" })).toBeVisible();

    // A phone: nothing scrolls sideways.
    await cust.setViewportSize({ width: 390, height: 844 });
    await cust.goto("/support");
    await expect(cust.getByRole("heading", { level: 1, name: "How can we help?" })).toBeVisible();
    expect(await cust.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await cust.goto(`/support/articles/${ids.ok}`);
    expect(await cust.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await ctx.close();

    // A signed-in customer: articles under the new request's subject.
    ids.contact = (await db.query("INSERT INTO hd_portal_contacts (email) VALUES ($1) RETURNING id", [customer])).rows[0].id;
    const token = randomBytes(32).toString("hex");
    await db.query("INSERT INTO hd_portal_sessions (contact_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [
      ids.contact,
      createHash("sha256").update(token, "utf8").digest("hex"),
    ]);
    const signed = await browser.newContext();
    const base = new URL(page.url());
    await signed.addCookies([{ name: "compass_portal", value: token, domain: base.hostname, path: "/support", httpOnly: true, sameSite: "Lax" }]);
    const form = await signed.newPage();
    await form.goto("/support/new");
    await expect(form.getByRole("heading", { level: 1, name: "New request" })).toBeVisible({ timeout: 60_000 });
    await form.getByLabel("Subject (optional)").fill(`export ${W}`);
    const help = form.getByRole("region", { name: "Articles that might help" });
    await expect(help.getByRole("link", { name: new RegExp(`Exporting reports to CSV ${W}`) })).toBeVisible({ timeout: 30_000 });
    await expect(help.getByRole("link", { name: new RegExp(`Exporting reports to CSV ${W}`) })).toHaveAttribute("target", "_blank");
    await signed.close();

    // The admin's Help centre tab.
    await page.goto("/desk/settings/portal/help-centre");
    const tabs = page.getByRole("navigation", { name: "Customer portal settings" });
    await expect(tabs.getByRole("link", { name: "Help centre" })).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    await expect(page.getByRole("switch", { name: "Show a help centre" }).or(page.getByRole("checkbox", { name: "Show a help centre" }))).toBeChecked();
    await expect(page.getByRole("list", { name: "Categories, in the order customers see them" }).getByText(`Getting started ${W}`)).toBeVisible();
    await expect(page.getByText("Last 30 days")).toBeVisible();
    await tabs.getByRole("link", { name: "Customers" }).click();
    await expect(page).toHaveURL(/\/desk\/settings\/portal\/customers$/);
    await expect(page.getByRole("searchbox", { name: "Search customers" }).or(page.getByLabel("Search customers"))).toBeVisible();
  });
});
