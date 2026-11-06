import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Major incidents (Helpdesk 1.19.2, agent W1), as the workspace
// administrator (desk Admin) with two requesters. Each test makes its own
// team and tickets (stamped) and deletes them afterwards (deleting the
// incident's ticket removes the incident). Unlicensed builds answer 402
// behind the desk, so these skip themselves and the EE rig runs them.

const REQ_A = { username: "e2e_hd_inc_req_a", password: "E2eIncReqA!12345" };
const REQ_B = { username: "e2e_hd_inc_req_b", password: "E2eIncReqB!12345" };

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/counts");
  return res.status === 200;
}

interface Fixture {
  team: number;
  stamp: string;
  numbers: number[];
}

async function setup(page: Page, n: number): Promise<Fixture> {
  const stamp = `${Date.now()}`;
  await ensureUser(page, REQ_A, "viewer", "Priya Incident");
  await ensureUser(page, REQ_B, "viewer", "Tom Incident");
  const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
  const reqs = [REQ_A, REQ_B].map((r) => users.find((u) => u.username === r.username)!.id);
  const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E incidents ${stamp}`, position: 9910 } });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  const numbers: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `E2E ${stamp} can't connect ${i + 1}`, body: `Message ${i + 1}`, team_id: team.body.team.id, requester_id: reqs[i % 2] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    numbers.push(r.body.ticket.number);
  }
  return { team: team.body.team.id, stamp, numbers };
}

async function teardown(page: Page, f: Fixture, more: number[] = []) {
  for (const n of [...more, ...f.numbers]) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
  await api(page, `/api/helpdesk/admin/teams/${f.team}`, { method: "DELETE" });
}

const box = (page: Page, number: number) => page.getByRole("checkbox", { name: new RegExp(`^Select #${number} `) });

