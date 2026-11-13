import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// "Before you solve" requirement sets (1.20.5). Desk settings → Before you
// solve: a new set for one team that asks for an owner, a category and two closing
// fields. On a ticket of that team: Solve opens the "Before you solve" dialog
// and changes nothing; Cancel leaves the ticket open and the typed reply in
// the composer; "Send and set Solved" opens it too and sends nothing when
// cancelled; filled in, the ticket is solved in one request and the side
// panel shows the answers under Solve details. Then a second ticket through
// "Send and solve": the reply is sent and the ticket solved together. A team
// with no set solves with no dialog, as before. Licensed rig only: the
// community build asserts the licence gate. Everything it makes (a team, a
// set, tickets) is its own and is deleted afterwards; the set is scoped to
// its own team, so no other run's tickets are ever asked.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const SETTINGS = "/desk/settings/before-you-solve";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test("before you solve: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/solve-requirements")).status).toBe(402);
});

test.describe("before you solve (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const teamName = `E2E Solve ${stamp}`;
  const otherTeamName = `E2E Solve other ${stamp}`;
  const setName = `Closing details ${stamp}`;
  // 1.20.6: a category is picked from the desk admin's list (Desk settings → Categories); this run's own entry.
  const NETWORK = `Network ${stamp}`;
  let teamId = 0;
  let otherTeamId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
      const other = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: otherTeamName, icon: "monitor", members: [] } });
      expect(other.status, JSON.stringify(other.body)).toBe(201);
      otherTeamId = other.body.team.id;
      const category = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: NETWORK } });
      expect(category.status, JSON.stringify(category.body)).toBe(201);
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    // The sets first: one left on would keep asking this team's tickets.
    const list = await api(page, "/api/helpdesk/admin/solve-requirements");
    for (const s of list.body?.sets ?? []) if (String(s.name).includes(stamp)) await api(page, `/api/helpdesk/admin/solve-requirements/${s.id}`, { method: "DELETE" });
    for (const n of new Set(tickets)) {
      // A ticket in the recycle bin still has its category: clear it, so the category below is unused.
      await api(page, `/api/helpdesk/tickets/${n}`, { method: "PATCH", body: { category: "" } });
      await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    }
    const categories = await api(page, "/api/helpdesk/admin/categories");
    for (const c of categories.body?.categories ?? []) if (String(c.name).includes(stamp)) await api(page, `/api/helpdesk/admin/categories/${c.id}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    if (otherTeamId) await api(page, `/api/helpdesk/admin/teams/${otherTeamId}`, { method: "DELETE" });
    await page.close();
  });

  async function newTicket(page: Page, subject: string, team: number): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "I can't connect from home since this morning.", team_id: team, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    tickets.push(t.body.ticket.number);
    return t.body.ticket.number as number;
  }
  const statusOf = async (page: Page, n: number) => (await api(page, `/api/helpdesk/tickets/${n}`)).body.ticket.status as string;

  test("a requirement set in Desk settings; Solve opens the dialog; the typed reply survives a cancel; filled in, it solves and the side panel shows the answers", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Desk settings → Before you solve: a new set.
    await page.goto(SETTINGS);
    await slow(page.getByRole("heading", { level: 1, name: "Before you solve" })).toBeVisible({ timeout: 120_000 });
    await slow(page.getByRole("link", { name: /^Before you solve/ })).toHaveAttribute("aria-current", "page");
    const create = page.getByRole("dialog", { name: "New requirement set" });
    // The busy dev rig may still be hydrating: click until the dialog opens.
    await expect(async () => {
      await page.getByRole("button", { name: "New requirement set" }).first().click();
      await expect(create).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await create.getByLabel("Name").fill(setName);
    const [made] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/solve-requirements") && r.request().method() === "POST", { timeout: 120_000 }),
      create.getByRole("button", { name: "Create set" }).click(),
    ]);
    expect(made.status()).toBe(201);
    const setId = (await made.json()).set.id as number;
    await page.waitForURL(new RegExp(`${SETTINGS}/${setId}$`), { timeout: 120_000 });
    await slow(page.getByRole("heading", { level: 1, name: setName })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("link", { name: /^Before you solve/ }).first()).toBeVisible();

    // Its scope, the ticket fields it requires, two closing fields, then on.
    await expect(async () => {
      await page.getByRole("radio", { name: "Chosen teams and request types" }).click();
      await expect(page.getByRole("group", { name: "Teams" })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole("group", { name: "Teams" }).getByLabel(teamName, { exact: true }).check();
    const onTicket = page.getByTestId("solve-ticket-fields");
    await onTicket.getByLabel(/^An owner/).check();
    await onTicket.getByLabel(/^A category/).check();
    await expect(onTicket.getByLabel(/^Time logged/)).toBeVisible();
    await page.getByRole("button", { name: "Add field" }).click();
    await page.getByRole("textbox", { name: "Field 1", exact: true }).fill("Resolution code");
    await page.getByRole("group", { name: "Field 1" }).getByLabel("Kind of answer").selectOption({ label: "Pick one (cards)" });
    await page.getByRole("textbox", { name: "Option 1 of field 1", exact: true }).fill("Fixed");
    await page.getByRole("group", { name: "Field 1" }).getByRole("button", { name: "Add option" }).click();
    await page.getByRole("textbox", { name: "Option 2 of field 1", exact: true }).fill("Workaround given");
    await page.getByRole("group", { name: "Field 1" }).getByLabel(/^Required/).check();
    await page.getByRole("button", { name: "Add field" }).click();
    await page.getByRole("textbox", { name: "Field 2", exact: true }).fill("Root cause");
    await page.getByRole("group", { name: "Field 2" }).getByLabel("Kind of answer").selectOption({ label: "Long answer" });
    await page.getByRole("group", { name: "Field 2" }).getByLabel(/^Required/).check();
    await page.getByRole("switch", { name: "On" }).click();
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/admin/solve-requirements/${setId}`) && r.request().method() === "PUT", { timeout: 120_000 }),
      page.getByRole("button", { name: "Save requirement set" }).click(),
    ]);
    expect(saved.status(), JSON.stringify(await saved.json())).toBe(200);
    const stored = (await api(page, "/api/helpdesk/admin/solve-requirements")).body.sets.find((s: { id: number }) => s.id === setId);
    expect(stored.enabled).toBe(true);
    expect(stored.team_ids).toEqual([teamId]);
    expect(stored.ticket_fields).toEqual(["assignee", "category"]);
    expect(stored.fields.map((f: { key: string; type: string; required?: boolean }) => [f.key, f.type, !!f.required])).toEqual([
      ["resolution_code", "choice", true],
      ["root_cause", "textarea", true],
    ]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-before-you-solve-set-1440-light.png`, fullPage: true });

    // The list names it, On, with its scope.
    await page.goto(SETTINGS);
    const row = page.getByTestId("hd-solve-set-row").filter({ hasText: setName });
    await slow(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toContainText("On");
    await expect(row).toContainText(teamName);
    await expect(row).toContainText("2 ticket fields · 2 closing fields");

    // A ticket of that team: the reply is typed, then Solve.
    const number = await newTicket(page, "Laptop won't connect to VPN from home", teamId);
    await page.goto(`/desk/tickets/${number}`);
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    await slow(reply).toBeVisible({ timeout: 120_000 });
    const TEXT = "I've renewed the VPN profile on your laptop. Please try again.";
    await expect(async () => {
      await reply.fill(TEXT);
      await expect(reply).toHaveValue(TEXT, { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: `Before you solve #${number}` });
    let patches = 0;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().endsWith(`/api/helpdesk/tickets/${number}`)) patches++;
    });
    await expect(async () => {
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(dialog.getByRole("combobox", { name: "Owner" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Category" })).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Resolution code" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Root cause" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-before-you-solve-1440-light.png`, fullPage: false });

    // Cancel: nothing changed, and the typed reply is still there.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reply).toHaveValue(TEXT);
    expect(patches, "the dialog opened before any request to change the ticket").toBe(0);
    expect(await statusOf(page, number)).toBe("new");

    // Send and set Solved opens it too; cancelled, nothing is sent and the text stays.
    await page.getByRole("button", { name: "Send and set the status" }).click();
    await page.getByRole("menuitem", { name: "Send and set Solved" }).click();
    await slow(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send and solve" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reply).toHaveValue(TEXT);
    const before = (await api(page, `/api/helpdesk/tickets/${number}`)).body;
    expect(before.ticket.status).toBe("new");
    expect(before.messages.filter((m: { kind: string; body: string }) => m.kind === "public" && m.body === TEXT)).toHaveLength(0);

    // Solve again: submitting empty says what is needed, in the dialog.
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await slow(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Solve", exact: true }).click();
    await expect(dialog.getByText("Pick an owner.")).toBeVisible();
    await expect(dialog.getByText("Pick a category.")).toBeVisible();
    await expect(dialog.getByText("Pick one.")).toBeVisible();
    await expect(dialog.getByText("This is needed.")).toBeVisible();
    expect(await statusOf(page, number)).toBe("new");

    // Fill it in and solve: one PATCH carries the owner, the category, the answers and the status.
    const owner = dialog.getByRole("combobox", { name: "Owner" });
    await expect(owner.locator("option", { hasText: "(you)" })).toHaveCount(1, { timeout: 60_000 });
    await owner.selectOption({ label: await owner.locator("option", { hasText: "(you)" }).innerText() });
    await dialog.getByRole("combobox", { name: "Category" }).selectOption({ label: NETWORK });
    await dialog.getByRole("radio", { name: /^Fixed/ }).check();
    await dialog.getByRole("textbox", { name: "Root cause" }).fill("The VPN profile on the laptop had expired.");
    const [solved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      dialog.getByRole("button", { name: "Solve", exact: true }).click(),
    ]);
    expect(solved.status(), JSON.stringify(await solved.json())).toBe(200);
    const sent = solved.request().postDataJSON();
    expect(sent.status).toBe("solved");
    expect(sent.category).toBe(NETWORK);
    expect(Object.keys(sent.solve_answers).sort()).toEqual([`${setId}:resolution_code`, `${setId}:root_cause`]);

    // The desk may move on to the next ticket after a solve: read from a page that stays put.
    const probe = await page.context().newPage();
    await probe.goto(`/desk/tickets/${number}`);
    const after = (await api(probe, `/api/helpdesk/tickets/${number}`)).body;
    expect(after.ticket.status).toBe("solved");
    expect(after.ticket.category).toBe(NETWORK);
    expect(after.ticket.assignee_id).toBeTruthy();
    expect(after.solve_details.map((d: { label: string; text: string }) => [d.label, d.text])).toEqual([
      ["Resolution code", "Fixed"],
      ["Root cause", "The VPN profile on the laptop had expired."],
    ]);
    // The side panel shows them, read-only; the unsent reply is still in the composer.
    const card = probe.getByTestId("solve-details");
    await slow(card).toBeVisible({ timeout: 120_000 });
    await expect(card.getByRole("heading", { name: "Solve details" })).toBeVisible();
    await expect(card).toContainText("Resolution code");
    await expect(card).toContainText("Fixed");
    await expect(card).toContainText("The VPN profile on the laptop had expired.");
    await expect(card.locator("input, textarea, select")).toHaveCount(0);
    await expect(probe.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(TEXT);
    await slow(probe.getByText(/filled in the solve details: Resolution code, Root cause/).first()).toBeVisible();
    if (SHOTS) await probe.screenshot({ path: `${SHOTS}/ticket-solve-details-1440-light.png`, fullPage: false });
    // Requesters never read the answers: their view of the request has no such line.
    const mine = await api(probe, `/api/helpdesk/requests/${number}`);
    expect(JSON.stringify(mine.body ?? {})).not.toContain("solve details");
    await probe.close();
  });

  test("Send and solve: the reply is sent and the ticket solved together; a team with no set solves with no dialog", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const sets = (await api(page, "/api/helpdesk/admin/solve-requirements")).body.sets.filter((s: { name: string }) => s.name === setName);
    expect(sets, "the first test made the set").toHaveLength(1);

    const number = await newTicket(page, "VPN drops every hour", teamId);
    await page.goto(`/desk/tickets/${number}`);
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    await slow(reply).toBeVisible({ timeout: 120_000 });
    const TEXT = "The gateway had a short idle timeout. It is raised now.";
    await expect(async () => {
      await reply.fill(TEXT);
      await expect(reply).toHaveValue(TEXT, { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: `Before you solve #${number}` });
    await expect(async () => {
      await page.getByRole("button", { name: "Send and set the status" }).click();
      await page.getByRole("menuitem", { name: "Send and set Solved" }).click({ timeout: 3_000 });
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    const owner = dialog.getByRole("combobox", { name: "Owner" });
    await expect(owner.locator("option", { hasText: "(you)" })).toHaveCount(1, { timeout: 60_000 });
    await owner.selectOption({ label: await owner.locator("option", { hasText: "(you)" }).innerText() });
    await dialog.getByRole("combobox", { name: "Category" }).selectOption({ label: NETWORK });
    await dialog.getByRole("radio", { name: /^Workaround given/ }).check();
    await dialog.getByRole("textbox", { name: "Root cause" }).fill("Idle timeout on the gateway.");
    const [posted] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}/messages`) && r.request().method() === "POST", { timeout: 120_000 }),
      dialog.getByRole("button", { name: "Send and solve" }).click(),
    ]);
    expect(posted.status(), JSON.stringify(await posted.json())).toBe(201);
    const probe = await page.context().newPage();
    await probe.goto(SETTINGS);
    const after = (await api(probe, `/api/helpdesk/tickets/${number}`)).body;
    expect(after.ticket.status).toBe("solved");
    expect(after.ticket.category).toBe(NETWORK);
    expect(after.messages.filter((m: { kind: string; body: string }) => m.kind === "public" && m.body === TEXT)).toHaveLength(1);
    expect(after.solve_details.map((d: { text: string }) => d.text)).toEqual(["Workaround given", "Idle timeout on the gateway."]);

    // Another team's ticket: no set matches, so Solve is one click and one request, as before.
    const free = await newTicket(probe, "Projector in room 4", otherTeamId);
    await probe.goto(`/desk/tickets/${free}`);
    await slow(probe.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible({ timeout: 120_000 });
    expect((await api(probe, `/api/helpdesk/tickets/${free}`)).body.before_solve).toBeUndefined();
    let checks = 0;
    probe.on("request", (r) => {
      if (r.url().includes(`/api/helpdesk/tickets/${free}/solve-requirements`)) checks++;
    });
    await expect(async () => {
      const [res] = await Promise.all([
        probe.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${free}`) && r.request().method() === "PATCH", { timeout: 10_000 }),
        probe.getByRole("button", { name: "Solve", exact: true }).click(),
      ]);
      expect(res.status()).toBe(200);
    }).toPass({ timeout: 60_000 });
    await expect(probe.getByRole("dialog", { name: /Before you solve/ })).toHaveCount(0);
    expect(checks, "nothing is asked when no set matches").toBe(0);
    await probe.close();
  });
});
