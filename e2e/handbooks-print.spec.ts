import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, ensureUser, api } from "./helpers";

// 1.18.0 (H5): the printed handbook, /handbooks/{id}/print. Outside the app
// shell; a cover, the contents, one sheet per policy and the signature page;
// @page rules for the paper size, the footer with the page number and each
// policy's running header (named pages); ?print=1 opens the dialog once and
// drops the flag; every print audits handbook.printed. A reader in the
// audience prints policies from a space they cannot open (handbook access
// opens its policies); a draft is the editors' alone.

const VIEWER = { username: "e2e_hb_print_viewer", password: "E2eHbPrint!12345" };
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** Pages in a Chromium PDF: one /Type /Page object each (not /Pages). */
function pdfPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

async function pageCss(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .filter((t) => t.includes("@page"))
      .join("\n")
  );
}

test("a handbook prints as a cover, contents, one page run per policy and a signature page", async ({ browser }) => {
  // Two accounts, a dozen requests, two PDFs: longer than the default.
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN);
  await ensureUser(page, VIEWER, "viewer", "Print Viewer");
  const s = stamp();
  const title = `E2E Handbook ${s}`;
  let spaceId: number | undefined;
  const docIds: number[] = [];
  let handbookId: number | undefined;
  try {
    // A private space the viewer cannot open: the handbook is their way in.
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E HB Print ${s}`, slug: `e2e-hb-print-${s}`, description: "", visibility: "private" },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "space created").toBeTruthy();
    for (const [t, content] of [
      [`Conduct ${s}`, `# Conduct ${s}\n\nBe kind. Marker-conduct-${s}.\n`],
      [`Security ${s}`, `# Security ${s}\n\nLock your screen. Marker-security-${s}.\n`],
    ] as const) {
      const made = await api(page, "/api/documents", {
        method: "POST",
        body: { space_id: spaceId, title: t, type: "policy", status: "published", content, summary: "", tags: [] },
      });
      expect(made.status, `${t} created`).toBe(201);
      docIds.push(made.body.doc.id);
    }

    const created = await api(page, "/api/handbooks", {
      method: "POST",
      body: {
        title,
        space_id: null,
        introduction: "Welcome. These are the policies everyone follows.",
        audience: "all",
        group_ids: [],
        confirm_whole: false,
        require_signature: false,
      },
    });
    expect(created.status, "handbook created").toBe(201);
    handbookId = created.body.handbook.id;
    const contents = await api(page, `/api/handbooks/${handbookId}/contents`, {
      method: "PUT",
      body: {
        sections: [
          { id: created.body.handbook.sections[0]?.id, title: "Working here", doc_ids: [docIds[0]] },
          { title: "Information security", doc_ids: [docIds[1]] },
        ],
      },
    });
    expect(contents.status, "contents saved").toBeLessThan(300);

    // A draft is the editors' alone.
    const viewerCtx = await browser.newContext();
    const vpage = await viewerCtx.newPage();
    await login(vpage, VIEWER);
    const draft = await vpage.goto(`/handbooks/${handbookId}/print`);
    expect(draft?.status(), "a reader cannot print a draft").toBe(404);
    expect((await api(vpage, `/api/handbooks/${handbookId}/printed`, { method: "POST" })).status).toBe(404);

    const pub = await api(page, `/api/handbooks/${handbookId}/publish`, { method: "POST", body: { publish: true } });
    expect(pub.status, "published").toBeLessThan(300);

    // The reader's print: no app chrome, the cover, the contents, the policies.
    await vpage.goto(`/handbooks/${handbookId}/print?paper=a4`);
    await expect(vpage.locator("aside")).toHaveCount(0);
    await expect(vpage.locator("h1")).toHaveText("Print preview");
    await expect(vpage.getByRole("region", { name: "Cover" }).getByRole("heading", { level: 2 })).toHaveText(title);
    await expect(vpage.getByText("2 policies · 2 sections")).toBeVisible();
    const contentsSheet = vpage.locator("section", { has: vpage.getByRole("heading", { name: "Contents" }) });
    await expect(contentsSheet.getByText("1 · Working here")).toBeVisible();
    await expect(contentsSheet.getByText("2 · Information security")).toBeVisible();
    await expect(contentsSheet.getByText(`Security ${s}`)).toBeVisible();
    await expect(vpage.getByRole("heading", { level: 2, name: `Conduct ${s}` })).toBeVisible();
    await expect(vpage.getByText(`Marker-conduct-${s}.`), "a private-space policy prints through the handbook").toBeVisible();
    await expect(vpage.getByRole("heading", { level: 2, name: "Acknowledgement" })).toBeVisible();
    for (const label of ["Full name", "Signature", "Date", "Manager"]) {
      await expect(vpage.getByText(label, { exact: true })).toBeVisible();
    }
    // The body's own "# Title" is not printed twice.
    await expect(vpage.getByRole("heading", { name: `Conduct ${s}` })).toHaveCount(1);

    // The page boxes: A4, the footer, a named page per policy.
    const css = await pageCss(vpage);
    expect(css).toContain("size: A4;");
    expect(css).toContain(`content: "${title} · `);
    expect(css).toContain('content: "Page " counter(page)');
    expect(css).toContain('@page hb-p-2 {\n  @top-left { content: "2 · Information security";');
    expect(css).toContain('content: "Policy 2 of 2"');
    const sheetPages = await vpage
      .locator("section[aria-labelledby^='hb-print-policy-']")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).getPropertyValue("page")));
    expect(sheetPages).toEqual(["hb-p-1", "hb-p-2"]);

    // On paper: no toolbar, no on-screen header/footer copies.
    await vpage.emulateMedia({ media: "print" });
    await expect(vpage.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
    await expect(vpage.getByText("Policy 1 of 2", { exact: true })).toBeHidden();
    const audited = vpage.waitForResponse((r) => r.url().endsWith(`/api/handbooks/${handbookId}/printed`), {
      timeout: 20_000,
    });
    const pdf = await vpage.pdf({ preferCSSPageSize: true, printBackground: true });
    // Two policies short enough to share a sheet still print on a page each:
    // cover, contents, policy 1, policy 2, the signature page.
    expect(pdfPages(pdf), "page count: each policy starts a new page").toBe(5);
    await vpage.emulateMedia({ media: "screen" });

    // Letter: the toolbar's paper choice is the @page size.
    await vpage.getByRole("radiogroup", { name: "Paper size" }).getByRole("radio", { name: "Letter" }).click();
    await expect(vpage).toHaveURL(/paper=letter/, { timeout: 20_000 });
    await expect.poll(() => pageCss(vpage), { timeout: 20_000 }).toContain("size: letter;");

    // Every print is audited: beforeprint, which the button, the dialog
    // link, Ctrl+P and page.pdf() all raise, posts handbook.printed.
    expect((await audited).status()).toBe(204);
    const log = await api(page, "/api/admin/audit?category=handbook&limit=50");
    expect(
      (log.body?.rows ?? []).some(
        (r: { action: string; target_id: string | null; actor_name: string }) =>
          r.action === "handbook.printed" && r.target_id === String(handbookId) && r.actor_name === "Print Viewer"
      ),
      "handbook.printed recorded for the reader"
    ).toBeTruthy();

    // ?print=1 opens the dialog once the page has settled, then drops the flag.
    await vpage.addInitScript(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed++;
      };
    });
    await vpage.goto(`/handbooks/${handbookId}/print?print=1`);
    await expect.poll(() => vpage.evaluate(() => (window as unknown as { __printed: number }).__printed), { timeout: 20_000 }).toBe(1);
    await expect(vpage).not.toHaveURL(/print=1/);

    // No horizontal scroll on a phone.
    await vpage.setViewportSize({ width: 375, height: 800 });
    await vpage.reload();
    const wide = await vpage.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll("body *"))
        .filter((el) => el.getBoundingClientRect().right > w + 0.5)
        .map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 40)}`)
        .slice(0, 5);
    });
    expect(wide, "nothing runs past the right edge at 375px").toEqual([]);
    await viewerCtx.close();
  } finally {
    if (handbookId) await api(page, `/api/handbooks/${handbookId}`, { method: "DELETE" });
    for (const id of docIds) {
      // Trash, then purge: a space with a trashed document cannot be deleted.
      await api(page, `/api/documents/${id}`, { method: "DELETE" });
      await api(page, `/api/trash/${id}`, { method: "DELETE" });
    }
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    await ctx.close();
  }
});
