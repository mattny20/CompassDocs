import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// Concurrent-edit safety (0.70): a stale save is refused with 409, and two
// open editors see each other via the presence banner.
test("stale save gets a conflict; concurrent editors see presence", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");

  const spaces = await api(adminPage, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(adminPage, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title: "E2E Conflict Target",
      type: "knowledge",
      status: "draft",
      content: "Draft v1.",
      summary: "",
      tags: [],
    },
  });
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();
  const loadedAt = (await api(adminPage, `/api/documents/${docId}`)).body?.doc?.updated_at
    ?? (await api(adminPage, `/api/documents/${docId}`)).body?.document?.updated_at;
  expect(loadedAt).toBeTruthy();

  // Someone else saves first…
  const first = await api(adminPage, `/api/documents/${docId}`, {
    method: "PUT",
    body: { content: "Draft v2 (winner).", status: "draft" },
  });
  expect(first.status).toBe(200);

  // …then a save carrying the stale token is refused, not overwritten.
  const stale = await api(adminPage, `/api/documents/${docId}`, {
    method: "PUT",
    body: { content: "Stale save (must lose).", status: "draft", base_updated_at: loadedAt },
  });
  expect(stale.status).toBe(409);
  expect(stale.body?.conflict).toBe(true);
  const current = await api(adminPage, `/api/documents/${docId}`);
  expect(JSON.stringify(current.body)).toContain("Draft v2 (winner).");
  expect(JSON.stringify(current.body)).not.toContain("Stale save");

  // Presence: two editors on the same doc see each other's banner.
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);
  await adminPage.goto(`/doc/${docId}/edit`);
  await editorPage.goto(`/doc/${docId}/edit`);
  // Each editor heartbeats on mount; the other's banner appears within a beat.
  await expect(editorPage.getByText(/also editing this document/)).toBeVisible({
    timeout: 45_000,
  });

  await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
  await adminCtx.close();
  await editorCtx.close();
});
