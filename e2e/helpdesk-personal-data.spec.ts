import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.1: Settings → Users, "Download personal data" (GET
// /api/admin/users/[id]/personal-data, user.delete). The admin downloads a
// person's file from their row; someone who may read users but not delete
// them sees no such action and the route answers 403.
//
// Parallel-safe: the people and the custom role are this spec's own
// (stamped) and are removed in a finally.

const SLOW = { timeout: 45_000 };
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", { method: "POST", body: { ...user, role: "viewer", name } });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

test.describe("Download personal data", () => {
  test.describe.configure({ timeout: 180_000 });

  test("the admin downloads a person's file; a reader without user.delete has no such action", async ({ page, browser }) => {
    await login(page, ADMIN);
    const s = stamp();
    const person = { username: `e2e-pd-${s}`, password: `E2ePd!${s}12345` };
    const reader = { username: `e2e-pdr-${s}`, password: `E2ePdr!${s}12345` };
    const ids: number[] = [];
    let roleId: number | null = null;
    try {
      ids.push(await makeUser(page, person, `Pia Person ${s}`));
      ids.push(await makeUser(page, reader, `Ray Reader ${s}`));
      const role = await api(page, "/api/admin/rbac/roles", {
        method: "POST",
        body: { name: `E2E user reader ${s}`, description: "e2e: reads users, cannot delete them", permissions: ["user.read"] },
      });
      expect(role.status).toBe(201);
      roleId = role.body?.id;
      expect((await api(page, "/api/admin/rbac/assignments", { method: "POST", body: { role_id: roleId, user_id: ids[1] } })).status).toBe(201);

      await page.goto("/admin/users");
      await page.getByLabel("Filter users").fill(person.username);
      // The row's less frequent actions sit in its ⋯ menu, so the table fits at 1440.
      const more = page.getByRole("button", { name: `More actions for Pia Person ${s}` });
      await expect(more).toBeVisible(SLOW);
      await expect(more).toHaveAttribute("data-tt", "More");
      expect(await more.getAttribute("title")).toBeNull();
      await more.click();
      const menu = page.getByRole("menu", { name: `More actions for Pia Person ${s}` });
      const button = menu.getByRole("menuitem", { name: "Download personal data" });
      await expect(button).toBeVisible(SLOW);
      await expect(button).toHaveAttribute("data-tt", /JSON file/);
      expect(await button.getAttribute("title")).toBeNull();
      await expect(menu.getByRole("menuitem", { name: "Delete…" })).toBeVisible();
      const download = page.waitForEvent("download", SLOW);
      await button.click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(`personal-data-${person.username}.json`);
      const body = JSON.parse(readFileSync((await file.path())!, "utf8"));
      expect(body.person.username).toBe(person.username);
      expect(body.helpdesk).toBeTruthy();
      await expect(page.getByText(`Personal data for Pia Person ${s} downloaded.`)).toBeVisible(SLOW);

      // A reader of users without user.delete: no action, and the route refuses.
      const ctx = await browser.newContext();
      try {
        const rp = await ctx.newPage();
        await login(rp, reader);
        await rp.goto("/admin/users");
        await rp.getByLabel("Filter users").fill(person.username);
        await expect(rp.getByText(`@${person.username}`)).toBeVisible(SLOW);
        await expect(rp.getByRole("menuitem", { name: /Download personal data/ })).toHaveCount(0);
        const rmore = rp.getByRole("button", { name: `More actions for Pia Person ${s}` });
        if (await rmore.count()) {
          await rmore.click();
          await expect(rp.getByRole("menuitem", { name: /Download personal data/ })).toHaveCount(0);
        }
        expect((await api(rp, `/api/admin/users/${ids[0]}/personal-data`)).status).toBe(403);
      } finally {
        await ctx.close();
      }
    } finally {
      if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
      for (const id of ids) await api(page, `/api/admin/users/${id}`, { method: "DELETE" });
    }
  });
});
