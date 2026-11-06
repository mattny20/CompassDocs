import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The desk (1.19.0, /desk): the agents' own full-screen workspace. CI runs
// the community build, where the helpdesk is not licensed: what it can
// assert is the gate (the desk shows the house licence notice, the desk's
// routes answer 402). The licensed flow below runs on the EE rig and skips
// itself on 402: a team with the admin in it, a ticket raised from the
// desk, the split view, a reply, the status menu, the keyboard, the
// workflow builder and the settings pages.

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/counts");
  return r.status !== 402;
}

test("desk: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  for (const path of ["/api/helpdesk/counts", "/api/helpdesk/tickets", "/api/helpdesk/macros", "/api/helpdesk/admin/workflows"]) {
    expect((await api(page, path)).status, path).toBe(402);
  }
  await page.goto("/desk");
  await expect(page.getByRole("heading", { level: 1, name: "Desk" })).toBeVisible();
  await expect(page.getByText("The helpdesk is an Enterprise feature.")).toBeVisible();
  // Its own shell: no CompassDocs sidebar.
  await expect(page.locator("aside[aria-label='Sidebar']")).toHaveCount(0);
});

test.describe("desk (licensed)", () => {
  const stamp = Date.now().toString(36);
  const teamName = `E2E Desk ${stamp}`;
  let teamId = 0;
  let ticketNumber = 0;

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    if (!teamId && !ticketNumber) return;
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (ticketNumber) await api(page, `/api/helpdesk/tickets/${ticketNumber}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("the split view: open, reply, change status, keyboard", async ({ page }) => {
    const people = await api(page, "/api/users/mentionable");
    const myId = (people.body?.users as { id: number; username: string }[] | undefined)?.find((u) => u.username === ADMIN.username)?.id;
    const team = await api(page, "/api/helpdesk/admin/teams", {
      method: "POST",
      body: { name: teamName, icon: "monitor", members: myId ? [{ user_id: myId, role: "lead" }] : [] },
    });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;

    // No word the starter rules match ("VPN and network" moves those to IT):
    // the shared database may hold the starter set.
    const created = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Monitor flickers every hour ${stamp}`, body: "Since this morning.", team_id: teamId, priority: "high", requester_id: myId },
    });
    expect(created.status).toBe(201);
    ticketNumber = created.body.ticket.number;

    await page.goto(`/desk?team=${teamId}`);
    // The desk's own shell: the top bar's search and the icon rail.
    await expect(page.getByRole("combobox", { name: "Search tickets, people and documents" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Desk" })).toBeVisible();
    const row = page.getByRole("link", { name: new RegExp(`Monitor flickers every hour ${stamp}`) });
    await expect(row).toBeVisible();

    // Deep link keeps the list beside the ticket.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/desk/tickets/${ticketNumber}`));
    await expect(page.getByRole("heading", { level: 2, name: `Monitor flickers every hour ${stamp}` })).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");

    // An internal note through the composer.
    await page.getByRole("radio", { name: "Internal note" }).click();
    await page.getByRole("textbox", { name: "Internal note" }).fill(`Checked the cable ${stamp}`);
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByText(`Checked the cable ${stamp}`)).toBeVisible();
    await expect(page.getByText("Internal note").first()).toBeVisible();

    // The status pill menu.
    await page.getByRole("button", { name: /^Status: / }).click();
    await page.getByRole("menuitemradio", { name: "On hold" }).click();
    await expect(page.getByRole("button", { name: "Status: On hold" })).toBeVisible();

    // Keyboard: r focuses the reply box.
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("r");
    await expect(page.getByRole("textbox", { name: "Reply" })).toBeFocused();
  });

  test("the workflow builder adds and moves a step", async ({ page }) => {
    await page.goto("/desk/workflows");
    await expect(page.getByRole("heading", { level: 1, name: "Workflows" })).toBeVisible();
    await page.getByRole("button", { name: "New workflow" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill(`E2E flow ${stamp}`);
    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `E2E flow ${stamp}` })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Add a step at the end" }).click();
    await page.getByRole("menuitem", { name: /^Approval/ }).click();
    await page.getByRole("button", { name: "Add a step at the end" }).click();
    await page.getByRole("menuitem", { name: /^Wait/ }).click();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    // Move the wait above the approval (Finish, when there is one, must stay last: the server refuses otherwise).
    await page.getByRole("button", { name: "Move or remove Wait a day" }).click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved.")).toBeVisible({ timeout: 15_000 });

    // Clean up through the API.
    const list = await api(page, "/api/helpdesk/admin/workflows");
    const wf = (list.body.workflows as { id: number; title: string }[]).find((w) => w.title === `E2E flow ${stamp}`);
    if (wf) await api(page, `/api/helpdesk/admin/workflows/${wf.id}`, { method: "DELETE" });
  });

  test("settings pages and approvals render with their titles", async ({ page }) => {
    for (const [path, title] of [
      ["/desk/settings/teams", "Teams"],
      ["/desk/settings/request-types", "Request types"],
      ["/desk/settings/sla", "Reply targets"],
      ["/desk/settings/email", "Email"],
      ["/desk/settings/automations", "Automations"],
      ["/desk/settings/macros", "Macros"],
      ["/desk/settings/csat", "Satisfaction"],
      ["/desk/approvals", "Approvals"],
      ["/desk/setup", "Set up your helpdesk"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(title) }), path).toBeVisible();
    }
    // Nothing scrolls sideways at phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/desk/settings/teams");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(wide).toBe(false);
  });
});
