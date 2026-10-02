import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.9.2 (item D5): the share page and the public document page render the
// same standalone document, and a body that opens with "# Title" does not
// show the title twice. Attachment links on the share page carry the token.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test("public and shared documents drop the duplicate title and share one layout", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const s = stamp();
  const title = `E2E Standalone ${s}`;
  let spaceId: number | undefined;
  let docId: number | undefined;
  let priorShare: unknown;
  try {
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Public ${s}`, slug: `e2e-public-${s}`, description: "", visibility: "public" },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "public space created").toBeTruthy();
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: {
        space_id: spaceId,
        title,
        type: "knowledge",
        status: "published",
        content: `# ${title}\n\nFirst paragraph of the body.\n\n## A real section\n\nMore.\n`,
        summary: "A one-line summary.",
        tags: ["alpha"],
      },
    });
    expect(made.status).toBe(201);
    docId = made.body?.doc?.id;
    const slug = made.body?.doc?.slug;
    expect(slug, "the document has a slug").toBeTruthy();

    // An attachment, so the share page has a link to carry the token on.
    const up = await page.request.post(`/api/documents/${docId}/attachments`, {
      multipart: { file: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
    });
    expect(up.ok(), "attachment uploaded").toBeTruthy();

    // The public site and share links may be off by default; turn both on.
    const site = await api(page, "/api/admin/public-site");
    priorShare = { enabled: site.body?.config?.enabled, shareLinks: site.body?.config?.shareLinks };
    const on = await api(page, "/api/admin/public-site", { method: "PATCH", body: { enabled: true, shareLinks: true } });
    expect(on.status, "public site and share links enabled").toBeLessThan(300);
    const share = await api(page, `/api/documents/${docId}/share`, { method: "POST", body: {} });
    expect(share.status, "share created").toBeLessThan(300);
    const shareUrl: string = share.body?.share?.url ?? `/share/${share.body?.share?.token}`;

    const anon = await browser.newContext();
    const apage = await anon.newPage();
    for (const url of [`/public/e2e-public-${s}/${slug}`, shareUrl]) {
      await apage.goto(url);
      await expect(apage.locator("h1"), `${url}: one masthead`).toHaveCount(1);
      await expect(apage.locator("h1")).toHaveText(title);
      await expect(apage.locator("article h1"), `${url}: no duplicated title in the body`).toHaveCount(0);
      await expect(apage.locator("article h2")).toHaveText("A real section");
      await expect(apage.getByText("First paragraph of the body.")).toBeVisible();
      await expect(apage.getByText("A one-line summary.")).toBeVisible();
      await expect(apage.getByRole("heading", { name: "Attachments" })).toBeVisible();
      await expect(apage.getByRole("link", { name: "notes.txt" })).toBeVisible();
      await expect(apage.getByRole("button", { name: /print/i })).toBeVisible();
    }
    const href = await apage.getByRole("link", { name: "notes.txt" }).getAttribute("href");
    expect(href, "the share page's attachment link carries the share token").toMatch(/\?share=/);
    await anon.close();
  } finally {
    const prior = priorShare as { enabled?: boolean; shareLinks?: boolean } | undefined;
    if (prior && typeof prior.enabled === "boolean") {
      await api(page, "/api/admin/public-site", {
        method: "PATCH",
        body: { enabled: prior.enabled, ...(typeof prior.shareLinks === "boolean" ? { shareLinks: prior.shareLinks } : {}) },
      });
    }
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    await ctx.close();
  }
});
