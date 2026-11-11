import { test, expect, type Page, type Route } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// Microsoft Intune's page: "Set up automatically with Microsoft" (1.20.4).
// The setup itself is the enterprise build's (POST /api/ee/intune/setup/start
// and …/poll) and talks to Microsoft, so this spec plays its answers, the
// page's own settings read and the first sync in the browser (page.route):
// nothing here reaches the setup's server code, Microsoft, or the saved
// settings. What it holds is the page's side: when the setup is offered, the
// code to enter, the closing notice (done, or still being activated by
// Microsoft), the form filled in from what was saved, the first sync started
// as after Connect, and the fields kept as the way to do it by hand.
// Licensed rig only (the page is the helpdesk's).

const PAGE = "/desk/settings/integrations/intune";
const VIEW = "**/api/helpdesk/admin/assets";
const TENANT = "8f4c2b7e-3d1a-4e6f-9b2c-5a7d1e0f4c93";
const CLIENT = "f9c3ef03-83fb-4d50-ae7e-4296271ca096";
const BUTTON = "Set up automatically with Microsoft";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

type Intune = Record<string, unknown>;
const NO_SYNC = { at: null, ok: null, error: "", count: 0, running: false };
const NOT_SET_UP: Intune = { on: false, mode: null, tenant: "", client_id: "", secret_set: false, unavailable: "credentials", sync: NO_SYNC, matched: 0, check_error: "" };
const OWN: Intune = { on: true, mode: "own", tenant: TENANT, client_id: CLIENT, secret_set: true, unavailable: null, sync: NO_SYNC, matched: 0, check_error: "" };
const view = (intune: Intune) => ({ snipeit: { url: "", key_set: false, on_solve: "nothing", sync: NO_SYNC }, intune, agents_search_all: true });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The page's settings read answers `state.intune`; the sync is recorded, never run. */
async function play(page: Page, state: { intune: Intune; syncs: unknown[] }) {
  await page.route(VIEW, (route) => (route.request().method() === "GET" ? json(route, view(state.intune)) : route.abort()));
  await page.route(`${VIEW}/sync`, (route) => {
    state.syncs.push(route.request().postDataJSON());
    return json(route, { ok: null, seen: 0, error: null, running: false, settings: view(state.intune) });
  });
}

/** The setup's two endpoints: a code, "not yet" once, then `done` (saved, as the server would have). */
async function playSetup(page: Page, state: { intune: Intune }, done: Record<string, unknown>) {
  let polls = 0;
  await page.route("**/api/ee/intune/setup/start", (route) => json(route, { setup_id: "setup-1", user_code: "H7KQ2MZP9", verification_uri: "https://microsoft.com/devicelogin", interval: 2, expires_in: 900 }));
  await page.route("**/api/ee/intune/setup/poll", (route) => {
    expect(route.request().postDataJSON()).toEqual({ setup_id: "setup-1" });
    if (polls++ === 0) return json(route, { status: "pending" });
    state.intune = OWN;
    return json(route, { status: "done", tenant: TENANT, client_id: CLIENT, secret_expires: "2028-11-10", ...done });
  });
}

