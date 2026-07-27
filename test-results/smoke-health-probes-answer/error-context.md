# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> health probes answer
- Location: e2e/smoke.spec.ts:4:5

# Error details

```
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3998
Call log:
  - → GET http://127.0.0.1:3998/healthz
    - user-agent: Playwright/1.62.0 (x64; ubuntu 24.04) node/22.22
    - accept: */*
    - accept-encoding: gzip,deflate,br

```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | import { ADMIN, login } from "./helpers";
  3  | 
  4  | test("health probes answer", async ({ request }) => {
> 5  |   expect((await request.get("/healthz")).status()).toBe(200);
     |                         ^ Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3998
  6  |   const ready = await request.get("/readyz");
  7  |   expect(ready.status()).toBe(200);
  8  |   expect((await ready.json()).status).toBe("ready");
  9  | });
  10 | 
  11 | test("unauthenticated app routes redirect to login", async ({ page }) => {
  12 |   await page.goto("/");
  13 |   await page.waitForURL("**/login**");
  14 |   await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  15 | });
  16 | 
  17 | test("admin signs in and sees the dashboard hub", async ({ page }) => {
  18 |   await login(page, ADMIN);
  19 |   // Greeting header + hero search are the dashboard's spine.
  20 |   await expect(page.locator("h1")).toContainText(/,/);
  21 |   await expect(page.getByText(/Search, or ask/)).toBeVisible();
  22 |   // Seeded example spaces render in the spaces column.
  23 |   await expect(page.locator("text=Spaces").first()).toBeVisible();
  24 | });
  25 | 
```