import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// The recycle bin for deleted tickets (Helpdesk 1.19.4, area C7; mock-ups
// v1 to v4), as the workspace administrator (desk Admin: Delete tickets and
// Delete for good). Each test makes its own team and tickets (stamped) and
// empties them from the bin afterwards. Unlicensed builds answer 402
// behind the desk, so these skip themselves and the EE rig runs them.

async function deskLicensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status === 200;
}

interface Fixture {
  team: number;
  stamp: string;
  numbers: number[];
}

async function setup(page: Page, n: number): Promise<Fixture> {
  const stamp = `${Date.now()}`;
  const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E bin ${stamp}`, position: 9910 } });
  expect(team.status, JSON.stringify(team.body)).toBe(201);
  const numbers: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `E2E ${stamp} bin ${i + 1}`, body: `Message ${i + 1}`, team_id: team.body.team.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    numbers.push(r.body.ticket.number);
  }
  return { team: team.body.team.id, stamp, numbers };
}

/** Lift holds, move what is left to the bin, then empty it for good, and drop the team. */
async function teardown(page: Page, f: Fixture) {
  for (const n of f.numbers) await api(page, `/api/helpdesk/tickets/${n}/legal-hold`, { method: "PUT", body: { on: false } });
  await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "bin", numbers: f.numbers } });
  await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "purge", numbers: f.numbers } });
  await api(page, `/api/helpdesk/admin/teams/${f.team}`, { method: "DELETE" });
}

const box = (page: Page, number: number) => page.getByRole("checkbox", { name: new RegExp(`^Select #${number} `) });

test.describe("recycle bin", () => {
  // First visits compile the desk routes on a dev server.
  test.describe.configure({ timeout: 300_000 });
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test("the Roles matrix: Delete tickets (changed) and Delete for good (new, Admin only)", async ({ page }) => {
    await page.goto("/desk/settings/roles");
    await expect(page.getByRole("checkbox", { name: "Admin: Delete for good" })).toBeChecked({ timeout: 60_000 });
    await expect(page.getByRole("checkbox", { name: "Manager: Delete for good" })).not.toBeChecked();
    const row = page.getByRole("rowheader", { name: /Delete tickets/ });
    await expect(row).toContainText("Changed");
    await expect(row).toContainText("recycle bin");
    await expect(page.getByRole("rowheader", { name: /Delete for good/ })).toContainText("New");
  });

  test("bulk delete keeps a ticket on legal hold, Undo puts them back, the bin lists them, a binned ticket opens read-only and is restored, Delete for good", async ({ page }) => {
    const f = await setup(page, 3);
    try {
      const [a, b, held] = f.numbers;
      expect((await api(page, `/api/helpdesk/tickets/${held}/legal-hold`, { method: "PUT", body: { on: true } })).status).toBe(200);
      await page.goto(`/desk?team=${f.team}&sort=created`);
      await expect(box(page, a)).toBeVisible({ timeout: 60_000 });
      for (const n of [a, b, held]) await box(page, n).click();
      const bar = page.getByRole("region", { name: "Bulk actions" });
      await expect(bar.getByText("3 selected")).toBeVisible();
      await bar.getByRole("button", { name: "Delete 3 selected tickets" }).click();

      // v1: the server's per-ticket check, the held one listed as staying.
      const dialog = page.getByRole("dialog", { name: "Move 2 of 3 tickets to the recycle bin?" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("listitem").filter({ hasText: `#${held}` })).toContainText("Legal hold, stays");
      await expect(dialog).toContainText("You can restore them from the recycle bin for 30 days.");
      await dialog.getByRole("button", { name: "Move 2 to the recycle bin" }).click();
      await expect(page.getByText("2 tickets moved to the recycle bin. 1 stayed.")).toBeVisible();
      await expect(box(page, a)).toBeHidden();
      await expect(box(page, held)).toBeVisible();

      // Undo restores them through the API.
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("2 tickets restored.")).toBeVisible();
      await expect(box(page, a)).toBeVisible();
      expect((await api(page, `/api/helpdesk/tickets/${a}`)).status).toBe(200);

      // The single delete from the … menu.
      await page.goto(`/desk/tickets/${a}?team=${f.team}`);
      await expect(page.getByRole("heading", { name: `E2E ${f.stamp} bin 1`, exact: true })).toBeVisible({ timeout: 60_000 });
      // A cold dev server can take the first click before the pane is interactive: retry until the menu shows.
      const deleteItem = page.getByRole("menuitem", { name: "Delete ticket…" });
      await expect(async () => {
        if (!(await deleteItem.isVisible())) await page.getByRole("button", { name: `More actions for ticket #${a}` }).click();
        await expect(deleteItem).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 60_000 });
      await deleteItem.click();
      const one = page.getByRole("dialog", { name: `Move #${a} to the recycle bin?` });
      await expect(one).toContainText("Nothing is sent to anyone.");
      await one.getByRole("button", { name: "Move to the recycle bin" }).click();
      await expect(page.getByText(`#${a} moved to the recycle bin.`)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/desk\\?team=${f.team}`));
      expect((await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "bin", numbers: [b] } })).body.ok).toBe(1);

      // v2: the bin, from the Views nav.
      await page.getByRole("navigation", { name: "Ticket views" }).getByRole("link", { name: /Recycle bin/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Recycle bin" })).toBeVisible();
      // Only the bin's row is current in the Views nav here.
      const views = page.getByRole("navigation", { name: "Ticket views" });
      await expect(views.getByRole("link", { name: /Recycle bin/ })).toHaveAttribute("aria-current", "page");
      await expect(views.locator('[aria-current="page"]')).toHaveCount(1);
      await page.getByRole("textbox", { name: "Search deleted tickets" }).fill(`E2E ${f.stamp}`);
      const rowA = page.getByRole("row").filter({ hasText: `#${a}` });
      await expect(rowA).toContainText("30 days");
      await expect(page.getByRole("row").filter({ hasText: `#${b}` })).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: `#${held}` })).toHaveCount(0);
      // On a phone the table folds (no Team, Deleted by or row Restore columns) and the page never scrolls sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("columnheader", { name: "Left" })).toBeVisible();
      await expect(rowA.getByRole("button", { name: `Restore #${a}` })).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.setViewportSize({ width: 1280, height: 720 });

      // v3: a binned ticket by link is read-only under the banner; Restore puts it back.
      await page.goto(`/desk/tickets/${b}`);
      const banner = page.getByTestId("binned-banner");
      await expect(banner).toContainText("This ticket is in the recycle bin.", { timeout: 60_000 });
      await expect(banner).toContainText("deleted it today at");
      await expect(page.getByRole("textbox", { name: /Reply|Internal note/ })).toHaveCount(0);
      await page.goto(`/desk/recycle-bin/${a}`);
      await expect(page.getByTestId("binned-banner")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("binned-banner").getByRole("button", { name: "Restore" }).click();
      await expect(page).toHaveURL(new RegExp(`/desk/tickets/${a}$`));
      await expect(page.getByRole("heading", { name: `E2E ${f.stamp} bin 1`, exact: true })).toBeVisible({ timeout: 60_000 });

      // Delete for good asks for the typed word; it can't be undone.
      await page.goto("/desk/recycle-bin");
      await page.getByRole("textbox", { name: "Search deleted tickets" }).fill(`E2E ${f.stamp}`);
      await page.getByRole("checkbox", { name: new RegExp(`^Select #${b} `) }).click();
      await page.getByRole("button", { name: "Delete for good…" }).click();
      const confirm = page.getByRole("dialog", { name: `Delete #${b} for good?` });
      await confirm.getByRole("textbox").fill("DELETE");
      await confirm.getByRole("button", { name: "Delete for good" }).click();
      await expect(page.getByText("1 ticket deleted for good.")).toBeVisible();
      expect((await api(page, `/api/helpdesk/recycle-bin/${b}`)).status).toBe(404);
    } finally {
      await teardown(page, f);
    }
  });
});
