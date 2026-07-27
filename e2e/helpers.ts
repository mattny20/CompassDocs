import { expect, type Page } from "@playwright/test";

// The admin comes from headless provisioning (COMPASSDOCS_ADMIN_USER /
// COMPASSDOCS_ADMIN_PASSWORD in the workflow); everyone else is created by
// ensureUser() through the admin API on first use.
export const ADMIN = { username: "e2e_admin", password: "E2eAdmin!12345" };
export const EDITOR = { username: "e2e_editor", password: "E2eEditor!12345" };

export async function login(page: Page, user: { username: string; password: string }) {
  await page.goto("/login");
  await page.fill('input[autocomplete="username"]', user.username);
  await page.fill('input[autocomplete="current-password"]', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(account\/password)?$/);

  // Admin-created users must change their password on first login. Satisfy
  // the gate via the API, re-using the same value so credentials stay stable.
  if (page.url().includes("/account/password")) {
    const status = await page.evaluate(async (pw) => {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: pw, newPassword: pw }),
      });
      return res.status;
    }, user.password);
    if (status >= 400) throw new Error(`change-password gate failed (${status})`);
    await page.goto("/");
  }
  await page.waitForURL("**/");
  await expect(page.locator("h1")).toBeVisible();
}

/** Create a user via the admin API if it doesn't exist yet (idempotent). */
export async function ensureUser(
  adminPage: Page,
  user: { username: string; password: string },
  role: "viewer" | "editor" | "approver" | "admin",
  name: string
) {
  const status = await adminPage.evaluate(
    async ({ u, r, n }) => {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u.username, password: u.password, role: r, name: n }),
      });
      return res.status;
    },
    { u: user, r: role, n: name }
  );
  // 201 created or a conflict-ish status when it already exists — both fine.
  if (![200, 201, 400, 409].includes(status)) {
    throw new Error(`ensureUser(${user.username}) unexpected status ${status}`);
  }
}

/** JSON fetch through the page's session cookie. */
export async function api(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(path, {
        method: method || "GET",
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: any = null;
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed };
    },
    { path, method: init?.method, body: init?.body }
  );
}
