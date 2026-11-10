import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";

// API tokens and outgoing webhooks (1.19.4 C2; mock-up g1). Desk settings →
// API and webhooks: New token shows the token once; the REST API answers it
// with Bearer and refuses a session cookie; the token works only its team's
// tickets, and its change says "via API"; Revoke stops it at once. New
// webhook shows its signing secret once; Send a test reports the endpoint's
// answer (the rig can't reach a receiver, so the test fails readably) and
// the delivery log lists it; Delete removes it.
//
// Signed delivery to a receiver, retries, the 24-hour give-up and the team
// filter are covered by test/helpdesk-api-webhooks against an in-process
// receiver. Everything this spec makes is stamped and deleted; its webhook
// is filtered to its own team, so no other spec's ticket reaches it.

const slow = expect.configure({ timeout: 60_000 });
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const BASE = process.env.E2E_BASE_URL || "http://localhost:3993";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/api")).status !== 402;
}

test.describe("API and webhooks (licensed)", () => {
  const stamp = Date.now().toString(36);
  let db: Client;
  let teamId = 0;
  let other = 0;
  const tickets: { id: number; number: number }[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
    teamId = (await db.query("INSERT INTO hd_teams (name, position) VALUES ($1, 9501) RETURNING id", [`E2E API ${stamp}`])).rows[0].id;
    other = (await db.query("INSERT INTO hd_teams (name, position) VALUES ($1, 9502) RETURNING id", [`E2E API other ${stamp}`])).rows[0].id;
    for (const [subject, team] of [
      [`E2E API ${stamp} mine`, teamId],
      [`E2E API ${stamp} theirs`, other],
    ] as const) {
      tickets.push(
        (
          await db.query(
            "INSERT INTO hd_tickets (subject, requester_name, requester_email, team_id, status) VALUES ($1, 'Rae Requester', 'rae@example.test', $2, 'open') RETURNING id, number",
            [subject, team]
          )
        ).rows[0]
      );
    }
  });

  test.afterAll(async () => {
    const principals = (await db.query("SELECT principal_id FROM hd_api_tokens WHERE name LIKE $1", [`E2E ${stamp}%`])).rows.map((r) => r.principal_id);
    await db.query("DELETE FROM hd_webhooks WHERE name LIKE $1", [`E2E ${stamp}%`]);
    await db.query("DELETE FROM hd_tickets WHERE id = ANY($1)", [tickets.map((t) => t.id)]);
    await db.query("DELETE FROM hd_api_tokens WHERE principal_id = ANY($1)", [principals]);
    await db.query("DELETE FROM users WHERE id = ANY($1) AND status = 'service'", [principals]);
    await db.query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, other]]);
    await db.end();
  });

  test("a token: shown once, Bearer only, its team only, via API, revoked at once", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "the helpdesk is not licensed here");
    await page.goto("/desk/settings/integrations/api");
    await slow(page.getByRole("heading", { name: "API and webhooks", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "New token" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Name").fill(`E2E ${stamp} Jira sync`);
    await dlg.getByLabel("Shown as").fill(`E2E ${stamp} bot`);
    await dlg.getByLabel("Acts as").selectOption("agent");
    await expect(dlg.getByText(/^Can: Read tickets · update status/)).toBeVisible();
    await dlg.locator("label", { hasText: `E2E API ${stamp}` }).filter({ hasNotText: "other" }).locator("input").check();
    await dlg.getByRole("button", { name: "Create token" }).click();
    await slow(dlg.getByTestId("hd-api-token")).toBeVisible();
    const token = (await dlg.getByTestId("hd-api-token").textContent())!.trim();
    expect(token).toMatch(/^cdh_[A-Za-z0-9_-]{43}$/);
    await expect(dlg.getByText("Copy the token now. It won't be shown again.")).toBeVisible();
    await dlg.getByRole("button", { name: "Done" }).click();
    const row = page.getByRole("row", { name: new RegExp(`E2E ${stamp} Jira sync`) });
    await expect(row).toContainText(`cdh_…${token.slice(-4)}`);
    await expect(row).toContainText(`E2E ${stamp} bot (Agent, E2E API ${stamp})`);
    expect(await page.content()).not.toContain(token);

    // The REST API, from outside the browser.
    const out = await pwRequest.newContext({ baseURL: BASE });
    try {
      const auth = { authorization: `Bearer ${token}` };
      const me = await out.get("/api/helpdesk/v1/me", { headers: auth });
      expect(me.status()).toBe(200);
      expect((await me.json()).acts_as.role).toBe("agent");
      expect((await out.get("/api/helpdesk/v1/me")).status()).toBe(401);
      // The signed-in admin's own session is not a credential here.
      expect((await page.request.get("/api/helpdesk/v1/me")).status()).toBe(401);
      const [mine, theirs] = tickets;
      expect((await out.get(`/api/helpdesk/v1/tickets/${mine.number}`, { headers: auth })).status()).toBe(200);
      expect((await out.get(`/api/helpdesk/v1/tickets/${theirs.number}`, { headers: auth })).status()).toBe(404);
      const list = await (await out.get(`/api/helpdesk/v1/tickets?view=all&q=${encodeURIComponent(`E2E API ${stamp}`)}`, { headers: auth })).json();
      expect(list.tickets.map((t: { number: number }) => t.number)).toEqual([mine.number]);
      const patched = await out.patch(`/api/helpdesk/v1/tickets/${mine.number}`, { headers: auth, data: { priority: "high" } });
      expect(patched.status()).toBe(200);

      // The desk shows the change "via API".
      await page.goto(`/desk/tickets/${mine.number}`);
      await slow(page.getByText(/changed the priority .* via API/)).toBeVisible();

      // Revoke: the next call is refused.
      await page.goto("/desk/settings/integrations/api");
      await slow(page.getByRole("button", { name: `Revoke E2E ${stamp} Jira sync` })).toBeVisible();
      await page.getByRole("button", { name: `Revoke E2E ${stamp} Jira sync` }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
      await slow(page.getByRole("button", { name: `Revoke E2E ${stamp} Jira sync` })).toHaveCount(0);
      expect((await out.get("/api/helpdesk/v1/me", { headers: auth })).status()).toBe(401);
    } finally {
      await out.dispose();
    }
  });

  test("a webhook: secret shown once, a test reports the answer, the log lists it, delete", async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "the helpdesk is not licensed here");
    await page.goto("/desk/settings/integrations/api");
    await slow(page.getByRole("heading", { name: "API and webhooks", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "New webhook" }).click();
    const dlg = page.getByRole("dialog");
    // http is refused with the server's sentence.
    await dlg.getByLabel("Endpoint").fill("http://hooks.example.invalid/compassdocs");
    await dlg.getByLabel("Name (optional)").fill(`E2E ${stamp} hook`);
    await dlg.locator("label", { hasText: `E2E API ${stamp}` }).filter({ hasNotText: "other" }).locator("input").check();
    await dlg.getByRole("button", { name: "Add webhook" }).click();
    await expect(dlg.getByText("Use an https:// address.")).toBeVisible();
    await dlg.getByLabel("Endpoint").fill("https://hooks.example.invalid/compassdocs");
    await dlg.getByRole("button", { name: "Add webhook" }).click();
    await slow(page.getByRole("dialog").getByTestId("hd-api-secret")).toBeVisible();
    const secret = (await page.getByRole("dialog").getByTestId("hd-api-secret").textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    const row = page.getByRole("row", { name: new RegExp(`E2E ${stamp} hook`) });
    await expect(row).toContainText("ticket.created, ticket.updated, ticket.solved");
    await expect(row).toContainText("No deliveries yet");
    expect(await page.content()).not.toContain(secret);

    await row.getByRole("button", { name: `Send a test to E2E ${stamp} hook` }).click();
    await slow(page.getByText(/^Test failed: /)).toBeVisible();

    await row.getByRole("button", { name: `More actions for E2E ${stamp} hook` }).click();
    await page.getByRole("menuitem", { name: "Delivery log" }).click();
    const log = page.getByRole("dialog");
    await expect(log.getByRole("heading", { name: "Delivery log" })).toBeVisible();
    await slow(log.getByText("ping")).toBeVisible();
    await expect(log.getByText("Failed")).toBeVisible();
    await expect(log.getByText("Test", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await row.getByRole("button", { name: `More actions for E2E ${stamp} hook` }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete webhook" }).click();
    await slow(page.getByText("Webhook deleted.")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`E2E ${stamp} hook`) })).toHaveCount(0);
  });
});
