import { test, expect } from "@playwright/test";
import { ADMIN, login } from "./helpers";

test("health probes answer", async ({ request }) => {
  expect((await request.get("/healthz")).status()).toBe(200);
  const ready = await request.get("/readyz");
  expect(ready.status()).toBe(200);
  expect((await ready.json()).status).toBe("ready");
});

test("unauthenticated app routes redirect to login", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/login**");
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
});

test("every page has its own document title", async ({ page }) => {
  // Page first, workspace last (1.5.0): the tab, history and password
  // managers used to read "CompassDocs — Team Knowledge Platform" everywhere.
  await page.goto("/login");
  await expect(page).toHaveTitle(/^Sign in — /);
  await login(page, ADMIN);
  await expect(page).toHaveTitle(/^Dashboard — /);
  await page.goto("/admin/users");
  await expect(page).toHaveTitle(/^Users & roles — /);
  await page.goto("/admin/directory/fields");
  await expect(page).toHaveTitle(/^Fields · Directory — /);
  await page.goto("/doc/1");
  await expect(page).toHaveTitle(/^Production Deployment SOP — /);
  await page.goto("/doc/1/history");
  await expect(page).toHaveTitle(/^History · Production Deployment SOP — /);
});

test("admin signs in and sees the dashboard hub", async ({ page }) => {
  await login(page, ADMIN);
  // Greeting header + hero search are the dashboard's spine.
  await expect(page.locator("h1")).toContainText(/,/);
  await expect(page.getByRole("link", { name: /^Ask .* anything/ })).toBeVisible();
  // Seeded example spaces render in the spaces column.
  await expect(page.locator("text=Spaces").first()).toBeVisible();
});
