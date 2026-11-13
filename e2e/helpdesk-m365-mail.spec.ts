import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { startFakeM365, type FakeM365 } from "../test/helpers/fake-m365";
import { ADMIN, api, login } from "./helpers";

// The Microsoft 365 mailbox connection (Helpdesk 1.20.7), end to end on Desk
// settings → Email against a fake Microsoft on this machine
// (test/helpers/fake-m365): set up (the one-click flow when the enterprise
// build has it, else the manual form), connect a mailbox that the app may
// not read yet, the restrict-access commands, Check access before and after
// "the admin ran them", a help address placed on the mailbox that sends
// through Microsoft 365, mail read with Check now and by a notification,
// Send test, an error state, and removing it all.
//
// It runs only where the app was started with the test seam
// (COMPASSDOCS_M365_MAIL_TEST_BASE=http://127.0.0.1:PORT, see
// lib/helpdesk/m365/graph, and COMPASSDOCS_SSO_SETUP_LOGIN_BASE / _GRAPH_BASE
// at <base>/login and <base>/graph for the one-click flow): everywhere else,
// CI's community build included, it skips itself. Nothing here may contact
// Microsoft. It never touches a connection that is already set up.
//
// The email settings and the help addresses are workspace state: written
// under the advisory lock the unit suites use (728351) and put back.

const stamp = `${Date.now()}`;
const HELP = `help-${stamp}@acme.example`;
const OTHER = `ceo-${stamp}@acme.example`;
const GROUP = `everyone-${stamp}@acme.example`;
const customer = `cara.${stamp}@clientco.example`;
const PAGE = "/desk/settings/email";
const LOCK = 728351;

test.describe.configure({ mode: "serial" });

