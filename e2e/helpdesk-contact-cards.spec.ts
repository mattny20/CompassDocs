import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.0 Helpdesk, contact cards (agent O): the requester's card in the
// desk's side panel, "Who's helping you" on the request page in Get help,
// and Desk settings → Contact cards. Licensed builds only: the API answers
// 402 on the community build and the specs skip.
//
// Global state: the contact card settings are read first and put back
// exactly as they were.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function licensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/contact-cards");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the contact card settings").toBe(200);
  return true;
}

test.describe("Helpdesk contact cards", () => {
  test("the desk shows the requester's card; Get help says who is on it; access is per ticket", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "community build: the helpdesk answers 402");
    const starter = await api(page, "/api/helpdesk/admin/setup/starter", { method: "POST", body: {} });
    expect([200, 201, 409]).toContain(starter.status);

    const subject = `Contact card check ${stamp()}`;
    const made = await api(page, "/api/helpdesk/requests", { method: "POST", body: { subject, body: "The VPN drops every hour." } });
    expect(made.status).toBe(201);
    const number = made.body.ticket.number as number;

    // The API: one card for the requester, nobody else's.
    const list = await api(page, `/api/helpdesk/contacts?ticket=${number}`);
    expect(list.status).toBe(200);
    expect(list.body.contacts[0].relation).toBe("requester");
    expect((await api(page, `/api/helpdesk/contacts/999999999?ticket=${number}`)).status).toBe(404);
    expect((await api(page, `/api/helpdesk/contacts?ticket=999999999`)).status).toBe(404);

    // The desk's side panel.
    await page.goto(`/desk/tickets/${number}`);
    const card = page.locator('section[aria-labelledby="hd-contact-requester"]');
    // The desk opens a ticket with several requests at once; on a dev server the card can take a while.
    await expect(card.getByRole("heading", { name: "Requester" })).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(list.body.contacts[0].name).first()).toBeVisible();

    // Get help: the request page carries "Who's helping you".
    await page.goto(`/help/requests/${number}`);
    await expect(page.getByRole("heading", { name: "Who’s helping you" })).toBeVisible();
  });

  test("Desk settings → Contact cards saves and puts back", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "community build: the helpdesk answers 402");
    const before = (await api(page, "/api/helpdesk/admin/contact-cards")).body.settings;
    try {
      await page.goto("/desk/settings/contact-cards");
      await expect(page.locator("h1")).toHaveText("Contact cards");
      await page.getByRole("combobox", { name: "Webex", exact: true }).selectOption("email");
      await page.getByRole("button", { name: "Save contact cards" }).click();
      await expect(page.getByText("Contact card settings saved.")).toBeVisible();
      const after = (await api(page, "/api/helpdesk/admin/contact-cards")).body.settings;
      expect(after.webex.mode).toBe("email");
      // The phones stay off for requesters unless ticked.
      expect(after.requester_sees).not.toContain("cell_phone");
    } finally {
      const put = await api(page, "/api/helpdesk/admin/contact-cards", { method: "PUT", body: before });
      expect(put.status).toBe(200);
    }
  });
});
