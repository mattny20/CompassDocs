import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Send-from addresses (Helpdesk 1.20.5): on Desk settings → Email an admin
// adds a send-from address, picks it on a help address with "Send replies
// from", sees it listed as used by that help address, and removes it after
// a confirm that names the help address, which goes back to the workspace
// address. No mail is sent here (the test send is covered by
// test/helpdesk-mailboxes.test.ts on a fake transport).
//
// The help addresses, the send-from addresses and the old single-address
// settings they mirror into are workspace state: written under the advisory
// lock the unit suites use for them (728351) and put back afterwards.
// Licensed rig only (the helpdesk is Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
const HELP = `help-${stamp}@northwind.example`;
const SENDER = `it-support-${stamp}@northwind.example`;
const SPARE = `no-reply-${stamp}@northwind.example`;
const LOCK = 728351;
const VIEWER = { username: "e2e_send_viewer", password: "E2eSendViewer!123" };

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("send-from addresses (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let touched = false;
  let savedBoxes: Record<string, unknown>[] = [];
  let savedSenders: Record<string, unknown>[] = [];
  let savedTickets: { id: number; mailbox_id: number }[] = [];
  let savedSettings: string | null | undefined;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
  });

  test.afterAll(async () => {
    if (touched) {
      // The workspace's own addresses and settings, as found.
      await db.query("DELETE FROM hd_mailboxes");
      await db.query("DELETE FROM hd_send_addresses");
      const put = async (table: string, rows: Record<string, unknown>[]) => {
        for (const b of rows) {
          const cols = Object.keys(b);
          await db.query(`INSERT INTO ${table} (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => b[c])).catch(() => undefined);
        }
      };
      await put("hd_send_addresses", savedSenders);
      await put("hd_mailboxes", savedBoxes);
      for (const t of savedTickets) await db.query("UPDATE hd_tickets SET mailbox_id = $2 WHERE id = $1", [t.id, t.mailbox_id]).catch(() => undefined);
      if (savedSettings === null) await db.query("DELETE FROM settings WHERE key = 'helpdesk_settings'");
      else if (savedSettings !== undefined) await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [savedSettings]);
      await db.query("DELETE FROM audit_log WHERE target_type IN ('helpdesk_mailbox', 'helpdesk_send_address') AND target_label = ANY($1)", [[HELP, SENDER, SPARE]]);
    }
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
  });

  test("add an address, pick it on a help address, it shows as in use, remove it with the confirm", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    savedBoxes = (await db.query("SELECT * FROM hd_mailboxes ORDER BY id")).rows;
    savedSenders = (await db.query("SELECT * FROM hd_send_addresses ORDER BY id")).rows;
    savedTickets = (await db.query("SELECT id, mailbox_id FROM hd_tickets WHERE mailbox_id IS NOT NULL")).rows;
    savedSettings = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0]?.value ?? null;
    touched = true;
    await db.query("DELETE FROM hd_mailboxes");
    await db.query("DELETE FROM hd_send_addresses");
    // No old single address to seed a help address from.
    if (savedSettings) await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [JSON.stringify({ ...JSON.parse(savedSettings), inbound_address: "" })]);

    // --- The empty list, and where the mail goes through ---
    await page.goto("/desk/settings/email");
    await expect(page.getByRole("heading", { level: 1, name: "Email" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("heading", { name: "Send-from addresses" })).toBeVisible();
    await expect(page.getByText("No send-from addresses yet.")).toBeVisible();
    await expect(page.getByText("Mail goes out through your workspace mail server (Settings, Notifications, Email).")).toBeVisible();
    await expect(page.getByText("Your mail provider, such as SMTP2GO, must allow each address")).toBeVisible();

    // --- Add two send-from addresses through the dialog ---
    async function addSender(address: string, name: string) {
      await page.getByRole("button", { name: "Add send-from address" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add send-from address" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Address", { exact: true }).fill(address);
      if (name) await dialog.getByLabel("From name (optional)").fill(name);
      await dialog.getByRole("button", { name: "Add send-from address" }).click();
      return dialog;
    }
    // The form's own rule first: an address.
    await page.getByRole("button", { name: "Add send-from address" }).first().click();
    const empty = page.getByRole("dialog", { name: "Add send-from address" });
    await empty.getByRole("button", { name: "Add send-from address" }).click();
    await expect(empty.getByText("Enter the address to send from.")).toBeVisible();
    await empty.getByRole("button", { name: "Cancel" }).click();
    await expect(empty).toBeHidden();

    await expect(await addSender(SENDER, "Northwind IT Help")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("Send-from address added. Pick it when you edit a help address.")).toBeVisible();
    await expect(await addSender(SPARE, "")).toBeHidden({ timeout: 30_000 });
    const senders = page.getByTestId("hd-send-address-row");
    await expect(senders).toHaveCount(2);
    const senderRow = senders.filter({ hasText: SENDER });
    await expect(senderRow).toContainText("From name: Northwind IT Help");
    await expect(senderRow).toContainText("Not used by a help address");
    await expect(senders.filter({ hasText: SPARE })).toContainText("Uses the help address's name");
    // The same address again is refused in the dialog, in the server's words.
    const dup = await addSender(SENDER.toUpperCase(), "");
    await expect(dup.getByText("That address is already on the list.")).toBeVisible();
    await dup.getByRole("button", { name: "Cancel" }).click();

    // --- A help address picks one of them ---
    await page.getByRole("button", { name: "Add address" }).first().click();
    const add = page.getByRole("dialog", { name: "Add address" });
    await add.getByLabel("Address", { exact: true }).fill(HELP);
    await add.getByLabel("From name").fill("Northwind Help Desk");
    const from = add.getByRole("combobox", { name: "Send replies from" });
    await expect(from).toHaveValue("");
    await expect(from.locator("option")).toContainText(["The workspace address", `${SENDER} (Northwind IT Help)`, SPARE, `${HELP} (adds it to your send-from addresses)`]);
    await expect(add.getByText("Answers always come back to this help address, whatever address the reply was sent from.")).toBeVisible();
    await from.selectOption({ label: `${SENDER} (Northwind IT Help)` });
    await expect(add.getByText('Replies will be from "Northwind IT Help", the name set on that send-from address.')).toBeVisible();
    await add.getByRole("button", { name: "Add address" }).click();
    await expect(add).toBeHidden({ timeout: 30_000 });

    const helpRow = page.getByTestId("hd-mailbox-row").filter({ hasText: HELP });
    await expect(helpRow.getByTestId("hd-mailbox-sends-from")).toContainText(`Sends from ${SENDER}`);
    // It shows as in use, by name.
    await expect(senderRow.getByTestId("hd-send-address-used-by")).toContainText(`Used by ${HELP}`);
    const stored = await db.query("SELECT m.send_from, s.address FROM hd_mailboxes m JOIN hd_send_addresses s ON s.id = m.send_address_id WHERE m.address = $1", [HELP]);
    expect(stored.rows).toEqual([{ send_from: false, address: SENDER }]);
    // Edit shows the pick.
    await helpRow.getByRole("button", { name: `Edit ${HELP}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${HELP}` });
    await expect(edit.getByRole("combobox", { name: "Send replies from" }).locator("option:checked")).toHaveText(`${SENDER} (Northwind IT Help)`);
    await edit.getByRole("button", { name: "Cancel" }).click();

    // --- Removing the one in use: the confirm names the help address, which goes back to the workspace address ---
    await senderRow.getByRole("button", { name: `Remove send-from address ${SENDER}` }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: `Remove ${SENDER}?` });
    await expect(confirm).toContainText(`${HELP} sends replies from it. It goes back to the workspace address`);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(senders).toHaveCount(2);
    await senderRow.getByRole("button", { name: `Remove send-from address ${SENDER}` }).click();
    await confirm.getByRole("button", { name: "Remove address" }).click();
    await expect(page.getByText("Send-from address removed. 1 help address now sends from the workspace address.")).toBeVisible({ timeout: 30_000 });
    await expect(senders).toHaveCount(1);
    await expect(helpRow).toBeVisible();
    await expect(helpRow.getByTestId("hd-mailbox-sends-from")).toHaveCount(0);
    expect((await db.query("SELECT send_address_id, send_from FROM hd_mailboxes WHERE address = $1", [HELP])).rows).toEqual([{ send_address_id: null, send_from: false }]);
    // One that nothing uses says so, and just goes.
    await senders.filter({ hasText: SPARE }).getByRole("button", { name: `Remove send-from address ${SPARE}` }).click();
    const spare = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: `Remove ${SPARE}?` });
    await expect(spare).toContainText("No help address sends from it");
    await spare.getByRole("button", { name: "Remove address" }).click();
    await expect(page.getByText("No send-from addresses yet.")).toBeVisible({ timeout: 30_000 });
    const audit = await db.query("SELECT action, details FROM audit_log WHERE target_type = 'helpdesk_send_address' AND target_label = $1 ORDER BY id", [SENDER]);
    expect(audit.rows.map((r) => r.action)).toEqual(["helpdesk.send_address.created", "helpdesk.send_address.deleted"]);
    expect(audit.rows[1].details.help_addresses).toEqual([HELP]);

    // Nobody without the email channel's capability reaches the list.
    await ensureUser(page, VIEWER, "viewer", "Tomas Reyes");
    const other = await browser.newContext();
    const vp = await other.newPage();
    await login(vp, VIEWER);
    expect((await api(vp, "/api/helpdesk/admin/send-addresses")).status).toBe(403);
    expect((await api(vp, "/api/helpdesk/admin/send-addresses", { method: "POST", body: { address: `x-${stamp}@northwind.example` } })).status).toBe(403);
    await other.close();
  });
});
