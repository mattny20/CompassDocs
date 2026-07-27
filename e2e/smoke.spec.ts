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

test("admin signs in and sees the dashboard hub", async ({ page }) => {
  await login(page, ADMIN);
  // Greeting header + hero search are the dashboard's spine.
  await expect(page.locator("h1")).toContainText(/,/);
  await expect(page.getByText(/Search, or ask/)).toBeVisible();
  // Seeded example spaces render in the spaces column.
  await expect(page.locator("text=Spaces").first()).toBeVisible();
});
