import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Recurring tickets and time tracking (1.19.1, agent V8). Recurring: Desk
// settings → Recurring tickets, a new weekly schedule with the next three
// dates previewed, Open one now (a ticket from source "recurring"), delete.
// Time: the ticket's Time card, Start and Stop the timer, Log time with
// hours, minutes and a note, the total, and the CSV export. CI's community
// build asserts the licence gate; the licensed flow runs on the EE rig and
// skips itself on 402. Everything it makes (a team, its tickets and
// schedules) is its own and is deleted afterwards.

// The dev rig compiles routes on first use: give each UI step room.
const slow = expect.configure({ timeout: 60_000 });

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/recurring")).status !== 402;
}

test("recurring and time: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/recurring")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/time/timer")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/time/export")).status).toBe(402);
});

test.describe("recurring tickets and time (licensed)", () => {
  const stamp = Date.now().toString(36);
  const teamName = `E2E Recurring ${stamp}`;
  let teamId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const list = await api(page, "/api/helpdesk/admin/recurring");
    for (const s of list.body?.schedules ?? []) if (s.team_id === teamId) await api(page, `/api/helpdesk/admin/recurring/${s.id}`, { method: "DELETE" });
    const opened = await api(page, `/api/helpdesk/tickets?view=all&team=${teamId}`);
    for (const t of opened.body?.tickets ?? []) tickets.push(t.number);
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("a weekly schedule: preview, save, open one now, delete", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/desk/settings/recurring");
    await slow(page.getByRole("heading", { level: 1, name: "Recurring tickets" })).toBeVisible({ timeout: 60_000 });
    await slow(page.getByRole("link", { name: "Recurring tickets" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "New schedule" }).first().click();

    const editor = page.getByRole("region", { name: "New schedule" });
    await editor.getByLabel("Subject").fill(`Fire alarm test {{date}} ${stamp}`);
    await editor.getByRole("combobox", { name: /^Team/ }).selectOption({ label: teamName });
    await editor.getByRole("radio", { name: "Weekly" }).click();
    await editor.getByRole("checkbox", { name: "Friday" }).check();
    await editor.getByRole("checkbox", { name: "Monday" }).uncheck();
    await slow(editor.getByTestId("recurring-preview")).toHaveText(/^Next three: Fri \w{3} \d+ · Fri \w{3} \d+ · Fri \w{3} \d+/, { timeout: 15_000 });
    await editor.getByLabel("Due").selectOption({ label: "Due in 3 business days" });
    await editor.getByRole("button", { name: "Save" }).click();
    await slow(page.getByText("Schedule created.")).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: `Fire alarm test ${stamp}` });
    await slow(row).toContainText(`${teamName} · every Friday 09:00`);
    await slow(row.getByRole("button")).toHaveAttribute("aria-current", "true");

    // Open one now: a ticket straight away, through the usual create path.
    const edit = page.getByRole("region", { name: `Edit Fire alarm test ${stamp}` });
    const [res] = await Promise.all([
      page.waitForResponse((r) => /\/api\/helpdesk\/admin\/recurring\/\d+\/run$/.test(r.url()) && r.request().method() === "POST", { timeout: 120_000 }),
      edit.getByRole("button", { name: "Open one now" }).click(),
    ]);
    expect(res.status()).toBe(201);
    const number = (await res.json()).ticket.number as number;
    await slow(page.getByText(`Opened #${number}.`)).toBeVisible();
    tickets.push(number);
    const t = await api(page, `/api/helpdesk/tickets/${number}`);
    expect(t.status).toBe(200);
    const ticket = t.body.ticket ?? t.body.detail?.ticket;
    expect(ticket.source).toBe("recurring");
    expect(ticket.team_id).toBe(teamId);
    expect(ticket.subject).toMatch(new RegExp(`^Fire alarm test \\w{3} \\d+ \\w{3} \\d{4} ${stamp}$`));

    // Delete it (the ticket it opened stays).
    await edit.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete schedule" }).click();
    await slow(page.getByText("Schedule deleted.")).toBeVisible();
    await slow(page.getByRole("row").filter({ hasText: `Fire alarm test ${stamp}` })).toHaveCount(0);
    expect((await api(page, `/api/helpdesk/tickets/${number}`)).status).toBe(200);
  });

  test("the Time card: start and stop the timer, log time, the total; the CSV export", async ({ page }) => {
    test.setTimeout(300_000);
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Time e2e ${stamp}`, body: "From the time spec.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const number = t.body.ticket.number as number;
    tickets.push(number);
    // A timer left running elsewhere by an earlier run would move here; start clean.
    const mine = await api(page, "/api/helpdesk/time/timer");
    if (mine.body?.timer) await api(page, `/api/helpdesk/tickets/${mine.body.timer.ticket_number}/time/timer`, { method: "DELETE", body: {} });

    await page.goto(`/desk/tickets/${number}`);
    const card = page.getByTestId("time-card");
    await slow(card.getByRole("heading", { name: "Time" })).toBeVisible({ timeout: 60_000 });
    await slow(card.getByText("No time logged yet.")).toBeVisible();

    await card.getByRole("button", { name: "Start" }).click();
    await slow(card.getByText("Timer running · you")).toBeVisible();
    await slow(card.getByRole("timer")).toHaveText(/^00:00:0[1-9]$/, { timeout: 10_000 });
    await card.getByRole("button", { name: "Stop" }).click();
    await slow(page.getByText("Logged 1m.")).toBeVisible();
    await slow(card.getByTestId("time-total")).toHaveText("1m");

    await card.getByRole("button", { name: "Log time" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Hours").fill("1");
    await dialog.getByLabel("Minutes").fill("5");
    await dialog.getByLabel("Note").fill("investigation");
    await dialog.getByRole("button", { name: "Log time" }).click();
    await slow(page.getByText("Logged 1h 5m.")).toBeVisible();
    await slow(card.getByTestId("time-total")).toHaveText("1h 6m");
    await slow(card.getByRole("list", { name: "Time logged" })).toContainText("You · investigation");

    // The export: one CSV row per entry, for the team.
    const csv = await page.evaluate(async (team) => {
      const r = await fetch(`/api/helpdesk/time/export?team=${team}`);
      return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
    }, teamId);
    expect(csv.status).toBe(200);
    expect(csv.type).toContain("text/csv");
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toContain('"Minutes","Hours","Note","Source"');
    expect(lines.length).toBe(3);
    expect(csv.text).toContain('"investigation","Manual"');

    // Reports: a Time logged widget carries Export, the same CSV for its dates and filters.
    const dash = await api(page, "/api/helpdesk/analytics/dashboards", {
      method: "POST",
      body: {
        name: `Time e2e ${stamp}`,
        visibility: "private",
        layout: {
          widgets: [{ id: "time", type: "kpi", title: "Time logged", measure: "time_logged", groupBy: [], filters: { team: [teamId] }, size: 2 }],
          filters: {},
          range: { preset: "last_7" },
          compare: null,
        },
      },
    });
    expect(dash.status, JSON.stringify(dash.body)).toBe(201);
    const dashId = dash.body.dashboard.id as number;
    try {
      await page.goto(`/desk/reports?d=${dashId}`);
      const widget = page.locator('[data-widget="time"]');
      const exp = widget.getByRole("button", { name: "Export time entries for Time logged" });
      await slow(exp).toBeVisible({ timeout: 60_000 });
      await expect(exp).toHaveAttribute("data-tt", /time entries for this period as CSV/);
      await expect(exp).not.toHaveAttribute("title", /.*/);
      const [download] = await Promise.all([page.waitForEvent("download"), exp.click()]);
      expect(download.suggestedFilename()).toMatch(/^helpdesk-time-\d{4}-\d{2}-\d{2}\.csv$/);
      const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
      expect(text).toContain('"investigation","Manual"');
      expect(text.trim().split("\r\n").length).toBe(3);
    } finally {
      await api(page, `/api/helpdesk/analytics/dashboards/${dashId}`, { method: "DELETE" });
    }
  });

  // 1.19.1 integration: "Send and set Solved" in the composer asks for time as Solve and `e` do.
  test("Send and set Solved asks for time when the team asks for it; Cancel sends nothing", async ({ page }) => {
    test.setTimeout(300_000);
    expect((await api(page, `/api/helpdesk/admin/teams/${teamId}/time`, { method: "PATCH", body: { ask_time_on_solve: true } })).status).toBe(200);
    try {
      const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Send-solve e2e ${stamp}`, body: "From the time spec.", team_id: teamId, priority: "normal" } });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      const number = t.body.ticket.number as number;
      tickets.push(number);
      const mine = await api(page, "/api/helpdesk/time/timer");
      if (mine.body?.timer) await api(page, `/api/helpdesk/tickets/${mine.body.timer.ticket_number}/time/timer`, { method: "DELETE", body: {} });

      await page.goto(`/desk/tickets/${number}`);
      const composer = page.getByRole("region", { name: "Reply" });
      await slow(composer).toBeVisible({ timeout: 60_000 });
      await composer.getByRole("radio", { name: "Internal note" }).click();
      await composer.getByRole("textbox").fill("Fixed the printer queue.");
      const openMenu = async () => {
        await composer.getByRole("button", { name: /and set the status$/ }).click();
        await page.getByRole("menuitem", { name: "Add note and set Solved" }).click();
      };

      // Cancel: nothing is posted and the text stays.
      await openMenu();
      const dialog = page.getByRole("dialog", { name: "Log your time before solving?" });
      await slow(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(composer.getByRole("textbox")).toHaveValue("Fixed the printer queue.");
      expect((await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.status).not.toBe("solved");

      // Log 10 minutes and solve.
      await openMenu();
      await slow(dialog).toBeVisible();
      await dialog.getByLabel("Minutes").fill("10");
      await dialog.getByRole("button", { name: "Solve" }).click();
      await slow(page.getByText("Note added.")).toBeVisible();
      await expect.poll(async () => (await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.status, { timeout: 30_000 }).toBe("solved");
      await slow(page.getByTestId("time-card").getByTestId("time-total")).toHaveText("10m");
    } finally {
      await api(page, `/api/helpdesk/admin/teams/${teamId}/time`, { method: "PATCH", body: { ask_time_on_solve: false } });
    }
  });
});
