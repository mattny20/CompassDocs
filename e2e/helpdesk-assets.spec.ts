import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";

// Assets on tickets (1.19.3; mock-ups i1 to i4). Desk settings → Assets:
// the Snipe-IT address and key (the key never comes back), "Offer to log a
// maintenance record", Test connection's readable error. On a ticket: the
// Assets card, + Link with the requester's device first, the link on the
// card, the asset's page with the ticket on it, then Solve: the "Log a
// maintenance record in Snipe-IT" dialog, the ticket solved and, since the
// rig can't reach a Snipe-IT, the failure as a toast and an internal note
// (the solve is never blocked). The success path of the post is covered by
// test/helpdesk-assets against an in-process fake Snipe-IT.
//
// The rig's dev server can't reach a fake Snipe-IT (https only, and local
// addresses are blocked), so the cache is seeded in the database under a
// stamped tag. The asset settings are workspace-wide: this spec holds an
// advisory lock while it changes them and restores the stored rows
// afterwards. Everything else it makes is its own and is deleted.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/assets")).status !== 402;
}

test("assets: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/assets")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/assets/mine")).status).toBe(402);
});

test.describe("assets (licensed)", () => {
  const stamp = Date.now().toString(36);
  const TAG = `E2E-${stamp.toUpperCase()}`;
  const requesterEmail = `daniel.okafor.${stamp}@example.test`;
  const teamName = `E2E Assets ${stamp}`;
  let teamId = 0;
  const tickets: number[] = [];
  let db: Client;
  let saved: { key: string; value: string }[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
    // One writer of the workspace's asset settings at a time; restored in afterAll.
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_assets_settings_test'))");
    saved = (await db.query("SELECT key, value FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')")).rows;
    // Start from nothing saved: a saved address would make ours a "new source" and retire its cache.
    await db.query("DELETE FROM settings WHERE key = 'helpdesk_assets'");
  });

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
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
    await db.query("DELETE FROM hd_assets WHERE provider = 'snipeit' AND tag LIKE $1", [`${TAG}%`]);
    await db.query("DELETE FROM settings WHERE key IN ('helpdesk_assets', 'helpdesk_assets_sync:snipeit')");
    for (const r of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
    await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_assets_settings_test'))");
    await db.end();
  });

  test("Snipe-IT in Desk settings, a device linked from the ticket, its page, and Solve offering a maintenance record", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1.20.2: Assets is three pages off the Integrations hub; the old address lands on the hub.
    await page.goto("/desk/settings/assets");
    await page.waitForURL(/\/desk\/settings\/integrations$/, { timeout: 120_000 });
    // Microsoft Intune has its own page and its own app registration: nothing entered on this rig,
    // so it is not connected and says what to enter (no word of directory sync).
    await page.goto("/desk/settings/integrations/intune");
    await slow(page.getByRole("heading", { level: 1, name: "Microsoft Intune" })).toBeVisible({ timeout: 60_000 });
    const intune = page.getByTestId("assets-intune");
    await expect(intune.getByTestId("assets-intune-line")).toHaveText("Enter the app registration Intune signs in with to start.");
    await expect(intune.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
    await expect(intune).not.toContainText(/directory sync/i);
    await expect(page.getByRole("link", { name: "Integrations", exact: true }).first()).toHaveAttribute("href", "/desk/settings/integrations");
    // Integrations → Snipe-IT.
    await page.goto("/desk/settings/integrations/snipe-it");
    await slow(page.getByRole("heading", { level: 1, name: "Snipe-IT" })).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("assets-snipeit");
    await card.getByLabel("Address").fill(`https://assets-${stamp}.example.com`);
    await card.getByLabel("API key").fill(`e2e-key-${stamp}`);
    await card.getByRole("radio", { name: "Offer to log a maintenance record" }).check();
    const [savedRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/assets") && r.request().method() === "PUT", { timeout: 120_000 }),
      page.getByRole("button", { name: "Save Snipe-IT settings" }).click(),
    ]);
    expect(savedRes.status()).toBe(200);
    expect(JSON.stringify(await savedRes.json())).not.toContain(`e2e-key-${stamp}`);
    await slow(card.getByRole("button", { name: "Replace the API key" })).toBeVisible();
    // The rig can't reach that host: Test connection says so in a sentence.
    const [tested] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/assets/test"), { timeout: 120_000 }),
      card.getByRole("button", { name: "Test connection" }).click(),
    ]);
    const testBody = await tested.json();
    expect(testBody.ok).toBe(false);
    expect(testBody.error).toMatch(/Couldn't|local or private|didn't answer/);
    // Seed the cache as a sync would have, and mark the last sync good.
    await db.query(
      `INSERT INTO hd_assets (provider, external_id, tag, serial, name, model, category, status_label, status_kind, assigned_email, assigned_name, location, purchase_date, warranty_end, url)
       VALUES ('snipeit', $1, $2, $3, 'MacBook Pro 14 (2024)', 'MacBook Pro 14 (2024)', 'Laptops', 'Ready to Deploy', 'deployed', $4, 'Daniel Okafor', 'London office', '2024-03-11', '2027-03-11', $5),
              ('snipeit', $6, $7, '', 'Dell U2723QE monitor', 'U2723QE', 'Monitors', 'Ready to Deploy', 'deployed', $4, 'Daniel Okafor', 'London office', NULL, NULL, $8)`,
      [`e2e-${stamp}-1`, `${TAG}-00421`, `C02${stamp}`, requesterEmail, `https://assets-${stamp}.example.com/hardware/1`, `e2e-${stamp}-2`, `${TAG}-00312`, `https://assets-${stamp}.example.com/hardware/2`]
    );
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('helpdesk_assets_sync:snipeit', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify({ started_at: new Date().toISOString(), at: new Date().toISOString(), ok: true, error: "", total: 2 })]
    );
    await page.reload();
    await slow(page.getByTestId("assets-sync-line")).toContainText(/Connected · \d[\d,]* assets? · synced/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-assets-1440-light.png`, fullPage: true });

    // A ticket from Daniel: + Link offers his devices first.
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Laptop won't connect to VPN from home ${stamp}`, body: "Authentication failed since this morning.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const number = t.body.ticket.number as number;
    tickets.push(number);
    // Daniel wrote in by email (no account): his devices match on the sender's address.
    await db.query("UPDATE hd_tickets SET requester_id = NULL, requester_name = 'Daniel Okafor', requester_email = $2 WHERE number = $1", [number, requesterEmail]);
    await page.goto(`/desk/tickets/${number}`);
    const side = page.getByTestId("assets-side");
    await slow(side).toBeVisible({ timeout: 60_000 });
    await expect(side).toContainText("No asset linked yet");
    await side.getByRole("button", { name: "Link" }).click();
    const picker = page.getByRole("dialog", { name: "Link an asset" });
    await slow(picker.getByRole("group", { name: "Assigned to Daniel Okafor" })).toContainText("MacBook Pro 14 (2024)");
    await expect(picker).toContainText(`${TAG}-00312`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-assets-picker-1440-light.png` });
    const [linked] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}/assets`) && r.request().method() === "POST", { timeout: 120_000 }),
      picker.getByRole("option", { name: /MacBook Pro 14 \(2024\)/ }).click(),
    ]);
    expect(linked.status()).toBe(201);
    const linkedAsset = side.getByTestId("asset-linked");
    await slow(linkedAsset).toContainText(`${TAG}-00421 · Snipe-IT`);
    await expect(linkedAsset).toContainText("Deployed");
    await expect(linkedAsset).toContainText("Until Mar 2027");
    await expect(linkedAsset.getByRole("link", { name: /Open in Snipe-IT/ })).toHaveAttribute("href", `https://assets-${stamp}.example.com/hardware/1`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ticket-assets-1440-light.png` });

    // Its page: the ticket on it, the cached details while the source can't be reached.
    await linkedAsset.getByRole("link", { name: "MacBook Pro 14 (2024)" }).click();
    await slow(page.getByRole("heading", { level: 1, name: "MacBook Pro 14 (2024)" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(`${TAG}-00421`);
    await expect(page.getByRole("row").filter({ hasText: `#${number}` })).toContainText("Daniel Okafor");
    await expect(page.getByText("London office")).toBeVisible();
    await expect(page.getByText(/Showing what was synced last/)).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/asset-page-1440-light.png`, fullPage: true });

    // Solve: the maintenance dialog first; the solve stands when the post fails.
    await page.goto(`/desk/tickets/${number}`);
    await slow(page.getByTestId("asset-linked")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Solve #${number}` });
    await slow(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Log a maintenance record in Snipe-IT" })).toBeChecked();
    await expect(dialog.getByLabel("Note")).toHaveValue(`CompassDocs #${number}.`);
    await dialog.getByLabel("Type").selectOption({ label: "Software support" });
    await dialog.getByLabel("Note").fill(`Re-paired the VPN client after a phone change. CompassDocs #${number}.`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/solve-maintenance-1440-light.png` });
    // Cancel keeps it open.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await api(page, `/api/helpdesk/tickets/${number}`)).body.ticket.status).not.toBe("solved");
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    const [, logged] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}`) && r.request().method() === "PATCH", { timeout: 120_000 }),
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${number}/assets/solve`) && r.request().method() === "POST", { timeout: 120_000 }),
      page.getByRole("dialog", { name: `Solve #${number}` }).getByRole("button", { name: "Solve and log" }).click(),
    ]);
    const outcome = await logged.json();
    expect(outcome.failed.length).toBe(1);
    await slow(page.getByText(/Solved, but the maintenance record wasn't logged/)).toBeVisible();
    const after = await api(page, `/api/helpdesk/tickets/${number}`);
    expect(after.body.ticket.status).toBe("solved");
    const notes = (after.body.messages as { kind: string; body: string }[]).filter((m) => m.kind === "internal");
    expect(notes.some((m) => /^Couldn't log the maintenance record in Snipe-IT for MacBook Pro 14 \(2024\)/.test(m.body))).toBe(true);
  });
});
