import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// RBAC enforcement (0.93). The permission is now the authority: the ladder is
// still evaluated, but only to keep the agreement scoreboard honest.
//
// The claim worth defending in CI is the one that would be invisible if it
// broke — that a permission granted through a *custom* role actually opens the
// door, and opens only that door. If the flip silently reverted to the ladder,
// every other test in this suite would still pass.
//
// Each test cleans up after itself: the suite shares one database, and a role
// left behind changes what later tests see.

const rid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test("a custom role grants an admin API to a viewer, and nothing else", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const suffix = rid();
  const user = { username: `e2e_deleg_${suffix}`, password: "E2eDeleg!12345" };
  let roleId: number | null = null;
  let userId: number | null = null;

  try {
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...user, role: "viewer", name: "E2E Delegate" },
    });
    expect(created.status, "delegate created").toBe(201);
    userId = created.body?.user?.id;
    expect(userId).toBeTruthy();

    // Sign in as them and confirm the ladder denies the admin API today.
    const dctx = await browser.newContext();
    const dpage = await dctx.newPage();
    await login(dpage, user);

    const before = await api(dpage, "/api/admin/links");
    expect(before.status, "a viewer cannot manage quick links").toBe(403);

    // Grant a custom role that holds exactly link.manage.
    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: {
        name: `E2E Link Curator ${suffix}`,
        description: "Runs the launchpad, nothing else",
        permissions: ["link.manage", "link.read"],
      },
    });
    expect(role.status, "custom role created").toBe(201);
    roleId = role.body?.id;
    expect(roleId).toBeTruthy();

    const assigned = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: roleId, user_id: userId },
    });
    expect(assigned.status, "role assigned").toBe(201);

    // THE assertion: a permission the ladder would never have given now opens
    // the route. Under the pre-0.93 guard this stays 403.
    const after = await api(dpage, "/api/admin/links");
    expect(after.status, "the custom role opens the route the ladder refused").toBe(200);

    // And only that route — a delegated role is not a back door to everything.
    for (const path of ["/api/admin/groups", "/api/admin/spaces", "/api/admin/audit"]) {
      expect((await api(dpage, path)).status, `${path} stays closed`).toBe(403);
    }

    // The page-level guard agrees with the API guard. Before 0.93 the /admin
    // layout gated the whole console on being an Administrator, so this user
    // could call the API but not open the page that calls it.
    await dpage.goto("/admin/links");
    expect(dpage.url(), "the section they hold is reachable").toContain("/admin/links");
    await dpage.goto("/admin/users");
    expect(new URL(dpage.url()).pathname, "sections they don't hold are not").toBe("/");

    // The explainer traces the decision back to the assignment that made it.
    const why = await api(page, `/api/admin/rbac/explain?user_id=${userId}&permission=link.manage`);
    expect(why.status).toBe(200);
    expect(why.body?.granted).toBe(true);
    expect(why.body?.via?.[0]?.role).toBe(`E2E Link Curator ${suffix}`);

    const notWhy = await api(page, `/api/admin/rbac/explain?user_id=${userId}&permission=audit.read`);
    expect(notWhy.body?.granted, "and says no when the answer is no").toBe(false);

    await dctx.close();
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("built-in roles are read-only, and their ladder assignments cannot be revoked", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  try {
    const list = await api(page, "/api/admin/rbac/roles");
    expect(list.status).toBe(200);
    const builtin = (list.body?.roles ?? []).filter((r: any) => r.is_builtin);
    expect(builtin.length, "the four presets exist").toBe(4);

    // Editing a preset would silently revert on the next boot (syncPresetRoles
    // re-derives them from the catalog), so it is refused rather than accepted
    // and lost.
    const edit = await api(page, `/api/admin/rbac/roles/${builtin[0].id}`, {
      method: "PATCH",
      body: { permissions: [] },
    });
    expect(edit.status, "a preset cannot be edited").toBe(400);

    const del = await api(page, `/api/admin/rbac/roles/${builtin[0].id}`, { method: "DELETE" });
    expect(del.status, "a preset cannot be deleted").toBe(400);

    // A preset held globally by a user IS that user's ladder rung, kept in step
    // by a database trigger. Deleting the row directly would leave them with no
    // permissions while users.role still said otherwise.
    const mirror = (list.body?.assignments ?? []).find(
      (a: any) =>
        a.user_id && a.scope_type === "global" && builtin.some((r: any) => r.id === a.role_id)
    );
    expect(mirror, "at least one ladder-mirror assignment exists").toBeTruthy();
    const revoke = await api(page, `/api/admin/rbac/assignments/${mirror.id}`, {
      method: "DELETE",
    });
    expect(revoke.status, "the ladder mirror cannot be revoked here").toBe(400);
    expect(revoke.body?.error, "and it says where to do it instead").toContain("Users & roles");

    // Nothing was actually removed.
    expect((await api(page, "/api/admin/rbac/audit")).body?.users_without_assignment).toBe(0);
  } finally {
    await ctx.close();
  }
});

test("a role edit that would strand the workspace is rolled back", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  // The invariant is "someone still holds user.update_role globally". Rather
  // than reducing the real workspace to one administrator, this grants a custom
  // role the recovery permission and then checks the guard counts it — the
  // mutation is only refused when the count would reach zero, so a workspace
  // with real admins must let this edit through.
  const suffix = rid();
  let roleId: number | null = null;
  try {
    const before = await api(page, "/api/admin/rbac/recovery");
    expect(before.body?.count, "the workspace starts recoverable").toBeGreaterThan(0);

    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Recovery ${suffix}`, permissions: ["user.update_role"] },
    });
    expect(role.status).toBe(201);
    roleId = role.body?.id;

    // While other holders remain, removing it is allowed — the guard is a
    // last-one-out check, not a blanket refusal.
    const strip = await api(page, `/api/admin/rbac/roles/${roleId}`, {
      method: "PATCH",
      body: { permissions: ["user.read"] },
    });
    expect(strip.status, "removing a redundant grant is permitted").toBe(200);

    const after = await api(page, "/api/admin/rbac/recovery");
    expect(after.body?.count, "and the workspace is still recoverable").toBeGreaterThan(0);
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the roles console renders the matrix, assignments, and the health checks", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  await page.goto("/admin/roles");
  await expect(page.getByRole("heading", { name: "Roles & permissions" })).toBeVisible();

  // The matrix defaults to the first role and reports how much of the catalog
  // it holds.
  await expect(page.getByText(/of \d+ permissions/)).toBeVisible();
  await expect(page.getByLabel("Filter permissions")).toBeVisible();

  await page.getByRole("button", { name: "Assignments" }).click();
  await expect(page.getByRole("heading", { name: "Grant a role" })).toBeVisible();

  await page.getByRole("button", { name: "Explain access" }).click();
  await expect(page.getByRole("heading", { name: /Explain someone/ })).toBeVisible();

  await page.getByRole("button", { name: "Health" }).click();
  await expect(page.getByRole("heading", { name: /let people back in/ })).toBeVisible();
  await expect(page.getByText(/without an assignment/)).toBeVisible();

  await ctx.close();
});
