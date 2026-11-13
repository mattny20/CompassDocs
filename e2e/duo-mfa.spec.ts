import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";
import { startFakeDuo, type FakeDuo } from "../test/helpers/fake-duo";

// The Duo sign-in check (1.20.5) end to end, against a fake Duo on this
// machine (test/helpers/fake-duo): the settings page's lockout guard, "Test
// with my account", the sign-in rule sending a password sign-in to the Duo
// step and on to the page it wanted, a denial, and Duo being down.
//
// It runs only on a rig that is licensed for SSO AND was started with the
// test seam (COMPASSDOCS_DUO_TEST_API_BASE=http://127.0.0.1:PORT, see
// lib/duo-config): everywhere else, CI's community build included, it skips
// itself. It never touches a workspace that already has Duo set up, never
// contacts Duo, and removes every duo_* setting when it finishes, so the
// rig is left with Duo not set up.

const CLIENT_ID = "DIE2EFAKECLIENT00001";
const CLIENT_SECRET = "e2efakesecrete2efakesecrete2efakesecret1";
const HOST = "api-e2e00000.duosecurity.com";
const PERSON = { username: "e2e_duo_person", password: "E2eDuoPerson!123" };

test.describe("Duo sign-in check (licensed rig with the test seam)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let duo: FakeDuo | null = null;
  let ours = false; // true once this spec has written Duo settings

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
  });
  test.afterAll(async () => {
    // Whatever happened above: Duo is not left set up, and nothing stays gated.
    if (ours) {
      await db.query("DELETE FROM settings WHERE key LIKE 'duo\\_%'");
      await db.query("DELETE FROM duo_states");
    }
    await db.end();
    await duo?.close();
  });

  async function signIn(page: Page, who: { username: string; password: string }) {
    await page.goto("/login");
    await page.fill('input[autocomplete="username"]', who.username);
    await page.fill('input[autocomplete="current-password"]', who.password);
    await page.click('button[type="submit"]');
  }

  test("guard, test, sign-in rule, denial, Duo down", async ({ page, browser }) => {
    test.setTimeout(420_000);
    await login(page, ADMIN);
    const view = (await api(page, "/api/admin/duo")).body as { enabled?: boolean; configured?: boolean; test_api_base?: string | null } | null;
    test.skip(!view?.enabled, "SSO is not licensed in this build; the EE rig runs the flow");
    test.skip(!view?.test_api_base, "the rig was not started with COMPASSDOCS_DUO_TEST_API_BASE; nothing here may contact Duo");
    test.skip(Boolean(view?.configured), "Duo is already set up on this rig; this spec does not touch a real configuration");
    const port = Number(new URL(view!.test_api_base!).port);
    try {
      duo = await startFakeDuo({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, port });
    } catch {
      test.skip(true, `port ${port} is in use; stop whatever is listening there to run this spec`);
    }
    await ensureUser(page, PERSON, "viewer", "E2E Duo Person");
    await db.query("UPDATE users SET must_change_password = 0, email = 'duo.person@e2e.example' WHERE username = $1", [PERSON.username]);

    // The lockout guard: no rule before the details are saved and tested.
    ours = true;
    expect((await api(page, "/api/admin/duo", { method: "PATCH", body: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, api_host: HOST, enforce_signin: true } })).status).toBe(400);
    expect((await api(page, "/api/admin/duo", { method: "PATCH", body: { api_host: "evil.example" } })).status).toBe(400);
    await page.goto("/admin/sso#duo");
    const card = page.locator("#duo");
    await expect(card.getByRole("switch", { name: "At sign-in" })).toBeDisabled({ timeout: 120_000 });
    // Filled until the form really holds all three (a fill that lands before hydration is thrown away).
    await expect(async () => {
      await card.getByLabel("Client ID").fill(CLIENT_ID);
      await card.getByLabel("Client secret").fill(CLIENT_SECRET);
      await card.getByLabel("API hostname").fill(HOST);
      await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 2_000 });
      await expect(card.getByLabel("Client ID")).toHaveValue(CLIENT_ID, { timeout: 1_000 });
      await expect(card.getByLabel("Client secret")).toHaveValue(CLIENT_SECRET, { timeout: 1_000 });
      await expect(card.getByLabel("API hostname")).toHaveValue(HOST, { timeout: 1_000 });
    }).toPass({ timeout: 120_000 });
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Duo settings saved.")).toBeVisible();
    expect(((await api(page, "/api/admin/duo")).body as { configured: boolean }).configured).toBe(true);
    await expect(card.getByRole("switch", { name: "At sign-in" })).toBeDisabled();
    expect((await api(page, "/api/admin/duo", { method: "PATCH", body: { enforce_signin: true } })).status).toBe(400);
    const saved = (await api(page, "/api/admin/duo")).body;
    expect(JSON.stringify(saved)).not.toContain(CLIENT_SECRET);

    // Test with my account: a real round trip through the (fake) prompt.
    await card.getByRole("button", { name: "Test with my account" }).click();
    await expect(page.getByText("Duo approved the test. You can turn the rules on now.")).toBeVisible({ timeout: 120_000 });
    await expect(card.getByText("Tested in this session")).toBeVisible();
    await card.getByRole("switch", { name: "At sign-in" }).click();
    await expect(card.getByText("No account skips Duo.")).toBeVisible();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByText("Enforced")).toBeVisible({ timeout: 60_000 });
    // The admin who turned it on stays signed in.
    expect((await api(page, "/api/account/sessions")).status).toBe(200);

    // Someone else signs in with a password: the Duo step, then the page they wanted.
    const ctx = await browser.newContext();
    const person = await ctx.newPage();
    await signIn(person, PERSON);
    await expect(person.getByRole("heading", { level: 1, name: "Confirm it's you" })).toBeVisible({ timeout: 120_000 });
    const gated = await api(person, "/api/account/sessions");
    expect(gated.status).toBe(401);
    expect(gated.body).toEqual({ error: "Confirm with Duo to continue.", code: "mfa_required" });
    await person.goto("/directory");
    await expect(person).toHaveURL(/\/login\/duo\?next=%2Fdirectory/);

    duo!.mode = "deny";
    await person.getByRole("button", { name: "Continue with Duo" }).click();
    await expect(person.getByText("Duo didn't approve that.")).toBeVisible({ timeout: 120_000 });
    duo!.mode = "down";
    await person.getByRole("button", { name: "Try again" }).click();
    await expect(person.getByRole("heading", { level: 1, name: "Duo can't be reached" })).toBeVisible({ timeout: 120_000 });
    expect((await api(person, "/api/account/sessions")).status).toBe(401);

    duo!.mode = "allow";
    await person.getByRole("button", { name: "Try again" }).click();
    await expect(person).toHaveURL(/\/directory$/, { timeout: 120_000 });
    expect((await api(person, "/api/account/sessions")).status).toBe(200);
    expect(duo!.lastUsername).toBe("duo.person@e2e.example");
    await ctx.close();

    // Changing the details turns the rule off again.
    const changed = await api(page, "/api/admin/duo", { method: "PATCH", body: { api_host: "api-e2e00001.duosecurity.com" } });
    expect(changed.status).toBe(200);
    expect((changed.body as { rules_turned_off: boolean }).rules_turned_off).toBe(true);
  });
});
