# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: approvals.spec.ts >> editor edit queues a change request; approval notifies the author
- Location: e2e/approvals.spec.ts:6:5

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3998/login
Call log:
  - navigating to "http://127.0.0.1:3998/login", waiting until "load"

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
  1  | import { expect, type Page } from "@playwright/test";
  2  | 
  3  | // The admin comes from headless provisioning (COMPASSDOCS_ADMIN_USER /
  4  | // COMPASSDOCS_ADMIN_PASSWORD in the workflow); everyone else is created by
  5  | // ensureUser() through the admin API on first use.
  6  | export const ADMIN = { username: "e2e_admin", password: "E2eAdmin!12345" };
  7  | export const EDITOR = { username: "e2e_editor", password: "E2eEditor!12345" };
  8  | 
  9  | export async function login(page: Page, user: { username: string; password: string }) {
> 10 |   await page.goto("/login");
     |              ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3998/login
  11 |   await page.fill('input[autocomplete="username"]', user.username);
  12 |   await page.fill('input[autocomplete="current-password"]', user.password);
  13 |   await page.click('button[type="submit"]');
  14 |   await page.waitForURL(/\/(account\/password)?$/);
  15 | 
  16 |   // Admin-created users must change their password on first login. Satisfy
  17 |   // the gate via the API, re-using the same value so credentials stay stable.
  18 |   if (page.url().includes("/account/password")) {
  19 |     const status = await page.evaluate(async (pw) => {
  20 |       const res = await fetch("/api/auth/change-password", {
  21 |         method: "POST",
  22 |         headers: { "content-type": "application/json" },
  23 |         body: JSON.stringify({ currentPassword: pw, newPassword: pw }),
  24 |       });
  25 |       return res.status;
  26 |     }, user.password);
  27 |     if (status >= 400) throw new Error(`change-password gate failed (${status})`);
  28 |     await page.goto("/");
  29 |   }
  30 |   await page.waitForURL("**/");
  31 |   await expect(page.locator("h1")).toBeVisible();
  32 | }
  33 | 
  34 | /** Create a user via the admin API if it doesn't exist yet (idempotent). */
  35 | export async function ensureUser(
  36 |   adminPage: Page,
  37 |   user: { username: string; password: string },
  38 |   role: "viewer" | "editor" | "approver" | "admin",
  39 |   name: string
  40 | ) {
  41 |   const status = await adminPage.evaluate(
  42 |     async ({ u, r, n }) => {
  43 |       const res = await fetch("/api/admin/users", {
  44 |         method: "POST",
  45 |         headers: { "content-type": "application/json" },
  46 |         body: JSON.stringify({ username: u.username, password: u.password, role: r, name: n }),
  47 |       });
  48 |       return res.status;
  49 |     },
  50 |     { u: user, r: role, n: name }
  51 |   );
  52 |   // 201 created or a conflict-ish status when it already exists — both fine.
  53 |   if (![200, 201, 400, 409].includes(status)) {
  54 |     throw new Error(`ensureUser(${user.username}) unexpected status ${status}`);
  55 |   }
  56 | }
  57 | 
  58 | /** JSON fetch through the page's session cookie. */
  59 | export async function api(
  60 |   page: Page,
  61 |   path: string,
  62 |   init?: { method?: string; body?: unknown }
  63 | ): Promise<{ status: number; body: any }> {
  64 |   return page.evaluate(
  65 |     async ({ path, method, body }) => {
  66 |       const res = await fetch(path, {
  67 |         method: method || "GET",
  68 |         headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  69 |         body: body !== undefined ? JSON.stringify(body) : undefined,
  70 |       });
  71 |       let parsed: any = null;
  72 |       try {
  73 |         parsed = await res.json();
  74 |       } catch {
  75 |         /* non-JSON */
  76 |       }
  77 |       return { status: res.status, body: parsed };
  78 |     },
  79 |     { path, method: init?.method, body: init?.body }
  80 |   );
  81 | }
  82 | 
```