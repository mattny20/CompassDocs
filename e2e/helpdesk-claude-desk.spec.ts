import { mkdir } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";
import { startFakeAnthropic, type FakeAnthropic } from "../test/support/fake-anthropic";

// Claude in the desk (1.20.0; mock-ups c1 to c3). Desk settings → Claude in
// the desk switched on; on a ticket, the Claude button's launcher with quick
// prompts (c2) and Ctrl/⌘+J; the docked panel (c1): a streamed answer with
// the tool activity line and source chips, a reply draft put in the reply
// box, and the status card applied through the desk's own PATCH (audited
// "via Claude in the desk"); the panel full screen at 390px.
//
// NEVER the real API. The spec starts the fake Messages API
// (test/support/fake-anthropic) on E2E_FAKE_ANTHROPIC_PORT (default 4917),
// and the rig's dev server must have been started with
//   COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917
// It runs only when E2E_FAKE_ANTHROPIC=1 says so; otherwise it skips, so a
// rig pointed at the real API is never asked anything.
//
// Workspace-wide settings (the AI provider and key, hd_claude_desk) are
// changed under an advisory lock and restored afterwards; the key it stores
// is a dummy only the fake accepts. Everything else it makes is its own.
//
// E2E_SHOTS=<dir> saves c1 to c3 in light and dark at 1440, and the panel at 390.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const FAKE_PORT = Number(process.env.E2E_FAKE_ANTHROPIC_PORT || 4917);
const SETTINGS = ["ai_provider", "ai_model", "anthropic_api_key", "hd_claude_desk"];

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/claude-desk")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

test("claude in the desk: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/claude-desk")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/claude/chat", { method: "POST", body: { ticket: null, text: "Hi" } })).status).toBe(402);
});

