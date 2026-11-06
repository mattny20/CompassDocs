import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Checklists (1.19.2, agent W3; mock-ups c1 and c2). Desk settings →
// Checklists: a new checklist with a required item and an item owned by a
// team and due in business days. On a ticket: Add a checklist from the side
// card, the card with its progress, Solve refused while the required item is
// open (the message names it), ticking (on the timeline), then Solve works.
// The workflow builder's Task step offers the checklist. CI's community
// build asserts the licence gate; the licensed flow runs on the EE rig and
// skips itself on 402. Everything it makes (a team, a template, a workflow,
// tickets) is its own and is deleted afterwards.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440 of both screens.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/checklists")).status !== 402;
}

test("checklists: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/checklists")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/checklists")).status).toBe(402);
});

test.describe("checklists (licensed)", () => {
  const stamp = Date.now().toString(36);
  const teamName = `E2E Checklists ${stamp}`;
  const name = `Leaver: IT ${stamp}`;
  let teamId = 0;
  const tickets: number[] = [];
  const workflows: number[] = [];

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
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    for (const id of workflows) await api(page, `/api/helpdesk/admin/workflows/${id}`, { method: "DELETE" });
    const list = await api(page, "/api/helpdesk/admin/checklists");
    for (const t of list.body?.templates ?? []) if (String(t.name).includes(stamp)) await api(page, `/api/helpdesk/admin/checklists/${t.id}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("a checklist in Desk settings, on a ticket, blocking Solve until its required item is ticked", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Desk settings → Checklists: a new checklist.
    await page.goto("/desk/settings/checklists");
    await slow(page.getByRole("heading", { level: 1, name: "Checklists" })).toBeVisible({ timeout: 60_000 });
    await slow(page.getByRole("link", { name: /^Checklists/ })).toHaveAttribute("aria-current", "page");
    const editor = page.locator("#checklist-editor");
    // The busy dev rig may still be hydrating: click until the editor opens.
    await expect(async () => {
      await page.getByRole("button", { name: "New checklist" }).first().click();
      await expect(editor.getByRole("heading", { name: "New checklist" })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await editor.getByLabel("Name").fill(name);
    await editor.getByRole("textbox", { name: "Item 1", exact: true }).fill("Disable sign-in on the leaving date");
    await editor.getByRole("button", { name: "Settings for Disable sign-in on the leaving date" }).click();
    await page.getByRole("switch", { name: "Required" }).click();
    await page.keyboard.press("Escape");
    await expect(editor.getByText("Required", { exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "Add item" }).click();
    await editor.getByRole("textbox", { name: "Item 2", exact: true }).fill("Collect the laptop and badge");
    await editor.getByRole("button", { name: "Settings for Collect the laptop and badge" }).click();
    await page.getByRole("combobox", { name: /^Owner team/ }).selectOption({ label: teamName });
    await page.getByRole("combobox", { name: /^Due/ }).selectOption({ label: "Due in 2 business days" });
    await page.keyboard.press("Escape");
    await editor.getByRole("button", { name: "Add item" }).click();
    await editor.getByRole("textbox", { name: "Item 3", exact: true }).fill("Wipe the laptop");
    // Reorder from the keyboard path: the grip's menu.
    await editor.getByRole("button", { name: "Move Wipe the laptop", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect(editor.getByRole("textbox", { name: "Item 2", exact: true })).toHaveValue("Wipe the laptop");
    // Wait on the response, not the toast: on the shared rig another agent's edit can reload the page.
    const [created] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/checklists") && r.request().method() === "POST", { timeout: 120_000 }),
      editor.getByRole("button", { name: "Create checklist" }).click(),
    ]);
    expect(created.status()).toBe(201);
    const row = page.getByRole("row").filter({ hasText: name });
    await slow(row).toContainText("Nothing (added by hand)");
    await expect(row.getByRole("button")).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#checklist-editor").getByRole("heading", { name: `Editing · ${name}` })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-checklists-1440-light.png`, fullPage: true });

    // A ticket: Add a checklist from the side card.
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Leaver Sam Park ${stamp}`, body: "Sam leaves on Friday.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const number = t.body.ticket.number as number;
    tickets.push(number);
    await page.goto(`/desk/tickets/${number}`);
    const side = page.getByTestId("checklists-side");
    await slow(side).toBeVisible({ timeout: 60_000 });
    await side.getByRole("button", { name: "Add a checklist" }).click();
    const [added] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}/checklists`) && r.request().method() === "POST", { timeout: 120_000 }),
      page.getByRole("menuitemradio", { name: new RegExp(name) }).click(),
    ]);
    expect(added.status()).toBe(201);
    const card = page.getByRole("region", { name })
      .or(page.locator("section").filter({ has: page.getByRole("heading", { name }) }))
      .first();
    await slow(card).toContainText("0 of 3 done");
    await expect(side).toContainText("0/3");
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await expect(card.getByText(`${teamName} · due`)).toBeVisible();

    // Solve is refused while the required item is open; the message names it.
    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      page.getByRole("button", { name: "Solve", exact: true }).click(),
    ]);
    expect(refused.status()).toBe(409);
    await slow(page.getByText(`Finish the required checklist items first: "Disable sign-in on the leaving date".`).first()).toBeVisible();
    expect((await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.status).toBe("new");

    // Tick it: progress, the timeline, then Solve works.
    await card.getByRole("checkbox", { name: /Disable sign-in on the leaving date/ }).check();
    await slow(card).toContainText("1 of 3 done");
    await expect(card.getByRole("checkbox", { name: /Disable sign-in on the leaving date/ })).toBeChecked();
    await expect(side).toContainText("1/3");
    await slow(page.getByText(/ticked "Disable sign-in on the leaving date"/).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-checklist-1440-light.png`, fullPage: false });
    const [solved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      page.getByRole("button", { name: "Solve", exact: true }).click(),
    ]);
    expect(solved.status()).toBe(200);
    // The desk may move on to the next ticket after a solve: read from a page that stays put.
    const probe = await page.context().newPage();
    await probe.goto("/desk/settings/checklists");
    expect((await api(probe, `/api/helpdesk/tickets/${number}`)).body.ticket.status).toBe("solved");

    // Requesters never read checklists: the route is agents-only and the timeline lines are internal.
    const mine = await api(probe, `/api/helpdesk/requests/${number}`);
    expect(JSON.stringify(mine.body ?? {})).not.toContain("ticked");
    await probe.close();
  });

  test("a team that asks for time: a blocked Solve keeps the timer running and asks nothing", async ({ page }) => {
    test.setTimeout(240_000);
    const set = await api(page, `/api/helpdesk/admin/teams/${teamId}/time`, { method: "PATCH", body: { ask_time_on_solve: true } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const made = await api(page, "/api/helpdesk/admin/checklists", { method: "POST", body: { name: `Timer guard ${stamp}`, items: [{ title: "Confirm the restore", required: true }] } });
    expect(made.status).toBe(201);
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Timer guard ${stamp}`, body: "From the checklist spec.", team_id: teamId, priority: "normal" } });
    expect(t.status).toBe(201);
    const number = t.body.ticket.number as number;
    tickets.push(number);
    expect((await api(page, `/api/helpdesk/tickets/${number}/checklists`, { method: "POST", body: { template_id: made.body.template.id } })).status).toBe(201);
    const mine = await api(page, "/api/helpdesk/time/timer");
    if (mine.body?.timer) await api(page, `/api/helpdesk/tickets/${mine.body.timer.ticket_number}/time/timer`, { method: "DELETE", body: {} });
    expect((await api(page, `/api/helpdesk/tickets/${number}/time/timer`, { method: "POST", body: {} })).status).toBe(200);
    try {
      await page.goto(`/desk/tickets/${number}`);
      await slow(page.getByTestId("ticket-checklists")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await slow(page.getByText(`Finish the required checklist items first: "Confirm the restore".`).first()).toBeVisible();
      await expect(page.getByRole("dialog", { name: /Log your time/ })).toHaveCount(0);
      const timer = await api(page, "/api/helpdesk/time/timer");
      expect(timer.body?.timer?.ticket_number, "the timer still runs here").toBe(number);
      expect((await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.status).toBe("new");
    } finally {
      await api(page, `/api/helpdesk/tickets/${number}/time/timer`, { method: "DELETE", body: {} });
      await api(page, `/api/helpdesk/admin/teams/${teamId}/time`, { method: "PATCH", body: { ask_time_on_solve: false } });
    }
  });

  test("the workflow builder's Task step adds a checklist", async ({ page }) => {
    test.setTimeout(240_000);
    const list = await api(page, "/api/helpdesk/admin/checklists");
    let tpl = (list.body.templates as { id: number; name: string }[]).find((x) => x.name === name);
    if (!tpl) {
      const made = await api(page, "/api/helpdesk/admin/checklists", { method: "POST", body: { name, items: [{ title: "Disable sign-in", required: true }] } });
      expect(made.status).toBe(201);
      tpl = made.body.template;
    }
    const wf = await api(page, "/api/helpdesk/admin/workflows", {
      method: "POST",
      body: { title: `E2E Checklist flow ${stamp}`, definition: { trigger: {}, steps: [{ key: "accounts", kind: "task", title: "Accounts and devices", team_id: teamId }] } },
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(201);
    const id = wf.body.workflow.id as number;
    const slug = wf.body.workflow.slug as string;
    workflows.push(id);
    await page.goto(`/desk/workflows/${slug}`);
    await slow(page.getByText("Accounts and devices").first()).toBeVisible({ timeout: 60_000 });
    await page.getByText("Accounts and devices").first().click();
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Checklists" }) });
    await slow(section.getByRole("button", { name: "Add checklist" })).toBeVisible();
    await section.getByRole("button", { name: "Add checklist" }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(name) }).click();
    await expect(section).toContainText(name);
    await page.getByRole("button", { name: "Save draft" }).click();
    await slow(page.getByText("Draft saved.")).toBeVisible();
    const back = await api(page, `/api/helpdesk/admin/workflows/${id}`);
    const steps = (back.body.workflow ?? back.body).draft?.steps ?? [];
    expect(steps[0]?.checklist_ids).toEqual([tpl!.id]);
  });
});
