import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Collapsing the parallel grant systems (0.94).
//
// Section delegation used to live as JSON in `settings` and the newsletter
// capability as a text column on `users`, each with its own resolver. Both are
// role assignments now. The settings pages look the same; what changed is that
// there is one model underneath, so the same grant can be explained, granted to
// a group, and audited like anything else.
//
// The regression worth defending: the database trigger that mirrors the role
// ladder used to delete EVERY built-in role assignment that wasn't the user's
// rung. Once delegated roles became built-in, that would have silently revoked
// someone's section access the moment an admin changed their role — an
// authorization bug with no error, no log line, and no failing test.

const rid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test("section delegation is a role assignment, and survives a role change", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const suffix = rid();
  const user = { username: `e2e_deleg2_${suffix}`, password: "E2eDeleg2!12345" };
  let userId: number | null = null;

  try {
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...user, role: "viewer", name: "E2E Section Delegate" },
    });
    expect(created.status).toBe(201);
    userId = created.body?.user?.id;

    const dctx = await browser.newContext();
    const dpage = await dctx.newPage();
    await login(dpage, user);
    await dpage.goto("/announcements");
    expect(new URL(dpage.url()).pathname, "a viewer cannot run announcements").toBe("/");

    // Grant through the Section access page's API, unchanged since 0.93.
    const granted = await api(page, "/api/admin/section-access", {
      method: "PATCH",
      body: { section: "announcements", users: [userId], groups: [] },
    });
    expect(granted.status, "section grant saved").toBe(200);
    expect(granted.body?.section?.users, "and reads back").toContain(userId);

    await dpage.goto("/announcements");
    expect(new URL(dpage.url()).pathname, "the section opens").toBe("/announcements");

    // It really is a role assignment: the Roles console can explain it.
    const why = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=announcement.manage`
    );
    expect(why.body?.granted, "the permission model agrees").toBe(true);
    expect(
      why.body?.via?.some((v: any) => v.role === "Announcements manager"),
      "traced to the seeded section role"
    ).toBe(true);

    // THE regression: changing their ladder role must not revoke it.
    const promoted = await api(page, `/api/admin/users/${userId}`, {
      method: "PATCH",
      body: { role: "editor" },
    });
    expect(promoted.status).toBeLessThan(400);

    const after = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=announcement.manage`
    );
    expect(after.body?.granted, "the delegated grant survived the role change").toBe(true);

    await dpage.goto("/announcements");
    expect(new URL(dpage.url()).pathname, "and the section still opens").toBe("/announcements");

    await dctx.close();
  } finally {
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the newsletter capability is a role assignment", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const suffix = rid();
  const user = { username: `e2e_news_${suffix}`, password: "E2eNews!12345" };
  let userId: number | null = null;

  try {
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...user, role: "viewer", name: "E2E Newsletter" },
    });
    expect(created.status).toBe(201);
    userId = created.body?.user?.id;

    const dctx = await browser.newContext();
    const dpage = await dctx.newPage();
    await login(dpage, user);
    await dpage.goto("/newsletter");
    expect(new URL(dpage.url()).pathname, "no capability, no module").toBe("/");

    const set = await api(page, "/api/admin/newsletter/people", {
      method: "PATCH",
      body: { user_id: userId, newsletter_role: "approver" },
    });
    expect(set.status, "capability set").toBe(200);

    const why = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=newsletter.send`
    );
    expect(why.body?.granted, "and it is a real grant, not a column read").toBe(true);
    expect(
      why.body?.via?.some((v: any) => v.role === "Newsletter approver"),
      "traced to the seeded newsletter role"
    ).toBe(true);

    await dpage.goto("/newsletter");
    expect(new URL(dpage.url()).pathname, "the module opens").toBe("/newsletter");

    // Revoking removes the assignment, not just the column.
    const cleared = await api(page, "/api/admin/newsletter/people", {
      method: "PATCH",
      body: { user_id: userId, newsletter_role: "none" },
    });
    expect(cleared.status).toBe(200);
    const gone = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=newsletter.send`
    );
    expect(gone.body?.granted, "revoked").toBe(false);

    await dctx.close();
  } finally {
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the seeded delegated roles exist and are read-only", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const list = await api(page, "/api/admin/rbac/roles");
  expect(list.status).toBe(200);
  const byKey = Object.fromEntries((list.body?.roles ?? []).map((r: any) => [r.key, r]));

  for (const key of [
    "announcements-manager",
    "compliance-manager",
    "training-manager",
    "newsletter-contributor",
    "newsletter-approver",
  ]) {
    expect(byKey[key], `${key} is seeded`).toBeTruthy();
    expect(byKey[key].is_builtin, `${key} is built in`).toBe(true);
    expect(byKey[key].permission_count, `${key} holds permissions`).toBeGreaterThan(0);
  }

  // An approver holds strictly more than a contributor — the two levels the
  // old newsletter_role column expressed, preserved exactly.
  expect(byKey["newsletter-approver"].permission_count).toBeGreaterThan(
    byKey["newsletter-contributor"].permission_count
  );

  const edit = await api(page, `/api/admin/rbac/roles/${byKey["training-manager"].id}`, {
    method: "PATCH",
    body: { permissions: [] },
  });
  expect(edit.status, "seeded roles are re-derived on boot, so editing is refused").toBe(400);

  await ctx.close();
});
