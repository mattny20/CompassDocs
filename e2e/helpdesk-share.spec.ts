import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Share and print a ticket (Helpdesk 1.19.4, area C6; mock-ups u1 to u5).
// The ticket's … menu (Share with an agent…, Copy link, Print or save as
// PDF…), the share dialog (an agent outside the team listed disabled with
// the reason), the agents-only timeline line, the recipient's bell, Ctrl+P
// opening the print dialog, and the print page (notes only when chosen,
// audited by the server as it renders, 404 for an agent outside the team).
// Each run makes its own teams, agents and ticket (stamped) and removes
// them. With E2E_SHOTS_DIR set it keeps screenshots, light and dark.

const SAM = { username: "e2e_hd_share_sam", password: "E2eShareSam!12345" };
const LENA = { username: "e2e_hd_share_lena", password: "E2eShareLena!12345" };
const DANIEL = { username: "e2e_hd_share_daniel", password: "E2eShareDan!12345" };
const SHOTS = process.env.E2E_SHOTS_DIR;
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const see = expect.configure({ timeout: 30_000 });

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("share and print a ticket (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.describe.configure({ mode: "serial", timeout: 300_000 });
  const stamp = Date.now().toString(36);
  const ids = { sam: 0, lena: 0, teamA: 0, teamB: 0, ticket: 0, number: 0 };

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const db = new Client({ connectionString: DB });
    await db.connect();
    try {
      // Deleting through the API now moves a ticket to the recycle bin (1.19.4, C7): remove ours for good.
      if (ids.ticket) {
        await db.query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1", [String(ids.ticket)]);
        await db.query("DELETE FROM hd_tickets WHERE id = $1", [ids.ticket]);
      }
      if (ids.number) await db.query("DELETE FROM notifications WHERE link = $1 AND user_id = ANY($2)", [`/desk/tickets/${ids.number}`, [ids.sam, ids.lena]]);
    } finally {
      await db.end();
    }
    for (const id of [ids.sam, ids.lena]) if (id) await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    for (const id of [ids.teamA, ids.teamB]) if (id) await api(page, `/api/helpdesk/admin/teams/${id}`, { method: "DELETE" });
    await page.close();
    // This file's own accounts go too: a shared rig's active-user count is read by other suites (ack-notices caps at 100).
    const db2 = new Client({ connectionString: DB });
    await db2.connect();
    try {
      const names = [SAM.username, LENA.username, DANIEL.username];
      const sub = "SELECT id FROM users WHERE username = ANY($1)";
      for (const t of ["notifications", "sessions", "role_assignments", "hd_notify_prefs"]) await db2.query(`DELETE FROM ${t} WHERE user_id IN (${sub})`, [names]).catch(() => undefined);
      await db2.query("DELETE FROM users WHERE username = ANY($1)", [names]);
    } finally {
      await db2.end();
    }
  });

  test("share from the … menu; the recipient's bell; Ctrl+P prints from a dialog", async ({ page, browser }) => {
    const users = async () => (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    await ensureUser(page, SAM, "viewer", "Sam Lee");
    await ensureUser(page, LENA, "viewer", "Lena Fischer");
    await ensureUser(page, DANIEL, "viewer", "Daniel Okafor");
    const all = await users();
    const myId = all.find((u) => u.username === ADMIN.username)!.id;
    ids.sam = all.find((u) => u.username === SAM.username)!.id;
    ids.lena = all.find((u) => u.username === LENA.username)!.id;
    const danielId = all.find((u) => u.username === DANIEL.username)!.id;

    const teamA = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Service Desk ${stamp}`, icon: "monitor", members: [{ user_id: myId, role: "lead" }] } });
    expect(teamA.status, JSON.stringify(teamA.body)).toBe(201);
    ids.teamA = teamA.body.team.id;
    const teamB = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Facilities ${stamp}`, icon: "building" } });
    expect(teamB.status, JSON.stringify(teamB.body)).toBe(201);
    ids.teamB = teamB.body.team.id;
    for (const [id, team] of [[ids.sam, ids.teamA], [ids.lena, ids.teamB]] as const) {
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
      const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: id, role: "agent", team_ids: [team] } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }

    const created = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Laptop won't connect to VPN from home ${stamp}`, body: "Since this morning the VPN client says Authentication failed.", team_id: ids.teamA, priority: "high", requester_id: danielId },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ids.number = created.body.ticket.number;
    ids.ticket = created.body.ticket.id;
    const n = ids.number;
    expect((await api(page, `/api/helpdesk/tickets/${n}/messages`, { method: "POST", body: { kind: "internal", body: `MFA re-enrolled yesterday ${stamp}` } })).status).toBe(201);

    // u1: the … menu.
    await page.goto(`/desk/tickets/${n}?team=${ids.teamA}`);
    await see(page.getByRole("heading", { level: 2, name: new RegExp(`Laptop won't connect to VPN from home ${stamp}`) })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: `More actions for ticket #${n}` }).click();
    const menu = page.getByRole("menu", { name: `Ticket #${n}` });
    await see(menu.getByRole("menuitem", { name: /^Share with an agent…/ })).toBeVisible();
    await see(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await see(menu.getByRole("menuitem", { name: /^Print or save as PDF…/ })).toHaveAttribute("aria-keyshortcuts", "Control+P Meta+P");
    await shot(page, "u1-ticket-menu");

    // u2: the share dialog. Lena (another team) is listed, disabled, with the reason.
    await menu.getByRole("menuitem", { name: /^Share with an agent…/ }).click();
    const dialog = page.getByRole("dialog", { name: `Share #${n}` });
    await see(dialog).toBeVisible();
    const lena = dialog.getByRole("option", { name: /Lena Fischer/ });
    await see(lena).toHaveAttribute("aria-disabled", "true");
    await see(lena).toContainText(`Can't see E2E Service Desk ${stamp} tickets`);
    await dialog.getByRole("combobox").fill("Sam");
    await dialog.getByRole("option", { name: /Sam Lee/ }).click();
    await see(dialog.getByRole("option", { name: /Sam Lee/ })).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("combobox").fill("");
    await dialog.getByRole("textbox", { name: /Message/ }).fill("Can you check the MFA side? You re-enrolled Daniel's phone yesterday.");
    await see(dialog.getByRole("checkbox", { name: /Make them follow this ticket/ })).toBeChecked();
    await shot(page, "u2-share-dialog");
    if (SHOTS) {
      // On a phone the dialog fills the width without sideways scroll.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SHOTS}/u2-share-dialog-390-light.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await see(page.getByText(`Shared #${n} with Sam Lee.`)).toBeVisible();
    const line = page.getByTestId("share-line");
    await see(line).toContainText("shared this with Sam Lee");
    await see(line).toContainText("Agents only");
    await line.scrollIntoViewIfNeeded();
    await shot(page, "u3-share-line");
    const people = await api(page, `/api/helpdesk/tickets/${n}/people`);
    expect(JSON.stringify(people.body)).toContain("Sam Lee");

    // u3: Sam's bell.
    const samCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sam = await samCtx.newPage();
    try {
      await login(sam, SAM);
      await sam.goto(`/desk/tickets/${n}?team=${ids.teamA}`);
      await see(sam.getByRole("heading", { level: 2, name: new RegExp(`Laptop won't connect to VPN from home ${stamp}`) })).toBeVisible({ timeout: 60_000 });
      await sam.getByRole("button", { name: /^Notifications/ }).click();
      await see(sam.getByText(new RegExp(`shared #${n} with you`))).toBeVisible();
      await see(sam.getByText(/Can you check the MFA side\?/).first()).toBeVisible();
      await shot(sam, "u3-shared-with-you");
      // Sam can't print or share it for someone outside the team either: the routes refuse Lena.
    } finally {
      await samCtx.close();
    }

    // u4: Ctrl+P on the ticket opens the print dialog.
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 5, y: 600 } });
    await page.keyboard.press("Control+p");
    const print = page.getByRole("dialog", { name: `Print #${n}` });
    await see(print).toBeVisible();
    await see(print.getByRole("checkbox", { name: /The conversation/ })).toBeDisabled();
    await see(print.getByRole("checkbox", { name: /Internal notes/ })).not.toBeChecked();
    await see(print.getByRole("checkbox", { name: /Details/ })).toBeChecked();
    await shot(page, "u4-print-dialog");

    // Print without notes: a new tab with the paper.
    const popupP = page.waitForEvent("popup");
    await print.getByRole("button", { name: "Print", exact: true }).click();
    const paper = await popupP;
    await paper.waitForLoadState();
    expect(paper.url()).toContain(`/desk/tickets/${n}/print?include=details%2Cchecklists%2Cattachments`);
    const sheet = paper.getByTestId("ticket-print");
    await see(sheet).toContainText("Since this morning the VPN client says Authentication failed.");
    await see(sheet).not.toContainText(`MFA re-enrolled yesterday ${stamp}`);
    await see(sheet).not.toContainText("shared this with");
    await see(sheet).toContainText("Internal notes not included.");
    await paper.close();
  });

  test("the print page: notes when chosen, audited, light on paper, 404 outside the team", async ({ page, browser }) => {
    test.skip(!ids.number, "the share test made the ticket");
    const n = ids.number;
    await page.goto(`/desk/tickets/${n}/print?include=details,notes,checklists,time,attachments`);
    const sheet = page.getByTestId("ticket-print");
    await see(sheet).toContainText(`MFA re-enrolled yesterday ${stamp}`);
    await see(sheet).toContainText("shared this with Sam Lee");
    await see(sheet).toContainText("Internal notes included.");
    await see(page.getByRole("heading", { level: 1, name: "Print preview" })).toBeVisible();
    await see(page.getByRole("link", { name: `Ticket #${n}` })).toBeVisible();

    // The server records helpdesk.ticket.printed as it renders the sheet, with the parts it rendered:
    // the first test's tab (no notes) and this page (notes). Nothing is posted from the browser.
    const db = new Client({ connectionString: DB });
    await db.connect();
    const printedRows = async () =>
      (await db.query("SELECT actor_id, details FROM audit_log WHERE action = 'helpdesk.ticket.printed' AND target_id = $1 ORDER BY id", [String(ids.ticket)])).rows;
    try {
      const rows = await printedRows();
      expect(rows.map((r) => r.details.notes)).toEqual([false, true]);
      expect(rows[1].details).toMatchObject({ number: n, details: true, notes: true, checklists: true, time: true, attachments: true });
    } finally {
      await db.end();
    }

    // The sheet is white paper in dark mode too.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const bg = await sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(255, 255, 255)");
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await page.emulateMedia({ colorScheme: "light" });
    await shot(page, "u5-print-page");
    if (SHOTS) {
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: `${SHOTS}/u5-print-media-light.png`, fullPage: true });
      // "Save as PDF" as Chromium does it: print media, the @page size and furniture.
      await page.pdf({ path: `${SHOTS}/u5-ticket.pdf`, preferCSSPageSize: true });
      await page.emulateMedia({ media: "screen" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${SHOTS}/u5-print-page-390-light.png` });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(390);
    }

    // Lena works another team's queue: the print page and the routes are 404 for her.
    const lenaCtx = await browser.newContext();
    const lena = await lenaCtx.newPage();
    try {
      await login(lena, LENA);
      const res = await lena.goto(`/desk/tickets/${n}/print?include=notes`);
      expect(res?.status()).toBe(404);
      expect((await api(lena, `/api/helpdesk/tickets/${n}/share`)).status).toBe(404);
      // Her refused page wrote no audit row, and no route takes a printed-parts list from a browser.
      const db3 = new Client({ connectionString: DB });
      await db3.connect();
      try {
        const lenaRows = await db3.query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.ticket.printed' AND target_id = $1 AND actor_id = $2", [String(ids.ticket), ids.lena]);
        expect(lenaRows.rowCount).toBe(0);
      } finally {
        await db3.end();
      }
      expect((await api(page, `/api/helpdesk/tickets/${n}/printed`, { method: "POST", body: { include: [] } })).status).toBe(404);
    } finally {
      await lenaCtx.close();
    }
  });
});
