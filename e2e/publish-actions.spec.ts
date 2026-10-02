import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.0 (decision D-7): publishing is an explicit action with a visible
// status. The editor shows the saved state as a chip beside the title and
// offers the actions that state and the person's rights allow — Publish,
// Save draft, Save changes, Unpublish (confirmed), Submit for review —
// instead of a Status select buried in the metadata grid.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function grantRole(page: Page, userId: number, name: string, permissions: string[]): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e", permissions },
  });
  expect(role.status, `role ${name} created`).toBe(201);
  const assigned = await api(page, "/api/admin/rbac/assignments", {
    method: "POST",
    body: { role_id: role.body?.id, user_id: userId },
  });
  expect(assigned.status, `role ${name} assigned`).toBe(201);
  return role.body?.id;
}

test("publish, unpublish (confirmed) and schedule from the editor's actions", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E publish actions ${stamp()}`;
  let docId: number | undefined;
  try {
    // New document: no saved state yet, Save draft beside Publish.
    await page.goto("/doc/new?template=blank");
    const header = page.locator("h1", { hasText: "New document" }).locator("..");
    await expect(header.getByText("Not saved yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
    await page.getByLabel("Document title").fill(title);
    await page.locator(".tiptap").first().click();
    await page.keyboard.type("Body of the document.");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.waitForURL(/\/doc\/\d+$/);
    docId = Number(page.url().match(/\/doc\/(\d+)$/)?.[1]);
    await expect(page.locator("h1")).toContainText(title);
    await expect(page.locator("main").getByText("Published", { exact: true }).first()).toBeVisible();

    // Published: the chip says so, Save changes is primary, Unpublish asks.
    await page.goto(`/doc/${docId}/edit`);
    await expect(page.locator("h1", { hasText: "Edit document" }).locator("..").getByText("Published")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    await expect(page.getByLabel(/Unpublish automatically at/)).toBeVisible();
    await expect(page.getByLabel(/Status/)).toHaveCount(0);
    await page.getByRole("button", { name: "Unpublish" }).click();
    const dialog = page.getByRole("dialog", { name: /unpublish this document/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.status ?? (await api(page, `/api/documents/${docId}`)).body?.status).toBe("published");
    await page.getByRole("button", { name: "Unpublish" }).click();
    await page.getByRole("dialog", { name: /unpublish this document/i }).getByRole("button", { name: "Unpublish" }).click();
    await page.waitForURL(`**/doc/${docId}`);
    await expect(page.locator("main").getByText("Draft", { exact: true }).first()).toBeVisible();

    // Draft: Publish is back, and a draft can be scheduled.
    await page.goto(`/doc/${docId}/edit`);
    await expect(page.locator("h1", { hasText: "Edit document" }).locator("..").getByText("Draft")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    const when = new Date(Date.now() + 36e5 * 24 * 30);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
    await page.getByLabel(/Publish automatically at/).fill(local);
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.waitForURL(`**/doc/${docId}`);
    const after = await api(page, `/api/documents/${docId}`);
    const doc = after.body?.doc ?? after.body;
    expect(doc?.status).toBe("draft");
    expect(doc?.publish_at, "the schedule was saved with the draft").toBeTruthy();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("an author without publish rights submits a draft for review", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const s = stamp();
  const probe = { username: `e2e_submitter_${s}`, password: "E2eSubmit!12345" };
  let userId: number | undefined;
  let roleId: number | undefined;
  let spaceId: number | undefined;
  let docId: number | undefined;
  let priorMode: string | undefined;
  try {
    const settings = await api(page, "/api/admin/settings");
    priorMode = settings.body?.settings?.approval_mode ?? settings.body?.approval_mode;
    expect([200, 204]).toContain(
      (await api(page, "/api/admin/settings", { method: "PATCH", body: { approval_mode: "strict" } })).status
    );
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Submit ${s}`, slug: `e2e-submit-${s}`, description: "", visibility: "internal" },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "space created").toBeTruthy();
    const made = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...probe, role: "viewer", name: "Submit Probe" },
    });
    expect(made.status, "probe user created").toBe(201);
    userId = made.body?.user?.id;
    roleId = await grantRole(page, userId!, `E2E Submitter ${s}`, [
      "document.read",
      "document.read_draft",
      "document.create",
      "document.update",
      "space.member",
      "space.author",
    ]);
    const draft = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: spaceId, title: `E2E to submit ${s}`, type: "knowledge", status: "draft", content: "x", tags: [] },
    });
    expect(draft.status).toBe(201);
    docId = draft.body?.doc?.id;

    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    await login(vpage, probe);
    await vpage.goto(`/doc/${docId}/edit`);
    await expect(vpage.getByRole("button", { name: "Save draft" })).toBeVisible();
    await expect(vpage.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
    await expect(vpage.getByText(/sends your change to the review queue/)).toBeVisible();
    await vpage.getByRole("button", { name: "Submit for review" }).click();
    await expect(vpage.getByText("Submitted for review")).toBeVisible();
    await vctx.close();

    // The live state is untouched; the change waits in the queue.
    const after = await api(page, `/api/documents/${docId}`);
    expect((after.body?.doc ?? after.body)?.status).toBe("draft");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    if (priorMode) await api(page, "/api/admin/settings", { method: "PATCH", body: { approval_mode: priorMode } });
    await ctx.close();
  }
});
