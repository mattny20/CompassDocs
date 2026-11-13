import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The desk's event calendar (1.20.6). On a ticket: the Event block's "Add an
// event" opens the dialog; saved, the block shows the time, the place and
// "Setup not complete", and the timeline says who added it. A second ticket
// at the same place and time brings the double-booking warning, with a link
// to the other ticket. The Calendar page shows the event in the week and, at
// 390px, as a list; the day sheet prints it with its tick box. Solve opens
// "Before you solve" with "Setup complete": unticked, nothing is solved;
// ticked, the ticket is solved and the block says who completed the setup.
// The API refuses to solve the other ticket with the plain sentence. A
// private feed link for the team is shown once, serves the event with no
// session, and stops working when revoked. Licensed rig only: the community
// build asserts the licence gate. Everything it makes (a team, two tickets,
// a feed link) is its own and is removed afterwards; the events are ten days
// ahead, so no reminder is ever due for them.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test("event calendar: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/calendar?from=2026-01-01&to=2026-01-07")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/admin/calendar")).status).toBe(402);
});

test.describe("event calendar (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const teamName = `E2E Events ${stamp}`;
  const place = `Boardroom ${stamp}`;
  // Ten days ahead, 14:00 to 15:30 in UTC (the rig's workspace zone).
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  let teamId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "building", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const feeds = await api(page, "/api/helpdesk/calendar/feeds");
    for (const f of feeds.body?.feeds ?? []) if (f.team_id === teamId) await api(page, `/api/helpdesk/calendar/feeds/${f.id}`, { method: "DELETE" });
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  async function newTicket(page: Page, subject: string): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "We need the room ready before the meeting starts.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    tickets.push(t.body.ticket.number);
    return t.body.ticket.number as number;
  }
  const statusOf = async (page: Page, n: number) => (await api(page, `/api/helpdesk/tickets/${n}`)).body.ticket.status as string;

  test("an event on a ticket, the double-booking warning, the Calendar and its day sheet, then Solve asks for Setup complete", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // A ticket with no event: the block offers to add one.
    const number = await newTicket(page, "Board meeting: room and video setup");
    await page.goto(`/desk/tickets/${number}`);
    const card = page.getByTestId("event-card");
    await slow(card).toBeVisible({ timeout: 120_000 });
    const dialog = page.getByTestId("event-dialog");
    // The busy dev rig may still be hydrating: click until the dialog opens.
    await expect(async () => {
      await card.getByRole("button", { name: "Add an event" }).click();
      await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await dialog.getByTestId("event-start").fill(`${day}T14:00`);
    await dialog.getByTestId("event-end").fill(`${day}T15:30`);
    await dialog.getByTestId("event-place").fill(place);
    await dialog.getByTestId("event-setup").selectOption("30");
    const [put] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}/event`) && r.request().method() === "PUT", { timeout: 120_000 }),
      dialog.getByTestId("event-save").click(),
    ]);
    expect(put.status(), JSON.stringify(await put.json())).toBe(200);
    await slow(dialog).toHaveCount(0);

    // The block: when, where, and that setup is not complete. The timeline says who added it.
    await slow(card.getByTestId("event-when")).toContainText("14:00");
    await slow(card).toContainText(place);
    await expect(card).toContainText("30 minutes before");
    await expect(card).toContainText("Setup not complete");
    await expect(card).toContainText("The ticket can't be solved until setup is complete.");
    await slow(page.getByText(/added an event: .*14:00 to 15:30/)).toBeVisible();
    const stored = (await api(page, `/api/helpdesk/tickets/${number}/event`)).body;
    expect(stored.event.starts_at).toBe(`${day}T14:00:00.000Z`);
    expect(stored.event.ends_at).toBe(`${day}T15:30:00.000Z`);
    expect(stored.event.setup_complete).toBe(false);

    // A second ticket at the same place (typed differently), overlapping: both get the warning.
    const other = await newTicket(page, "Investor call: video conferencing check");
    const clash = await api(page, `/api/helpdesk/tickets/${other}/event`, {
      method: "PUT",
      body: { starts_at: `${day}T15:00:00.000Z`, ends_at: `${day}T16:00:00.000Z`, place: `  ${place.toUpperCase()} `, setup_minutes: 15 },
    });
    expect(clash.status, JSON.stringify(clash.body)).toBe(200);
    expect(clash.body.conflicts.map((c: { number: number }) => c.number)).toEqual([number]);
    await page.reload();
    const warning = card.getByTestId("event-conflicts");
    await slow(warning).toBeVisible({ timeout: 120_000 });
    await expect(warning).toContainText("Double-booked");
    await expect(warning.getByRole("link", { name: new RegExp(`#${other}`) })).toHaveAttribute("href", new RegExp(`/desk/tickets/${other}$`));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-event-1440-light.png`, fullPage: true });

    // The Calendar: the week holds both; a click opens the ticket. Nothing here changes what the admin has saved.
    await page.goto(`/desk/calendar?view=week&date=${day}&team=${teamId}`);
    await slow(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible({ timeout: 120_000 });
    const grid = page.getByTestId("calendar-grid");
    await slow(grid).toBeVisible({ timeout: 120_000 });
    const item = grid.locator("[data-cal-item]").filter({ hasText: `#${number}` }).first();
    await slow(item).toBeVisible({ timeout: 120_000 });
    await slow(grid.locator("[data-cal-item]").filter({ hasText: `#${other}` }).first()).toBeVisible();
    await expect(page.getByTestId("calendar-team")).toHaveValue(String(teamId));
    await expect(page.getByRole("radio", { name: "Week", exact: true })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Day", "Month"]) await expect(page.getByRole("radio", { name, exact: true })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/calendar-week-1440-light.png`, fullPage: true });

    // At phone width the same week is a list.
    await page.setViewportSize({ width: 390, height: 844 });
    const list = page.getByTestId("calendar-list");
    await slow(list).toBeVisible();
    await slow(list.locator("[data-cal-item]").filter({ hasText: `#${number}` }).first()).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });

    // The day sheet for paper: a tick box, the time, the event and its place.
    await page.goto(`/desk/calendar/print?view=day&date=${day}&team=${teamId}`);
    const sheet = page.getByTestId("print-day");
    await slow(sheet).toBeVisible({ timeout: 120_000 });
    await expect(sheet).toContainText(`#${number} Board meeting: room and video setup ${stamp}`);
    await expect(sheet).toContainText(place);
    await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeVisible();

    // Back on the grid, a click opens the ticket.
    await page.goto(`/desk/calendar?view=week&date=${day}&team=${teamId}`);
    await slow(item).toBeVisible({ timeout: 120_000 });
    await expect(async () => {
      await item.click();
      await expect(page).toHaveURL(new RegExp(`/desk/tickets/${number}$`), { timeout: 5_000 });
    }).toPass({ timeout: 90_000 });

    // Solve: "Before you solve" asks for Setup complete. Unticked, nothing is solved.
    await slow(card).toBeVisible({ timeout: 120_000 });
    const solve = page.getByRole("dialog", { name: `Before you solve #${number}` });
    await expect(async () => {
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await expect(solve).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    const tick = solve.getByRole("checkbox", { name: /^Setup complete/ });
    await expect(tick).not.toBeChecked();
    await solve.getByRole("button", { name: "Solve", exact: true }).click();
    await slow(solve.getByRole("alert")).toContainText("Tick this once the setup is done.");
    expect(await statusOf(page, number)).not.toBe("solved");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/before-you-solve-setup-1440-light.png`, fullPage: false });

    // Ticked: solved in one request, and the block says who completed the setup.
    await tick.check();
    const [patched] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      solve.getByRole("button", { name: "Solve", exact: true }).click(),
    ]);
    expect(patched.status(), JSON.stringify(await patched.json())).toBe(200);
    // The busy rig can take a while to redraw the ticket after the answer.
    await slow(solve).toHaveCount(0);
    expect(await statusOf(page, number)).toBe("solved");
    await slow(card).toContainText("Setup complete");
    await expect(card).not.toContainText("Setup not complete");
    expect((await api(page, `/api/helpdesk/tickets/${number}/event`)).body.event.setup_complete).toBe(true);

    // Any other route is refused with the same plain sentence, and nothing changes.
    const refused = await api(page, `/api/helpdesk/tickets/${other}`, { method: "PATCH", body: { status: "solved" } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Before you solve, this ticket needs: the event setup marked complete.");
    expect(await statusOf(page, other)).not.toBe("solved");
  });

  test("Calendar settings: the reminders, and a private feed link that is shown once, works with no session and stops when revoked", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const other = tickets[1];
    test.skip(!other, "the first test made the tickets");

    await page.goto("/desk/settings/event-calendar");
    await slow(page.getByRole("heading", { level: 1, name: "Event calendar" })).toBeVisible({ timeout: 120_000 });
    await slow(page.getByRole("link", { name: /^Event calendar/ })).toHaveAttribute("aria-current", "page");
    const reminders = page.getByTestId("calendar-reminders");
    await slow(reminders).toBeVisible({ timeout: 120_000 });
    // Out of the box: a day and an hour before. Nothing is saved by this test.
    await expect(reminders.getByTestId("lead-1440")).toBeChecked();
    await expect(reminders.getByTestId("lead-60")).toBeChecked();
    await expect(reminders.getByTestId("lead-15")).not.toBeChecked();

    // A link for this run's team: shown once.
    const create = page.getByTestId(`feed-create-${teamId}`);
    await slow(create).toBeVisible({ timeout: 120_000 });
    const url = page.getByTestId("feed-url");
    await expect(async () => {
      if (!(await url.isVisible())) await create.click();
      await expect(url).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
    const link = ((await url.textContent()) ?? "").trim();
    expect(link).toMatch(/\/api\/helpdesk\/calendar\/feed\/cdf_[A-Za-z0-9_-]{20,}\.ics$/);
    await slow(page.getByText("Copy the link now. It won't be shown again.")).toBeVisible();

    // No session: the calendar app's request. The event is there; the requester's words are not.
    const path = new URL(link).pathname;
    const fetchFeed = () =>
      page.evaluate(async (p) => {
        const res = await fetch(p, { credentials: "omit", cache: "no-store" });
        return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
      }, path);
    const feed = await fetchFeed();
    expect(feed.status).toBe(200);
    expect(feed.type).toContain("text/calendar");
    expect(feed.body).toContain("BEGIN:VCALENDAR");
    expect(feed.body).toContain(`#${other} Investor call`);
    expect(feed.body).not.toContain("We need the room ready");
    // A wrong link says nothing about why.
    const wrong = await page.evaluate(async (p) => (await fetch(p.replace(/.{6}\.ics$/, "AAAAAA.ics"), { credentials: "omit" })).status, path);
    expect(wrong).toBe(404);

    // Closed, the list keeps only its last characters; revoked, the link is dead.
    await page.getByRole("button", { name: "Done" }).click();
    await slow(url).toHaveCount(0);
    const mine = (await api(page, "/api/helpdesk/calendar/feeds")).body.feeds.find((f: { team_id: number | null }) => f.team_id === teamId);
    expect(mine, "the link is listed").toBeTruthy();
    expect(JSON.stringify(mine)).not.toContain(link.slice(-20, -4));
    await page.getByRole("button", { name: `Revoke the ${teamName} link` }).click();
    const [gone] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/calendar/feeds/${mine.id}`) && r.request().method() === "DELETE", { timeout: 120_000 }),
      page.getByRole("button", { name: "Revoke link" }).click(),
    ]);
    expect(gone.status()).toBe(200);
    expect((await fetchFeed()).status).toBe(404);
  });
});
