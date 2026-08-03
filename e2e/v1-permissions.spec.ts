import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The public REST API honours permissions, not the role ladder (0.99.1).
//
// Until 0.99.1 every /api/v1 route gated on `roleAtLeast(user.role, …)` and
// consulted no permission at all. Custom roles — the whole point of 0.93 —
// therefore worked everywhere in the app except over the API: a viewer holding
// document.create got a document through POST /api/documents and a 403 saying
// "Creating documents needs the editor role" through POST /api/v1/documents.
//
// This is that exact scenario, both ways round, so the two can never drift
// apart again without a red test.

test("a custom role reaches the public API, not just the app", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);

  const suffix = Date.now();
  let roleId: number | undefined;
  let docId: number | undefined;
  let userId: number | undefined;

  try {
    // Unique per run: this test mints tokens and grants a role, and reusing a
    // shared account across runs makes those pile up.
    const probe = { username: `e2e_v1_viewer_${suffix}`, password: "E2eV1Viewer!12345" };
    const madeUser = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...probe, role: "viewer", name: "V1 Permission Probe" },
    });
    expect(madeUser.status, "probe user created").toBe(201);
    userId = madeUser.body?.user?.id;
    expect(userId, "probe user exists").toBeTruthy();

    // Sign the viewer in and mint a read+write token for them. The token's
    // scopes are the credential's limit; the role decides the person's.
    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    await login(vpage, probe);
    const token = await api(vpage, "/api/account/tokens", {
      method: "POST",
      body: { name: `v1-perm-${suffix}`, scopes: ["read", "write"] },
    });
    expect(token.status, "token minted").toBe(201);
    const bearer = { authorization: `Bearer ${token.body.token}` };

    // Before the grant: a plain viewer is refused, by permission now rather
    // than by rung — the point is that they cannot write.
    const before = await request.post("/api/v1/documents", {
      headers: bearer,
      data: { space: "engineering", title: `denied ${suffix}`, content: "x" },
    });
    expect(before.status(), "a plain viewer cannot create over the API").toBe(403);

    // Grant a custom role holding exactly what creating a document needs.
    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: {
        name: `E2E V1 Author ${suffix}`,
        description: "Writes through the API and nothing else",
        permissions: ["document.create", "document.update", "document.read", "space.member"],
      },
    });
    expect(role.status, "custom role created").toBe(201);
    roleId = role.body?.id;

    const assigned = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: roleId, user_id: userId },
    });
    expect(assigned.status, "role assigned").toBe(201);

    // The app already honoured this before 0.99.1 — assert it so a failure
    // here says "the grant didn't take" rather than "the API is broken".
    const viaApp = await api(vpage, "/api/documents", {
      method: "POST",
      body: { space: "engineering", title: `app ${suffix}`, content: "x" },
    });
    expect(viaApp.status, "the app honours the custom role").toBe(201);
    docId = viaApp.body?.doc?.id;

    // The regression: the same person, the same grant, over the public API.
    const viaApi = await request.post("/api/v1/documents", {
      headers: bearer,
      data: { space: "engineering", title: `api ${suffix}`, content: "x" },
    });
    expect(
      viaApi.status(),
      "the public API honours the custom role too (0.99.1)"
    ).toBe(201);
    const madeDoc = await viaApi.json();
    expect(madeDoc?.document?.title ?? madeDoc?.title).toContain(String(suffix));

    // Token scope still bounds the credential independently of the role: a
    // read-only token from the same now-privileged user must still be refused.
    const ro = await api(vpage, "/api/account/tokens", {
      method: "POST",
      body: { name: `v1-perm-ro-${suffix}`, scopes: ["read"] },
    });
    expect(ro.status).toBe(201);
    const roWrite = await request.post("/api/v1/documents", {
      headers: { authorization: `Bearer ${ro.body.token}` },
      data: { space: "engineering", title: `scoped out ${suffix}`, content: "x" },
    });
    expect(roWrite.status(), "a read-only token stays read-only").toBe(403);

    await vctx.close();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    await ctx.close();
  }
});
