import net from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Several help addresses (Helpdesk 1.20.2): an admin adds two addresses on
// Desk settings → Email, mail comes in to each through the one webhook, the
// tickets land in the right team on the right address, an agent's reply
// leaves from the right address (read from the mail a tiny SMTP sink
// receives), the agent changes "Answer from", and removing an address in
// use says how many tickets move.
//
// The email settings, the mailboxes and the SMTP settings are workspace
// state: written under the advisory locks the unit suites use for them
// (728351 email settings, 728661 SMTP) and put back afterwards. Licensed rig
// only (the helpdesk is Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
const HELP = `help-${stamp}@acme.example`;
const BILLING = `billing-${stamp}@acme.example`;
const SMTP_FROM = `desk-${stamp}@mail.acme.example`;
const customer = `cara.${stamp}@clientco.example`;
const LOCKS = [728351, 728661];
// The agent who answers (not the e2e admin: a desk Admin's public replies are held for review).
const AGENT = { username: "e2e_mailbox_agent", password: "E2eMailboxAgent!123" };

// --- A minimal SMTP sink (as e2e/helpdesk-portal.spec.ts), keeping the envelope sender ------

const inbox: { from: string; to: string; data: string }[] = [];
function smtpSink(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      let inData = false;
      let rcpt = "";
      let mailFrom = "";
      sock.write("220 sink ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) break;
            inbox.push({ from: mailFrom, to: rcpt, data: buf.slice(0, end) });
            buf = buf.slice(end + 5);
            inData = false;
            sock.write("250 OK\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
          else if (cmd === "MAIL") {
            mailFrom = (/<([^>]*)>/.exec(line)?.[1] ?? "").toLowerCase();
            sock.write("250 OK\r\n");
          } else if (cmd === "RCPT") {
            rcpt = (/<([^>]+)>/.exec(line)?.[1] ?? "").toLowerCase();
            sock.write("250 OK\r\n");
          } else if (cmd === "DATA") {
            inData = true;
            sock.write("354 go\r\n");
          } else if (cmd === "QUIT") {
            sock.end("221 bye\r\n");
          } else sock.write("250 OK\r\n");
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A header of a captured mail (unfolded). */
function header(data: string, name: string): string {
  const head = data.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  return new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1]?.trim() ?? "";
}

/** The newest mail to `to` whose body holds `needle`. */
async function mailTo(to: string, needle: string) {
  let found: (typeof inbox)[number] | undefined;
  await expect
    .poll(
      () => {
        found = [...inbox].reverse().find((m) => m.to === to.toLowerCase() && m.data.replace(/=\r\n/g, "").includes(needle));
        return !!found;
      },
      { timeout: 30_000, message: `a mail to ${to} holding "${needle}"` }
    )
    .toBe(true);
  return found!;
}

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

test.describe("help addresses (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let sink: { port: number; close: () => Promise<void> } | null = null;
  const saved = new Map<string, string | null>();
  let savedBoxes: Record<string, unknown>[] = [];
  let savedTickets: { id: number; mailbox_id: number }[] = [];
  const teams: number[] = [];
  const numbers: number[] = [];
  let adminEmailSet = false;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    for (const l of LOCKS) await db.query("SELECT pg_advisory_lock($1)", [l]);
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await login(page, ADMIN);
      for (const n of numbers) await db.query("DELETE FROM hd_tickets WHERE number = $1", [n]);
      await db.query("DELETE FROM hd_tickets WHERE requester_email = $1", [customer]);
      await db.query("DELETE FROM hd_mailboxes WHERE address = ANY($1)", [[HELP, BILLING]]);
      for (const id of teams) await api(page, `/api/helpdesk/admin/teams/${id}`, { method: "DELETE" });
    } finally {
      await page.close();
    }
    // The workspace's own addresses, as found.
    if (savedBoxes.length) {
      await db.query("DELETE FROM hd_mailboxes");
      for (const b of savedBoxes) {
        const cols = Object.keys(b);
        await db.query(`INSERT INTO hd_mailboxes (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => b[c])).catch(() => undefined);
      }
      for (const t of savedTickets) await db.query("UPDATE hd_tickets SET mailbox_id = $2 WHERE id = $1", [t.id, t.mailbox_id]).catch(() => undefined);
    }
    for (const [k, v] of saved) {
      if (v === null) await db.query("DELETE FROM settings WHERE key = $1", [k]);
      else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    await db.query(
      "DELETE FROM role_assignments WHERE user_id = (SELECT id FROM users WHERE username = $1) AND role_id = (SELECT id FROM roles WHERE key = 'helpdesk-agent')",
      [AGENT.username]
    );
    await db.query("DELETE FROM audit_log WHERE target_type = 'helpdesk_mailbox' AND target_label = ANY($1)", [[HELP, BILLING]]);
    if (adminEmailSet) await db.query("UPDATE users SET email = '' WHERE username = $1 AND email = $2", [ADMIN.username, `e2e-admin-${stamp}@acme.example`]);
    for (const l of [...LOCKS].reverse()) await db.query("SELECT pg_advisory_unlock($1)", [l]);
    await db.end();
    await sink?.close();
  });

  async function keep(key: string) {
    if (saved.has(key)) return;
    const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
    saved.set(key, r.rows[0]?.value ?? null);
  }
  async function setSetting(key: string, value: string) {
    await keep(key);
    await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  }

  test("two addresses: mail lands on the right one, replies leave from it, Answer from changes it", async ({ page, browser }) => {
    test.setTimeout(900_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    // The workspace's state this spec changes, kept for afterAll.
    for (const k of ["helpdesk_settings", "helpdesk_inbound_auth"]) await keep(k);
    savedBoxes = (await db.query("SELECT * FROM hd_mailboxes ORDER BY id")).rows;
    savedTickets = (await db.query("SELECT id, mailbox_id FROM hd_tickets WHERE mailbox_id IS NOT NULL")).rows;
    await db.query("DELETE FROM hd_mailboxes");
    sink = await smtpSink();
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(sink.port));
    await setSetting("smtp_secure", "none");
    await setSetting("smtp_user", "");
    await setSetting("smtp_from", SMTP_FROM);

    // Two teams and an agent in both.
    await ensureUser(page, AGENT, "viewer", "Priya Shah");
    const agentId = (await db.query("SELECT id FROM users WHERE username = $1", [AGENT.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [agentId]
    );
    await db.query("DELETE FROM hd_agent_roles WHERE user_id = $1", [agentId]);
    const teamId: Record<string, number> = {};
    for (const name of ["Support", "Billing"]) {
      const r = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `${name} MB ${stamp}`, members: [{ user_id: agentId, role: "agent" }] } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      teamId[name] = r.body.team.id;
      teams.push(r.body.team.id);
    }

    // --- Settings → Email: the empty state, then two addresses through the dialog ---
    await page.goto("/desk/settings/email");
    await expect(page.getByRole("heading", { level: 1, name: "Email" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("No addresses yet.")).toBeVisible();
    await expect(page.getByText("Forward each of your addresses to this webhook.")).toBeVisible();

    async function addAddress(address: string, name: string, team: string, sendFrom: boolean) {
      await page.getByRole("button", { name: "Add address" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add address" });
      await expect(dialog).toBeVisible();
      // The form's own rules: an address, and a name.
      await dialog.getByRole("button", { name: "Add address" }).click();
      await expect(dialog.getByText("Enter the address people write to.")).toBeVisible();
      await dialog.getByLabel("Address", { exact: true }).fill(address);
      await dialog.getByLabel("From name").fill(name);
      await dialog.getByRole("combobox", { name: "Team" }).selectOption({ label: team });
      if (sendFrom) await dialog.getByRole("switch", { name: "Send replies from this address" }).click();
      await dialog.getByRole("button", { name: "Add address" }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
    }
    await addAddress(HELP, "Acme Help", `Support MB ${stamp}`, false);
    await addAddress(BILLING, "Acme Billing", `Billing MB ${stamp}`, true);
    const rows = page.getByTestId("hd-mailbox-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(HELP);
    await expect(rows.nth(0)).toContainText("Default");
    await expect(rows.nth(0)).toContainText(`Acme Help · Support MB ${stamp}`);
    await expect(rows.nth(1)).toContainText(BILLING);
    await expect(rows.nth(1)).toContainText("Sends from this address");
    await expect(rows.nth(1)).not.toContainText("Default");
    // The same address again is refused in the dialog, in the server's words.
    await page.getByRole("button", { name: "Add address" }).first().click();
    const dup = page.getByRole("dialog", { name: "Add address" });
    await dup.getByLabel("Address", { exact: true }).fill(BILLING.toUpperCase());
    await dup.getByLabel("From name").fill("Again");
    await dup.getByRole("button", { name: "Add address" }).click();
    await expect(dup.getByText("That address is already listed.")).toBeVisible();
    await dup.getByRole("button", { name: "Cancel" }).click();

    // Send test: to the admin's own address, from the address itself when it sends from it.
    const gave = await db.query("UPDATE users SET email = $2 WHERE username = $1 AND COALESCE(email, '') = '' RETURNING id", [ADMIN.username, `e2e-admin-${stamp}@acme.example`]);
    adminEmailSet = (gave.rowCount ?? 0) > 0;
    const adminEmail = (await db.query("SELECT email FROM users WHERE username = $1", [ADMIN.username])).rows[0].email as string;
    await rows.nth(1).getByRole("button", { name: "Send test" }).click();
    await expect(page.getByText(`Test sent to ${adminEmail} from ${BILLING}.`)).toBeVisible({ timeout: 30_000 });
    const testMail = await mailTo(adminEmail, "This test was sent from");
    expect(header(testMail.data, "From")).toContain(`<${BILLING}>`);
    expect(testMail.from).toBe(BILLING);

    // Inbound on, outside senders accepted (the customer has no account).
    let s = await api(page, "/api/helpdesk/admin/settings");
    if (!s.body.inbound_path) s = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { rotate_inbound_secret: true } });
    const patched = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { outside_senders: true } });
    expect(patched.status).toBe(200);
    const hook = patched.body.inbound_path as string;
    expect(hook).toMatch(/^\/api\/helpdesk\/inbound\//);
    // The old single-address setting follows the default address (a 1.20.1 reader sees the same).
    expect(patched.body.settings.inbound_address).toBe(HELP);
    expect(patched.body.settings.email_from_name).toBe("Acme Help");

    // --- One webhook, mail to each address ---
    async function mailIn(to: string, subject: string, extra: Record<string, unknown> = {}) {
      const r = await page.request.post(hook, {
        data: { from: `Cara Customer <${customer}>`, to, subject, text: `${subject}. Thanks, Cara`, message_id: `<${subject.replace(/\W+/g, "-")}-${stamp}@clientco.example>`, dmarc: "pass", ...extra },
      });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      if (body.ticket) numbers.push(body.ticket);
      return body as { outcome: string; ticket: number };
    }
    const toHelp = await mailIn(HELP, `Laptop will not start ${stamp}`);
    expect(toHelp.outcome).toBe("created");
    const toBilling = await mailIn(`Acme Billing <${BILLING.toUpperCase()}>`, `Invoice charged twice ${stamp}`);
    expect(toBilling.outcome).toBe("created");
    // A provider's forward: the To header is the provider's own address, the envelope recipient is ours.
    const viaEnvelope = await mailIn("abc123@inbound.provider.example", `Refund for order 77 ${stamp}`, { recipients: [BILLING] });
    expect(viaEnvelope.outcome).toBe("created");
    // An address that is not listed counts as the default.
    const unknown = await mailIn(`sales-${stamp}@acme.example`, `Do you sell licences ${stamp}`);
    expect(unknown.outcome).toBe("created");
    // Delivered to the help address (the envelope) with the billing address written into To: the
    // envelope decides, the sender does not.
    const forgedTo = await mailIn(BILLING, `Payroll question ${stamp}`, { recipients: [HELP] });
    expect(forgedTo.outcome).toBe("created");
    // Mail from one of our own addresses that is also in one of our threads is a loop, never a
    // ticket, and the drop is in the audit log.
    const loop = await page.request.post(hook, {
      data: { from: BILLING, to: HELP, subject: `Loop ${stamp}`, text: "x", dmarc: "pass", in_reply_to: "<hd.k7q2xz9m4pqa1b2c.root@acme.example>" },
    });
    expect((await loop.json()).outcome).toBe("ignored_loop");
    const dropped = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1 AND details->>'subject' = $2", [BILLING, `Loop ${stamp}`]);
    expect(dropped.rows.map((r) => [r.details.reason, r.details.signal])).toEqual([["own_address_loop", "thread"]]);
    await db.query("DELETE FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1", [BILLING]);

    const facts = async (n: number) => (await db.query("SELECT t.team_id, m.address FROM hd_tickets t LEFT JOIN hd_mailboxes m ON m.id = t.mailbox_id WHERE t.number = $1", [n])).rows[0];
    expect(await facts(toHelp.ticket)).toEqual({ team_id: teamId.Support, address: HELP });
    expect(await facts(toBilling.ticket)).toEqual({ team_id: teamId.Billing, address: BILLING });
    expect(await facts(viaEnvelope.ticket)).toEqual({ team_id: teamId.Billing, address: BILLING });
    expect(await facts(unknown.ticket)).toEqual({ team_id: teamId.Support, address: HELP });
    expect(await facts(forgedTo.ticket)).toEqual({ team_id: teamId.Support, address: HELP });

    // --- The agent: the address on the ticket and in the queue, and the reply's From ---
    const agentCtx = await browser.newContext();
    const desk = await agentCtx.newPage();
    await login(desk, AGENT);
    await desk.goto(`/desk/tickets/${toBilling.ticket}?team=${teamId.Billing}`);
    await expect(desk.getByRole("heading", { level: 2, name: `Invoice charged twice ${stamp}` })).toBeVisible({ timeout: 120_000 });
    await expect(desk.locator("article").getByTestId("ticket-address")).toHaveText(`· to ${BILLING}`);
    const answerFrom = desk.getByTestId("answer-from");
    await expect(answerFrom).toHaveAccessibleName(`Answer from: ${BILLING}`);
    // The queue's rows name the address too.
    await expect(desk.locator(`li[data-number="${toBilling.ticket}"]`).getByTestId("ticket-address")).toContainText(BILLING);

    async function reply(text: string) {
      await desk.getByRole("textbox", { name: "Reply" }).fill(text);
      const sent = desk.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST", { timeout: 120_000 });
      await desk.getByRole("button", { name: "Send", exact: true }).click();
      const res = await sent;
      expect(res.status()).toBeLessThan(300);
      expect((await res.json()).held).toBeFalsy();
    }
    await reply(`We have refunded the second charge ${stamp}.`);
    const fromBilling = await mailTo(customer, `We have refunded the second charge ${stamp}.`);
    expect(header(fromBilling.data, "From")).toMatch(new RegExp(`Acme Billing.*<${BILLING.replace(/[.+]/g, "\\$&")}>`));
    expect(fromBilling.from, "the envelope sender follows the From header").toBe(BILLING);
    expect(header(fromBilling.data, "Reply-To")).toMatch(new RegExp(`^billing-${stamp}\\+hd-[a-z0-9]{16}@acme\\.example$`));

    // The customer answers that mail: it threads into the ticket, which keeps its address.
    const replyTo = header(fromBilling.data, "Reply-To");
    const back = await mailIn(replyTo, `Re: Invoice charged twice ${stamp}`, { text: `Thank you ${stamp}!`, message_id: `<re-1-${stamp}@clientco.example>` });
    expect(back).toMatchObject({ outcome: "appended", ticket: toBilling.ticket });
    expect((await facts(toBilling.ticket)).address).toBe(BILLING);

    // Change Answer from to the help address: the next reply leaves under its name, from the workspace address.
    await answerFrom.click();
    await desk.getByRole("menuitemradio", { name: new RegExp(HELP.replace(/[.+]/g, "\\$&")) }).click();
    await expect(desk.getByText("Answer-from address changed.")).toBeVisible({ timeout: 30_000 });
    await expect(answerFrom).toHaveAccessibleName(`Answer from: ${HELP}`);
    await expect(desk.getByText(new RegExp(`changed the address this ticket is answered from`))).toBeVisible();
    await reply(`Anything else we can do ${stamp}?`);
    const fromHelp = await mailTo(customer, `Anything else we can do ${stamp}?`);
    expect(header(fromHelp.data, "From")).toMatch(new RegExp(`Acme Help.*<${SMTP_FROM.replace(/[.+]/g, "\\$&")}>`));
    expect(fromHelp.from).toBe(SMTP_FROM);
    expect(header(fromHelp.data, "Reply-To")).toMatch(new RegExp(`^help-${stamp}\\+hd-[a-z0-9]{16}@acme\\.example$`));
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.mailbox_changed' AND details->>'number' = $1", [String(toBilling.ticket)]);
    expect(audit.rows.map((r) => r.details)).toEqual([{ number: toBilling.ticket, from: BILLING, to: HELP }]);

    // The queue's Address filter.
    await desk.goto(`/desk?view=all&mailbox=${encodeURIComponent(BILLING)}`);
    await expect(desk.getByText(`Address ${BILLING}`)).toBeVisible({ timeout: 60_000 });
    await expect(desk.locator(`li[data-number="${viaEnvelope.ticket}"]`)).toBeVisible();
    await expect(desk.locator(`li[data-number="${toHelp.ticket}"]`)).toHaveCount(0);
    await agentCtx.close();

    // --- Removing an address in use: the dialog says how many tickets move, and they do ---
    await page.goto("/desk/settings/email");
    const billingRow = page.getByTestId("hd-mailbox-row").filter({ hasText: BILLING });
    await expect(billingRow).toContainText("1 ticket", { timeout: 60_000 });
    await billingRow.getByRole("button", { name: `Remove ${BILLING}` }).click();
    const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: `Remove ${BILLING}?` });
    await expect(confirm).toContainText(`1 ticket came in on it: it moves to ${HELP}`);
    await confirm.getByRole("button", { name: "Remove address" }).click();
    await expect(page.getByText(`Address removed. 1 ticket moved to ${HELP}.`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hd-mailbox-row")).toHaveCount(1);
    expect((await facts(viaEnvelope.ticket)).address).toBe(HELP);
    // Nobody without the email channel's capability reaches the list.
    const agentApi = await browser.newContext();
    const ap = await agentApi.newPage();
    await login(ap, AGENT);
    expect((await api(ap, "/api/helpdesk/admin/mailboxes")).status).toBe(403);
    expect((await api(ap, "/api/helpdesk/admin/mailboxes", { method: "POST", body: { address: `x-${stamp}@acme.example`, name: "x" } })).status).toBe(403);
    await agentApi.close();
  });
});
