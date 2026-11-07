import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Desk reports (1.19.0, /desk/reports): the built-in Overview, the filter
// bar in the address, building a widget in Edit mode (gallery, side panel,
// save), the drill-down into the queue, Explore, and the CSV export. CI's
// community build asserts the licence gate; the licensed flow runs on the
// EE rig and skips itself on 402. Everything it makes is its own (a team,
// two tickets, a dashboard) and is deleted afterwards.

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/analytics/dashboards");
  return r.status !== 402;
}

test("reports: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  for (const path of ["/api/helpdesk/analytics/dashboards", "/api/helpdesk/analytics/options", "/api/helpdesk/analytics/schedules"]) {
    expect((await api(page, path)).status, path).toBe(402);
  }
  expect((await api(page, "/api/helpdesk/analytics/query", { method: "POST", body: { measure: "created" } })).status).toBe(402);
});

test.describe("reports (licensed)", () => {
  const stamp = Date.now().toString(36);
  const teamName = `E2E Reports ${stamp}`;
  let teamId = 0;
  const tickets: number[] = [];
  const dashboards: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const id of dashboards) await api(page, `/api/helpdesk/analytics/dashboards/${id}`, { method: "DELETE" });
    for (const n of tickets) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("overview, filters in the address, build a widget, drill down, explore, export", async ({ page }) => {
    test.setTimeout(180_000);
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    for (const [subject, priority] of [
      [`Reports e2e high ${stamp}`, "high"],
      [`Reports e2e normal ${stamp}`, "normal"],
    ]) {
      const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject, body: "From the reports spec.", team_id: teamId, priority } });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      tickets.push(t.body.ticket.number);
    }

    // The default dashboard: Overview, built in, with the filter bar.
    await page.goto("/desk/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Overview/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Tickets created", exact: true })).toBeVisible();

    // Filter to the spec's team: the view travels in the address.
    await page.getByRole("button", { name: /^Team/ }).first().click();
    await page.getByRole("menuitemcheckbox", { name: teamName }).click();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`team=${teamId}`));
    const created = page.locator("section[data-widget]").filter({ has: page.getByRole("heading", { name: "Tickets created", exact: true }) });
    await expect(created.locator("p.text-3xl")).toHaveText("2");
    // The link reopens the same view.
    await page.reload();
    await expect(created.locator("p.text-3xl")).toHaveText("2");

    // A built-in is a template: duplicate it to edit, then add a widget from the gallery.
    await page.getByRole("button", { name: "Duplicate to edit" }).click();
    await expect(page.getByText(/Editing Overview \(copy\)/)).toBeVisible({ timeout: 15_000 });
    dashboards.push(Number(new URL(page.url()).searchParams.get("d")));
    await page.getByRole("button", { name: "Add widget" }).first().click();
    await expect(page.getByRole("heading", { name: "Add a widget" })).toBeVisible();
    await page.getByRole("button", { name: "Add ranked bars" }).click();
    // Exactly one side panel, and the gallery gone, before typing into it. A second pick before
    // the gallery closed could re-key the panel mid-edit; the pick is idempotent now (1.19.4).
    await expect(page.getByRole("heading", { name: "Add a widget" })).toBeHidden();
    const panel = page.getByRole("dialog", { name: "Configure widget" });
    await expect(panel).toHaveCount(1);
    await expect(panel).toBeVisible();
    await panel.getByLabel("Title").fill(`By priority ${stamp}`);
    await panel.getByLabel("Split by").selectOption("priority");
    await expect(panel.getByRole("button", { name: /^High: / })).toBeVisible(); // the live preview
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Dashboard saved.")).toBeVisible();
    const mine = page.locator("section[data-widget]").filter({ has: page.getByRole("heading", { name: `By priority ${stamp}` }) });
    await expect(mine).toBeVisible();

    // Keyboard reordering is there in Edit mode.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("button", { name: `Move By priority ${stamp} earlier` })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel" }).click();

    // Export the dashboard as CSV.
    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Dashboard as CSV" }).click()]);
    const csv = await (await download.createReadStream())!.toArray();
    expect(Buffer.concat(csv).toString("utf8")).toContain(`By priority ${stamp}`);

    // Drill down: the High bar opens those tickets in the queue.
    await mine.getByRole("button", { name: /^High: 1\. Open these tickets/ }).click();
    await expect(page).toHaveURL(/\/desk\?from=reports.*priority=high/);
    await expect(page).toHaveURL(new RegExp(`team=${teamId}`));

    // Explore: any measure by any split, chart and table.
    await page.goto(`/desk/reports/explore`);
    await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
    // Scoped to the question's controls: an unscoped getByLabel("Measure") once resolved to two
    // elements under load (1.19.3 CI). Locators here are scoped to the dialog or the group.
    const question = page.getByRole("group", { name: "Question" });
    await expect(question).toHaveCount(1);
    await question.getByLabel("Measure").selectOption("created");
    await question.getByLabel("Split by").selectOption("priority");
    await expect(page.getByRole("heading", { name: "The numbers" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to dashboard" })).toBeVisible();
  });
});
