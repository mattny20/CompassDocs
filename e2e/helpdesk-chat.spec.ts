import { test, expect, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";

// Chat apps: Microsoft Teams and Slack (1.19.4; mock-up f1). Desk settings →
// Chat apps: Connect Teams (app ID, tenant, client secret: saving calls
// nobody, the secret never comes back), the messaging endpoint with Copy,
// What people can do in Teams (Turn a channel message into a ticket off by
// default), Channels that open tickets (a Teams mention, a Slack reaction),
// one Save; then Slack, and the two endpoints: unsigned or unverified
// requests are 401, a request signed with the saved signing secret is read
// (Slack's url_verification). Disconnect stops both.
//
// The rig never calls Microsoft or Slack: nothing here presses Test or sends
// an event that would make the server answer in a chat. The full flows run
// against in-process fakes in test/helpdesk-chat.
//
// The chat settings are workspace-wide: this spec holds an advisory lock
// while it changes them and restores the stored row afterwards.
//
// E2E_SHOTS=<dir> also saves screenshots: 1440 light and dark, 390 light.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/chat")).status !== 402;
}

test("chat apps: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/chat")).status).toBe(402);
});

test.describe("chat apps (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const APP_ID = randomUUID();
  const TENANT = randomUUID();
  const SECRET = `e2e-teams-secret-${stamp}-abcdefgh`;
  const SLACK_TOKEN = `xoxb-e2e-${stamp}-token`;
  const SIGNING = createHmac("sha256", stamp).update("signing").digest("hex").slice(0, 32);
  const teamNames = [`E2E IT Service Desk ${stamp}`, `E2E Facilities ${stamp}`];
  const teamIds: number[] = [];
  let db: Client;
  let saved: string | undefined;
  let startedAt = "";

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_chat_settings_test'))");
    saved = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_chat'")).rows[0]?.value;
    startedAt = (await db.query("SELECT now()::text AS t")).rows[0].t;
    await db.query("DELETE FROM settings WHERE key = 'helpdesk_chat'");
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamIds.length) {
      for (const name of teamNames) {
        const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name, icon: "monitor", members: [] } });
        expect(team.status, JSON.stringify(team.body)).toBe(201);
        teamIds.push(team.body.team.id);
      }
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const id of teamIds) await api(page, `/api/helpdesk/admin/teams/${id}`, { method: "DELETE" });
    await page.close();
    await db.query("DELETE FROM settings WHERE key = 'helpdesk_chat'");
    if (saved !== undefined) await db.query("INSERT INTO settings (key, value) VALUES ('helpdesk_chat', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [saved]);
    // This spec's own settings audits (only the chat settings write helpdesk.chat.*, and the lock keeps other writers out).
    await db.query("DELETE FROM audit_log WHERE action IN ('helpdesk.chat.settings_changed', 'helpdesk.chat.disconnected') AND at >= $1::timestamptz", [startedAt]);
    await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_chat_settings_test'))");
    await db.end();
  });

  test("connect Teams, choose what people can do and the channels, one Save; the secret never comes back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/chat");
    await slow(page.getByRole("heading", { level: 1, name: "Chat apps" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Let people raise and follow requests, and approve them, from Microsoft Teams or Slack.")).toBeVisible();
    const teamsCard = page.getByTestId("chat-app-teams");
    const slackCard = page.getByTestId("chat-app-slack");
    await expect(teamsCard.getByText("Not connected")).toBeVisible();
    await expect(slackCard.getByText("Connect a Slack workspace to install the CompassDocs app.")).toBeVisible();
    // No abilities card before an app is connected.
    await expect(page.getByText("What people can do in Teams")).toHaveCount(0);

    await teamsCard.getByRole("button", { name: "Connect" }).click();
    const form = page.getByTestId("chat-form-teams");
    await expect(form.getByLabel("App ID")).toBeFocused();
    await form.getByLabel("App ID").fill(APP_ID);
    await form.getByLabel("Tenant ID").fill(TENANT);
    await form.getByLabel("Client secret").fill(SECRET);
    await expect(page.getByTestId("chat-endpoint-teams")).toHaveText(/\/api\/helpdesk\/chat\/teams\/messages$/);
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Microsoft Teams connected. Use Test to check it with Microsoft.")).toBeVisible();
    await expect(teamsCard.getByText("Connected", { exact: true })).toBeVisible();
    await expect(teamsCard.getByText(`Connected · tenant ${TENANT.slice(0, 8)}…`)).toBeVisible();
    const view = await api(page, "/api/helpdesk/admin/chat");
    expect(JSON.stringify(view.body)).not.toContain(SECRET);
    expect(view.body.teams.secret_set).toBe(true);

    // What people can do in Teams: the last one is off by default.
    const abilities = page.getByTestId("chat-abilities-teams");
    await expect(abilities.getByRole("switch")).toHaveCount(4);
    await expect(abilities.getByRole("switch", { name: "Raise a request" })).toHaveAttribute("aria-checked", "true");
    await expect(abilities.getByRole("switch", { name: "Turn a channel message into a ticket" })).toHaveAttribute("aria-checked", "false");
    await abilities.getByRole("switch", { name: "Approve and decline" }).click();

    // Channels that open tickets.
    await expect(page.getByText("No channels open tickets yet.")).toBeVisible();
    const addChannel = async (app: "teams" | "slack", id: string, name: string, team: string, reaction?: string) => {
      await page.getByRole("button", { name: "Add a channel" }).click();
      const row = page.getByTestId("chat-channel-add");
      await row.getByLabel(/^App/).selectOption(app);
      await row.getByLabel("Channel ID", { exact: true }).fill(id);
      await row.getByLabel("Name", { exact: true }).fill(name);
      await row.getByLabel(/^Team/).selectOption({ label: team });
      if (reaction) {
        await row.getByLabel(/^Opened by/).selectOption("reaction");
        await row.getByLabel("Reaction", { exact: true }).fill(reaction);
      }
      await row.getByRole("button", { name: "Add channel" }).click();
    };
    await addChannel("teams", `19:e2e${stamp}@thread.tacv2`, "it-help", teamNames[0]);
    await addChannel("slack", `C0E2E${stamp.toUpperCase()}`, "facilities", teamNames[1], "ticket");
    const table = page.getByTestId("chat-channels");
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table.getByText("Any message that mentions @CompassDocs")).toBeVisible();
    await expect(table.getByText("The :ticket: reaction")).toBeVisible();
    await page.getByRole("button", { name: "Save chat app settings" }).click();
    await expect(page.getByText("Chat app settings saved.")).toBeVisible();

    await page.reload();
    await slow(page.getByTestId("chat-channels").getByRole("row")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId("chat-abilities-teams").getByRole("switch", { name: "Approve and decline" })).toHaveAttribute("aria-checked", "false");
    // Back on, as in the mock-up, for the pictures.
    await page.getByTestId("chat-abilities-teams").getByRole("switch", { name: "Approve and decline" }).click();
    await page.getByRole("button", { name: "Save chat app settings" }).click();
    await expect(page.getByText("Chat app settings saved.")).toBeVisible();

    if (SHOTS) {
      await page.getByRole("button", { name: /dismiss|close/i }).last().click().catch(() => {});
      await expect(page.getByText("Chat app settings saved.")).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${SHOTS}/f1-chat-apps-light.png`, fullPage: true });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/f1-chat-apps-dark.png`, fullPage: true });
      await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
      await teamsCard.getByRole("button", { name: "Edit" }).click();
      await page.getByTestId("chat-form-teams").locator("details summary").click();
      await page.screenshot({ path: `${SHOTS}/f1-chat-apps-teams-form-light.png`, fullPage: true });
      await page.getByTestId("chat-form-teams").getByRole("button", { name: "Cancel" }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await slow(page.getByTestId("chat-channels").getByRole("row")).toHaveCount(3, { timeout: 60_000 });
      // No sideways scroll on a phone: list anything wider than the screen.
      const wide = await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1
          ? []
          : [...document.querySelectorAll("body *")]
              .filter((el) => {
                // What sticks out (the settings rail's own scrolling strip aside), to say what widened the page.
                return el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest("nav");
              })
              .slice(0, 8)
              .map((el) => `${el.tagName}.${String(el.className).slice(0, 80)}`)
      );
      await page.screenshot({ path: `${SHOTS}/f1-chat-apps-390-light.png`, fullPage: true });
      expect(wide).toEqual([]);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("Slack: connect; the endpoint reads only requests signed with the saved secret; Teams only verified ones", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/chat");
    const slackCard = page.getByTestId("chat-app-slack");
    await slow(slackCard.getByRole("button", { name: "Connect" })).toBeVisible({ timeout: 60_000 });
    await slackCard.getByRole("button", { name: "Connect" }).click();
    const form = page.getByTestId("chat-form-slack");
    await form.getByLabel("Bot token").fill(SLACK_TOKEN);
    await form.getByLabel("Signing secret").fill(SIGNING);
    await expect(page.getByTestId("chat-endpoint-slack")).toHaveText(/\/api\/helpdesk\/chat\/slack\/events$/);
    await form.getByRole("button", { name: "Connect" }).click();
    await expect(slackCard.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("What people can do in Slack")).toBeVisible();
    // A saved secret reads as dots with Replace.
    await slackCard.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByTestId("chat-form-slack").getByRole("button", { name: "Replace the signing secret" })).toBeVisible();
    await page.getByTestId("chat-form-slack").getByRole("button", { name: "Cancel" }).click();

    const url = "/api/helpdesk/chat/slack/events";
    const body = JSON.stringify({ type: "url_verification", challenge: `c-${stamp}` });
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = (secret: string, t = ts) => `v0=${createHmac("sha256", secret).update(`v0:${t}:${body}`).digest("hex")}`;
    const post = (headers: Record<string, string>) => page.request.post(url, { data: body, headers: { "content-type": "application/json", ...headers } });
    expect((await post({})).status()).toBe(401);
    expect((await post({ "x-slack-request-timestamp": ts, "x-slack-signature": sign("0".repeat(32)) })).status()).toBe(401);
    const stale = String(Number(ts) - 600);
    expect((await post({ "x-slack-request-timestamp": stale, "x-slack-signature": sign(SIGNING, stale) })).status()).toBe(401);
    const ok = await post({ "x-slack-request-timestamp": ts, "x-slack-signature": sign(SIGNING) });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ challenge: `c-${stamp}` });
    // Teams: no Bot Framework token, no reading.
    const teams = await page.request.post("/api/helpdesk/chat/teams/messages", { data: { type: "message", text: "hi", channelId: "msteams", serviceUrl: "https://smba.trafficmanager.net/teams/" } });
    expect(teams.status()).toBe(401);

    // Disconnect both: nothing is read any more.
    for (const card of [page.getByTestId("chat-app-slack"), page.getByTestId("chat-app-teams")]) {
      await card.getByRole("button", { name: "Disconnect" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
      await expect(card.getByText("Not connected")).toBeVisible();
    }
    expect((await post({ "x-slack-request-timestamp": ts, "x-slack-signature": sign(SIGNING) })).status()).toBe(401);
  });
});
