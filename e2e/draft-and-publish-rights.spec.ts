import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Seeing drafts, and publishing without review, are permissions (1.0).
//
// Both were role rungs at about thirty-five call sites: `roleAtLeast(role,
// "editor")` decided every draft-visibility question — search, the space list,
// the nested tree, the palette's recents, relation pickers, the doc page itself
// — and `roleAtLeast(role, "approver") || approvalMode === "open"` decided every
// publish-vs-queue one. Neither consulted the permission model at all, so a
// custom role holding `document.read_draft` saw no drafts anywhere and a role
// holding `document.publish` still had its work queued for review.
//
// These two tests are those two sentences, made executable.

/** Grant `permissions` to `userId` via a throwaway custom role. Returns its id. */
async function grantRole(
  page: import("@playwright/test").Page,
  userId: number,
  name: string,
  permissions: string[]
): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e", permissions },
  });
  expect(role.status, `role ${name} created`).toBe(201);
  const roleId = role.body?.id;
  const assigned = await api(page, "/api/admin/rbac/assignments", {
    method: "POST",
    body: { role_id: roleId, user_id: userId },
  });
  expect(assigned.status, `role ${name} assigned`).toBe(201);
  return roleId;
}

test("a custom role sees drafts; a plain viewer does not", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const probe = { username: `e2e_draftread_${stamp}`, password: "E2eDraft!12345" };
  let userId: number | undefined;
  let roleId: number | undefined;
  let spaceId: number | undefined;

  try {
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: {
        name: `E2E Drafts ${stamp}`,
        slug: `e2e-drafts-${stamp}`,
        description: "",
        visibility: "internal",
      },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "space created").toBeTruthy();

    // One draft and one published document, with titles that only match
    // themselves — search asserts on which of the two comes back.
    const draftTitle = `E2E hidden draft ${stamp}`;
    const liveTitle = `E2E visible live ${stamp}`;
    for (const [title, status] of [
      [draftTitle, "draft"],
      [liveTitle, "published"],
    ] as const) {
      const made = await api(page, "/api/documents", {
        method: "POST",
        body: { space_id: spaceId, title, type: "knowledge", status, content: "x", tags: [] },
      });
      expect(made.status, `${status} document created`).toBe(201);
    }

    const made = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...probe, role: "viewer", name: "Draft Visibility Probe" },
    });
    expect(made.status, "probe user created").toBe(201);
    userId = made.body?.user?.id;

    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    await login(vpage, probe);

    // Before the grant: the published doc is findable, the draft is not.
    const before = await api(vpage, `/api/search?q=${stamp}`);
    expect(before.status).toBe(200);
    const beforeTitles = (before.body?.hits ?? []).map((h: any) => h.title);
    expect(beforeTitles, "the live document is findable").toContain(liveTitle);
    expect(beforeTitles, "the draft is not").not.toContain(draftTitle);

    // The draft is not readable directly either — 404, not 403, so its
    // existence isn't disclosed.
    const draftId = (
      await api(page, `/api/search?q=${stamp}`)
    ).body.hits.find((h: any) => h.title === draftTitle)?.id;
    expect(draftId, "admin can see the draft to get its id").toBeTruthy();
    expect((await api(vpage, `/api/documents/${draftId}`)).status).toBe(404);

    // Grant exactly the draft-reading permission and nothing else that would
    // confuse the result.
    roleId = await grantRole(page, userId!, `E2E Draft Reader ${stamp}`, [
      "document.read",
      "document.read_draft",
      "space.member",
    ]);

    // After: the same search now returns the draft, and it reads.
    const after = await api(vpage, `/api/search?q=${stamp}`);
    const afterTitles = (after.body?.hits ?? []).map((h: any) => h.title);
    expect(afterTitles, "document.read_draft reveals the draft (1.0)").toContain(draftTitle);
    expect((await api(vpage, `/api/documents/${draftId}`)).status).toBe(200);

    await vctx.close();
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("document.publish decides direct publish, not the role rung", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const probe = { username: `e2e_publisher_${stamp}`, password: "E2ePublish!12345" };
  let userId: number | undefined;
  let authorRoleId: number | undefined;
  let publishRoleId: number | undefined;
  let spaceId: number | undefined;
  let priorMode: string | undefined;

  try {
    // Strict approval, so "queued" and "published" are distinguishable. Open
    // mode short-circuits the permission by design and is not what's under test.
    const settings = await api(page, "/api/admin/settings");
    priorMode = settings.body?.settings?.approval_mode ?? settings.body?.approval_mode;
    const set = await api(page, "/api/admin/settings", {
      method: "PATCH",
      body: { approval_mode: "strict" },
    });
    expect([200, 204]).toContain(set.status);

    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: {
        name: `E2E Publish ${stamp}`,
        slug: `e2e-publish-${stamp}`,
        description: "",
        visibility: "internal",
      },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "space created").toBeTruthy();

    const made = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...probe, role: "viewer", name: "Publish Rights Probe" },
    });
    expect(made.status, "probe user created").toBe(201);
    userId = made.body?.user?.id;

    // An author who may write but not publish.
    authorRoleId = await grantRole(page, userId!, `E2E Author ${stamp}`, [
      "document.read",
      "document.read_draft",
      "document.create",
      "document.update",
      "space.member",
      "space.author",
    ]);

    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    await login(vpage, probe);

    // Asking to publish without the permission yields a draft — the request
    // succeeds, the status is downgraded. That is the pre-existing contract;
    // what's new is that a rung no longer decides it.
    const queued = await api(vpage, "/api/documents", {
      method: "POST",
      body: {
        space_id: spaceId,
        title: `E2E queued ${stamp}`,
        type: "knowledge",
        status: "published",
        content: "x",
        tags: [],
      },
    });
    expect(queued.status, "the author may create").toBe(201);
    expect(queued.body?.doc?.status, "without document.publish it stays a draft").toBe("draft");

    // Same person, same space, plus the one permission.
    publishRoleId = await grantRole(page, userId!, `E2E Publisher ${stamp}`, ["document.publish"]);

    const published = await api(vpage, "/api/documents", {
      method: "POST",
      body: {
        space_id: spaceId,
        title: `E2E published ${stamp}`,
        type: "knowledge",
        status: "published",
        content: "x",
        tags: [],
      },
    });
    expect(published.status).toBe(201);
    expect(
      published.body?.doc?.status,
      "document.publish publishes directly, with no approver rung (1.0)"
    ).toBe("published");

    await vctx.close();
  } finally {
    if (publishRoleId) await api(page, `/api/admin/rbac/roles/${publishRoleId}`, { method: "DELETE" });
    if (authorRoleId) await api(page, `/api/admin/rbac/roles/${authorRoleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    if (priorMode) {
      await api(page, "/api/admin/settings", {
        method: "PATCH",
        body: { approval_mode: priorMode },
      });
    }
    await ctx.close();
  }
});
