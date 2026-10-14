import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.4: a link opened while signed out comes back to the page it named
// after sign-in, not the dashboard. The page guard sends the visitor to
// /login?next=<page>; the password form, the forced password change and
// (in the enterprise build) the SSO entry points all carry it through.
// The value is attacker-controllable, so off-site, API and sign-in-page
// destinations fall back to the dashboard.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function signIn(page: Page, user = ADMIN) {
  await page.fill('input[autocomplete="username"]', user.username);
  await page.fill('input[autocomplete="current-password"]', user.password);
  await page.click('button[type="submit"]');
}

test("a signed-out visit to a document lands on the document after sign-in", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto("/doc/1");
    await page.waitForURL(/\/login\?next=%2Fdoc%2F1$/);
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await signIn(page);
    await page.waitForURL(/\/doc\/1$/);
    await expect(page.locator("h1").first()).not.toContainText(/sign in/i);
  } finally {
    await ctx.close();
  }
});

test("the query string survives the round trip", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto("/search?q=hello%20world");
    await page.waitForURL(/\/login\?next=/);
    // Next normalises the query on the way through (a space may become
    // "+"); what matters is that the same value comes back.
    const next = new URL(page.url()).searchParams.get("next") ?? "";
    const remembered = new URL(next, "http://x");
    expect(remembered.pathname).toBe("/search");
    expect(remembered.searchParams.get("q")).toBe("hello world");
    await signIn(page);
    await page.waitForURL(/\/search\?q=hello(%20|\+)world$/);
    await expect(page.getByLabel("Ask a question or search by keyword")).toHaveValue("hello world");
  } finally {
    await ctx.close();
  }
});

test("off-site, API and sign-in-page destinations fall back to the dashboard", async ({ browser }) => {
  for (const next of ["https://evil.example/phish", "//evil.example", "/api/auth/logout", "/login", "/\\evil.example"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
      // The SSO buttons (when present) carry no such destination either.
      for (const a of await page.locator('a[href*="/api/ee/"]').all()) {
        expect(await a.getAttribute("href"), `SSO link for ${next}`).not.toContain("next=");
      }
      await signIn(page);
      await page.waitForURL(/\/$/);
      expect(new URL(page.url()).pathname, `destination ${next}`).toBe("/");
    } finally {
      await ctx.close();
    }
  }
});

test("already signed in, /login?next= goes straight to the page", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/login?next=%2Fdoc%2F1");
  await page.waitForURL(/\/doc\/1$/);
  await page.goto("/login?next=https%3A%2F%2Fevil.example");
  await page.waitForURL(/\/$/);
});

test("a forced password change on first sign-in still ends on the document", async ({ browser }) => {
  const admin = await browser.newContext();
  const apage = await admin.newPage();
  await login(apage, ADMIN);
  const s = stamp();
  const probe = { username: `e2e_returnto_${s}`, password: "E2eReturn!12345" };
  let userId: number | undefined;
  try {
    const made = await api(apage, "/api/admin/users", {
      method: "POST",
      body: { ...probe, role: "viewer", name: "Return To Probe" },
    });
    expect(made.status, "probe user created").toBe(201);
    userId = made.body?.user?.id;

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/doc/1");
    await page.waitForURL(/\/login\?next=%2Fdoc%2F1$/);
    await signIn(page, probe);
    // Admin-created accounts must change their password first; the
    // destination rides along.
    await page.waitForURL(/\/account\/password\?next=%2Fdoc%2F1$/);
    await page.getByLabel(/current password/i).fill(probe.password);
    const fresh = "E2eReturn!67890";
    await page.getByLabel(/^new password/i).fill(fresh);
    await page.getByLabel(/confirm/i).fill(fresh);
    await page.getByRole("button", { name: /set password/i }).click();
    await page.waitForURL(/\/doc\/1$/);
    await ctx.close();
  } finally {
    if (userId) await api(apage, `/api/admin/users/${userId}`, { method: "DELETE" });
    await admin.close();
  }
});