test.describe("major incidents", () => {
  // First visits compile the desk routes on a dev server.
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test("declare from a selection, post an update, Me too in Get help, then solve everything", async ({ page, browser }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const f = await setup(page, 2);
    let incident = 0;
    const reqCtx = await browser.newContext();
    try {
      const [a, b] = f.numbers;
      const title = `E2E ${f.stamp} VPN is down from home`;
      await page.goto(`/desk?team=${f.team}&sort=created`);
      await expect(box(page, a)).toBeVisible({ timeout: 60_000 });
      await box(page, a).click();
      await box(page, b).click();
      const bar = page.getByRole("region", { name: "Bulk actions" });
      await bar.getByRole("button", { name: "Declare incident…" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Declare a major incident" })).toBeVisible();
      await expect(dialog.getByText("The 2 selected tickets")).toBeVisible();
      await dialog.getByLabel("Title people will see").fill(title);
      await dialog.getByLabel("Team").selectOption(String(f.team));
      await dialog.getByLabel("Link new tickets automatically while it's open").fill(`e2evpn${f.stamp}`);
      const declared = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/incidents") && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "Declare incident" }).click();
      const res = await declared;
      expect(res.status()).toBe(201);
      incident = (await res.json()).number;
      await page.waitForURL(new RegExp(`/desk/tickets/${incident}`));

      // The incident's ticket: the banner, the linked tickets, the nav group.
      await expect(page.getByTestId("incident-banner")).toContainText("Major incident", { timeout: 60_000 });
      await expect(page.getByTestId("incident-banner")).toContainText("2 tickets linked · shown in Get help");
      const linked = page.getByTestId("incident-linked");
      await expect(linked.getByRole("heading", { name: "Linked tickets · 2" })).toBeVisible();
      await expect(linked.getByRole("link", { name: `#${a}` })).toBeVisible();
      await expect(linked).toContainText(`e2evpn${f.stamp}`);
      const nav = page.getByTestId("incidents-nav").first();
      await expect(nav.getByRole("link", { name: new RegExp(title) })).toBeVisible();

      // The requesters were told when their tickets were linked.
      const msgs = (await api(page, `/api/helpdesk/tickets/${a}`)).body.messages as { kind: string; body: string }[];
      expect(msgs.some((m) => m.kind === "public" && m.body.startsWith("We know about this problem"))).toBe(true);

      // Post an update to everyone affected.
      const updates = page.getByTestId("incident-updates");
      await updates.getByLabel("Update to everyone affected").fill("We've found the cause: an expired certificate. A new one is going in now.");
      const posted = page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/incidents/${incident}/updates`));
      await updates.getByRole("button", { name: "Post update" }).click();
      expect((await posted).status()).toBe(200);
      await expect(page.getByText("Update sent to 2 requesters.")).toBeVisible({ timeout: 60_000 });
      await expect(updates.getByText("We've found the cause: an expired certificate.")).toBeVisible({ timeout: 30_000 });
      await expect(updates.getByText(/sent to 2 requesters and shown in Get help/)).toBeVisible();

      // Queue rows carry the chips.
      await page.goto(`/desk?team=${f.team}&sort=created`);
      await expect(page.locator(`li[data-number="${incident}"]`).getByText("Major incident")).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(`li[data-number="${a}"]`).getByText(`#${incident}`, { exact: false }).last()).toBeVisible();

      // Get help: the banner with the latest update, and Me too.
      const req = await reqCtx.newPage();
      await login(req, REQ_A);
      await req.goto("/help");
      const banner = req.getByRole("region", { name: title });
      await expect(banner).toContainText("We've found the cause: an expired certificate.", { timeout: 60_000 });
      await expect(banner).toContainText("2 people affected");
      const meToo = banner.getByRole("button", { name: "Me too" });
      await meToo.click();
      // The first press compiles the route on a dev server.
      await expect(meToo).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
      await expect(banner).toContainText("including you");

      // Solve the incident and its linked tickets.
      await page.goto(`/desk/tickets/${incident}?team=${f.team}`);
      const box2 = page.getByTestId("incident-updates");
      await box2.getByLabel("Update to everyone affected").fill("The VPN is working again.", { timeout: 60_000 });
      await box2.getByRole("checkbox", { name: "Solve the incident and its 2 linked tickets" }).check();
      await box2.getByRole("button", { name: "Post update" }).click();
      const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
      const solved = page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/incidents/${incident}/updates`));
      await confirm.getByRole("button", { name: "Post and solve" }).click();
      const sres = await solved;
      expect(sres.status()).toBe(200);
      const sbody = await sres.json();
      expect(sbody.solve.incident.ok).toBe(true);
      expect(sbody.solve.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
      await expect(page.getByTestId("incident-banner")).toContainText("Major incident, solved", { timeout: 60_000 });
      for (const n of f.numbers) expect((await api(page, `/api/helpdesk/tickets/${n}`)).body.ticket.status).toBe("solved");

      // The banner is gone from Get help.
      await req.goto("/help");
      await expect(req.getByRole("heading", { name: "Get help", level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect(req.getByRole("region", { name: title })).toHaveCount(0);
    } finally {
      await reqCtx.close();
      await teardown(page, f, incident ? [incident] : []);
    }
  });

  test("a ticket's … menu links it to an open incident; its strip unlinks it", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const f = await setup(page, 2);
    let incident = 0;
    try {
      const [a, b] = f.numbers;
      const d = await api(page, "/api/helpdesk/incidents", {
        method: "POST",
        body: { title: `E2E ${f.stamp} Printers offline`, team_id: f.team, numbers: [a], notify_on_link: false, banner: "off" },
      });
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      incident = d.body.number;

      await page.goto(`/desk/tickets/${b}?team=${f.team}`);
      await page.getByRole("button", { name: `More actions for ticket #${b}` }).click({ timeout: 60_000 });
      await page.getByRole("menuitem", { name: "Link to a major incident…" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: new RegExp(`#${incident} E2E ${f.stamp} Printers offline`) }).check();
      await dialog.getByRole("button", { name: `Link to #${incident}` }).click();
      await expect(page.getByText(`#${b} linked to major incident #${incident}.`)).toBeVisible({ timeout: 60_000 });
      const strip = page.getByTestId("incident-link-strip");
      await expect(strip).toContainText(`Linked to major incident #${incident}`);
      await strip.getByRole("button", { name: "Unlink" }).click();
      // A read of the ticket's incident side starts just before the change
      // (as a poll or another view's reload can): the views must still show
      // the state after it. (1.19.2 fix: the shared read was reused for half
      // a second, so a fast server's answer to a change never showed.)
      await page.evaluate(() => window.dispatchEvent(new Event("hd-incidents-changed")));
      await page.getByRole("button", { name: "Unlink" }).last().click();
      await expect(page.getByText(`#${b} unlinked from #${incident}.`)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("incident-link-strip")).toHaveCount(0);

      // The incident's own ticket has no "Declare" or "Link" in its menu.
      await page.goto(`/desk/tickets/${incident}?team=${f.team}`);
      await expect(page.getByTestId("incident-banner")).toBeVisible({ timeout: 60_000 });
      const more = page.getByRole("button", { name: `More actions for ticket #${incident}` });
      await more.click();
      await expect(page.getByRole("menuitem", { name: "Link to a major incident…" })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Declare a major incident…" })).toHaveCount(0);
    } finally {
      await teardown(page, f, incident ? [incident] : []);
    }
  });
});
