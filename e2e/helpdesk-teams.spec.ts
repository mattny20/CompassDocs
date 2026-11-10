import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Desk settings → Teams as a list, then one page per team (1.20.2): add a
// team from the list, land on its page, edit and save with the Save row
// (and the leave prompt), change its people, go back to the list, open it
// again by keyboard, an old "#team-<id>" address, a phone-width check, and
// delete from the danger zone. The page and its API stay behind
// teams.manage: a team lead reaches neither, exactly as before the split.
// Licensed rig only (the helpdesk is Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
const NAME = `Finance E2E ${stamp}`;
const LEAD = { username: "e2e_teams_lead", password: "E2eTeamsLead!123" };

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

test.describe("teams: list and detail (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let teamId = 0;
  let leadId = 0;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
  });

  test.afterAll(async () => {
    await db.query("DELETE FROM hd_teams WHERE name LIKE $1", [`%E2E ${stamp}%`]);
    if (leadId) {
      await db.query("DELETE FROM hd_agent_roles WHERE user_id = $1", [leadId]);
      await db.query("DELETE FROM role_assignments WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE key = 'helpdesk-agent')", [leadId]);
    }
    await db.end();
  });

  test("add a team, edit and save it, change its people, back to the list, delete it", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    // --- The list, and Add team ---
    await page.goto("/desk/settings/teams");
    await expect(page.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Add team" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add team" });
    await dialog.getByLabel("Name").fill(NAME);
    await dialog.getByLabel("Icon (optional)").fill("wallet");
    await dialog.getByRole("button", { name: "Add team" }).click();
    // Created, and its own page opens.
    await page.waitForURL(/\/desk\/settings\/teams\/\d+$/, { timeout: 120_000 });
    teamId = Number(/teams\/(\d+)$/.exec(page.url())![1]);
    await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("link", { name: "Teams", exact: true }).first()).toHaveAttribute("href", "/desk/settings/teams");
    // The rail stays on Teams.
    await expect(page.getByRole("navigation", { name: "Desk settings" }).getByRole("link", { name: /^Teams/ })).toHaveAttribute("aria-current", "page");

    // --- Edit and save through the Save row ---
    const save = page.getByRole("button", { name: "Save team" });
    await expect(save).toBeDisabled();
    await page.getByLabel("What it handles (optional)").fill("Expenses, invoices and payroll questions");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    // Leaving with unsaved changes asks first; staying keeps the edit.
    let prompts = 0;
    page.once("dialog", async (d) => {
      prompts++;
      await d.dismiss();
    });
    await page.getByRole("link", { name: "Teams", exact: true }).first().click();
    expect(prompts).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/desk/settings/teams/${teamId}$`));
    await expect(page.getByLabel("What it handles (optional)")).toHaveValue("Expenses, invoices and payroll questions");
    // A bad alias is refused in place.
    await page.getByLabel("Email alias (optional)").fill("not an address");
    await save.click();
    await expect(page.getByText("That is not an email address.")).toBeVisible();
    await page.getByLabel("Email alias (optional)").fill(`finance-${stamp}@acme.example`);
    const patched = page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/admin/teams/${teamId}`) && r.request().method() === "PATCH");
    await save.click();
    expect((await patched).status()).toBe(200);
    await expect(page.getByText("Team saved.")).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(page.getByText("Expenses, invoices and payroll questions").first()).toBeVisible();
    const row = (await db.query("SELECT name, description, icon, email_alias FROM hd_teams WHERE id = $1", [teamId])).rows[0];
    expect(row).toEqual({ name: NAME, description: "Expenses, invoices and payroll questions", icon: "wallet", email_alias: `finance-${stamp}@acme.example` });
    const audit = await db.query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_team' AND target_id = $1 ORDER BY id", [String(teamId)]);
    expect(audit.rows.map((r) => r.action)).toEqual(["helpdesk.team.created", "helpdesk.team.updated"]);

    // Everything the expanded card had is here.
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(page.getByText(`Nobody yet. Add the people who answer for ${NAME}.`)).toBeVisible();
    await expect(page.getByText(`Reply targets for ${NAME}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete team…" })).toBeVisible();

    // --- People change at once, as before ---
    await ensureUser(page, LEAD, "viewer", "Lena Lead");
    leadId = (await db.query("SELECT id FROM users WHERE username = $1", [LEAD.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [leadId]
    );
    await db.query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'team_lead') ON CONFLICT (user_id) DO UPDATE SET role = 'team_lead'", [leadId]);
    const put = await api(page, `/api/helpdesk/admin/teams/${teamId}/members`, { method: "PUT", body: { members: [{ user_id: leadId, role: "lead" }] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await page.reload();
    const role = page.getByLabel(`Role of Lena Lead in ${NAME}`);
    await expect(role).toHaveValue("lead", { timeout: 60_000 });

    // --- Back to the list: the row, then open it by keyboard ---
    await page.getByRole("link", { name: "Teams", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible();
    const teamRow = page.getByTestId("hd-team-row").filter({ hasText: NAME });
    await expect(teamRow).toContainText("1 person · Lead: Lena Lead");
    await expect(teamRow).toContainText("0 open");
    await expect(teamRow).not.toContainText("No members");
    await teamRow.getByRole("link").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/desk/settings/teams/${teamId}$`));
    await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();

    // An address from before the team pages opens the team's page.
    await page.goto(`/desk/settings/teams#team-${teamId}`);
    await page.waitForURL(new RegExp(`/desk/settings/teams/${teamId}$`), { timeout: 60_000 });

    // Nothing scrolls sideways at phone width, on either page.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`/desk/settings/teams/${teamId}`, "/desk/settings/teams"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), path).toBe(false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("a team lead reaches neither the list nor a team's page (teams.manage, as before)", async ({ browser }) => {
    test.setTimeout(300_000);
    test.skip(!teamId, "the first test did not run (unlicensed build)");
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, LEAD);
    for (const path of ["/desk/settings/teams", `/desk/settings/teams/${teamId}`]) {
      await p.goto(path);
      await expect(p.getByText("Teams is for helpdesk managers"), path).toBeVisible({ timeout: 120_000 });
    }
    expect((await api(p, "/api/helpdesk/admin/teams")).status).toBe(403);
    expect((await api(p, `/api/helpdesk/admin/teams/${teamId}`, { method: "PATCH", body: { name: "Mine now" } })).status).toBe(403);
    await ctx.close();
  });

  test("delete from the danger zone returns to the list", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!teamId, "the first test did not run (unlicensed build)");
    await login(page, ADMIN);
    await page.goto(`/desk/settings/teams/${teamId}`);
    await page.getByRole("button", { name: "Delete team…" }).click({ timeout: 120_000 });
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: `Delete ${NAME}?` });
    await expect(confirm).toContainText("Its people leave the team.");
    await confirm.getByRole("button", { name: "Delete team" }).click();
    await page.waitForURL(/\/desk\/settings\/teams$/, { timeout: 60_000 });
    await expect(page.getByText(`${NAME} deleted.`)).toBeVisible();
    await expect(page.getByTestId("hd-team-row").filter({ hasText: NAME })).toHaveCount(0);
    expect((await db.query("SELECT 1 FROM hd_teams WHERE id = $1", [teamId])).rowCount).toBe(0);
    // The team's page now says it is gone.
    await page.goto(`/desk/settings/teams/${teamId}`);
    await expect(page.getByText("This team no longer exists")).toBeVisible({ timeout: 60_000 });
  });
});
