# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> unauthenticated app routes redirect to login
- Location: e2e/smoke.spec.ts:11:5

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3998/
Call log:
  - navigating to "http://127.0.0.1:3998/", waiting until "load"

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e6]:
    - heading "This site can’t be reached" [level=1] [ref=e7]
    - paragraph [ref=e8]:
      - strong [ref=e9]: 127.0.0.1
      - text: refused to connect.
    - generic [ref=e10]:
      - paragraph [ref=e11]: "Try:"
      - list [ref=e12]:
        - listitem [ref=e13]: Checking the connection
        - listitem [ref=e14]:
          - link "Checking the proxy and the firewall" [ref=e15] [cursor=pointer]:
            - /url: "#buttons"
    - generic [ref=e16]: ERR_CONNECTION_REFUSED
  - generic [ref=e17]:
    - button "Reload" [ref=e19] [cursor=pointer]
    - button "Details" [ref=e20] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | import { ADMIN, login } from "./helpers";
  3  | 
  4  | test("health probes answer", async ({ request }) => {
  5  |   expect((await request.get("/healthz")).status()).toBe(200);
  6  |   const ready = await request.get("/readyz");
  7  |   expect(ready.status()).toBe(200);
  8  |   expect((await ready.json()).status).toBe("ready");
  9  | });
  10 | 
  11 | test("unauthenticated app routes redirect to login", async ({ page }) => {
> 12 |   await page.goto("/");
     |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3998/
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