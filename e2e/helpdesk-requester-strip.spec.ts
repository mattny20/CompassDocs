import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";

// The requester strip (1.20.3): who asked, across the top of the desk's
// ticket, where the side panel's Requester card used to be. Closed: the
// person, one joined group of the ways to reach them, a band of facts
// (devices, tickets, manager). Open: Contact, Devices, Work and History
// tiles. Open or closed is remembered per agent in the browser. On a phone
// the group is full width, one fact per line, the tiles stack, and nothing
// scrolls sideways. A ticket with no requester has no strip.
//
// The requester is a directory person who wrote in by email (no account),
// seeded in the database with a manager, three devices in the asset cache
// and two other tickets (one open, one solved and rated). Two workspace
// settings are touched and put back: the contact cards (Teams and Webex on,
// London's time zone), under the advisory lock test/helpdesk-contact-cards
// holds, and the asset source, under e2e/helpdesk-assets' lock. Everything
// else is this spec's own and is deleted.
//
// E2E_SHOTS=<dir> also saves the screenshots (1440 light and dark, 390).

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const CARDS_LOCK = 728460; // helpdesk_contact_cards (test/helpdesk-contact-cards.test.ts)

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/contact-cards")).status !== 402;
}

/**
 * No sideways scroll: the page doesn't, and nothing of the strip sticks out of the ticket pane
 * (an element, or a tooltip's bubble, which widens the pane's scroller even while hidden).
 * Only the strip is measured in the pane: the side column's own tooltips are not this spec's.
 */
async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(() => {
    const pane = document.querySelector("article")?.parentElement;
    const strip = document.querySelector('[data-testid="requester-strip"]');
    const out = { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, who: [] as string[] };
    if (!pane || !strip) return out;
    const limit = pane.getBoundingClientRect().left + pane.clientWidth;
    for (const el of [strip, ...strip.querySelectorAll("*")]) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > limit + 1) out.who.push(`<${el.tagName.toLowerCase()}> ${(el.textContent ?? "").trim().slice(0, 40)} +${Math.round(r.right - limit)}px`);
      const tt = el.getAttribute("data-tt");
      if (!tt) continue;
      const cs = getComputedStyle(el, "::after");
      const w = parseFloat(cs.width) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const left = r.left + parseFloat(cs.left) + (cs.transform === "none" ? 0 : new DOMMatrix(cs.transform).e);
      if (left + w > limit + 1) out.who.push(`tooltip "${tt}" +${Math.round(left + w - limit)}px`);
    }
    return out;
  });
  expect(over.page, "the page doesn't scroll sideways").toBeLessThanOrEqual(1);
  expect(over.who, "nothing of the strip sticks out of the ticket pane").toEqual([]);
}

