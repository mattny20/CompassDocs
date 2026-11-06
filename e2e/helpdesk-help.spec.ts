import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.0 Helpdesk, Get help (agent E): /help with the guide search and the
// request-type cards, a request form and its validation, the request page
// (progress, reply), My requests, Approvals, and the CompassDocs triggers
// (Report a problem with this page, Request access on a space address).
//
// Licensed builds only: the requester API answers 402 on the community
// build, where the specs check the licence gate and skip the rest, as the
// other licensed specs do.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** The requester API answers 402 on the community build. */
async function helpdeskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/request-types");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the request types").toBe(200);
  return true;
}

/** The starter set (teams, request types, workflows); a second run adds nothing. */
async function ensureStarter(page: Page): Promise<void> {
  const res = await api(page, "/api/helpdesk/admin/setup/starter", { method: "POST", body: {} });
  expect([200, 201, 409], "starter set").toContain(res.status);
}

test.describe("Get help", () => {
  test("unlicensed: every /help page shows the licence gate under its own title", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(await helpdeskLicensed(page), "licensed build: the gate does not show");
    for (const [path, title] of [
      ["/help", "Get help"],
      ["/help/requests", "My requests"],
      ["/help/approvals", "Approvals"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("h1")).toHaveText(title);
      await expect(page.getByText("The helpdesk is an Enterprise feature.")).toBeVisible();
    }
    // No trigger offers a request the API would refuse.
    await page.goto("/spaces/no-such-space-" + stamp());
    await expect(page.locator("h1")).toHaveText("Page not found");
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });

  test("the catalog, the guide search, a request form, the request page and My requests", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await helpdeskLicensed(page)), "community build: the helpdesk answers 402");
    await ensureStarter(page);

    await page.goto("/help");
    await expect(page.locator("h1")).toHaveText("Get help");
    await expect(page.getByRole("heading", { name: "Popular requests" })).toBeVisible();
    const card = page.getByRole("link", { name: /Report a problem/ });
    await expect(card).toBeVisible();

    // The guide search offers documents first and the request under them.
    await page.getByRole("searchbox", { name: "Describe what you need" }).fill("password reset");
    const panel = page.getByRole("dialog", { name: "Suggested guides" });
    await expect(panel.getByText("These might solve it")).toBeVisible();
    await expect(panel.getByRole("link", { name: "Send a request" })).toHaveAttribute("href", /\/help\/new\?subject=password%20reset/);
    await page.keyboard.press("Escape");

    // Report a problem asks for a subject and a description beside its own question.
    await card.click();
    await expect(page).toHaveURL(/\/help\/new\/report-a-problem$/);
    await expect(page.locator("h1")).toHaveText("Report a problem");
    await expect(page.getByRole("heading", { name: "What happens next" })).toBeVisible();
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Say in a few words what you need.")).toBeVisible();
    await expect(page.getByLabel("What do you need?")).toBeFocused();

    const subject = `Printer jams on the 2nd floor ${stamp()}`;
    await page.getByLabel("What do you need?").fill(subject);
    await page.getByLabel("Tell us more").fill("Every second page jams since this morning.");
    await page.getByLabel("How much does it stop you working?").selectOption("slowed");
    await page.getByRole("button", { name: "Send request" }).click();

    // The request page may compile on first visit (dev server): allow for it.
    await expect(page).toHaveURL(/\/help\/requests\/\d+$/, { timeout: 30_000 });
    const number = Number(page.url().split("/").pop());
    await expect(page.locator("h1")).toHaveText(subject);
    const progress = page.getByRole("region", { name: "Progress" });
    await expect(progress.getByText("Sent")).toBeVisible();
    await expect(page.getByText("Every second page jams since this morning.")).toBeVisible();

    // A reply lands in the conversation.
    await page.getByLabel("Add a message").fill("It happens on A3 paper only.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("It happens on A3 paper only.")).toBeVisible();

    // My requests lists it, open.
    await page.goto("/help/requests");
    await expect(page.locator("h1")).toHaveText("My requests");
    await expect(page.getByRole("link", { name: new RegExp(subject) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(subject) })).toHaveAttribute("href", `/help/requests/${number}`);
  });

  test("Approvals: an empty list says so; a decline needs a note", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await helpdeskLicensed(page)), "community build: the helpdesk answers 402");
    await page.goto("/help/approvals");
    await expect(page.locator("h1")).toHaveText("Approvals");
    const decline = page.getByRole("button", { name: "Decline", exact: true });
    if ((await decline.count()) === 0) {
      await expect(page.getByText("Nothing waiting for your decision")).toBeVisible();
      return;
    }
    await decline.first().click();
    await expect(page.getByText("Add a note to decline: the requester sees it.")).toBeVisible();
  });

  test("a document page offers Report a problem with this page", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await helpdeskLicensed(page)), "community build: the helpdesk answers 402");
    await ensureStarter(page);
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: `Helpdesk trigger page ${stamp()}`, status: "published", content: "Body.", tags: [] },
    });
    expect(made.status, "document created").toBe(201);
    await page.goto(`/doc/${made.body.doc.id}`);
    await page.getByRole("button", { name: "Report a problem with this page" }).click();
    const dialog = page.getByRole("dialog", { name: "Report a problem with this page" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("What's wrong with it?").fill("The screenshots show the old menu.");
    await dialog.getByLabel("How much does it stop you working?").selectOption("minor");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Request #\d+ sent/)).toBeVisible();
    await api(page, `/api/documents/${made.body.doc.id}`, { method: "DELETE" });
  });

  test("a space address offers Request access, worded the same whether or not a space is there", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await helpdeskLicensed(page)), "community build: the helpdesk answers 402");
    await ensureStarter(page);
    await page.goto(`/spaces/no-such-space-${stamp()}`);
    await expect(page.locator("h1")).toHaveText("Page not found");
    await expect(page.getByText("If this is a space you need for your work, you can ask for access.")).toBeVisible();
    await page.getByRole("button", { name: "Request access" }).click();
    await expect(page.getByRole("dialog", { name: "Request access" })).toBeVisible();
    // Any other address keeps the plain not-found page.
    await page.keyboard.press("Escape");
    await page.goto(`/doc/999999999`);
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });

  test("Get help fits a phone: no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, ADMIN);
    await page.goto("/help");
    await expect(page.locator("h1")).toHaveText("Get help");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
