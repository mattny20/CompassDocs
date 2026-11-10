import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, login } from "./helpers";

// Status page services per team (Helpdesk 1.19.2, agent W6), as the
// workspace administrator (desk Admin, made a lead of its own stamped
// team). The team ticks an internal Status page service in Desk settings →
// Teams; the service is set degraded in the database (an internal service,
// so no vendor is polled and nobody else is alerted); the desk's pill,
// pop-up and the team queue's banner follow; a major incident is declared
// from the banner, prefilled; once the service is operational again the
// incident's runner is asked to solve it. Everything made here (team,
// tickets, the service, bells) is removed afterwards. Unlicensed builds
// answer 402 behind the desk, so these skip themselves and the EE rig runs
// them. W6_SHOTS=<dir> also saves light 1440 sanity screenshots.

const SHOTS = process.env.W6_SHOTS || "";

async function deskLicensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status === 200;
}

test.describe("status services per team", () => {
  test.describe.configure({ mode: "serial", timeout: 420_000 });
  let db: Client;
  const stamp = `${Date.now()}`;
  const serviceName = `Mail ${stamp}`;
  const teamName = `E2E status ${stamp}`;
  let teamId = 0;
  let serviceId = 0;
  let adminId = 0;
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
      if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    } finally {
      await page.close();
    }
    if (serviceId) await db.query("DELETE FROM status_services WHERE id = $1", [serviceId]);
    if (adminId) await db.query("DELETE FROM notifications WHERE user_id = $1 AND title LIKE $2", [adminId, `%${stamp}%`]);
    await db.query("DELETE FROM audit_log WHERE action LIKE 'helpdesk.team_status.%' AND (target_label LIKE $1 OR details::text LIKE $1)", [`%${stamp}%`]);
    await db.end();
  });

  test("choose services, see the pill, the pop-up and the banner, declare from it, and be asked to solve once it recovers", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await page.setViewportSize({ width: 1440, height: 900 });

    adminId = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0].id;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, position: 9930 } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    const members = await api(page, `/api/helpdesk/admin/teams/${teamId}/members`, { method: "PUT", body: { members: [{ user_id: adminId, role: "lead" }] } });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    serviceId = (await db.query("INSERT INTO status_services (name, provider, source_url, status) VALUES ($1, 'manual', '', 'operational') RETURNING id", [serviceName])).rows[0].id;

    // Desk settings → Teams → the team's own page (1.20.2): tick the service for the team.
    await page.goto(`/desk/settings/teams/${teamId}`);
    const section = page.locator("details").filter({ has: page.getByText(`Status services for ${teamName}`, { exact: true }) });
    await section.getByText(`Status services for ${teamName}`, { exact: true }).click({ timeout: 120_000 });
    await section.getByLabel(serviceName, { exact: true }).check();
    await expect(section.getByLabel(`Pop-up for ${serviceName}`)).toHaveValue("degraded");
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/team-status/teams/${teamId}`) && r.request().method() === "PUT");
    await section.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(`${teamName}'s status services saved.`)).toBeVisible();

    // A ticket that mentions it, then the service degrades.
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `E2E ${stamp} mail is not arriving`, body: "Since this morning", team_id: teamId } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    numbers.push(t.body.ticket.number);
    await db.query("UPDATE status_services SET status = 'degraded', status_detail = 'Delayed mail delivery', last_changed_at = now() - interval '2 minutes' WHERE id = $1", [serviceId]);

    // The desk: the pill and the pop-up (the desk's poll runs the sync).
    await page.goto("/desk");
    const popup = page.locator(`[data-status-popup]`).filter({ hasText: `${serviceName} is degraded` });
    await expect(popup).toBeVisible({ timeout: 120_000 });
    await expect(popup).toContainText("Delayed mail delivery. Started");
    await expect(popup).toContainText("1 new ticket mentions mail since");
    await expect(popup.getByRole("button", { name: "Declare major incident" })).toBeVisible();
    const pill = page.getByRole("button", { name: /1 service affected/ });
    await expect(pill).toBeVisible();
    await popup.getByRole("button", { name: "View details" }).click();
    const pop = page.getByRole("dialog", { name: "Your teams' services" });
    await expect(pop.getByText(serviceName, { exact: true })).toBeVisible();
    await expect(pop.getByText("Degraded", { exact: true })).toBeVisible();
    await expect(pop.getByRole("link", { name: /Status page/ })).toHaveAttribute("href", "/status");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/s1-desk-status-popup-light-1440.png` });
    await page.keyboard.press("Escape");

    // Dismissing is remembered.
    await popup.getByRole("button", { name: `Dismiss: ${serviceName} is degraded` }).click();
    await expect(popup).toBeHidden();
    await page.reload();
    await expect(page.getByRole("button", { name: /1 service affected/ })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(`[data-status-popup]`).filter({ hasText: serviceName })).toHaveCount(0);

    // The team's queue: the banner, and Declare major incident from it, prefilled.
    await page.goto(`/desk?team=${teamId}`);
    const banner = page.getByRole("status").filter({ hasText: `${serviceName} is degraded` });
    await expect(banner).toBeVisible({ timeout: 120_000 });
    await expect(banner).toContainText("Delayed mail delivery");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/s3-queue-status-banner-light-1440.png` });
    await banner.getByRole("button", { name: "Declare major incident" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Declare a major incident" })).toBeVisible();
    await expect(dialog.getByText(`Started from the Status page: ${serviceName} is degraded.`)).toBeVisible();
    await expect(dialog.getByLabel("Title people will see")).toHaveValue(`${serviceName} is degraded`);
    await expect(dialog.getByLabel("Link new tickets automatically while it's open")).toHaveValue("mail");
    await expect(dialog.getByLabel(/Link the open ticket that mentions mail since/)).toBeChecked();
    await expect(dialog.getByLabel(`Solve the incident's tickets when ${serviceName} is operational again (asks first)`)).toBeChecked();
    await dialog.getByLabel("Show a banner in Get help with a “Me too” button").uncheck();
    const declared = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/incidents") && r.request().method() === "POST");
    const watched = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/team-status/incident"));
    await dialog.getByRole("button", { name: "Declare incident" }).click();
    const res = await declared;
    expect(res.status()).toBe(201);
    const incident = (await res.json()) as { number: number; linked: number[] };
    numbers.unshift(incident.number);
    expect(incident.linked).toEqual([t.body.ticket.number]);
    expect((await watched).status()).toBe(200);
    // The service is kept in the watch only; W1's Status page mirror column stays W1's.
    const row = (await db.query("SELECT i.status_service_id, w.service_id, w.ask_solve FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id JOIN hd_status_incident_watch w ON w.incident_id = i.id WHERE t.number = $1", [incident.number])).rows[0];
    expect(row).toEqual({ status_service_id: null, service_id: serviceId, ask_solve: 1 });

    // The banner now links to the open incident instead of offering another; Hide for today, per person.
    await page.goto(`/desk?team=${teamId}`);
    await expect(banner).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByRole("link", { name: `Major incident #${incident.number}` })).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByRole("button", { name: "Declare major incident" })).toHaveCount(0);
    await banner.getByRole("button", { name: "Hide for today" }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("button", { name: /1 service affected/ })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("status").filter({ hasText: `${serviceName} is degraded` })).toHaveCount(0);

    // Operational again: the pill goes quiet and the runner is asked (nothing solved by itself).
    await db.query("UPDATE status_services SET status = 'operational', status_detail = '', last_changed_at = now() WHERE id = $1", [serviceId]);
    await page.goto("/desk");
    const ask = page.locator(`[data-status-ask="${incident.number}"]`);
    await expect(ask).toBeVisible({ timeout: 120_000 });
    await expect(ask).toContainText(`${serviceName} is operational again`);
    await expect(ask).toContainText("with 1 linked ticket");
    await expect(page.getByRole("button", { name: /service affected/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /all your teams' services are operational/ })).toBeVisible();
    const solved = page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/incidents/${incident.number}/updates`));
    await ask.getByRole("button", { name: "Solve incident and linked tickets" }).click();
    expect((await solved).status()).toBe(200);
    await expect(page.getByText(`Major incident #${incident.number} solved`)).toBeVisible({ timeout: 30_000 });
    await expect(ask).toBeHidden({ timeout: 30_000 });
    const status = (await db.query("SELECT status FROM hd_tickets WHERE number = ANY($1) ORDER BY number", [[incident.number, t.body.ticket.number]])).rows.map((r) => r.status);
    expect(status).toEqual(["solved", "solved"]);
  });
});
