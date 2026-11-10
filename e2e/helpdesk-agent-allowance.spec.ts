import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Helpdesk agent allowances: the usage meter on Settings → Agents, the
// warning past the allowance, Add agent at the limit (and the server's 402
// when someone took the last place meanwhile), a Team lead not seeing the
// meter, and the License page's Helpdesk agents row.
//
// The licensed rig's key has no `agents` claim (unlimited), so the limited
// states stub the two read APIs with page.route, merging the stubbed
// numbers into the real responses; the unlimited states and one real add
// use the rig as it is. Unlicensed builds answer 402 behind the desk, so
// these skip themselves. E2E_SHOTS=<dir> saves the screenshots (1440 light
// and dark, the Agents page at 390 too).

const SHOTS = process.env.E2E_SHOTS ?? "";
const PICK = { username: "e2e_hd_allow_pick", password: "E2eAllowPick!12345" };
const PICK_NAME = "Pat Pickable";
const REAL = { username: "e2e_hd_allow_real", password: "E2eAllowReal!12345" };
const REAL_NAME = "Rae Realadd";
const LEAD = { username: "e2e_hd_allow_lead", password: "E2eAllowLead!12345" };
const LEAD_NAME = "Lou Leadonly";
const AGENTS_API = /\/api\/helpdesk\/admin\/agents$/;
const LICENSE_API = /\/api\/admin\/license$/;

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/agents");
  if (res.status === 402) return false;
  expect(res.status, "the admin manages agents").toBe(200);
  return true;
}

