import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// Private-space scope enforcement on the two routes that reach a space through
// canEditSpace(), which is deliberately visibility-blind (see lib/access.ts).
//
// Both of these were exploitable: with the default `editors_edit_all` setting
// on, canEditSpace() returns true for ANY editor on ANY space, so an editor
// with no grant on a private space could still act on its documents. The share
// route was the serious one — it mints an anonymous /share/<token> URL, turning
// "editor who cannot read the doc" into "the whole internet can read the doc".
//
// The fix is a scopeAllows(spaceScopeFor(user), spaceId) pre-check on both, the
// same guard the sibling routes (move, review) already carried.

test("an editor outside a private space cannot share or restore its documents", async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");

  // A private space. The editor is in no group, so it grants them nothing.
  const slug = `e2e-private-${Date.now()}`;
  const createdSpace = await api(adminPage, "/api/admin/spaces", {
    method: "POST",
    body: { name: `E2E Private ${slug}`, slug, description: "scope test", visibility: "private" },
  });
  const spaceId = createdSpace.body?.space?.id ?? createdSpace.body?.id;
  expect(spaceId, "private space was created").toBeTruthy();

  const secret = `SECRET-${slug}-do-not-disclose`;
  const createdDoc = await api(adminPage, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title: "E2E Confidential",
      type: "policy",
      status: "published",
      content: secret,
      summary: "",
      tags: [],
    },
  });
  const docId = createdDoc.body?.doc?.id ?? createdDoc.body?.document?.id;
  expect(docId, "confidential document was created").toBeTruthy();

  // Share links must be on, or the route short-circuits before the scope check
  // and the test would pass for the wrong reason.
  await api(adminPage, "/api/admin/settings", {
    method: "PATCH",
    body: { share_links_enabled: "1" },
  });

  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);

  // Baseline: the document is genuinely out of reach for reads.
  const read = await api(editorPage, `/api/documents/${docId}`);
  expect(read.status, "editor cannot read the document").toBe(404);

  // The exploit: mint an anonymous share link for a document you can't read.
  const share = await api(editorPage, `/api/documents/${docId}/share`, {
    method: "POST",
    body: {},
  });
  expect(share.status, "editor cannot mint a share link out of scope").toBe(404);
  expect(share.body?.share?.token, "no share token was issued").toBeFalsy();

  // Nothing leaked even if a token somehow existed: no anonymous context should
  // be able to reach the content.
  const anonCtx = await browser.newContext();
  const anonPage = await anonCtx.newPage();
  const token = share.body?.share?.token;
  if (token) {
    const res = await anonPage.goto(`/share/${token}`);
    expect(res?.status(), "anonymous share fetch is refused").not.toBe(200);
    expect(await anonPage.content()).not.toContain(secret);
  }

  // Same bug class on trash restore: move it to the trash as admin, then have
  // the out-of-scope editor try to restore it into the private space.
  const trashed = await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
  expect([200, 204]).toContain(trashed.status);

  const restore = await api(editorPage, `/api/trash/${docId}`, { method: "POST" });
  expect(restore.status, "editor cannot restore into a space out of scope").toBe(404);

  // And it really is still in the trash.
  const trash = await api(adminPage, "/api/trash");
  const stillTrashed = JSON.stringify(trash.body ?? {}).includes(String(docId));
  expect(stillTrashed, "document remained in the trash").toBe(true);

  await anonCtx.close();
  await editorCtx.close();
  await adminCtx.close();
});
