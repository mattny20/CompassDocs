import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// RBAC foundation (0.91). The engine is in place and seeded, but the app is
// still enforcing the legacy ladder — 0.92 ports the check sites. So these
// assert the two things that must be true *before* that port is safe:
//
//   1. The upgrade is behaviour-preserving: every user's new grants reproduce
//      exactly what their ladder role gave them.
//   2. The workspace cannot be locked out. countAdmins() has no meaning once
//      roles are custom, so its replacement — "is there still someone holding
//      user.update_role globally?" — has to hold under the operations that
//      could strand a workspace.

test("preset roles are seeded and every user has a matching assignment", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);
  await ensureUser(page, EDITOR, "editor", "E2E Editor");

  const res = await api(page, "/api/admin/rbac/roles");
  expect(res.status, "the roles endpoint answers for an admin").toBe(200);

  const roles: { key: string; is_builtin: boolean; permission_count: number }[] =
    res.body?.roles ?? [];
  const byKey = Object.fromEntries(roles.map((r) => [r.key, r]));

  for (const key of ["viewer", "editor", "approver", "admin"]) {
    expect(byKey[key], `${key} preset exists`).toBeTruthy();
    expect(byKey[key].is_builtin, `${key} is built in`).toBe(true);
    expect(byKey[key].permission_count, `${key} holds permissions`).toBeGreaterThan(0);
  }

  // The ladder was strictly increasing, so the presets that replace it must be
  // too — this is what "behaviour-preserving" means concretely.
  expect(byKey.viewer.permission_count).toBeLessThan(byKey.editor.permission_count);
  expect(byKey.editor.permission_count).toBeLessThan(byKey.approver.permission_count);
  expect(byKey.approver.permission_count).toBeLessThan(byKey.admin.permission_count);

  // Nobody was left behind by the migration.
  const audit = await api(page, "/api/admin/rbac/audit");
  expect(audit.status).toBe(200);
  expect(audit.body?.users_without_assignment, "no user lost their role").toBe(0);
  expect(audit.body?.mismatched, "no user's assignment disagrees with their ladder role").toBe(0);

  await ctx.close();
});

test("the workspace can always be recovered: the last admin cannot be removed", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  // This test has to reduce the workspace to a single administrator to exercise
  // the guard, and the whole suite shares one database — so every demotion is
  // recorded and undone in `finally`. A test that can strand the account the
  // rest of the suite signs in with is worse than no test.
  const demoted: number[] = [];

  try {
    const before = await api(page, "/api/admin/rbac/recovery");
    expect(before.status).toBe(200);
    expect(before.body?.count, "someone can administer users").toBeGreaterThan(0);
    expect(before.body?.permission, "the guard names the permission it checks").toBe(
      "user.update_role"
    );

    // A disposable second admin proves the guard PERMITS removal while it is safe.
    const spare = { username: `e2e_rbac_spare_${Date.now()}`, password: "E2eSpare!12345" };
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...spare, role: "admin", name: "E2E Spare Admin" },
    });
    expect(created.status, "spare admin created").toBe(201);
    const spareId: number = created.body?.user?.id;
    expect(spareId).toBeTruthy();

    // Creating a user must also create their assignment — a database trigger
    // keeps the ladder and the assignments in step, and this is what proves it.
    const seeded = await api(page, "/api/admin/rbac/audit");
    expect(seeded.body?.users_without_assignment, "the new admin got an assignment").toBe(0);

    expect((await api(page, "/api/admin/rbac/recovery")).body?.count).toBeGreaterThanOrEqual(2);

    // Reduce to exactly one holder, never touching the account we signed in as.
    for (let i = 0; i < 12; i++) {
      const now = await api(page, "/api/admin/rbac/recovery");
      const hs: { id: number; username: string }[] = now.body?.holders ?? [];
      const victim = hs.find((h) => h.username !== ADMIN.username);
      if (!victim) break;
      const r = await api(page, `/api/admin/users/${victim.id}`, {
        method: "PATCH",
        body: { role: "viewer" },
      });
      expect(r.status, `demoting ${victim.username} while others remain is allowed`).toBeLessThan(
        400
      );
      demoted.push(victim.id);
    }

    const one = await api(page, "/api/admin/rbac/recovery");
    const holders: { id: number; username: string }[] = one.body?.holders ?? [];
    expect(holders.length, "exactly one recovery holder remains").toBe(1);
    expect(holders[0].username, "and it is the account we signed in with").toBe(ADMIN.username);
    const last = holders[0];

    // Every route out of "someone can still administer users" must be refused.
    const attempts: [string, { method: "PATCH" | "DELETE"; body?: unknown }][] = [
      ["demoted", { method: "PATCH", body: { role: "viewer" } }],
      ["disabled", { method: "PATCH", body: { status: "disabled" } }],
      ["deleted", { method: "DELETE" }],
    ];
    for (const [what, req] of attempts) {
      const r = await api(page, `/api/admin/users/${last.id}`, req);
      expect(r.status, `the last admin cannot be ${what}`).toBeGreaterThanOrEqual(400);
    }

    // And the refusals really were refusals — nothing changed underneath.
    const after = await api(page, "/api/admin/rbac/recovery");
    expect(after.body?.count, "someone can still administer users").toBe(1);
  } finally {
    for (const id of demoted) {
      await api(page, `/api/admin/users/${id}`, { method: "PATCH", body: { role: "admin" } });
    }
    await ctx.close();
  }
});
