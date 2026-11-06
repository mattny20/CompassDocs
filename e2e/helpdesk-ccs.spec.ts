import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// CCs and followers (Helpdesk 1.19.1, agent V3). The desk's CC row, + Add,
// Follow / Unfollow and the composer's "Reply to … + 1 CC"; Get help's
// "People on this request" for the requester (Add people) and for a CC
// (the conversation without internal notes, a reply, Leave). Each test
// makes its own team and tickets (stamped) and deletes them afterwards.
// Unlicensed builds answer 402 behind the desk, so these skip themselves.

const REQ = { username: "e2e_hd_cc_req", password: "E2eCcReq!12345" };
const CC = { username: "e2e_hd_cc_priya", password: "E2eCcPriya!12345" };

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/counts");
  if (res.status === 402) return false;
  return res.status === 200;
}

async function users(page: Page) {
  await ensureUser(page, REQ, "viewer", "Daniel Okafor");
  await ensureUser(page, CC, "viewer", "Priya Natarajan");
  const all = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
  return { req: all.find((u) => u.username === REQ.username)!.id, cc: all.find((u) => u.username === CC.username)!.id };
}

async function team(page: Page, stamp: string): Promise<number> {
  const t = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E CC ${stamp}`, position: 9910 } });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  return t.body.team.id;
}

// First compiles of each route on a dev server take seconds.
const slow = { timeout: 30_000 };

test.describe("CCs and followers", () => {
  // Three sign-ins and first compiles of the desk and Get help routes on a dev server.
  test.describe.configure({ timeout: 240_000 });
  test("desk: add a CC, the composer counts them, follow and unfollow", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const stamp = `${Date.now()}`;
    const u = await users(page);
    const teamId = await team(page, stamp);
    const made = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `E2E ${stamp} VPN from home`, body: "Authentication failed from home.", team_id: teamId, requester_id: u.req },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const number = made.body.ticket.number as number;
    try {
      await page.goto(`/desk/tickets/${number}`);
      const row = page.getByTestId("ticket-people");
      await expect(row.getByRole("group", { name: "CC" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("radio", { name: "Reply to Daniel", exact: true })).toBeVisible();

      await row.getByRole("button", { name: "Add" }).click();
      const dialog = page.getByRole("dialog", { name: "Add people" });
      await dialog.getByRole("combobox").fill("Priya Natarajan");
      const option = page.getByRole("option", { name: /Priya Natarajan/ }).first();
      await expect(option).toBeVisible({ timeout: 30_000 });
      await option.click();
      await expect(page.getByText("Priya Natarajan added as CC.")).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
      await expect(row.getByRole("group", { name: "CC" }).getByText("Priya Natarajan")).toBeVisible(slow);
      await expect(page.getByRole("radio", { name: "Reply to Daniel + 1 CC" })).toBeVisible(slow);

      // Follow, then the Following row names you; Unfollow takes you off.
      await page.getByRole("button", { name: /^Follow(\s|$)/ }).click();
      await expect(row.getByRole("group", { name: "Following" }).getByText("You")).toBeVisible(slow);
      await page.getByRole("button", { name: /^Unfollow/ }).click();
      await expect(page.getByRole("button", { name: /^Follow(\s|$)/ })).toBeVisible(slow);

      // Removing the CC.
      await row.getByRole("button", { name: "Remove Priya Natarajan from CC" }).click();
      await expect(page.getByText("Priya Natarajan removed from CC.")).toBeVisible(slow);
      const people = await api(page, `/api/helpdesk/tickets/${number}/people`);
      expect(people.body.ccs).toHaveLength(0);
    } finally {
      await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
      await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    }
  });

  test("Get help: the requester adds people; a CC reads public replies only, replies and can leave", async ({ page, browser }) => {
    await login(page, ADMIN);
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const stamp = `${Date.now()}`;
    const u = await users(page);
    const teamId = await team(page, stamp);
    const reqCtx = await browser.newContext();
    const ccCtx = await browser.newContext();
    let number = 0;
    try {
      // The requester raises a request from the form, copying Priya on it.
      const reqPage = await reqCtx.newPage();
      await login(reqPage, REQ);
      const made = await api(reqPage, "/api/helpdesk/requests", {
        method: "POST",
        body: { subject: `E2E ${stamp} Shared drive`, body: "Need Q4 finance access.", cc: [{ user_id: u.cc }] },
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      number = made.body.ticket.number;
      await api(page, `/api/helpdesk/tickets/${number}`, { method: "PATCH", body: { team_id: teamId } });
      // The desk writes a note and a public reply.
      expect((await api(page, `/api/helpdesk/tickets/${number}/messages`, { method: "POST", body: { kind: "internal", body: `secret note ${stamp}` } })).status).toBe(201);
      const pub = await api(page, `/api/helpdesk/tickets/${number}/messages`, { method: "POST", body: { kind: "public", body: `public answer ${stamp}` } });
      expect(pub.status, JSON.stringify(pub.body)).toBe(201);
      // Where the shared rig's desk roles hold the admin's replies for review, the CC must not see it either.
      const held = pub.body.held === true;

      await reqPage.goto(`/help/requests/${number}`);
      const card = reqPage.getByTestId("request-people");
      await expect(card.getByRole("heading", { name: "People on this request" })).toBeVisible({ timeout: 30_000 });
      await expect(card.getByText("Priya Natarajan")).toBeVisible(slow);
      await expect(card.getByRole("button", { name: "Add people" })).toBeVisible();

      // The CC's view: public reply yes, internal note never; they reply.
      const ccPage = await ccCtx.newPage();
      await login(ccPage, CC);
      await ccPage.goto(`/help/requests/${number}`);
      await expect(ccPage.getByText("Need Q4 finance access.")).toBeVisible(slow);
      if (held) await expect(ccPage.getByText(`public answer ${stamp}`)).toHaveCount(0);
      else await expect(ccPage.getByText(`public answer ${stamp}`)).toBeVisible();
      await expect(ccPage.getByText(`secret note ${stamp}`)).toHaveCount(0);
      const ccCard = ccPage.getByTestId("request-people");
      await expect(ccCard.getByText("Daniel Okafor")).toBeVisible(slow);
      await expect(ccCard.getByRole("button", { name: "Add people" })).toHaveCount(0);
      const reply = await api(ccPage, `/api/helpdesk/requests/${number}/messages`, { method: "POST", body: { body: `cc reply ${stamp}` } });
      expect(reply.status).toBe(201);
      // The desk's agent view is not theirs.
      expect([403, 404]).toContain((await api(ccPage, `/api/helpdesk/tickets/${number}`)).status);

      // The CC leaves and can no longer open it.
      await ccPage.goto(`/help/requests/${number}`);
      await ccCard.getByRole("button", { name: "Leave" }).click();
      await ccPage.getByRole("dialog").getByRole("button", { name: "Leave" }).click();
      await ccPage.waitForURL("**/help/requests", slow);
      expect((await api(ccPage, `/api/helpdesk/requests/${number}`)).status).toBe(404);
    } finally {
      if (number) await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
      await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
      await reqCtx.close();
      await ccCtx.close();
    }
  });
});
