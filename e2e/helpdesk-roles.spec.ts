import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Desk roles (Helpdesk 1.19.0, agent J): Settings → Agents and Settings →
// Roles in the desk, as the workspace administrator (desk Admin from their
// workspace role). Unlicensed builds answer 402 behind the desk, so these
// skip themselves and the EE rig runs them. The matrix is never saved here
// (it is shared state); the Agents flow adds and removes its own account.

const NEWBIE = { username: "e2e_hd_newbie", password: "E2eNewbie!12345" };

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/roles");
  if (res.status === 402) return false;
  expect(res.status, "the admin is desk Admin").toBe(200);
  return true;
}

test.describe("desk roles", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test("Agents: the admin is Admin from their workspace role; add a newbie, promote, remove", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await ensureUser(page, NEWBIE, "viewer", "Nia Newbie");
    const users = await api(page, "/api/users/mentionable");
    const nia = (users.body.users as { id: number; username: string }[]).find((u) => u.username === NEWBIE.username)!;
    await api(page, `/api/helpdesk/admin/agents/${nia.id}`, { method: "DELETE" }); // a clean start

    await page.goto("/desk/settings/agents");
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    await expect(page.getByText("Admin (from workspace role)").first()).toBeVisible();

    await page.getByRole("button", { name: "Add agent" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Person" }).fill("Nia Newbie");
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Role").selectOption("newbie");
    const added = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/admin/agents") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Add to desk" }).click();
    expect((await added).status()).toBe(201);

    const role = page.getByRole("combobox", { name: "Desk role of Nia Newbie" });
    await expect(role).toHaveValue("newbie");
    const changed = page.waitForResponse((r) => r.url().includes(`/api/helpdesk/admin/agents/${nia.id}`) && r.request().method() === "PATCH");
    await role.selectOption("agent");
    expect((await changed).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Desk role of Nia Newbie" })).toHaveValue("agent");

    await page.getByRole("button", { name: "Remove Nia Newbie from the desk" }).click();
    const removed = page.waitForResponse((r) => r.url().includes(`/api/helpdesk/admin/agents/${nia.id}`) && r.request().method() === "DELETE");
    await page.getByRole("dialog").getByRole("button", { name: "Remove from desk" }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByRole("combobox", { name: "Desk role of Nia Newbie" })).toHaveCount(0);
  });

  test("Roles: Admin's column is locked, the exclusive reply pair flips, unsaved changes are flagged", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await page.goto("/desk/settings/roles");
    await expect(page.getByRole("heading", { level: 1, name: "Roles" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Admin: Delete tickets" })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Admin: Delete tickets" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Team lead: Assign desk roles" })).toBeDisabled();

    const pub = page.getByRole("checkbox", { name: "Newbie: Reply to the requester" });
    const held = page.getByRole("checkbox", { name: "Newbie: Reply after review" });
    await expect(held).toBeChecked();
    await pub.check();
    await expect(held).not.toBeChecked();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await held.check();
    await expect(pub).not.toBeChecked();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  });

  test("Reviews: the list answers for a reviewer", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const res = await api(page, "/api/helpdesk/reviews");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviews)).toBeTruthy();
  });
});
