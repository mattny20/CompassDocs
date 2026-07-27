import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, login, ensureUser, api } from "./helpers";

// Strict-mode approval loop: editor's change to published content queues a
// change request; the admin approves it; the editor is notified in-app.
test("editor edit queues a change request; approval notifies the author", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, ADMIN);
  await ensureUser(adminPage, EDITOR, "editor", "E2E Editor");

  // A published doc to edit.
  const spaces = await api(adminPage, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  const created = await api(adminPage, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title: "E2E Approval Target",
      type: "sop",
      status: "published",
      content: "Original content.",
      summary: "",
      tags: [],
    },
  });
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();

  // Editor edits it → 200 with pending change request (strict mode default).
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, EDITOR);
  const edit = await api(editorPage, `/api/documents/${docId}`, {
    method: "PUT",
    body: {
      title: "E2E Approval Target",
      content: "Edited by the e2e editor.",
      status: "published",
    },
  });
  expect(edit.status).toBe(200);
  expect(edit.body?.pending).toBe(true);
  const crId = edit.body?.changeRequestId;
  expect(crId).toBeTruthy();

  // Admin approves; the doc's live content updates.
  const approve = await api(adminPage, `/api/change-requests/${crId}`, {
    method: "PATCH",
    body: { action: "approve", note: "e2e approve" },
  });
  expect(approve.status).toBe(200);
  const after = await api(adminPage, `/api/documents/${docId}`);
  expect(JSON.stringify(after.body)).toContain("Edited by the e2e editor.");

  // The author hears about the decision in their inbox.
  const inbox = await api(editorPage, "/api/notifications");
  expect(inbox.status).toBe(200);
  expect(JSON.stringify(inbox.body.items)).toContain("cr_resolved");

  await api(adminPage, `/api/documents/${docId}`, { method: "DELETE" });
  await adminCtx.close();
  await editorCtx.close();
});
