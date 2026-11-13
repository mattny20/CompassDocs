import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Custom fields per team (1.20.6). Desk settings → Custom fields: a new
// "Pick one" field for two teams, marked Public, made in the dialog (its key
// is shown as it is typed); a second, agent-only field; the order changed
// from the row. On a ticket of the first team: the side panel's Custom
// fields block, a choice picked from its menu and a text typed in the
// prompt, each saved by one PATCH and noted on the timeline. The requester's
// page (Get help) shows the Public field under Details and nothing of the
// agent-only one. Moved to the second team, the ticket shows that team's
// fields; moved back, its values are there again. A "Before you solve" set
// that requires a custom field asks for it in the dialog and stores it with
// the solve. Archive hides a field and keeps its values; Delete asks first
// and says how many tickets hold a value. Licensed rig only: the community
// build asserts the licence gate. Everything it makes (teams, fields, a
// set, tickets) is its own and is deleted afterwards; its fields are
// assigned to its own teams only, so no other run's tickets ever show one.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const SETTINGS = "/desk/settings/custom-fields";
const FIELDS_API = "/api/helpdesk/admin/custom-fields";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test("custom fields: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, FIELDS_API)).status).toBe(402);
});

test.describe("custom fields (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const teamName = `E2E Fields IT ${stamp}`;
  const otherTeamName = `E2E Fields Facilities ${stamp}`;
  const deviceLabel = `Device type ${stamp}`;
  const serialLabel = `Serial number ${stamp}`;
  const deviceKey = `device_type_${stamp}`;
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
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const sets = await api(page, "/api/helpdesk/admin/solve-requirements");
    for (const s of sets.body?.sets ?? []) if (String(s.name).includes(stamp)) await api(page, `/api/helpdesk/admin/solve-requirements/${s.id}`, { method: "DELETE" });
    const fields = await api(page, FIELDS_API);
    for (const f of fields.body?.fields ?? []) if (String(f.label).includes(stamp)) await api(page, `${FIELDS_API}/${f.id}`, { method: "DELETE" });
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    if (otherTeamId) await api(page, `/api/helpdesk/admin/teams/${otherTeamId}`, { method: "DELETE" });
    await page.close();
  });

  async function newTicket(page: Page, subject: string, team: number): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "The screen flickers when it is docked.", team_id: team, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    tickets.push(t.body.ticket.number);
    return t.body.ticket.number as number;
  }
  const fieldsOf = async (page: Page) => ((await api(page, FIELDS_API)).body.fields as { id: number; key: string; label: string; archived: boolean; tickets: number }[]).filter((f) => f.label.includes(stamp));
  const valuesOf = async (page: Page, n: number) =>
    Object.fromEntries((((await api(page, `/api/helpdesk/tickets/${n}`)).body.custom_fields ?? []) as { label: string; value: unknown }[]).filter((f) => f.label.includes(stamp)).map((f) => [f.label, f.value]));

  test("a field made in Desk settings shows on its teams' tickets, is edited in place, and its Public value reaches the requester", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Desk settings → Custom fields: a new field in the dialog.
    await page.goto(SETTINGS);
    await slow(page.getByRole("heading", { level: 1, name: "Custom fields" })).toBeVisible({ timeout: 120_000 });
    await slow(page.getByRole("link", { name: /^Custom fields/ })).toHaveAttribute("aria-current", "page");
    const dialog = page.getByRole("dialog", { name: "New custom field" });
    // The busy dev rig may still be hydrating: click until the dialog opens.
    await expect(async () => {
      await page.getByRole("button", { name: "New field" }).first().click();
      await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await dialog.getByRole("textbox", { name: "Label", exact: true }).fill(deviceLabel);
    await expect(dialog.getByTestId("hd-custom-field-key")).toContainText(deviceKey);
    const kind = dialog.getByLabel("Kind");
    await expect(kind.locator("option")).toHaveText(["Short text", "Long text", "Pick one", "Yes / no", "Date", "Date and time", "Number", "A person"]);
    await kind.selectOption({ label: "Pick one" });
    await dialog.getByRole("textbox", { name: "Option 1 of field 1", exact: true }).fill("Laptop");
    await dialog.getByRole("button", { name: "Add option" }).click();
    await dialog.getByRole("textbox", { name: "Option 2 of field 1", exact: true }).fill("Desktop");
    await dialog.getByLabel("Help line (optional)").fill("What the ticket is about.");
    // Saving with no team chosen says so, inline.
    await dialog.getByRole("radio", { name: "Chosen teams" }).click();
    await dialog.getByRole("button", { name: "Create field" }).click();
    await expect(dialog.getByText("Pick at least one team, or choose All teams.")).toBeVisible();
    await dialog.getByTestId("hd-custom-field-teams").getByLabel(teamName, { exact: true }).check();
    await dialog.getByTestId("hd-custom-field-teams").getByLabel(otherTeamName, { exact: true }).check();
    await dialog.getByRole("radio", { name: "Public" }).check();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-custom-field-editor-1440-light.png`, fullPage: false });
    const [made] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(FIELDS_API) && r.request().method() === "POST", { timeout: 120_000 }),
      dialog.getByRole("button", { name: "Create field" }).click(),
    ]);
    expect(made.status(), JSON.stringify(await made.json())).toBe(201);
    const device = (await made.json()).field as { id: number; key: string; options: { value: string }[] };
    expect(device.key).toBe(deviceKey);
    expect(device.options.map((o) => o.value)).toEqual(["laptop", "desktop"]);
    await expect(dialog).toHaveCount(0);

    const deviceRow = page.getByTestId("hd-custom-field-row").filter({ hasText: deviceLabel });
    await slow(deviceRow).toBeVisible();
    await expect(deviceRow).toContainText("Public");
    await expect(deviceRow).toContainText("Pick one · Laptop, Desktop");
    await expect(deviceRow).toContainText(teamName);
    await expect(deviceRow).toContainText(otherTeamName);
    await expect(deviceRow).toContainText(deviceKey);

    // A second field, agent-only, for the first team; then it is moved above the first from its row.
    const serial = await api(page, FIELDS_API, { method: "POST", body: { label: serialLabel, type: "text", team_ids: [teamId] } });
    expect(serial.status, JSON.stringify(serial.body)).toBe(201);
    await page.reload();
    const serialRow = page.getByTestId("hd-custom-field-row").filter({ hasText: serialLabel });
    await slow(serialRow).toBeVisible({ timeout: 120_000 });
    await expect(serialRow).toContainText("Agent only");
    await expect(async () => {
      const [moved] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`${FIELDS_API}/order`) && r.request().method() === "PUT", { timeout: 10_000 }),
        page.getByRole("button", { name: `Move ${serialLabel} up` }).click(),
      ]);
      expect(moved.status()).toBe(200);
    }).toPass({ timeout: 60_000 });
    expect((await fieldsOf(page)).map((f) => f.label)).toEqual([serialLabel, deviceLabel]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-custom-fields-1440-light.png`, fullPage: true });

    // A ticket of the first team: the block, in the settings page's order.
    const number = await newTicket(page, "Laptop screen flickers on the dock", teamId);
    await page.goto(`/desk/tickets/${number}`);
    const card = page.getByTestId("custom-fields");
    await slow(card).toBeVisible({ timeout: 120_000 });
    await expect(card.getByRole("heading", { name: "Custom fields" })).toBeVisible();
    await expect(card.getByText("The requester sees these once they are filled in.")).toBeVisible();

    // A choice: picked from its menu, one PATCH.
    const deviceButton = card.getByRole("button", { name: `${deviceLabel}: None` });
    await expect(async () => {
      await deviceButton.click();
      await expect(page.getByRole("menu", { name: deviceLabel })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    const [picked] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      page.getByRole("menuitemradio", { name: /^Laptop/ }).click(),
    ]);
    expect(picked.status(), JSON.stringify(await picked.json())).toBe(200);
    expect(picked.request().postDataJSON()).toEqual({ custom_fields: { [deviceKey]: "laptop" } });
    await slow(card.getByRole("button", { name: `${deviceLabel}: Laptop` })).toBeVisible();

    // A text: typed in the prompt.
    await card.getByRole("button", { name: `${serialLabel}: None. Change` }).click();
    const prompt = page.getByRole("dialog", { name: serialLabel });
    await slow(prompt).toBeVisible();
    await prompt.getByRole("textbox", { name: serialLabel }).fill("C02XK1ABCD");
    const [typed] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      prompt.getByRole("button", { name: "Save" }).click(),
    ]);
    expect(typed.status()).toBe(200);
    await slow(card.getByRole("button", { name: `${serialLabel}: C02XK1ABCD. Change` })).toBeVisible();
    expect(await valuesOf(page, number)).toEqual({ [serialLabel]: "C02XK1ABCD", [deviceLabel]: "laptop" });
    // Each change is one agents-only line on the timeline.
    await slow(page.getByText(new RegExp(`set ${deviceLabel} to Laptop`)).first()).toBeVisible();
    await slow(page.getByText(new RegExp(`set ${serialLabel} to C02XK1ABCD`)).first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-custom-fields-1440-light.png`, fullPage: false });

    // The requester's page: the Public field under Details; nothing of the agent-only one.
    const mine = await api(page, `/api/helpdesk/requests/${number}`);
    expect(mine.status).toBe(200);
    expect(mine.body.request.details).toEqual([{ key: deviceKey, label: deviceLabel, type: "select", value: "Laptop" }]);
    expect(JSON.stringify(mine.body)).not.toContain("C02XK1ABCD");
    expect(JSON.stringify(mine.body)).not.toContain(serialLabel);
    const help = await page.context().newPage();
    await help.goto(`/help/requests/${number}`);
    const details = help.getByTestId("hd-request-details");
    await slow(details).toBeVisible({ timeout: 120_000 });
    await expect(details.getByRole("heading", { name: "Details" })).toBeVisible();
    await expect(details).toContainText(deviceLabel);
    await expect(details).toContainText("Laptop");
    await expect(details.locator("input, select, textarea, button")).toHaveCount(0);
    await expect(help.getByText("C02XK1ABCD")).toHaveCount(0);
    await expect(help.getByText(serialLabel)).toHaveCount(0);
    if (SHOTS) await help.screenshot({ path: `${SHOTS}/help-request-details-1440-light.png`, fullPage: true });
    await help.close();

    // Moved to the other team: that team's fields only. Moved back: the values are there again.
    expect((await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { team_id: otherTeamId } })).status).toBe(200);
    await page.reload();
    await slow(card.getByRole("button", { name: `${deviceLabel}: Laptop` })).toBeVisible({ timeout: 120_000 });
    await expect(card.getByText(serialLabel)).toHaveCount(0);
    expect((await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { custom_fields: { [`serial_number_${stamp}`]: "X" } } })).status).toBe(400);
    expect((await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { team_id: teamId } })).status).toBe(200);
    expect(await valuesOf(page, number)).toEqual({ [serialLabel]: "C02XK1ABCD", [deviceLabel]: "laptop" });
  });

  test("Before you solve asks for a required custom field and stores it with the solve; archive keeps values; delete says how many tickets hold one", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fields = await fieldsOf(page);
    expect(fields.map((f) => f.label), "the first test made the fields").toEqual([serialLabel, deviceLabel]);
    const [serial, device] = fields;

    // The set editor offers "A custom field"; picked, it is listed with the ticket fields.
    const set = await api(page, "/api/helpdesk/admin/solve-requirements", { method: "POST", body: { name: `Hardware details ${stamp}`, enabled: false, team_ids: [teamId] } });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    const setId = set.body.set.id as number;
    await page.goto(`/desk/settings/before-you-solve/${setId}`);
    const pick = page.getByTestId("solve-custom-field-pick");
    await slow(pick).toBeVisible({ timeout: 120_000 });
    await expect(async () => {
      await pick.selectOption({ label: deviceLabel });
      await expect(page.getByTestId("solve-custom-field-row").filter({ hasText: `A custom field: ${deviceLabel}` })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await pick.selectOption({ label: serialLabel });
    await expect(page.getByTestId("solve-custom-field-row")).toHaveCount(2);
    await page.getByRole("switch", { name: "On" }).click();
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/admin/solve-requirements/${setId}`) && r.request().method() === "PUT", { timeout: 120_000 }),
      page.getByRole("button", { name: "Save requirement set" }).click(),
    ]);
    expect(saved.status(), JSON.stringify(await saved.json())).toBe(200);
    expect((await saved.json()).set.custom_field_ids).toEqual([device.id, serial.id]);

    // A new ticket of the team: Solve opens the dialog with both fields.
    const number = await newTicket(page, "Docking station has no power", teamId);
    await page.goto(`/desk/tickets/${number}`);
    await slow(page.getByTestId("custom-fields")).toBeVisible({ timeout: 120_000 });
    const dialog = page.getByRole("dialog", { name: `Before you solve #${number}` });
    await expect(async () => {
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await expect(dialog).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(dialog.getByRole("combobox", { name: deviceLabel })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: serialLabel })).toBeVisible();
    await dialog.getByRole("button", { name: "Solve", exact: true }).click();
    await expect(dialog.getByText("Pick one.")).toBeVisible();
    await expect(dialog.getByText("This is needed.")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-before-you-solve-custom-field-1440-light.png`, fullPage: false });
    await dialog.getByRole("combobox", { name: deviceLabel }).selectOption({ label: "Desktop" });
    await dialog.getByRole("textbox", { name: serialLabel }).fill("DK-7781");
    const [solved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      dialog.getByRole("button", { name: "Solve", exact: true }).click(),
    ]);
    expect(solved.status(), JSON.stringify(await solved.json())).toBe(200);
    expect(solved.request().postDataJSON().custom_fields).toEqual({ [device.key]: "desktop", [serial.key]: "DK-7781" });
    const probe = await page.context().newPage();
    await probe.goto(SETTINGS);
    const after = (await api(probe, `/api/helpdesk/tickets/${number}`)).body;
    expect(after.ticket.status).toBe("solved");
    expect(await valuesOf(probe, number)).toEqual({ [serialLabel]: "DK-7781", [deviceLabel]: "desktop" });

    // Archive from the row: the field leaves tickets, its values stay; Restore brings it back.
    const row = probe.getByTestId("hd-custom-field-row").filter({ hasText: serialLabel });
    await slow(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toContainText("Filled in on 2 tickets");
    await expect(async () => {
      const [res] = await Promise.all([
        probe.waitForResponse((r) => r.url().endsWith(`${FIELDS_API}/${serial.id}`) && r.request().method() === "PUT", { timeout: 10_000 }),
        probe.getByRole("button", { name: `Archive ${serialLabel}` }).click(),
      ]);
      expect(res.status()).toBe(200);
    }).toPass({ timeout: 60_000 });
    await slow(probe.getByTestId("hd-custom-fields-archived").getByText(serialLabel)).toBeVisible();
    expect(Object.keys(await valuesOf(probe, number))).toEqual([deviceLabel]);
    await probe.getByRole("button", { name: `Restore ${serialLabel}` }).click();
    await slow(probe.getByTestId("hd-custom-fields").getByText(serialLabel)).toBeVisible();
    expect((await valuesOf(probe, number))[serialLabel]).toBe("DK-7781");

    // Delete asks first and says how many tickets hold a value.
    await probe.getByRole("button", { name: `Delete ${serialLabel}` }).click();
    const confirm = probe.getByRole("dialog", { name: `Delete ${serialLabel}?` });
    await slow(confirm).toBeVisible();
    await expect(confirm).toContainText("2 tickets hold a value for this field.");
    await expect(confirm).toContainText("archive the field instead");
    const [gone] = await Promise.all([
      probe.waitForResponse((r) => r.url().endsWith(`${FIELDS_API}/${serial.id}`) && r.request().method() === "DELETE", { timeout: 120_000 }),
      confirm.getByRole("button", { name: "Delete field" }).click(),
    ]);
    expect(gone.status()).toBe(200);
    await expect(probe.getByTestId("hd-custom-field-row").filter({ hasText: serialLabel })).toHaveCount(0);
    expect((await fieldsOf(probe)).map((f) => f.label)).toEqual([deviceLabel]);
    // The set no longer requires the deleted field.
    const sets = (await api(probe, "/api/helpdesk/admin/solve-requirements")).body.sets.find((s: { id: number }) => s.id === setId);
    expect(sets.custom_field_ids).toEqual([device.id]);
    await probe.close();
  });
});
