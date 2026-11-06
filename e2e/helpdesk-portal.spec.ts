import net from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// The customer portal (Helpdesk 1.19.1): someone outside the workspace asks
// for a sign-in link at /support, opens the link read from the mail the
// server sent, raises a request, an agent replies in the desk, and the
// customer sees the reply in the portal.
//
// The mail goes through the real SMTP path to a tiny SMTP sink this spec
// runs on 127.0.0.1. The portal's settings and the SMTP settings are
// workspace keys: they are written under advisory lock 728661 (shared with
// test/helpdesk-portal.test.ts) and restored afterwards. Licensed rig only
// (the helpdesk is Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
const customer = `jordan.${stamp}@clientco.example`;
const LOCK = 728661;
// The agent who answers: an Agent desk role in the spec's own team. (Not the
// e2e admin: a desk Admin's public replies are held for review in 1.19.0,
// reported separately; the held reply would not reach the customer.)
const AGENT = { username: "e2e_portal_agent", password: "E2ePortalAgent!123" };

// --- A minimal SMTP sink --------------------------------------------------------------

const inbox: { to: string; data: string }[] = [];
function smtpSink(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      let inData = false;
      let rcpt = "";
      let data = "";
      sock.write("220 sink ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) break;
            data += buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            inbox.push({ to: rcpt, data });
            data = "";
            sock.write("250 OK\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
          else if (cmd === "MAIL") sock.write("250 OK\r\n");
          else if (cmd === "RCPT") {
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

/** The sign-in link in the newest mail to `to` (quoted-printable undone). */
async function linkFromInbox(to: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const m = [...inbox].reverse().find((x) => x.to === to.toLowerCase());
    if (m) {
      const text = m.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
      const url = /https?:\/\/[^\s"<>)\]]+\/support\/signin\?token=[a-f0-9]{64}/.exec(text)?.[0];
      if (url) return url;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-in link mailed to ${to}`);
}

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

test.describe("customer portal (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let sink: { port: number; close: () => Promise<void> } | null = null;
  const saved = new Map<string, string | null>();
  let teamId = 0;
  let typeId = 0;
  let number = 0;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await login(page, ADMIN);
      if (number) await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
      if (typeId) await api(page, `/api/helpdesk/admin/request-types/${typeId}`, { method: "DELETE" });
      if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    } finally {
      await page.close();
    }
    for (const [k, v] of saved) {
      if (v === null) await db.query("DELETE FROM settings WHERE key = $1", [k]);
      else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    await db.query("DELETE FROM hd_portal_contacts WHERE email = $1", [customer]);
    await db.query(
      "DELETE FROM role_assignments WHERE user_id = (SELECT id FROM users WHERE username = $1) AND role_id = (SELECT id FROM roles WHERE key = 'helpdesk-agent')",
      [AGENT.username]
    );
    await db.query("DELETE FROM audit_log WHERE target_label = $1", [customer]);
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
    await sink?.close();
  });

  async function setSetting(key: string, value: string) {
    if (!saved.has(key)) {
      const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
      saved.set(key, r.rows[0]?.value ?? null);
    }
    await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  }

  test("sign in by link, raise a request, the desk replies, the customer sees it", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    // A team the admin leads, an exposed request type, the portal on, mail to the sink.
    const people = await api(page, "/api/users/mentionable");
    const myId = (people.body?.users as { id: number; username: string }[] | undefined)?.find((u) => u.username === ADMIN.username)?.id;
    await ensureUser(page, AGENT, "viewer", "Priya Shah");
    const agentId = (await db.query("SELECT id FROM users WHERE username = $1", [AGENT.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
       SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [agentId]
    );
    await db.query("DELETE FROM hd_agent_roles WHERE user_id = $1", [agentId]);
    const team = await api(page, "/api/helpdesk/admin/teams", {
      method: "POST",
      body: { name: `Portal E2E ${stamp}`, members: [...(myId ? [{ user_id: myId, role: "lead" }] : []), { user_id: agentId, role: "agent" }] },
    });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    const rt = await api(page, "/api/helpdesk/admin/request-types", {
      method: "POST",
      body: { title: `Product support ${stamp}`, slug: `portal-e2e-${stamp}`, team_id: teamId, form: [], sla_priority: "normal", visibility: "all" },
    });
    expect([200, 201]).toContain(rt.status);
    typeId = (rt.body.request_type ?? rt.body.type ?? rt.body).id;
    sink = await smtpSink();
    await setSetting("smtp_host", "127.0.0.1");
    await setSetting("smtp_port", String(sink.port));
    await setSetting("smtp_secure", "none");
    await setSetting("smtp_user", "");
    await setSetting("smtp_from", "help@acme.example");
    const portal = await api(page, "/api/helpdesk/admin/portal");
    expect(portal.status).toBe(200);
    await setSetting("helpdesk_portal", "{}");
    const put = await api(page, "/api/helpdesk/admin/portal", {
      method: "PUT",
      body: { enabled: true, types: [{ id: typeId, team_id: null }], access: "anyone", domains: [], brand_name: "Acme Support", limits: {}, blocked_words: [], blocked_domains: [] },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // The dev rig compiles a route on its first visit: warm the portal's pages first.
    for (const p of ["/support", "/support/signin?token=x", "/support/requests", "/support/new", "/support/requests/1"]) {
      await page.request.get(p, { timeout: 180_000, maxRedirects: 0 }).catch(() => null);
    }
    for (const p of ["/support/api/link", "/support/api/session", "/support/api/requests"]) {
      await page.request.post(p, { timeout: 180_000, data: {}, headers: { origin: "http://evil.example" } }).catch(() => null);
    }

    // The customer: a browser with no CompassDocs session at all.
    const ctx = await browser.newContext();
    const cust = await ctx.newPage();
    await cust.goto("/support");
    await expect(cust.getByRole("heading", { level: 1, name: "How can we help?" })).toBeVisible();
    await expect(cust.getByText("Acme Support")).toBeVisible();
    await expect(cust.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await cust.getByLabel("Email").fill(customer);
    await cust.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(cust.getByRole("heading", { name: "Check your email" })).toBeVisible();

    const link = new URL(await linkFromInbox(customer));
    await cust.goto(`${link.pathname}${link.search}`);
    await expect(cust.getByText(customer)).toBeVisible();
    await cust.getByRole("button", { name: "Continue" }).click();
    await expect(cust.getByRole("heading", { level: 1, name: "Your requests" })).toBeVisible({ timeout: 90_000 });
    // The link worked once: opening it again says so.
    await cust.goto(`${link.pathname}${link.search}`);
    await expect(cust.getByRole("heading", { name: "This link has expired" })).toBeVisible();

    // The portal session never reaches the app.
    const appApi = await cust.request.get("/api/helpdesk/requests");
    expect(appApi.status()).toBe(401);

    await cust.goto("/support/requests");
    await cust.getByRole("link", { name: "New request" }).click();
    await cust.getByRole("radio", { name: new RegExp(`Product support ${stamp}`) }).check();
    await cust.getByLabel("Subject (optional)").fill(`Export to CSV times out ${stamp}`);
    await cust.getByLabel("Describe what you need").fill("The export spins for a minute and then fails.");
    await cust.getByRole("button", { name: "Send request" }).click();
    await expect(cust.getByRole("heading", { level: 1, name: `Export to CSV times out ${stamp}` })).toBeVisible({ timeout: 90_000 });
    number = Number(/\/support\/requests\/(\d+)/.exec(cust.url())![1]);
    expect(number).toBeGreaterThan(0);

    // The agent: the ticket carries the Outside customer chip; reply in the desk.
    const agentCtx = await browser.newContext();
    const desk = await agentCtx.newPage();
    await login(desk, AGENT);
    await desk.goto(`/desk/tickets/${number}`);
    await expect(desk.getByRole("heading", { level: 2, name: `Export to CSV times out ${stamp}` })).toBeVisible({ timeout: 60_000 });
    await expect(desk.getByText("Outside customer").first()).toBeVisible();
    await desk.getByRole("textbox", { name: "Reply" }).fill(`We've fixed the export ${stamp}. Can you try again?`);
    const sent = desk.waitForResponse((r) => r.url().includes(`/api/helpdesk/tickets/${number}/messages`) && r.request().method() === "POST", { timeout: 120_000 });
    await desk.getByRole("button", { name: "Send", exact: true }).click();
    const res = await sent;
    expect(res.status()).toBeLessThan(300);
    const posted = await res.json();
    expect(posted.message.kind).toBe("public");
    expect(posted.held).toBeFalsy();

    // The customer sees the reply (by first name), and was told by email.
    await cust.reload();
    await expect(cust.getByText(`We've fixed the export ${stamp}. Can you try again?`)).toBeVisible({ timeout: 60_000 });
    await expect(cust.getByText("Priya", { exact: true })).toBeVisible();
    await expect(cust.getByText("Shah")).toHaveCount(0);
    await expect.poll(() => inbox.filter((m) => m.to === customer.toLowerCase()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    const replyMail = inbox.filter((m) => m.to === customer.toLowerCase()).map((m) => m.data.replace(/=\r\n/g, "")).join("\n");
    expect(replyMail).toContain(`/support/requests/${number}`);

    // Sign out ends the portal session.
    await cust.getByRole("button", { name: /Sign out/ }).click();
    await expect(cust.getByRole("heading", { level: 1, name: "How can we help?" })).toBeVisible();
    await ctx.close();
    await agentCtx.close();
  });
});
