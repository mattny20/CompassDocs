import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Per-space role grants (0.95).
//
// Role assignments have carried a space scope since 0.91, but until now nothing
// consulted it: a role granted "in Engineering only" unlocked nothing, because
// space visibility and edit rights were decided by two mechanisms that had never
// heard of role assignments. This is the test that the scope means something.
//
// Both checks below are additive by construction — a space-scoped grant can only
// add access, never remove it — so the assertions are about what becomes
// possible, and the sibling spec (private-space-scope) still guards what must
// stay impossible.

test("a space-scoped role grants read, then authoring, in exactly that space", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const user = { username: `e2e_spacerole_${stamp}`, password: "E2eSpace!12345" };
  let userId: number | null = null;
  let memberRoleId: number | null = null;
  let authorRoleId: number | null = null;

  try {
    // Two private spaces: one the role will name, one it won't. The second is
    // what proves the grant is scoped rather than global.
    const spaces: { id: number; slug: string; docId: number }[] = [];
    for (const which of ["granted", "other"]) {
      const slug = `e2e-scoped-${which}-${stamp}`;
      const res = await api(page, "/api/admin/spaces", {
        method: "POST",
        body: { name: `E2E Scoped ${which} ${stamp}`, slug, description: "", visibility: "private" },
      });
      const id = res.body?.space?.id ?? res.body?.id;
      expect(id, `${which} space created`).toBeTruthy();
      // A document in each: reading one is the scope-respecting signal. The
      // space PAGE renders an in-app 404 at the same URL (0.87), so the URL
      // alone cannot tell "not allowed" from "allowed and empty".
      const doc = await api(page, "/api/documents", {
        method: "POST",
        body: {
          space_id: id,
          title: `E2E Scoped ${which} doc ${stamp}`,
          type: "policy",
          status: "published",
          content: `contents of the ${which} space`,
          summary: "",
          tags: [],
        },
      });
      const docId = doc.body?.doc?.id ?? doc.body?.document?.id;
      expect(docId, `${which} document created`).toBeTruthy();
      spaces.push({ id, slug, docId });
    }
    const [granted, other] = spaces;

    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...user, role: "editor", name: "E2E Space Role" },
    });
    expect(created.status).toBe(201);
    userId = created.body?.user?.id;

    const uctx = await browser.newContext();
    const upage = await uctx.newPage();
    await login(upage, user);

    // Baseline: an editor in no group can reach neither private space. The
    // space page is the honest test — it is what a user would actually open.
    const reads = async (docId: number) =>
      (await api(upage, `/api/documents/${docId}`)).status === 200;
    expect(await reads(granted.docId), "the granted space is unreadable to start").toBe(false);
    expect(await reads(other.docId), "and so is the other one").toBe(false);

    // Membership as a role, scoped to one space.
    const memberRole = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Space Member ${stamp}`, permissions: ["space.member", "space.read"] },
    });
    expect(memberRole.status).toBe(201);
    memberRoleId = memberRole.body?.id;

    const assigned = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: memberRoleId, user_id: userId, space_id: granted.id },
    });
    expect(assigned.status, "assigned in one space").toBe(201);

    expect(await reads(granted.docId), "the space named by the grant is now readable").toBe(true);
    expect(await reads(other.docId), "the space it did not name is not").toBe(false);

    // The explainer agrees, and knows which space it applies to.
    const why = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=space.member&space_id=${granted.id}`
    );
    expect(why.body?.granted, "granted in the named space").toBe(true);
    const elsewhere = await api(
      page,
      `/api/admin/rbac/explain?user_id=${userId}&permission=space.member&space_id=${other.id}`
    );
    expect(elsewhere.body?.granted, "not granted in the other one").toBe(false);

    // Authoring, likewise scoped. Turn the org-wide "editors edit everything"
    // switch OFF first, or every editor may already author anywhere visible and
    // the grant below would prove nothing.
    const policy = await api(page, "/api/admin/spaces", {
      method: "PATCH",
      body: { editorsEditAll: false },
    });
    expect(policy.status, "org edit policy is restrictive for this test").toBeLessThan(400);
    expect(policy.body?.editorsEditAll, "and the switch actually took").toBe(false);

    const authorRole = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Space Author ${stamp}`, permissions: ["space.author"] },
    });
    expect(authorRole.status).toBe(201);
    authorRoleId = authorRole.body?.id;
    await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: authorRoleId, user_id: userId, space_id: granted.id },
    });

    const wrote = await api(upage, "/api/documents", {
      method: "POST",
      body: {
        space_id: granted.id,
        title: `E2E Scoped Author ${stamp}`,
        type: "policy",
        status: "draft",
        content: "written through a space-scoped role grant",
        summary: "",
        tags: [],
      },
    });
    expect(wrote.status, "the space-scoped grant authorises authoring there").toBeLessThan(400);

    await uctx.close();
  } finally {
    // Restore the org switch to its default so later runs start where they expect.
    await api(page, "/api/admin/spaces", {
      method: "PATCH",
      body: { editorsEditAll: true },
    });
    for (const id of [memberRoleId, authorRoleId]) {
      if (id) await api(page, `/api/admin/rbac/roles/${id}`, { method: "DELETE" });
    }
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});

test("the admin bypasses are permissions now, and administrators still hold them", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const holders = await api(page, "/api/admin/rbac/recovery");
  const myId = (holders.body?.holders ?? []).find((h: any) => h.username === ADMIN.username)?.id;
  expect(myId, "the signed-in admin's id").toBeTruthy();

  for (const key of ["space.read_all", "space.author_all"]) {
    const why = await api(page, `/api/admin/rbac/explain?user_id=${myId}&permission=${key}`);
    expect(why.status).toBe(200);
    expect(why.body?.granted, `${key} is held by the Administrator preset`).toBe(true);
    expect(
      why.body?.via?.some((v: any) => v.role === "Administrator"),
      `${key} comes from the preset, not a hard-coded role check`
    ).toBe(true);
  }

  await ctx.close();
});