test.describe("Microsoft Intune: set up automatically with Microsoft (licensed)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test("offered while Intune has no app registration of its own, and not once it has", async ({ page }) => {
    test.setTimeout(600_000);
    const state = { intune: NOT_SET_UP, syncs: [] as unknown[] };
    await play(page, state);
    const card = page.getByTestId("assets-intune");
    const button = card.getByRole("button", { name: BUTTON });

    await page.goto(PAGE);
    await expect(button).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText("creates the app registration with only the DeviceManagementManagedDevices.Read.All permission, grants admin consent and connects Intune.");
    // The fields stay, as the way to do it by hand.
    await expect(card.getByLabel("Tenant")).toBeVisible();
    await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();

    // An install still on the directory sync app: offered, and it says the devices stay.
    state.intune = { ...NOT_SET_UP, on: true, mode: "directory", unavailable: null };
    await page.reload();
    await expect(page.getByTestId("assets-intune-legacy")).toBeVisible({ timeout: 120_000 });
    await expect(button).toBeVisible();
    await expect(card).toContainText("switches Intune to it. Its devices and their links stay.");

    // That app gone (directory sync no longer set up): the setup is the quick way back.
    state.intune = { ...NOT_SET_UP, on: true, unavailable: "legacy_gone" };
    await page.reload();
    await expect(card).toContainText("Needs attention", { timeout: 120_000 });
    await expect(button).toBeVisible();

    // Its own app registration is saved, connected or switched off: a second run would leave a second app in Entra.
    for (const intune of [OWN, { ...OWN, on: false }]) {
      state.intune = intune;
      await page.reload();
      await expect(card.getByRole("button", { name: "Forget credentials" })).toBeVisible({ timeout: 120_000 });
      await expect(button).toHaveCount(0);
    }
  });

  test("the code to enter, then done: the form shows what was saved and the first sync starts", async ({ page }) => {
    test.setTimeout(600_000);
    const state = { intune: NOT_SET_UP, syncs: [] as unknown[] };
    await play(page, state);
    await playSetup(page, state, { verified: true });
    const card = page.getByTestId("assets-intune");

    await page.goto(PAGE);
    await card.getByRole("button", { name: BUTTON }).click({ timeout: 120_000 });
    await expect(card.locator("code")).toHaveText("H7KQ2MZP9");
    await expect(card.getByRole("link", { name: "microsoft.com/devicelogin" })).toHaveAttribute("href", "https://microsoft.com/devicelogin");
    await expect(card).toContainText("signing in as a tenant admin");

    const done = card.getByRole("status");
    await expect(done).toHaveText(
      "Done. The app registration was created in Entra, admin consent was granted and Intune is connected. Its devices sync now and every 30 minutes. The client secret is good until 2028-11-10.",
      { timeout: 60_000 }
    );
    await expect(done).toHaveClass(/notice-ok/);
    await expect(card).toContainText("Connected");
    await expect(card.getByLabel("Tenant")).toHaveValue(TENANT);
    await expect(card.getByLabel("Application (client) ID")).toHaveValue(CLIENT);
    await expect(card.getByRole("button", { name: "Replace the client secret" })).toBeVisible();
    await expect(card.getByRole("button", { name: BUTTON })).toHaveCount(0);
    await expect.poll(() => state.syncs).toEqual([{ provider: "intune" }]);
    // Forgetting that app registration offers the setup afresh (the save is played too).
    await page.unroute(VIEW);
    await page.route(VIEW, (route) => {
      if (route.request().method() === "PUT") state.intune = NOT_SET_UP;
      return json(route, view(state.intune));
    });
    await card.getByRole("button", { name: "Forget credentials" }).click();
    await page.getByRole("button", { name: "Forget and disconnect" }).click();
    await expect(card.getByRole("button", { name: BUTTON })).toBeVisible();
    await expect(card.getByRole("status")).toHaveCount(0);
  });

  test("still being activated by Microsoft: saved, a warning says what to do, and no sync is started", async ({ page }) => {
    test.setTimeout(600_000);
    const state = { intune: NOT_SET_UP, syncs: [] as unknown[] };
    await play(page, state);
    await playSetup(page, state, { verified: false });
    const card = page.getByTestId("assets-intune");

    await page.goto(PAGE);
    await card.getByRole("button", { name: BUTTON }).click({ timeout: 120_000 });
    const done = card.getByRole("status");
    await expect(done).toHaveText("The app registration was created in Entra and saved here. Microsoft is still activating it, so Intune can't sign in yet. Press Test connection in a minute, then Sync now.", { timeout: 60_000 });
    await expect(done).toHaveClass(/notice-warn/);
    await expect(card.getByLabel("Application (client) ID")).toHaveValue(CLIENT);
    await expect(card.getByRole("button", { name: "Test connection" })).toBeEnabled();
    expect(state.syncs).toEqual([]);
  });

  test("a refusal is said in place, and the setup can be tried again", async ({ page }) => {
    test.setTimeout(600_000);
    const state = { intune: NOT_SET_UP, syncs: [] as unknown[] };
    await play(page, state);
    const card = page.getByTestId("assets-intune");
    const refusal = "You signed in to a different Microsoft 365 tenant than the Intune devices already here came from, so nothing was created.";
    await page.route("**/api/ee/intune/setup/start", (route) => json(route, { setup_id: "setup-2", user_code: "C9YY37NQW", verification_uri: "https://microsoft.com/devicelogin", interval: 2, expires_in: 900 }));
    await page.route("**/api/ee/intune/setup/poll", (route) => json(route, { error: refusal }, 502));

    await page.goto(PAGE);
    await card.getByRole("button", { name: BUTTON }).click({ timeout: 120_000 });
    await expect(card).toContainText(refusal, { timeout: 60_000 });
    await expect(card.getByRole("button", { name: BUTTON })).toBeEnabled();
    await expect(card).toContainText("Not connected");

    // An enterprise build from before the setup existed answers 404: say so, and point at the fields.
    await page.unroute("**/api/ee/intune/setup/start");
    await page.route("**/api/ee/intune/setup/start", (route) => route.fulfill({ status: 404, body: "Not found" }));
    await card.getByRole("button", { name: BUTTON }).click();
    await expect(card).toContainText("This build can't do this setup yet. Update the enterprise image, or enter the details by hand.");
  });
});