test.describe("Microsoft 365 mailboxes (licensed, fake Microsoft)", () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
  let fake: FakeM365 | null = null;
  let base = "";
  let ours = false;
  let saved: { key: string; value: string | null }[] = [];

  const ctl = async (op: string, body?: unknown) => (await fetch(`${base}/__fake/${op}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })).json();

  test.beforeAll(async () => {
    await db.connect();
  });

  test.afterAll(async ({ browser }) => {
    if (ours) {
      const page = await browser.newPage();
      await login(page, ADMIN);
      const v = (await api(page, "/api/helpdesk/admin/m365-mail")).body;
      for (const m of v?.mailboxes ?? []) await api(page, `/api/helpdesk/admin/m365-mail/mailboxes/${m.id}`, { method: "DELETE" });
      await api(page, "/api/helpdesk/admin/m365-mail", { method: "DELETE" });
      await page.close();
      await db.query("DELETE FROM hd_tickets WHERE requester_email = $1", [customer]);
      await db.query("DELETE FROM hd_m365_mailboxes WHERE address = $1", [HELP]);
      await db.query("DELETE FROM hd_mailboxes WHERE address = $1", [HELP]);
      await db.query("DELETE FROM settings WHERE key = 'helpdesk_m365_mail'");
      for (const s of saved) {
        if (s.value === null) await db.query("DELETE FROM settings WHERE key = $1", [s.key]);
        else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
      }
      await db.query("DELETE FROM audit_log WHERE action LIKE 'helpdesk.m365.%' AND at > now() - interval '1 hour'");
      await db.query("DELETE FROM audit_log WHERE target_type = 'helpdesk_mailbox' AND target_label = $1", [HELP]);
      await db.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    }
    await db.end();
    await fake?.close();
  });

  const card = (page: Page) => page.getByTestId("hd-m365");

  test("set up, limit access, read mail, send, and remove", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    const first = await api(page, "/api/helpdesk/admin/m365-mail");
    test.skip(first.status === 402 || first.status === 404, "the helpdesk is not licensed in this build; the EE rig runs the flow");
    const view = first.body as { connected?: boolean; mailboxes?: unknown[]; test_base?: string } | null;
    test.skip(!view?.test_base, "the rig was not started with COMPASSDOCS_M365_MAIL_TEST_BASE; nothing here may contact Microsoft");
    test.skip(Boolean(view?.connected) || (view?.mailboxes?.length ?? 0) > 0, "Microsoft 365 is already set up on this rig; this spec does not touch a real configuration");
    base = view!.test_base!;
    // The rig's own fake, when one is already listening; else one of ours on the port the seam names.
    const alive = await fetch(`${base}/__fake/ping`, { method: "POST" }).then((r) => r.ok, () => false);
    if (!alive) {
      try {
        fake = await startFakeM365({ port: Number(new URL(base).port) });
      } catch {
        test.skip(true, `port ${new URL(base).port} is in use by something that is not the fake Microsoft`);
      }
    }
    await ctl("reset");
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
    ours = true;
    for (const key of ["helpdesk_settings", "helpdesk_inbound_auth"]) saved.push({ key, value: (await db.query("SELECT value FROM settings WHERE key = $1", [key])).rows[0]?.value ?? null });
    for (const [address, kind] of [[HELP, "shared"], [OTHER, "user"], [GROUP, "group"]]) await ctl("mailbox", { address, kind });
    // Outside senders may write in for this run (the customer has no account).
    expect((await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { outside_senders: true } })).status).toBe(200);

    // --- Before setup -------------------------------------------------------------------
    await page.goto(PAGE);
    await expect(card(page)).toBeVisible({ timeout: 120_000 });
    const setup = card(page).getByRole("button", { name: "Set up automatically with Microsoft" });
    await expect(setup).toBeVisible({ timeout: 120_000 });
    await expect(card(page)).toContainText("Distribution lists and Microsoft 365 groups are not supported: use a shared mailbox instead.");
    await expect(card(page).getByText("Enter an app registration by hand")).toBeVisible();

    // --- Set up: one click where the enterprise build has it, else by hand ------------------
    const probe = await api(page, "/api/ee/m365-mail/setup/poll", { method: "POST", body: { setup_id: "none" } });
    if (probe.status === 410) {
      await setup.click();
      await expect(card(page).getByText("H7KQ2MZP9")).toBeVisible({ timeout: 60_000 });
      await expect(card(page).getByRole("status")).toContainText("Done. The app registration was created in Entra and saved here. It can't read any mailbox yet", { timeout: 120_000 });
      const made = (await ctl("state")).apps as { displayName: string; roles: string[] }[];
      expect(made.map((a) => [a.displayName, a.roles])).toEqual([["CompassDocs Helpdesk Mail", []]]);
    } else {
      const made = await ctl("app");
      await card(page).getByText("Enter an app registration by hand").click();
      await card(page).getByLabel("Tenant ID").fill(made.tenant);
      await card(page).getByLabel("Application (client) ID").fill(made.client_id);
      await card(page).getByLabel("Client secret").fill(made.secret);
      await card(page).getByRole("button", { name: "Connect", exact: true }).click();
    }
    await expect(card(page).getByRole("heading", { name: "Mailboxes" })).toBeVisible({ timeout: 60_000 });
    await expect(card(page)).toContainText("No mailbox is connected yet.");
    // The secret is nowhere on the page or in the view.
    const state1 = await ctl("state");
    expect(JSON.stringify((await api(page, "/api/helpdesk/admin/m365-mail")).body)).not.toContain("fake~");
    expect(state1.apps.length).toBe(1);

    // --- A group is refused; the shared mailbox is listed, waiting for access -----------------
    const address = card(page).getByLabel("Mailbox address");
    await address.fill(GROUP);
    await card(page).getByRole("button", { name: "Connect mailbox" }).click();
    await expect(card(page).getByRole("alert")).toContainText("can't be connected. Use a shared mailbox instead.", { timeout: 30_000 });
    await address.fill(HELP);
    await card(page).getByRole("button", { name: "Connect mailbox" }).click();
    const row = card(page).getByTestId("hd-m365-mailbox-row").filter({ hasText: HELP });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Waiting for access");
    await expect(row.getByTestId("hd-m365-mailbox-warning")).toContainText("has not let the app read this mailbox yet");

    // --- Limit access: the commands name this app and this mailbox ----------------------------
    const restrict = card(page).getByTestId("hd-m365-restrict");
    await expect(restrict).toHaveAttribute("open", "");
    const commands = restrict.getByTestId("hd-m365-commands");
    await expect(commands).toContainText("New-ServicePrincipal -AppId");
    await expect(commands).toContainText(`PrimarySmtpAddress -eq '${HELP}'`);
    await expect(commands).toContainText('-Role "Application Mail.ReadWrite" -CustomResourceScope "CompassDocs help mailboxes"');
    await expect(commands).toContainText('-Role "Application Mail.Send"');
    await expect(restrict.getByRole("button", { name: "Copy commands" }).first()).toBeVisible();
    await restrict.getByRole("button", { name: "Check access" }).click();
    const access = restrict.getByTestId("hd-m365-access");
    await expect(access).toContainText("No organisation-wide mail permission is granted in Entra.", { timeout: 30_000 });
    await expect(access).toContainText(`${HELP}: Microsoft 365 did not let the app read this mailbox`);

    // "The admin ran the commands": the fake's Exchange scope now holds the help mailbox, and nothing else.
    await ctl("scope", { addresses: [HELP] });
    await restrict.getByLabel("A mailbox the desk should not reach (optional)").fill(OTHER);
    await restrict.getByRole("button", { name: "Check access" }).click();
    await expect(access).toContainText(`${HELP}: the app can read it.`, { timeout: 30_000 });
    await expect(access).toContainText(`${OTHER}: Microsoft 365 refused, as it should. The app can't read this mailbox.`);

    // --- A help address on the mailbox, sending through Microsoft 365 -------------------------
    await page.getByRole("button", { name: "Add address" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Address", { exact: true }).fill(HELP);
    await dialog.getByLabel("From name").fill("Acme Help");
    await dialog.getByTestId("hd-mailbox-m365-pick").selectOption({ label: HELP });
    await dialog.getByLabel("Send replies from").selectOption("m365");
    await expect(dialog).toContainText(`Replies go out through Microsoft 365 as ${HELP} and show in its Sent Items.`);
    await dialog.getByRole("button", { name: "Add address", exact: true }).click();
    const addressRow = page.getByTestId("hd-mailbox-row").filter({ hasText: HELP });
    await expect(addressRow.getByTestId("hd-mailbox-m365")).toBeVisible({ timeout: 30_000 });
    await expect(addressRow.getByTestId("hd-mailbox-m365-send")).toContainText(`Sends through Microsoft 365 as ${HELP}`);
    await expect(row).toContainText(`Help address: ${HELP}`);

    // --- Mail arrives: Check now reads it; then a notification brings the next at once ---------
    await ctl("message", { address: HELP, subject: `Invoice ${stamp} looks wrong`, from: { name: "Cara Customer", address: customer }, body: { contentType: "text", content: "The total is off by ten." } });
    await row.getByRole("button", { name: "Check now" }).click();
    await expect(row).toContainText("1 taken in, 0 dropped", { timeout: 60_000 });
    await expect(row).not.toContainText("Waiting for access");
    const ticket = (await db.query("SELECT number, mailbox_id FROM hd_tickets WHERE requester_email = $1 AND subject = $2", [customer, `Invoice ${stamp} looks wrong`])).rows;
    expect(ticket.length).toBe(1);
    let inboxState = (await ctl("state")).mailboxes.find((m: { address: string }) => m.address === HELP);
    expect(inboxState.messages.map((m: { isRead: boolean }) => m.isRead)).toEqual([true]);
    // Check now also set up notifications (the dev server is on loopback, which the seam lets the fake call back).
    await expect(row).toContainText("Notifications on", { timeout: 60_000 });
    const second = await ctl("message", { address: HELP, subject: `Second ${stamp}`, from: { name: "Cara Customer", address: customer }, body: { contentType: "text", content: "And one more thing." } });
    expect((await ctl("deliver", { address: HELP, id: second.id })).status).toBe(202);
    await expect.poll(async () => (await db.query("SELECT count(*)::int AS n FROM hd_tickets WHERE requester_email = $1", [customer])).rows[0].n, { timeout: 60_000 }).toBe(2);
    // The same notification again, and a read on top: still two.
    await ctl("deliver", { address: HELP, id: second.id });
    await row.getByRole("button", { name: "Check now" }).click();
    await expect(row).toContainText("2 taken in, 0 dropped", { timeout: 60_000 });
    expect((await db.query("SELECT count(*)::int AS n FROM hd_tickets WHERE requester_email = $1", [customer])).rows[0].n).toBe(2);

    // --- Send test goes through Microsoft 365 (when the admin has an email address to send to) ----
    const sent = await api(page, `/api/helpdesk/admin/mailboxes/${(await db.query("SELECT id FROM hd_mailboxes WHERE address = $1", [HELP])).rows[0].id}/test`, { method: "POST", body: {} });
    if (sent.status === 200) {
      expect([sent.body.ok, sent.body.via, sent.body.from]).toEqual([true, "microsoft_365", HELP]);
      inboxState = (await ctl("state")).mailboxes.find((m: { address: string }) => m.address === HELP);
      // Sent Items also hold what the desk already sent the customer about the two tickets, as the mailbox.
      const testMail = (inboxState.sent as string[]).find((m) => m.includes("This test was sent through Microsoft 365"));
      expect(testMail).toContain(`From: Acme Help <${HELP}>`);
      expect((inboxState.sent as string[]).some((m) => m.includes(`To: ${customer}`) && m.includes("Reply-To: help-"))).toBe(true);
    } else expect(sent.status).toBe(400);

    // --- An error state: Microsoft down, in words on the row -------------------------------------
    await ctl("set", { fail: { delta: 503 } });
    await row.getByRole("button", { name: "Check now" }).click();
    await expect(row.getByTestId("hd-m365-mailbox-warning")).toContainText("Microsoft 365 had a problem (error 503). The desk tries again shortly.", { timeout: 60_000 });
    await expect(card(page).locator("xpath=ancestor::section").getByText("Needs attention").first()).toBeVisible();
    await ctl("set", { fail: {} });
    await row.getByRole("button", { name: "Check now" }).click();
    await expect(row.getByTestId("hd-m365-mailbox-warning")).toHaveCount(0, { timeout: 60_000 });

    // --- Options: move to a folder -----------------------------------------------------------------
    await card(page).getByTestId("hd-m365-options").locator("summary").click();
    await card(page).getByLabel("Move it to a folder").check();
    await card(page).getByRole("button", { name: "Save options" }).click();
    await expect(page.getByText("Microsoft 365 options saved.")).toBeVisible({ timeout: 30_000 });
    const third = await ctl("message", { address: HELP, subject: `Third ${stamp}`, from: { name: "Cara Customer", address: customer }, body: { contentType: "text", content: "Filed away." } });
    await row.getByRole("button", { name: "Check now" }).click();
    await expect(row).toContainText("3 taken in", { timeout: 60_000 });
    inboxState = (await ctl("state")).mailboxes.find((m: { address: string }) => m.address === HELP);
    expect(inboxState.folders).toEqual(["Processed"]);
    expect(inboxState.messages.find((m: { id: string }) => m.id === third.id).folder).toBe("Processed");

    // --- Remove: the mailbox, then the connection; the page is back to "not set up" ---------------
    await row.getByRole("button", { name: `Disconnect ${HELP}` }).click();
    await page.getByRole("button", { name: "Disconnect mailbox" }).click();
    await expect(card(page).getByTestId("hd-m365-mailbox-row")).toHaveCount(0, { timeout: 30_000 });
    await expect(addressRow.getByTestId("hd-mailbox-m365")).toHaveCount(0);
    expect((await ctl("state")).subscriptions).toEqual([]);
    await card(page).getByTestId("hd-m365-app").locator("summary").click();
    await card(page).getByRole("button", { name: "Remove connection" }).click();
    await page.getByRole("button", { name: "Remove connection" }).last().click();
    await expect(card(page).getByText("Enter an app registration by hand")).toBeVisible({ timeout: 30_000 });
    expect((await api(page, "/api/helpdesk/admin/m365-mail")).body.connected).toBe(false);
  });

  test("without a session nothing answers: the admin routes 401, the notification address 404", async ({ page }) => {
    await login(page, ADMIN);
    const first = await api(page, "/api/helpdesk/admin/m365-mail");
    test.skip(first.status === 402 || first.status === 404, "the helpdesk is not licensed in this build");
    // No session: every route answers 401 and the notification address 404, whatever is sent.
    const anon = await page.context().browser()!.newContext();
    const res = await anon.request.get("/api/helpdesk/admin/m365-mail");
    expect(res.status()).toBe(401);
    expect((await anon.request.post("/api/helpdesk/admin/m365-mail/check-access", { data: {} })).status()).toBe(401);
    expect((await anon.request.post("/api/helpdesk/m365/notify/not-the-key?validationToken=hello", { data: {} })).status()).toBe(404);
    expect((await anon.request.post("/api/helpdesk/m365/notify/not-the-key", { data: { value: [{ subscriptionId: "x", clientState: "y" }] } })).status()).toBe(404);
    await anon.close();
  });
});