test.describe("claude in the desk (licensed, fake Messages API)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.env.E2E_FAKE_ANTHROPIC !== "1", "set E2E_FAKE_ANTHROPIC=1 with the dev server on COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917");
  const stamp = Date.now().toString(36);
  const teamName = `E2E Claude ${stamp}`;
  let teamId = 0;
  let number = 0;
  let db: Client;
  let fake: FakeAnthropic;
  let saved: { key: string; value: string }[] = [];

  test.beforeAll(async () => {
    fake = await startFakeAnthropic({ port: FAKE_PORT });
    db = new Client({ connectionString: DB });
    await db.connect();
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_claude_desk_settings_test'))");
    saved = (await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [SETTINGS])).rows;
    // A dummy key (only the fake answers) on the Anthropic provider, Opus 5.5.
    for (const [k, v] of [
      ["ai_provider", "anthropic"],
      ["ai_model", "claude-opus-5-5"],
      ["anthropic_api_key", `sk-ant-e2e-fake-${stamp}`],
    ]) {
      await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    await db.query("DELETE FROM settings WHERE key = 'hd_claude_desk'");
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
    // 1.19.4: a delete goes to the recycle bin; purge it for good (its Claude chats go with it).
    if (number) {
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "bin", numbers: [number] } });
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "purge", numbers: [number] } });
    }
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
    await db.query("DELETE FROM settings WHERE key = ANY($1)", [SETTINGS]);
    for (const r of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
    await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_claude_desk_settings_test'))");
    await db.end();
    await fake.close();
  });

  test("c3: Desk settings → Claude in the desk switches it on, as drawn", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/claude-desk");
    await slow(page.getByRole("heading", { level: 1, name: "Claude in the desk" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Uses the key and model set in Settings → AI · Claude Opus 5.5")).toBeVisible();
    for (const label of ["Read tickets, notes and your articles", "Search past solved tickets and assets", "Search the web", "Suggest ticket changes", "Draft replies and internal notes"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await page.getByRole("switch", { name: /^Claude in the desk Uses the key/ }).click();
    await page.getByRole("switch", { name: /^Search the web\b/ }).click();
    await page.getByLabel("Sites Claude may search", { exact: true }).fill("support.microsoft.com, support.apple.com, docs.paloaltonetworks.com");
    await page.getByLabel("Monthly limit for the workspace", { exact: true }).fill("400");
    await page.getByLabel("Monthly limit per agent", { exact: true }).fill("25");
    await page.getByRole("button", { name: "Save Claude settings" }).click();
    await slow(page.getByText("Claude in the desk settings saved.")).toBeVisible();
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.settings.updated' AND details->>'section' = 'claude_desk' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]?.details.changed).toContain("enabled");
    await page.reload();
    await slow(page.getByText("Only these sites: support.microsoft.com, support.apple.com, docs.paloaltonetworks.com")).toBeVisible();
    await shot(page, "c3-claude-settings-1440");
  });

  test("c2 and c1: the launcher, a streamed answer, a draft in the reply box and Apply", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Laptop won't connect to VPN from home ${stamp}`, body: 'Since this morning the VPN client says "Authentication failed" when I connect from home. It works in the office.', team_id: teamId, priority: "normal" },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    number = t.body.ticket.number;
    await db.query("UPDATE hd_tickets SET requester_name = 'Daniel Okafor' WHERE number = $1", [number]);
    expect((await api(page, `/api/helpdesk/tickets/${number}/messages`, { method: "POST", body: { kind: "internal", body: "MFA re-enrolled yesterday after the phone swap; the old token is probably cached." } })).status).toBe(201);

    await page.goto(`/desk/tickets/${number}`);
    const claude = page.getByRole("button", { name: "Claude", exact: true });
    await slow(claude).toBeVisible({ timeout: 120_000 });
    // c2: the launcher.
    await claude.click();
    const launcher = page.getByRole("menu", { name: `Ask Claude about #${number}` });
    await expect(launcher).toBeVisible();
    for (const p of ["Summarise this ticket", "Has this happened before?", "Draft a reply", "Translate my reply into French", "What should I do next?"]) {
      await expect(launcher.getByRole("menuitem", { name: p })).toBeVisible();
    }
    await shot(page, "c2-claude-launcher-1440");
    await launcher.getByRole("menuitem", { name: "Has this happened before?" }).click();

    // c1: the panel answers, with the activity line.
    const panel = page.getByRole("complementary", { name: "Claude" });
    await expect(panel).toBeVisible();
    await slow(panel.getByText("Searched solved tickets", { exact: true })).toBeVisible();
    await slow(panel.getByRole("log").getByText(/couldn't find an earlier ticket|times in the last month/)).toBeVisible();
    const sent = fake.requests.filter((r) => Array.isArray(r.body?.tools));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].body.output_config).toEqual({ effort: "high" });
    expect(sent[0].body.tools.some((x: { type?: string }) => x.type === "web_search_20260209")).toBe(true);

    // Ask for a draft by typing: it lands in the reply box; the change waits for Apply.
    const box = panel.getByLabel("Ask Claude");
    await box.fill("Draft a reply with the steps, and put it on waiting.");
    await box.press("Enter");
    await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    await expect(panel.getByText("in your reply box", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll("textarea")].some((t) => t.value.includes("the VPN client keeps your old sign-in token"))), { timeout: 60_000 })
      .toBe(true);
    await expect(panel.getByText("Set status to Waiting on requester", { exact: true })).toBeVisible();
    await expect(panel.getByText("After you send the reply.", { exact: true })).toBeVisible();
    expect((await db.query("SELECT status FROM hd_tickets WHERE number = $1", [number])).rows[0].status, "not applied yet").toBe(t.body.ticket.status);
    await shot(page, "c1-claude-panel-1440");

    await panel.getByRole("button", { name: "Apply" }).click();
    await slow(panel.getByText("Applied", { exact: true })).toBeVisible();
    // The Apply button gives way to "Applied": focus stays in the panel, on the question box.
    await expect(panel.getByLabel("Ask Claude")).toBeFocused();
    expect((await db.query("SELECT status FROM hd_tickets WHERE number = $1", [number])).rows[0].status).toBe("pending");
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.updated' AND details->>'via' = 'claude_desk' AND (details->>'number')::int = $1", [number]);
    expect(audit.rowCount).toBe(1);
    const chats = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.claude.chat' AND (details->>'number')::int = $1", [number]);
    expect(chats.rowCount).toBeGreaterThanOrEqual(2);

    // Ctrl/⌘+J closes and reopens it; Escape closes it and focus returns.
    await page.keyboard.press("Control+j");
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Control+j");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    await panel.getByLabel("Ask Claude").press("Escape");
    await expect(panel).toHaveCount(0);

    // The panel at 390: full screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+j");
    await expect(panel).toBeVisible();
    // The chat is loaded again before the picture.
    await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    const boxSize = await panel.boundingBox();
    expect(Math.round(boxSize?.width ?? 0)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "c1-claude-panel-390");
  });
});