test.describe("Helpdesk requester strip", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const TAG = `E2E-RQ-${stamp.toUpperCase()}`;
  const email = `daniel.okafor.${stamp}@example.test`;
  const teamName = `E2E Requester ${stamp}`;
  let db: Client;
  let ready = false;
  let teamId = 0;
  let number = 0;
  let openNo = 0;
  let bare = 0;
  const tickets: number[] = [];
  const people: number[] = [];
  let savedCards: unknown = null;
  let savedAssets: { key: string; value: string }[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    db = new Client({ connectionString: DB });
    await db.connect();
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (!(await licensed(page))) {
      await page.close();
      return;
    }
    // One writer of each workspace setting at a time; both are restored in afterAll.
    await db.query("SELECT pg_advisory_lock($1)", [CARDS_LOCK]);
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
    ready = true;
    savedCards = (await api(page, "/api/helpdesk/admin/contact-cards")).body.settings;
    const put = await api(page, "/api/helpdesk/admin/contact-cards", {
      method: "PUT",
      body: { ...(savedCards as object), teams: { mode: "everyone", field: "" }, webex: { mode: "email", field: "" }, office_timezones: { ...((savedCards as { office_timezones?: Record<string, string> }).office_timezones ?? {}), london: "Europe/London" } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // The asset source: a Snipe-IT the rig can't reach, its cache seeded as a sync would have.
    savedAssets = (await db.query("SELECT key, value FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')")).rows;
    await db.query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
    const src = await api(page, "/api/helpdesk/admin/assets", { method: "PUT", body: { url: `https://assets-${stamp}.example.com`, api_key: `e2e-key-${stamp}` } });
    expect(src.status, JSON.stringify(src.body)).toBe(200);
    const base = `https://assets-${stamp}.example.com/hardware`;
    await db.query(
      `INSERT INTO hd_assets (provider, external_id, tag, serial, name, model, category, status_label, status_kind, assigned_email, assigned_name, location, url)
       VALUES ('snipeit', $1, $2, $3, 'LON-LT-0421', 'ThinkPad T14', 'Laptops', 'Ready to Deploy', 'deployed', $4, 'Daniel Okafor', 'London office', $5),
              ('snipeit', $6, $7, '', 'iPhone 15', 'iPhone 15', 'Phones', 'Ready to Deploy', 'deployed', $4, 'Daniel Okafor', 'London office', $8),
              ('snipeit', $9, $10, '', 'Dell U2723QE', 'U2723QE', 'Monitors', 'Ready to Deploy', 'deployed', $4, 'Daniel Okafor', 'London office', $11)`,
      [`${TAG}-1`, `${TAG}-00421`, `PF${stamp}`, email, `${base}/1`, `${TAG}-2`, `${TAG}-00777`, `${base}/2`, `${TAG}-3`, `${TAG}-00312`, `${base}/3`]
    );
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('helpdesk_assets_sync:snipeit', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify({ started_at: new Date().toISOString(), at: new Date().toISOString(), ok: true, error: "", total: 3 })]
    );

    // The directory: Daniel and his manager.
    const boss = (await db.query("INSERT INTO directory_people (name, title, department, email) VALUES ('Priya Shah', 'Finance Director', 'Finance', $1) RETURNING id", [`priya.shah.${stamp}@example.test`])).rows[0].id as number;
    const dan = (
      await db.query(
        `INSERT INTO directory_people (name, title, department, email, phone, mobile, office)
         VALUES ('Daniel Okafor', 'Finance Analyst', 'Finance', $1, '+44 20 7946 0142', '+44 7700 900142', $2) RETURNING id`,
        [email, "London"]
      )
    ).rows[0].id as number;
    people.push(dan, boss);
    await db.query("INSERT INTO directory_person_links (person_id, field_key, target_id) VALUES ($1, 'manager', $2)", [dan, boss]);

    // His tickets: this one, an open one and a solved one he rated.
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    // Seeded in the database (as e2e/helpdesk-api-webhooks does): Daniel wrote in by email, with no account.
    const make = async (subject: string, status: string, from: { name: string; email: string } | null, message = "") => {
      const t = (
        await db.query("INSERT INTO hd_tickets (subject, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, $3, $4, $5, 'email') RETURNING id, number", [
          subject,
          from?.name ?? "",
          from?.email ?? "",
          teamId,
          status,
        ])
      ).rows[0] as { id: number; number: number };
      if (message && from) await db.query("INSERT INTO hd_messages (ticket_id, author_name, author_email, kind, body, via) VALUES ($1, $2, $3, 'public', $4, 'email')", [t.id, from.name, from.email, message]);
      tickets.push(t.number);
      return t.number;
    };
    const daniel = { name: "Daniel Okafor", email };
    const solved = await make(`Dock not charging ${stamp}`, "solved", daniel);
    openNo = await make(`Shared drive access ${stamp}`, "open", daniel);
    number = await make(`Laptop won't connect to VPN from home ${stamp}`, "new", daniel, "Since this morning the VPN client says “Authentication failed” when I connect from home. It works in the office.");
    // An alert with nobody behind it.
    bare = await make(`Disk space alert ${stamp}`, "new", null);
    await db.query("UPDATE hd_tickets SET solved_at = now(), created_at = now() - interval '6 days', csat_score = 5, csat_at = now() WHERE number = $1", [solved]);
    await db.query("UPDATE hd_tickets SET created_at = now() - interval '2 days' WHERE number = $1", [openNo]);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    if (ready) {
      const page = await browser.newPage();
      await login(page, ADMIN);
      await db.query("DELETE FROM hd_tickets WHERE number = ANY($1::int[])", [tickets]);
      if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
      if (savedCards) await api(page, "/api/helpdesk/admin/contact-cards", { method: "PUT", body: savedCards });
      await page.close();
      await db.query("DELETE FROM directory_person_links WHERE person_id = ANY($1::int[]) OR target_id = ANY($1::int[])", [people]);
      await db.query("DELETE FROM directory_people WHERE id = ANY($1::int[])", [people]);
      await db.query("DELETE FROM hd_assets WHERE provider = 'snipeit' AND tag LIKE $1", [`${TAG}%`]);
      await db.query("DELETE FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')");
      for (const r of savedAssets) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
      await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))");
      await db.query("SELECT pg_advisory_unlock($1)", [CARDS_LOCK]);
    }
    await db.end();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ready, "helpdesk is not licensed in this build; the EE rig runs the flow");
    await login(page, ADMIN);
  });

  async function openTicket(page: Page, n: number) {
    await page.goto(`/desk/tickets/${n}`);
    await slow(page.getByRole("heading", { level: 2 }).first()).toBeVisible({ timeout: 90_000 });
  }

  async function shot(page: Page, name: string, fullPage = false) {
    if (!SHOTS) return;
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
  }

  test("closed and open at 1440: the person, the ways to reach them, the facts, the four tiles; copy; remembered after a reload", async ({ page, context }) => {
    test.setTimeout(300_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTicket(page, number);
    const strip = page.getByTestId("requester-strip");
    await slow(strip).toBeVisible({ timeout: 90_000 });

    // Closed by default. Row 1: who, and one joined group of the ways to reach them.
    await expect(strip).toHaveAttribute("data-open", "false");
    await expect(strip.getByTestId("requester-name")).toHaveText("Daniel Okafor");
    await expect(strip).toContainText("Finance Analyst");
    await expect(strip).toContainText("Finance · London · ");
    await expect(strip).toContainText("local time");
    const group = strip.getByRole("group", { name: "Contact Daniel Okafor" });
    // Email, one Call for both numbers, then chat in the card's order: four segments, nothing under More.
    await expect(group.locator(":scope > *")).toHaveText([/^Email/, /^Call/, /^Teams/, /^Webex/]);
    await expect(group.getByRole("link", { name: /^Email/ })).toHaveAttribute("href", `mailto:${email}`);
    await expect(group.getByRole("link", { name: /^Teams/ })).toHaveAttribute("href", `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`);
    await expect(group.getByRole("link", { name: /^Webex/ })).toHaveAttribute("href", `webexteams://im?email=${encodeURIComponent(email)}`);
    await expect(group.getByRole("button", { name: /^More/ })).toHaveCount(0);
    // Two numbers: Call opens the list of them (keyboard: Enter opens, arrows walk, Escape closes).
    const call = group.getByRole("button", { name: /^Call/ });
    await expect(call).toHaveAttribute("aria-expanded", "false");
    await call.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Call Daniel Okafor" });
    await expect(menu.getByRole("menuitem")).toHaveText([/^Desk phone\s*\+44 20 7946 0142$/, /^Cell phone\s*\+44 7700 900142$/]);
    await expect(menu.getByRole("menuitem").first()).toHaveAttribute("href", "tel:+442079460142");
    await expect(menu.getByRole("menuitem").last()).toHaveAttribute("href", "tel:+447700900142");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(call).toBeFocused();

    // Row 2: two devices and "+1", his tickets, his manager.
    const facts = strip.getByTestId("requester-facts");
    await slow(facts.getByRole("link", { name: "LON-LT-0421" })).toBeVisible();
    await expect(facts.getByRole("link", { name: "iPhone 15" })).toBeVisible();
    await expect(facts).not.toContainText("Dell U2723QE");
    await expect(facts.getByRole("button", { name: /^\+1 more device/ })).toBeVisible();
    await expect(facts.getByTestId("requester-tickets")).toHaveText(/^1 open · 1 earlier/);
    await expect(facts.getByTestId("requester-tickets")).toHaveAttribute("href", `/desk?requester_email=${encodeURIComponent(email)}`);
    await expect(facts).toContainText("Manager");
    await expect(facts.getByRole("link", { name: "Priya Shah" })).toBeVisible();

    // The side panel no longer carries the Requester card.
    await expect(page.locator('section[aria-labelledby="hd-contact-requester"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Requester", exact: true })).toHaveCount(0);
    await noSidewaysScroll(page);
    await shot(page, "strip-closed-1440-light");

    // Open: the four tiles.
    const toggle = strip.getByRole("button", { name: "Show requester details", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(strip).toHaveAttribute("data-open", "true");
    await expect(strip.getByRole("button", { name: "Hide requester details", exact: true })).toHaveAttribute("aria-expanded", "true");
    const details = strip.getByTestId("requester-details");
    for (const tile of ["Contact", "Devices", "Work", "History"]) await expect(details.getByRole("heading", { level: 3, name: tile })).toBeVisible();
    await slow(details.getByTestId("requester-device")).toHaveCount(3);
    await shot(page, "strip-open-1440-light");
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForTimeout(300);
      await shot(page, "strip-open-1440-dark");
      await strip.getByRole("button", { name: "Hide requester details", exact: true }).click();
      await shot(page, "strip-closed-1440-dark");
      await strip.getByRole("button", { name: "Show requester details", exact: true }).click();
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.emulateMedia({ colorScheme: "light" });
    }
    await expect(details.getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
    await expect(details.getByRole("link", { name: "+44 7700 900142" })).toHaveAttribute("href", "tel:+447700900142");
    await expect(details.getByRole("link", { name: "Chat in Teams" })).toHaveAttribute("href", `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`);
    await expect(details.getByTestId("requester-device")).toHaveCount(3);
    // Computers first, then phones, then the rest.
    await expect(details.getByTestId("requester-device").first()).toContainText(`ThinkPad T14 · ${TAG}-00421 · Snipe-IT`);
    await expect(details.getByTestId("requester-device").last()).toContainText("Dell U2723QE");
    await expect(details.getByRole("link", { name: /Open LON-LT-0421 in Snipe-IT/ })).toHaveAttribute("href", `https://assets-${stamp}.example.com/hardware/1`);
    await expect(details.getByText("Department")).toBeVisible();
    const history = details.getByTestId("requester-history");
    await expect(history.getByRole("link", { name: new RegExp(`#${openNo} Shared drive access`) })).toHaveAttribute("href", `/desk/tickets/${openNo}`);
    await expect(history).toContainText("1 earlier ticket");
    await expect(history).toContainText("5 of 5 · 1 rating");
    await history.getByRole("button", { name: /^Show/ }).click();
    await expect(history.getByRole("link", { name: /Dock not charging/ })).toBeVisible();
    await history.getByRole("button", { name: /^Hide/ }).click();

    // A contact action: copy the email.
    await details.getByRole("button", { name: "Copy email" }).click();
    await expect(page.getByText("Email copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(email);
    // Reply in ticket puts the cursor in the composer.
    await details.getByRole("button", { name: "Reply in ticket" }).click();
    await expect(page.getByPlaceholder(/^Write a reply/)).toBeFocused();
    await noSidewaysScroll(page);

    // On paper: the closed strip's first row, with the ways to reach them as text.
    await page.emulateMedia({ media: "print" });
    await expect(strip.getByTestId("requester-methods")).toBeHidden();
    await expect(strip.getByTestId("requester-facts")).toBeHidden();
    await expect(strip.getByTestId("requester-details")).toBeHidden();
    await expect(strip.getByRole("button", { name: "Hide requester details", exact: true })).toBeHidden();
    await expect(strip.getByText(`${email} · Desk phone +44 20 7946 0142 · Cell phone +44 7700 900142`)).toBeVisible();
    await page.emulateMedia({ media: null });

    // Remembered: still open after a reload, and on another ticket of his; closed again stays closed.
    await page.reload();
    await slow(strip).toHaveAttribute("data-open", "true", { timeout: 90_000 });
    await expect(strip.getByTestId("requester-details").getByRole("heading", { level: 3, name: "Contact" })).toBeVisible();
    await openTicket(page, openNo);
    await slow(page.getByTestId("requester-strip")).toHaveAttribute("data-open", "true", { timeout: 90_000 });
    await page.getByTestId("requester-strip").getByRole("button", { name: "Hide requester details", exact: true }).click();
    await expect(page.getByTestId("requester-strip")).toHaveAttribute("data-open", "false");
    await page.reload();
    await slow(page.getByTestId("requester-strip")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("requester-strip")).toHaveAttribute("data-open", "false");
    await expect(page.getByTestId("requester-strip").getByRole("heading", { level: 3 })).toHaveCount(0);
  });

  test("on a phone: the contact group is full width, one fact per line, the tiles stack, nothing scrolls sideways", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openTicket(page, number);
    const strip = page.getByTestId("requester-strip");
    await slow(strip).toBeVisible({ timeout: 90_000 });
    await slow(strip.getByTestId("requester-facts").getByRole("link", { name: "LON-LT-0421" })).toBeVisible();
    await expect(strip).toHaveAttribute("data-open", "false");

    // The group spans the strip, its buttons equal.
    const box = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!;
    const s = await box(strip);
    const g = await box(strip.getByTestId("requester-methods"));
    expect(g.width).toBeGreaterThan(s.width - 40);
    const widths = await strip.getByTestId("requester-methods").locator(":scope > *").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(widths.length).toBe(4);
    expect(Math.max(...widths) - Math.min(...widths), `equal segments: ${widths.join(", ")}`).toBeLessThanOrEqual(2);
    // One fact per line.
    const tops = await strip.getByTestId("requester-facts").locator(":scope > li").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(tops.length);
    await noSidewaysScroll(page);
    await shot(page, "strip-closed-390-light");

    await strip.getByRole("button", { name: "Show requester details", exact: true }).click();
    const tiles = strip.getByTestId("requester-details").locator(":scope > section");
    await expect(tiles).toHaveCount(4);
    const lefts = await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(lefts).size, "the tiles are one column").toBe(1);
    await noSidewaysScroll(page);
    if (SHOTS) {
      await page.setViewportSize({ width: 390, height: 1500 });
      await shot(page, "strip-open-390-light");
      await page.setViewportSize({ width: 390, height: 844 });
    }
    // Leave it closed for whoever opens the desk next in this browser profile.
    await strip.getByRole("button", { name: "Hide requester details", exact: true }).click();
  });

  test("a ticket with no requester has no strip, and no Requester card comes back in the side panel", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const cards = page.waitForResponse((r) => r.url().includes(`/api/helpdesk/contacts?ticket=${bare}`), { timeout: 120_000 });
    await openTicket(page, bare);
    const res = await cards;
    expect(res.status()).toBe(200);
    expect(((await res.json()).contacts as { relation: string }[]).some((c) => c.relation === "requester")).toBe(false);
    await slow(page.getByRole("region", { name: "Properties" })).toBeVisible();
    await expect(page.getByTestId("requester-strip")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Requester" })).toHaveCount(0);
    await expect(page.locator('section[aria-labelledby="hd-contact-requester"]')).toHaveCount(0);
  });
});
