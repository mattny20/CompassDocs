import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.17.0: the redesigned dashboard. Every section is one tile with its title
// inside (DashboardTile, data-dashboard-section = its key), in two columns
// on a wide content column and one on a phone; Edit dashboard hides
// sections per person; Latest switches between the spaces you follow and
// everything; the status strip replaces the problems banner.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const tile = (page: Page, key: string) => page.locator(`[data-dashboard-section="${key}"]`);

async function setHidden(page: Page, hidden: string[]) {
  const res = await api(page, "/api/account/dashboard", { method: "PUT", body: { hidden } });
  expect(res.status).toBe(200);
}

test("tiles carry their titles inside and sit in two columns, one on a phone", async ({ browser }) => {
  for (const width of [1440, 375]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1200 } });
    const page = await ctx.newPage();
    await login(page, ADMIN);
    try {
      await setHidden(page, []);
      await page.goto("/");
      const latest = tile(page, "latest");
      const spaces = tile(page, "spaces");
      await expect(latest.getByRole("heading", { name: "Latest in your spaces" })).toBeVisible();
      await expect(spaces.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();
      // The section is named by its own heading.
      await expect(page.getByRole("region", { name: "Latest in your spaces" })).toBeVisible();
      // At most eight spaces, rows linking to each.
      expect(await spaces.locator("a[href^='/spaces/']").count()).toBeLessThanOrEqual(8);
      // The left column stacks with 24px between tiles.
      const lb = (await latest.boundingBox())!;
      const sb = (await spaces.boundingBox())!;
      expect(sb.y).toBeGreaterThan(lb.y + lb.height);
      // Quick links: beside Latest on the wide page, under the left column on a phone.
      const ql = tile(page, "quick_links");
      if (await ql.count()) {
        const qb = (await ql.boundingBox())!;
        if (width === 1440) {
          expect(qb.x, "right column").toBeGreaterThan(lb.x + lb.width);
          expect(Math.round(qb.width)).toBeLessThanOrEqual(19 * 16 + 1);
        } else {
          expect(qb.y, "below the left column").toBeGreaterThan(sb.y + sb.height);
        }
      }
      const o = await page.evaluate(() => {
        const m = document.querySelector("main")!;
        return { body: document.body.scrollWidth - document.body.clientWidth, main: m.scrollWidth - m.clientWidth };
      });
      expect(o.body, `no sideways scroll at ${width}`).toBeLessThanOrEqual(0);
      expect(o.main, `no sideways scroll at ${width}`).toBeLessThanOrEqual(0);
      // A phone folds Space and Updated by under the title.
      const spaceHeader = latest.getByRole("columnheader", { name: "Space" });
      if ((await latest.getByRole("row").count()) > 1) {
        if (width === 375) await expect(spaceHeader).toBeHidden();
        else await expect(spaceHeader).toBeVisible();
      }
    } finally {
      await ctx.close();
    }
  }
});

