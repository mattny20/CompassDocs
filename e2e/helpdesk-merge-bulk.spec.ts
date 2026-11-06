import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Merge tickets and bulk edits (Helpdesk 1.19.1, agent V2), as the
// workspace administrator (desk Admin). Each test makes its own team and
// tickets (stamped) and deletes them afterwards. Unlicensed builds answer
// 402 behind the desk, so these skip themselves and the EE rig runs them.

const REQ_A = { username: "e2e_hd_merge_req_a", password: "E2eMergeReqA!12345" };
const REQ_B = { username: "e2e_hd_merge_req_b", password: "E2eMergeReqB!12345" };

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/counts");
  if (res.status === 402) return false;
  return res.status === 200;
}

interface Fixture {
  team: number;
  stamp: string;
  numbers: number[];
}

async function setup(page: Page, n: number): Promise<Fixture> {
  const stamp = `${Date.now()}`;
  await ensureUser(page, REQ_A, "viewer", "Priya Merge");
  await ensureUser(page, REQ_B, "viewer", "Daniel Merge");
  const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
  const reqs = [REQ_A, REQ_B].map((r) => users.find((u) => u.username === r.username)!.id);
  const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E merge ${stamp}`, position: 9900 } });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  const numbers: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `E2E ${stamp} printer ${i + 1}`, body: `Message ${i + 1}`, team_id: team.body.team.id, requester_id: i === 0 ? undefined : reqs[(i - 1) % 2] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    numbers.push(r.body.ticket.number);
  }
  return { team: team.body.team.id, stamp, numbers };
}

async function teardown(page: Page, f: Fixture) {
  for (const n of f.numbers) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
  await api(page, `/api/helpdesk/admin/teams/${f.team}`, { method: "DELETE" });
}

const box = (page: Page, number: number) => page.getByRole("checkbox", { name: new RegExp(`^Select #${number} `) });

test.describe("merge and bulk edit", () => {
  // First visits compile the desk routes on a dev server.
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test("the Roles matrix shows Merge tickets and Bulk edit again", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await page.goto("/desk/settings/roles");
    await expect(page.getByRole("checkbox", { name: "Agent: Merge tickets" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Agent: Bulk edit" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Newbie: Merge tickets" })).not.toBeChecked();
  });

  test("select rows (click, shift-click, x), bulk set the priority, then merge three into the oldest", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const f = await setup(page, 3);
    try {
      const [a, b, c] = f.numbers;
      await page.goto(`/desk?team=${f.team}&sort=created`);
      await expect(box(page, a)).toBeVisible({ timeout: 60_000 });

      // Click one, shift-click the range, x on a focused row toggles it.
      await box(page, c).click();
      await box(page, a).click({ modifiers: ["Shift"] });
      const bar = page.getByRole("region", { name: "Bulk actions" });
      await expect(bar.getByText("3 selected")).toBeVisible();
      await page.locator(`li[data-number="${b}"] a[data-row]`).focus();
      await page.keyboard.press("x");
      await expect(bar.getByText("2 selected")).toBeVisible();
      await expect(box(page, b)).not.toBeChecked();

      await bar.getByRole("button", { name: "Priority" }).click();
      const done = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/tickets/bulk"));
      await page.getByRole("menuitemradio", { name: "High" }).click();
      const res = await done;
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(2);
      await expect(page.getByText("2 tickets set to High priority.")).toBeVisible();
      expect((await api(page, `/api/helpdesk/tickets/${a}`)).body.ticket.priority).toBe("high");
      expect((await api(page, `/api/helpdesk/tickets/${b}`)).body.ticket.priority).toBe("normal");

      // Merge all three: the oldest (a) is the one kept.
      // A successful edit cleared the selection.
      await expect(bar).toHaveCount(0);
      for (const n of f.numbers) if (!(await box(page, n).isChecked())) await box(page, n).click();
      await bar.getByRole("button", { name: "Merge…" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Merge 3 tickets" })).toBeVisible();
      await expect(dialog.getByRole("radio", { name: new RegExp(`^#${a} `) })).toBeChecked();
      await expect(dialog.getByText("Priya Merge and Daniel Merge are added as CCs")).toBeVisible();
      const merged = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/tickets/merge"));
      await dialog.getByRole("button", { name: `Merge into #${a}` }).click();
      expect((await merged).status()).toBe(200);
      await expect(page.getByText(`Merged #${b} and #${c} into #${a}.`)).toBeVisible();

      await page.goto(`/desk/tickets/${a}?team=${f.team}`);
      const related = page.getByRole("region", { name: "Related" });
      await expect(related.getByText("Merged in:")).toBeVisible({ timeout: 60_000 });
      await expect(related.getByRole("link", { name: `#${b}` })).toBeVisible();
      await expect(page.getByText(`from #${b}`).first()).toBeVisible();

      await page.goto(`/desk/tickets/${b}?team=${f.team}`);
      await expect(page.getByRole("link", { name: new RegExp(`^#${a} E2E`) })).toBeVisible({ timeout: 60_000 });
      const detail = await api(page, `/api/helpdesk/tickets/${b}`);
      expect(detail.body.ticket.status).toBe("closed");
      expect(detail.body.merge.into.number).toBe(a);
      // 1.19.1 integration: the merged ticket is read-only. No composer, no status menu, a link to the kept one.
      const lock = page.getByTestId("merged-composer-lock");
      await expect(lock).toContainText(`This ticket was merged into #${a}.`);
      await expect(lock.getByRole("link", { name: `Open #${a}` })).toHaveAttribute("href", new RegExp(`/desk/tickets/${a}`));
      await expect(page.getByRole("region", { name: "Reply" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
      expect((await api(page, `/api/helpdesk/tickets/${b}/messages`, { method: "POST", body: { kind: "internal", body: "late note" } })).status).toBe(409);
      expect((await api(page, `/api/helpdesk/tickets/${b}`, { method: "PATCH", body: { status: "open" } })).status).toBe(409);
    } finally {
      await teardown(page, f);
    }
  });

  test("a ticket's … menu merges it into another ticket found by search", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const f = await setup(page, 2);
    try {
      const [d, e] = f.numbers;
      await page.goto(`/desk/tickets/${d}?team=${f.team}`);
      await page.getByRole("button", { name: `More actions for ticket #${d}` }).click({ timeout: 60_000 });
      await page.getByRole("menuitem", { name: "Merge into another ticket…" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("The other ticket").fill(String(e));
      await dialog.getByRole("button", { name: new RegExp(`^#${e} `) }).click();
      await expect(dialog.getByRole("radio", { name: new RegExp(`^#${e} `) })).toBeChecked();
      await dialog.getByRole("checkbox", { name: /Tell the requesters/ }).uncheck();
      const merged = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/tickets/merge"));
      await dialog.getByRole("button", { name: `Merge into #${e}` }).click();
      expect((await merged).status()).toBe(200);
      await page.waitForURL(new RegExp(`/desk/tickets/${e}`));
      expect((await api(page, `/api/helpdesk/tickets/${d}`)).body.merge.into.number).toBe(e);
    } finally {
      await teardown(page, f);
    }
  });
});
