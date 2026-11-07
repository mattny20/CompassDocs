import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";
import { DESK_NEW_PAGES, DESK_NEW_RELEASE } from "../src/lib/helpdesk/whats-new-shared";

const FIRST_NEW = DESK_NEW_PAGES[0];

// Helpdesk 1.19.2 loose ends (agent W5), on the licensed rig:
//   - Desk settings: the rail's "New" chips clear once the page is opened,
//     and the "New in <release>" strip once dismissed (mock e2; read from whats-new-shared);
//   - Import: the dry run runs in the background with progress, the page
//     can be left, the bell says when it's ready (mock e1);
//   - the customer portal: a solved request asks "How did we do?", an
//     email rating link preselects the answer, and the kept request lists
//     the customer's request joined with it (mock e3).
//
// Parallel-safe: its own team, request type, desk person, portal contact,
// import and tickets, all removed afterwards. The portal setting (one
// workspace key) is written under advisory lock 728661 (shared with the
// portal tests) and restored. Screenshots (light, 1440) go to SHOTS when set.

const stamp = `${Date.now()}`;
const SHOTS = process.env.W5_SHOTS_DIR || "";
const LOCK = 728661;
const DESK = { username: `e2e_w5_desk_${stamp}`, password: "E2eW5Desk!12345" };
const customer = `jordan.${stamp}@clientco.example`;

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // The dev server's own overlay badge is not part of the page.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe("helpdesk 1.19.2 loose ends (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let teamId = 0;
  let typeId = 0;
  let jobId = 0;
  let deskUserId = 0;
  let savedPortal: string | null = null;
  const numbers: number[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
  });

  test.afterAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await browser.newPage();
    try {
      await login(page, ADMIN);
      for (const n of numbers) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
      if (jobId) await api(page, `/api/helpdesk/admin/import/${jobId}`, { method: "DELETE" });
      if (typeId) await api(page, `/api/helpdesk/admin/request-types/${typeId}`, { method: "DELETE" });
      if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    } finally {
      await page.close();
    }
    if (jobId) await db.query("DELETE FROM hd_import_jobs WHERE id = $1", [jobId]);
    await db.query("DELETE FROM hd_portal_contacts WHERE email = $1", [customer]);
    await db.query("DELETE FROM audit_log WHERE actor_name = $1 OR target_label = $2", [`Customer portal: ${customer}`, customer]);
    const admin = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0]?.id;
    if (admin) await db.query("DELETE FROM notifications WHERE user_id = $1 AND link LIKE $2", [admin, `/desk/settings/import?job=${jobId}`]);
    if (deskUserId) {
      await db.query("DELETE FROM hd_desk_seen WHERE user_id = $1", [deskUserId]);
      await db.query("DELETE FROM hd_agent_roles WHERE user_id = $1", [deskUserId]);
      await db.query("DELETE FROM role_assignments WHERE user_id = $1", [deskUserId]);
      await db.query("DELETE FROM sessions WHERE user_id = $1", [deskUserId]);
      await db.query("DELETE FROM audit_log WHERE actor_id = $1", [deskUserId]);
      await db.query("DELETE FROM users WHERE id = $1", [deskUserId]);
    }
    await db.end();
  });

  test("Desk settings: New chips clear once the page is opened; the release strip once dismissed", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    // A desk admin of our own, so the shared admin's "seen" records stay untouched.
    await ensureUser(page, DESK, "viewer", "Wendy Five");
    deskUserId = (await db.query("SELECT id FROM users WHERE username = $1", [DESK.username])).rows[0].id;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [deskUserId]
    );
    await db.query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [deskUserId]);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desk = await ctx.newPage();
    await login(desk, DESK);
    await desk.goto("/desk/settings/teams");
    await expect(desk.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible({ timeout: 120_000 });
    const rail = desk.getByRole("navigation", { name: "Desk settings" });
    // The release's first New page (1.20.0: Claude in the desk; the list grows as areas land).
    const assets = rail.getByRole("link", { name: new RegExp(`^${FIRST_NEW.label}`) });
    await expect(assets).toContainText("New");
    await expect(rail.getByRole("link", { name: /^Teams$/ })).not.toContainText("New");
    // 1.19.4's pages are no longer New.
    await expect(rail.getByRole("link", { name: /^Appearance/ })).not.toContainText("New");
    const strip = desk.getByRole("note").filter({ hasText: `New in ${DESK_NEW_RELEASE}` });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("badge goes once you've opened the page");
    await expect(desk.getByText("Loading…")).toHaveCount(0, { timeout: 60_000 });
    await shot(desk, "e2-settings-new-badges-1440-light");

    await assets.click();
    await desk.waitForURL((u) => u.pathname.startsWith(FIRST_NEW.href));
    await expect(assets).not.toContainText("New");
    await expect.poll(async () => (await db.query("SELECT 1 FROM hd_desk_seen WHERE user_id = $1 AND item = $2", [deskUserId, FIRST_NEW.href])).rowCount, { timeout: 60_000 }).toBe(1);
    await desk.goto("/desk/settings/teams");
    await expect(assets).not.toContainText("New");
    await strip.getByRole("button", { name: /Dismiss what's new/ }).click();
    await expect(strip).toHaveCount(0);
    await expect.poll(async () => (await db.query("SELECT 1 FROM hd_desk_seen WHERE user_id = $1 AND item = $2", [deskUserId, `strip:${DESK_NEW_RELEASE}`])).rowCount, { timeout: 60_000 }).toBe(1);
    await desk.reload();
    await expect(desk.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible();
    await expect(desk.getByRole("note").filter({ hasText: `New in ${DESK_NEW_RELEASE}` })).toHaveCount(0);
    await ctx.close();
  });

  test("Import: the dry run runs in the background with progress; the bell says when it's ready", async ({ page }, testInfo) => {
    test.setTimeout(400_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    // A CSV big enough to watch the check run.
    const rows = ["Ticket Id,Subject,Description,Status,Priority,Created Time,Contact Email,Contact Name"];
    for (let i = 1; i <= 30_000; i++) rows.push(`w5-${stamp}-${i},Export ${i} times out,It spins and fails,Open,Medium,2026-10-0${1 + (i % 9)} 10:00,c${i % 500}@w5-${stamp}.test,Customer ${i % 500}`);
    const dir = path.join(testInfo.project.outputDir, `w5-import-${stamp}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `zoho-desk-2026-11-${stamp}.csv`);
    await writeFile(file, rows.join("\n"));

    await page.goto("/desk/settings/import");
    await expect(page.getByRole("heading", { level: 1, name: "Import" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("radio", { name: /CSV file/ }).check({ force: true });
    await page.getByLabel("Tickets file (.csv)").setInputFiles(file);
    await page.getByRole("button", { name: "Upload and continue" }).click();
    await expect(page.getByRole("button", { name: "Run the dry run" })).toBeVisible({ timeout: 180_000 });
    await expect(page).toHaveURL(/[?&]job=\d+/);
    jobId = Number(new URL(page.url()).searchParams.get("job"));
    expect(jobId).toBeGreaterThan(0);
    await page.getByLabel("Time zone of the export's times").fill("UTC");
    await page.getByRole("button", { name: "Run the dry run" }).click();

    // The check card: progress, counts so far, "you can leave", Stop.
    await expect(page.getByText("Checking your export")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("progressbar", { name: "Dry run progress" })).toBeVisible();
    await expect(page.getByText(/You can leave this page\. We'll tell you in the bell when the dry run is ready\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Import [\d,]+ tickets?$/ })).toBeDisabled();
    await expect(page.getByText(/of 30,000 tickets checked/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("To create")).toBeVisible();
    // A moment well into the run for the picture.
    await expect
      .poll(async () => Number(await page.getByRole("progressbar", { name: "Dry run progress" }).getAttribute("aria-valuenow")), { timeout: 240_000 })
      .toBeGreaterThanOrEqual(40);
    await shot(page, "e1-import-dryrun-background-1440-light");

    // Leave the page; the check carries on, and the bell says when it's ready.
    await page.goto("/desk/settings/teams");
    const admin = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0].id as number;
    await expect
      .poll(async () => (await db.query("SELECT title FROM notifications WHERE user_id = $1 AND link = $2", [admin, `/desk/settings/import?job=${jobId}`])).rows[0]?.title ?? "", {
        timeout: 300_000,
      })
      .toMatch(/^Dry run ready: /);
    await page.goto(`/desk/settings/import?job=${jobId}`);
    await expect(page.getByText("tickets to create")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Import 30,000 tickets" })).toBeEnabled();

    // Stop: a second dry run, stopped, goes back to the map step.
    await page.getByRole("button", { name: "Back to mapping" }).click();
    await page.getByRole("button", { name: "Run the dry run" }).click();
    await expect(page.getByText("Checking your export")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Run the dry run" })).toBeVisible({ timeout: 60_000 });
    expect((await db.query("SELECT status FROM hd_import_jobs WHERE id = $1", [jobId])).rows[0].status).toBe("uploaded");
  });

  test("Customer portal: How did we do? on a solved request, the email link preselects, the joined request shows", async ({ page, browser, baseURL }) => {
    test.setTimeout(400_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const people = await api(page, "/api/users/mentionable");
    const myId = (people.body?.users as { id: number; username: string }[] | undefined)?.find((u) => u.username === ADMIN.username)?.id;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `Product support W5 ${stamp}`, members: myId ? [{ user_id: myId, role: "lead" }] : [] } });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    const rt = await api(page, "/api/helpdesk/admin/request-types", {
      method: "POST",
      body: { title: `Product support ${stamp}`, slug: `w5-e2e-${stamp}`, team_id: teamId, form: [], sla_priority: "normal", visibility: "all" },
    });
    expect([200, 201]).toContain(rt.status);
    typeId = (rt.body.request_type ?? rt.body.type ?? rt.body).id;

    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
    try {
      savedPortal = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_portal'")).rows[0]?.value ?? null;
      const portalSettings = { enabled: true, types: [{ id: typeId, team_id: null }], access: "anyone", domains: [], brand_name: "Acme Support", limits: {}, blocked_words: [], blocked_domains: [] };
      await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_portal', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(portalSettings)]);

      // The customer's session (the portal's own cookie; the sign-in flow has its own spec).
      const contact = (await db.query("INSERT INTO hd_portal_contacts (email, name, last_seen_at) VALUES ($1, 'Jordan', now()) RETURNING id", [customer])).rows[0].id as number;
      const token = randomBytes(32).toString("hex");
      await db.query("INSERT INTO hd_portal_sessions (contact_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [
        contact,
        createHash("sha256").update(token).digest("hex"),
      ]);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const host = new URL(baseURL!).hostname;
      await ctx.addCookies([{ name: "compass_portal", value: token, domain: host, path: "/support", httpOnly: true, sameSite: "Lax" }]);
      const cust = await ctx.newPage();
      const raise = async (subject: string) => {
        const r = await cust.request.post("/support/api/requests", {
          headers: { origin: new URL(baseURL!).origin },
          multipart: { request_type_id: String(typeId), subject, body: "The export spins for a minute and then fails.", answers: "{}" },
          timeout: 180_000,
        });
        expect(r.status(), await r.text()).toBe(201);
        const n = (await r.json()).number as number;
        numbers.push(n);
        return n;
      };
      const joined = await raise(`Export to CSV fails ${stamp}`);
      const kept = await raise(`Export to CSV times out ${stamp}`);

      // The desk joins the first into the second and solves it.
      const merged = await api(page, "/api/helpdesk/tickets/merge", { method: "POST", body: { keep: kept, merge: [joined], notify: true } });
      expect(merged.status, JSON.stringify(merged.body)).toBeLessThan(300);
      const solved = await api(page, `/api/helpdesk/tickets/${kept}`, { method: "PATCH", body: { status: "solved" } });
      expect(solved.status, JSON.stringify(solved.body)).toBeLessThan(300);

      // The solved email's "Not good" link: signed in, it opens the request with Not good chosen.
      const t = (await db.query("SELECT reply_token FROM hd_tickets WHERE number = $1", [kept])).rows[0];
      expect(t.reply_token).toBeTruthy();
      const csat = createHmac("sha256", t.reply_token).update(`csat:${kept}`).digest("base64url").slice(0, 22);
      const hex = Buffer.from(csat).toString("hex");
      await cust.goto(`/support/requests/${kept}/rate/not-good/${hex}`, { timeout: 180_000 });
      await expect(cust).toHaveURL(new RegExp(`/support/requests/${kept}\\?rate=not_good&t=`), { timeout: 120_000 });
      await expect(cust.getByRole("heading", { name: "This request is solved. How did we do?" })).toBeVisible();
      await expect(cust.getByRole("radio", { name: "Not good" })).toBeChecked();
      await expect(cust.getByText(`Your request #${joined} was joined with this one, because it was about the same problem. Replies to either go here.`)).toBeVisible();

      // The customer changes their mind: Good, with a comment.
      const good = cust.getByRole("radio", { name: "Good", exact: true });
      // Clicked again until the page has hydrated and holds it.
      await expect(async () => {
        await cust.getByText("Good", { exact: true }).click();
        await expect(good).toBeChecked({ timeout: 1000 });
        await expect(cust.getByRole("radio", { name: "Not good" })).not.toBeChecked({ timeout: 1000 });
      }).toPass({ timeout: 60_000 });
      await cust.getByLabel("Anything to add? (optional)").fill("Quick fix, thanks Ana.");
      await shot(cust, "e3-portal-survey-1440-light");
      await cust.getByRole("form", { name: /How did we do/ }).getByRole("button", { name: "Send" }).click();
      await expect(cust.getByText("Thanks for telling us. You rated this request Good.")).toBeVisible({ timeout: 60_000 });
      const row = (await db.query("SELECT csat_score, csat_comment FROM hd_tickets WHERE number = $1", [kept])).rows[0];
      expect(row.csat_score).toBe(5);
      expect(row.csat_comment).toBe("Quick fix, thanks Ana.");
      await cust.reload();
      await expect(cust.getByText("Thanks for telling us. You rated this request Good.")).toBeVisible();
      await expect(cust.getByRole("heading", { name: "This request is solved. How did we do?" })).toHaveCount(0);
      await ctx.close();
    } finally {
      if (savedPortal === null) await db.query("DELETE FROM settings WHERE key = 'helpdesk_portal'");
      else await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_portal', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [savedPortal]);
      await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    }
  });
});
