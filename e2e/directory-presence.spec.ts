import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Teams presence (1.3.5): the switch lives with the Microsoft sync settings
// and round-trips; the community build keeps the directory dot-free and
// never asks the enterprise route.

test("the presence switch round-trips on the Microsoft sync settings; the community build shows no dots", async ({ page }) => {
  await login(page, ADMIN);
  const before = await api(page, "/api/admin/directory/graph");
  expect(before.status).toBe(200);
  expect(before.body.presence).toBe(false);
  try {
    const on = await api(page, "/api/admin/directory/graph", { method: "PATCH", body: { presence: true } });
    expect(on.status).toBe(200);
    expect((await api(page, "/api/admin/directory/graph")).body.presence).toBe(true);

    // The Sync page offers the switch on an enterprise build; the community
    // build shows the licence notice instead and keeps the setting.
    await page.goto("/admin/directory/sync");
    if (before.body.bundled) {
      await expect(page.getByText("Show Teams presence")).toBeVisible();
    } else {
      await expect(page.getByText("Microsoft 365 directory sync")).toBeVisible();
    }

    // Community build: the enterprise route is not there, the page has no dot
    // and asks nothing.
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ee/directory/presence")) asked.push(r.url());
    });
    await page.goto("/directory");
    await expect(page.getByRole("heading", { name: "Directory" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(asked).toEqual([]);
    expect(await page.locator('[role="img"][aria-label$=": Available"], [role="img"][aria-label$=": Busy"], [role="img"][aria-label$=": Away"]').count()).toBe(0);
  } finally {
    await api(page, "/api/admin/directory/graph", { method: "PATCH", body: { presence: before.body.presence } });
  }
});