test("Edit dashboard hides sections for this person until they switch them back on", async ({ page }) => {
  await login(page, ADMIN);
  try {
    await setHidden(page, []);
    await page.goto("/");
    await expect(tile(page, "spaces")).toBeVisible();

    await page.getByRole("button", { name: "Edit dashboard" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit dashboard" });
    await expect(dialog).toBeVisible();
    const spacesSwitch = dialog.getByRole("switch", { name: /^Spaces/ });
    await expect(spacesSwitch).toHaveAttribute("aria-checked", "true");
    await spacesSwitch.click();
    await dialog.getByRole("switch", { name: /^Latest in your spaces/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(tile(page, "spaces")).toHaveCount(0);
    await expect(tile(page, "latest")).toHaveCount(0);

    // Stored for the person: a fresh load keeps them hidden.
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(tile(page, "spaces")).toHaveCount(0);
    const stored = await api(page, "/api/account/dashboard", { method: "PUT", body: { hidden: ["latest", "spaces"] } });
    expect(stored.body?.hidden).toEqual(["latest", "spaces"]);

    // Cancel leaves the stored state alone.
    await page.getByRole("button", { name: "Edit dashboard" }).click();
    await dialog.getByRole("switch", { name: /^Spaces/ }).click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(tile(page, "spaces")).toHaveCount(0);

    // And back on.
    await page.getByRole("button", { name: "Edit dashboard" }).click();
    await expect(dialog.getByRole("switch", { name: /^Spaces/ })).toHaveAttribute("aria-checked", "false");
    await dialog.getByRole("switch", { name: /^Spaces/ }).click();
    await dialog.getByRole("switch", { name: /^Latest in your spaces/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(tile(page, "spaces")).toBeVisible();
    await expect(tile(page, "latest")).toBeVisible();
  } finally {
    await setHidden(page, []);
  }
});

test("the dashboard API takes known section keys only", async ({ page }) => {
  await login(page, ADMIN);
  try {
    expect((await api(page, "/api/account/dashboard", { method: "PUT", body: { hidden: ["nope"] } })).status).toBe(400);
    expect((await api(page, "/api/account/dashboard", { method: "PUT", body: { hidden: "spaces" } })).status).toBe(400);
    expect((await api(page, "/api/account/dashboard", { method: "PUT", body: {} })).status).toBe(400);
    // Duplicates collapse and the order is the dashboard's.
    const ok = await api(page, "/api/account/dashboard", {
      method: "PUT",
      body: { hidden: ["people", "status", "people"] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body?.hidden).toEqual(["status", "people"]);
  } finally {
    await setHidden(page, []);
  }
});

test("Latest shows the spaces you follow by default, and Everything on request", async ({ page }) => {
  await login(page, ADMIN);
  const s = stamp();
  const docIds: number[] = [];
  // Two seeded spaces: one the admin follows for this test, one muted.
  const followed = 1;
  const other = 3;
  const before = await Promise.all(
    [followed, other].map(async (id) => (await api(page, `/api/spaces/${id}/subscription`)).body?.state ?? null)
  );
  try {
    await setHidden(page, []);
    expect((await api(page, `/api/spaces/${followed}/subscription`, { method: "PUT", body: { action: "subscribe" } })).status).toBe(200);
    expect((await api(page, `/api/spaces/${other}/subscription`, { method: "PUT", body: { action: "mute" } })).status).toBe(200);
    for (const [space, title] of [
      [followed, `E2E dash followed ${s}`],
      [other, `E2E dash elsewhere ${s}`],
    ] as const) {
      const made = await api(page, "/api/documents", {
        method: "POST",
        body: { space_id: space, title, type: "knowledge", status: "published", content: "x", tags: [] },
      });
      expect(made.status).toBeLessThan(300);
      docIds.push(made.body?.doc?.id);
    }

    await page.goto("/");
    const latest = tile(page, "latest");
    const views = latest.getByRole("radiogroup", { name: "Show updates from" }).filter({ visible: true });
    await expect(views.getByRole("radio", { name: "Following" })).toHaveAttribute("aria-checked", "true");
    await expect(latest.getByRole("link", { name: `E2E dash followed ${s}` })).toBeVisible();
    await expect(latest.getByRole("link", { name: `E2E dash elsewhere ${s}` })).toHaveCount(0);
    await expect(latest.getByText("Updated in the spaces you follow")).toBeVisible();
    // Rows name the type.
    const row = latest.getByRole("row").filter({ hasText: `E2E dash followed ${s}` });
    await expect(row.getByText("Knowledge").filter({ visible: true })).toHaveCount(1);

    await views.getByRole("radio", { name: "Everything" }).click();
    await page.waitForURL(/latest=everything/);
    await expect(latest.getByRole("link", { name: `E2E dash elsewhere ${s}` })).toBeVisible();
    await expect(latest.getByText("Updated across your spaces")).toBeVisible();
  } finally {
    for (const id of docIds) if (id) await api(page, `/api/documents/${id}`, { method: "DELETE" });
    for (const [i, id] of [followed, other].entries()) {
      const action = before[i] === "subscribed" ? "subscribe" : before[i] === "muted" ? "mute" : "clear";
      await api(page, `/api/spaces/${id}/subscription`, { method: "PUT", body: { action } });
    }
  }
});

test("the status strip names each service and counts the ones with problems", async ({ page }) => {
  await login(page, ADMIN);
  const s = stamp();
  let serviceId: number | undefined;
  try {
    await setHidden(page, []);
    const made = await api(page, "/api/admin/status", {
      method: "POST",
      body: { name: `AAA E2E strip ${s}`, provider: "manual" },
    });
    expect(made.status).toBe(201);
    serviceId = made.body?.service?.id;

    await page.goto("/");
    const strip = tile(page, "status");
    await expect(strip).toBeVisible();
    await expect(strip.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/status");

    const declared = await api(page, "/api/status/incidents", {
      method: "POST",
      body: { action: "declare", service_id: serviceId, title: "Slow", severity: "degraded" },
    });
    expect(declared.status).toBeLessThan(300);
    await page.goto("/");
    // Problems lead the list, with the incident's words.
    await expect(strip.getByText(/^\d+ services? degraded$/)).toBeVisible();
    await expect(strip.locator("li").first()).toContainText(`AAA E2E strip ${s}`);
    await expect(strip.locator("li").first()).toContainText("· Slow");

    // Hidden with Edit dashboard: not rendered.
    await setHidden(page, ["status"]);
    await page.goto("/");
    await expect(page.locator("h1")).toBeVisible();
    await expect(tile(page, "status")).toHaveCount(0);
  } finally {
    await setHidden(page, []);
    if (serviceId) await api(page, `/api/admin/status?id=${serviceId}`, { method: "DELETE" });
  }
});