async function shot(page: Page, name: string, both = true) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => document.querySelectorAll("nextjs-portal").forEach((e) => e.remove()));
  await page.screenshot({ path: path.join(SHOTS, `${name}-light.png`) });
  if (!both) return;
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}-dark.png`) });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

/** GET /api/helpdesk/admin/agents answers the real list with these allowance numbers. */
async function stubAgents(page: Page, numbers: Record<string, unknown>) {
  await page.unroute(AGENTS_API);
  await page.route(AGENTS_API, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, ...numbers } });
  });
}

const BUY_URL = "https://docs.compassdocs.io/admin/license/#helpdesk-agents";
const within = { allowed: 6, licensed: 6, enforced: true, used: 5, over: 0, buy_url: BUY_URL };

async function openAgents(page: Page) {
  await page.goto("/desk/settings/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add agent" }).first()).toBeVisible();
}

test.describe("helpdesk agent allowance", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
  });

  test("Agents: the meter within the allowance, at 1440 and 390", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await stubAgents(page, within);
    await openAgents(page);
    await expect(page.getByText("5 of 6 agents", { exact: true })).toBeVisible();
    await expect(page.getByText("on your licence · 3 included, 3 bought", { exact: true })).toBeVisible();
    const meter = page.getByRole("meter", { name: "Helpdesk agents in use" });
    await expect(meter).toHaveAttribute("aria-valuenow", "5");
    await expect(meter).toHaveAttribute("aria-valuemax", "6");
    await expect(meter.locator("div")).toHaveClass(/bg-compass-600/);
    const buy = page.getByRole("link", { name: /Buy more agents/ });
    await expect(buy).toHaveAttribute("href", BUY_URL);
    await expect(buy).toHaveAttribute("target", "_blank");
    await expect(buy).toHaveAttribute("rel", /noopener/);
    await expect(page.getByText(/people work the desk and your licence includes/)).toHaveCount(0);
    // Directly under the page header, before the list.
    const box = await meter.boundingBox();
    const list = await page.getByLabel("Filter agents").boundingBox();
    expect(box!.y).toBeLessThan(list!.y);
    await shot(page, "b1-agents-meter-1440");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(meter).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, "no horizontal page scroll").toBeLessThanOrEqual(390);
    await shot(page, "b1-agents-meter-390");
  });

  test("Agents: exactly the 3 included drops the bought part; in grace it says it isn't enforced, with no warning", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await stubAgents(page, { ...within, allowed: 3, licensed: 3, used: 2 });
    await openAgents(page);
    await expect(page.getByText("2 of 3 agents", { exact: true })).toBeVisible();
    await expect(page.getByText("on your licence · 3 included", { exact: true })).toBeVisible();
    await stubAgents(page, { ...within, allowed: null, enforced: false });
    await openAgents(page);
    await expect(page.getByText("on your licence · 3 included, 3 bought · not enforced while the licence is in grace", { exact: true })).toBeVisible();
    // Over in grace: no amber warning or bar, the muted line says by how much once renewed.
    await stubAgents(page, { ...within, allowed: null, enforced: false, used: 7, over: 1 });
    await openAgents(page);
    await expect(
      page.getByText("on your licence · 3 included, 3 bought · not enforced while the licence is in grace · over by 1 once renewed", { exact: true })
    ).toBeVisible();
    await expect(page.locator(".notice-warn")).toHaveCount(0);
    await expect(page.getByRole("meter", { name: "Helpdesk agents in use" }).locator("div")).toHaveClass(/bg-compass-600/);
  });

  test("Agents: past the allowance, an amber bar and the warning above it", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await stubAgents(page, { ...within, used: 7, over: 1 });
    await openAgents(page);
    const warn = page.locator(".notice-warn").filter({ hasText: "7 people work the desk and your licence includes 6." });
    await expect(warn).toBeVisible();
    // Adding someone new needs one place more than the desk is over by.
    await expect(warn).toContainText("Nobody loses access. To add someone new, buy 2 more agents or take 2 people off the desk.");
    await expect(warn.locator("b")).toHaveText("7 people work the desk and your licence includes 6.");
    const meter = page.getByRole("meter", { name: "Helpdesk agents in use" });
    await expect(meter).toHaveAttribute("aria-valuenow", "6");
    await expect(meter).toHaveAttribute("aria-valuetext", "7 of 6, over by 1");
    await expect(meter.locator("div")).toHaveClass(/bg-amber-500/);
    // The warning sits above the meter's card.
    expect((await warn.boundingBox())!.y).toBeLessThan((await meter.boundingBox())!.y);
    await shot(page, "b2-agents-over-1440");
    await stubAgents(page, { ...within, used: 9, over: 3 });
    await openAgents(page);
    await expect(page.locator(".notice-warn")).toContainText("To add someone new, buy 4 more agents or take 4 people off the desk.");
  });

  test("Agents: unlimited on the rig's key is one muted line, no meter", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    const real = await api(page, "/api/helpdesk/admin/agents");
    test.skip(real.body.licensed !== null, "the rig's key carries an agents claim");
    await openAgents(page);
    await expect(page.getByText(`${real.body.used} agent${real.body.used === 1 ? "" : "s"} · unlimited on your licence`, { exact: true })).toBeVisible();
    await expect(page.getByRole("meter")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Buy more agents/ })).toHaveCount(0);
  });

  test("Add agent at the limit: the warning, the link and a disabled submit", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await stubAgents(page, { ...within, used: 6 });
    await openAgents(page);
    await page.getByRole("button", { name: "Add agent" }).first().click();
    const dialog = page.getByRole("dialog");
    const warn = dialog.locator(".notice-warn");
    await expect(warn).toContainText("All 6 agents on your licence are in use. Buy more agents to add someone, or take someone off the desk first.");
    await expect(warn.locator("b")).toHaveText("All 6 agents on your licence are in use.");
    await expect(warn.getByRole("link", { name: /Buy more agents/ })).toHaveAttribute("href", BUY_URL);
    await expect(dialog.getByRole("button", { name: "Add to desk" })).toBeDisabled();
    await shot(page, "b3-add-agent-limit-1440");
  });

  test("Add agent: the server's 402 (the last place went meanwhile) shows its sentence with the link and reloads the numbers", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await ensureUser(page, PICK, "viewer", PICK_NAME);
    const sentence = "Your licence includes 6 helpdesk agents and all are in use. Buy more agents to add someone.";
    // The desk as the page first sees it (5 of 6); the 402 means someone took the last place.
    let numbers: Record<string, unknown> = within;
    let posted = 0;
    let reads = 0;
    await page.unroute(AGENTS_API);
    await page.route(AGENTS_API, async (route) => {
      if (route.request().method() === "POST") {
        posted++;
        numbers = { ...within, used: 6 };
        return route.fulfill({ status: 402, json: { error: sentence, code: "agent_limit", allowed: 6, used: 6 } });
      }
      reads++;
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), ...numbers } });
    });
    await openAgents(page);
    await page.getByRole("button", { name: "Add agent" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".notice-warn")).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Person" }).fill(PICK.username);
    await page.keyboard.press("Enter");
    await expect(dialog.getByText(PICK_NAME)).toBeVisible();
    await dialog.getByRole("button", { name: "Add to desk" }).click();
    const warn = dialog.locator(".notice-warn");
    await expect(warn).toContainText(sentence);
    await expect(warn).toHaveAttribute("role", "alert");
    await expect(warn.getByRole("link", { name: /Buy more agents/ })).toHaveAttribute("href", BUY_URL);
    expect(posted).toBe(1);
    // The page read the numbers again: the meter shows the desk full and the submit is disabled.
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("6 of 6 agents", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add to desk" })).toBeDisabled();
    await expect(warn).toContainText(sentence);
  });

  test("a real add on the rig's unlimited key still works", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await ensureUser(page, REAL, "viewer", REAL_NAME);
    const users = await api(page, "/api/users/mentionable");
    const id = (users.body.users as { id: number; username: string }[]).find((u) => u.username === REAL.username)!.id;
    await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    try {
      const add = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: id, role: "newbie" } });
      expect(add.status, JSON.stringify(add.body)).toBe(201);
      expect(add.body.agent.role).toBe("newbie");
    } finally {
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    }
  });

  test("a Team lead adds people but doesn't see the meter", async ({ page, browser }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await ensureUser(page, LEAD, "viewer", LEAD_NAME);
    const users = await api(page, "/api/users/mentionable");
    const id = (users.body.users as { id: number; username: string }[]).find((u) => u.username === LEAD.username)!.id;
    const set = await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "PATCH", body: { role: "team_lead" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const lead = await ctx.newPage();
      await login(lead, LEAD);
      await stubAgents(lead, within);
      await openAgents(lead);
      await expect(lead.getByRole("meter")).toHaveCount(0);
      await expect(lead.getByText("5 of 6 agents")).toHaveCount(0);
    } finally {
      await ctx.close();
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    }
  });

  test("License: the Helpdesk agents row after Seats, over and unlimited; the Helpdesk feature first", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    const stubLicense = async (patch: (body: any) => Record<string, unknown>) => {
      await page.unroute(LICENSE_API);
      await page.route(LICENSE_API, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const body = await res.json();
        await route.fulfill({ response: res, json: { ...body, ...patch(body) } });
      });
    };
    const open = async () => {
      await page.goto("/admin/license");
      await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
    };
    const row = () => page.locator("dl > div").filter({ has: page.locator("dt", { hasText: "Helpdesk agents" }) });

    // Unlimited: the rig as it is.
    await open();
    const real = await api(page, "/api/admin/license");
    expect(real.body.features[0].key, "Helpdesk is the first feature").toBe("helpdesk");
    await expect(page.locator("h3", { hasText: "Enterprise features" }).locator("xpath=following-sibling::ul[1]/li").first()).toContainText("Helpdesk");
    if (real.body.license?.agents === null) await expect(row().locator("dd")).toHaveText(`${real.body.agentsUsed} used · unlimited`);

    // 5 of 6, right after Seats.
    await stubLicense((b) => ({ license: { ...b.license, agents: 6 }, agentsAllowed: 6, agentsUsed: 5, buyAgentsUrl: BUY_URL, source: "settings" }));
    await open();
    await expect(row().locator("dd")).toContainText("5 / 6");
    await expect(row().locator("dd")).toContainText("· 3 included, 3 bought");
    const buy = row().getByRole("link", { name: /Buy more helpdesk agents/ });
    await expect(buy).toHaveAttribute("href", BUY_URL);
    await expect(buy).toHaveAttribute("target", "_blank");
    const labels = await page.locator("dl > div > dt").allTextContents();
    expect(labels[labels.indexOf("Seats") + 1]).toBe("Helpdesk agents");
    await expect(row().locator(".ink-warn")).toHaveCount(0);
    await expect(page.getByText("Enterprise features (the helpdesk, SSO, SCIM, audit export, training) turn off immediately.", { exact: false })).toBeVisible();
    await shot(page, "b4-license-agents-1440");

    // Over: the used number amber, with "over by".
    await stubLicense((b) => ({ license: { ...b.license, agents: 6 }, agentsAllowed: 6, agentsUsed: 7, buyAgentsUrl: BUY_URL }));
    await open();
    await expect(row().locator(".ink-warn").first()).toHaveText("7");
    await expect(row().locator("dd")).toContainText("· over by 1");
    await expect(row().locator("dd")).not.toContainText("not enforced");
    await shot(page, "b5-license-agents-over-1440", false);

    // Over in grace: the key's number, the over count muted, not enforced.
    await stubLicense((b) => ({ license: { ...b.license, agents: 6 }, agentsAllowed: null, agentsUsed: 7, buyAgentsUrl: BUY_URL }));
    await open();
    await expect(row().locator("dd")).toContainText("7 / 6");
    await expect(row().locator("dd")).toContainText("· over by 1");
    await expect(row().locator("dd")).toContainText("· not enforced in grace");
    await expect(row().locator(".ink-warn")).toHaveCount(0);

    // The helpdesk off: no row.
    await stubLicense(() => ({ agentsUsed: null }));
    await open();
    await expect(row()).toHaveCount(0);
  });
});
