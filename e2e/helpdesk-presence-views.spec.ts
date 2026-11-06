import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Collision warnings and saved views (1.19.1, agent V4). Licensed only (the
// EE rig); skips itself on 402.
//   presence    a second agent, in a second browser context, opens the same
//               ticket: the first sees "Sam Lee is viewing", then "is
//               replying" while Sam types.
//   collision   the admin types a reply, Sam sends one first: the admin's
//               Send opens "Sam Lee replied while you were typing", nothing
//               is sent until Send anyway.
//   saved view  filter the team's list, save it for the team, open it from
//               the views column with its count.
// Everything is stamped and removed afterwards. E2E_SHOTS_DIR (optional)
// keeps screenshots, light and dark.

const SAM = { username: "e2e_hd_sam", password: "E2eSamLee!12345" };
const SHOTS = process.env.E2E_SHOTS_DIR;
// Route compiles and a shared rig make single requests slow: assertions wait longer.
const see = expect.configure({ timeout: 20_000 });

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("presence and saved views (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const stamp = Date.now().toString(36);
  let teamId = 0;
  let ticketNumber = 0;
  let samId = 0;
  const viewIds: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const id of viewIds) await api(page, `/api/helpdesk/views/${id}`, { method: "DELETE" });
    if (ticketNumber) await api(page, `/api/helpdesk/tickets/${ticketNumber}`, { method: "DELETE" });
    if (samId) await api(page, `/api/helpdesk/admin/agents/${samId}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("a second agent shows as viewing and replying; Send warns about their reply", async ({ page, browser }) => {
    test.setTimeout(300_000);
    const people = await api(page, "/api/users/mentionable");
    const users = people.body.users as { id: number; username: string }[];
    const myId = users.find((u) => u.username === ADMIN.username)!.id;
    await ensureUser(page, SAM, "viewer", "Sam Lee");
    samId = ((await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[]).find((u) => u.username === SAM.username)!.id;

    const team = await api(page, "/api/helpdesk/admin/teams", {
      method: "POST",
      body: { name: `E2E Presence ${stamp}`, icon: "monitor", members: [{ user_id: myId, role: "lead" }] },
    });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    await api(page, `/api/helpdesk/admin/agents/${samId}`, { method: "DELETE" });
    const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: samId, role: "agent", team_ids: [teamId] } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const created = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Laptop won't connect from home ${stamp}`, body: "It works in the office.", team_id: teamId, priority: "high", requester_id: myId },
    });
    expect(created.status).toBe(201);
    ticketNumber = created.body.ticket.number;

    // Sam, in a browser of their own, opens the ticket.
    const samCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sam = await samCtx.newPage();
    await login(sam, SAM);
    await sam.goto(`/desk/tickets/${ticketNumber}?team=${teamId}`);
    await see(sam.getByRole("heading", { level: 2, name: new RegExp(`Laptop won't connect from home ${stamp}`) })).toBeVisible({ timeout: 60_000 });

    await page.goto(`/desk/tickets/${ticketNumber}?team=${teamId}`);
    const presence = page.getByTestId("ticket-presence");
    await see(presence).toContainText("Sam Lee is viewing", { timeout: 60_000 });
    await shot(page, "presence-viewing");

    // Sam types: "is replying".
    const samBox = sam.getByRole("textbox", { name: "Reply" });
    await samBox.click();
    await samBox.pressSequentially("Hi, I've reset your VPN token from our side.", { delay: 5 });
    await see(presence).toContainText("Sam Lee is replying", { timeout: 45_000 });

    // The admin starts a reply, then Sam sends first.
    const box = page.getByRole("textbox", { name: "Reply" });
    await box.click();
    await box.pressSequentially("Could you try re-pairing the VPN client?", { delay: 5 });
    await shot(page, "presence-replying");
    await sam.getByRole("button", { name: "Send", exact: true }).click();
    await see(sam.getByText("Reply sent.")).toBeVisible({ timeout: 60_000 });

    const posted: number[] = [];
    page.on("response", (r) => {
      if (r.url().endsWith(`/api/helpdesk/tickets/${ticketNumber}/messages`) && r.request().method() === "POST") posted.push(r.status());
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sam Lee replied while you were typing" });
    await see(dialog).toBeVisible();
    await see(dialog).toContainText("I've reset your VPN token");
    await see(dialog).toContainText("Your reply hasn't been sent.");
    await see.poll(() => posted, { timeout: 60_000 }).toEqual([409]);
    await shot(page, "collision-dialog");

    // Keep editing: the draft stays; the same message doesn't warn again.
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await see(dialog).toBeHidden();
    await see(box).toHaveValue("Could you try re-pairing the VPN client?");
    // Sam's reply is in the conversation now.
    await see(page.getByText("Hi, I've reset your VPN token from our side.")).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await see.poll(() => posted, { timeout: 60_000 }).toEqual([409, 201]);

    // Send anyway: Sam replies again while the admin types.
    await box.click();
    await box.pressSequentially("One more thing.", { delay: 5 });
    await samBox.click();
    await samBox.pressSequentially("Signing off now.", { delay: 5 });
    const samPosts: number[] = [];
    sam.on("response", (r) => {
      if (r.url().endsWith(`/api/helpdesk/tickets/${ticketNumber}/messages`) && r.request().method() === "POST") samPosts.push(r.status());
    });
    await sam.getByRole("button", { name: "Send", exact: true }).click();
    await see.poll(() => samPosts.length, { timeout: 60_000 }).toBe(1);
    // Sam's pane may not show the admin's reply yet: then Sam is warned too.
    if (samPosts[0] === 409) {
      await sam.getByRole("dialog", { name: /replied while you were typing/ }).getByRole("button", { name: "Send anyway" }).click();
      await see.poll(() => samPosts, { timeout: 60_000 }).toEqual([409, 201]);
    } else expect(samPosts).toEqual([201]);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await see(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Send anyway" }).click();
    await see(dialog).toBeHidden();
    await see.poll(() => posted, { timeout: 60_000 }).toEqual([409, 201, 409, 201]);

    // Sam leaves: the line goes.
    await sam.close();
    await samCtx.close();
    await see(presence).toHaveCount(0, { timeout: 45_000 });
  });

  test("filter a list, save it for the team, open it from the views column", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!teamId || !ticketNumber, "needs the first test's team and ticket");
    await page.goto(`/desk?team=${teamId}`);
    await page.getByRole("button", { name: "Filter tickets" }).click();
    const filter = page.getByRole("dialog", { name: "Filter tickets" });
    await filter.getByLabel("Start from").selectOption("all");
    await filter.getByLabel("Contains").fill(stamp);
    await filter.getByLabel("Status").selectOption("group:open");
    await filter.getByRole("button", { name: "Show list" }).click();
    await see(page).toHaveURL(/from=filter/);
    await see(page.getByText(`Filtered: Contains "${stamp}"`)).toBeVisible();
    await see(page.getByRole("link", { name: new RegExp(`Laptop won't connect from home ${stamp}`) })).toBeVisible();

    await page.getByRole("button", { name: "Save view" }).click();
    const save = page.getByRole("dialog", { name: "Save this view" });
    await see(save).toContainText(`Contains "${stamp}"`);
    await see(save).toContainText("Not solved");
    await save.getByLabel("Name").fill(`VPN this week ${stamp}`);
    // Up to two teams are cards of their own; more (an admin) is "A team" and a picker.
    const own = save.getByRole("radio", { name: `E2E Presence ${stamp}` });
    if (await own.count()) await own.check();
    else {
      await save.getByRole("radio", { name: "A team" }).check();
      await save.getByRole("combobox").selectOption({ label: `E2E Presence ${stamp}` });
    }
    await shot(page, "save-view-dialog");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/views") && r.request().method() === "POST");
    await save.getByRole("button", { name: "Save view" }).click();
    const res = await saved;
    expect(res.status()).toBe(201);
    const id = (await res.json()).view.id as number;
    viewIds.push(id);
    await see(page).toHaveURL(new RegExp(`saved=${id}`));

    const nav = page.getByRole("navigation", { name: "Ticket views" });
    await see(nav.getByText(`E2E Presence ${stamp} views`)).toBeVisible();
    const link = nav.getByRole("link", { name: new RegExp(`VPN this week ${stamp}`) });
    await see(link).toHaveAttribute("aria-current", "page");
    await see(link).toContainText(/1\s*tickets/);
    await see(page.getByRole("heading", { level: 2, name: new RegExp(`VPN this week ${stamp}`) })).toBeVisible();
    await shot(page, "saved-view-open");

    // From another list, the view opens from the column; its row menu is keyboard reachable.
    await page.goto("/desk");
    await nav.getByRole("link", { name: new RegExp(`VPN this week ${stamp}`) }).click();
    await see(page).toHaveURL(new RegExp(`saved=${id}`));
    await see(page.getByRole("link", { name: new RegExp(`Laptop won't connect from home ${stamp}`) })).toBeVisible();
    const menuBtn = nav.getByRole("button", { name: `Actions for the view VPN this week ${stamp}` });
    await menuBtn.focus();
    await page.keyboard.press("Enter");
    await see(page.getByRole("menuitem", { name: "Rename…" })).toBeFocused();
    await page.keyboard.press("Escape");
  });
});
