import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.18.3: a person asked to confirm a policy only through a handbook (they
// can't open the policy's space, the handbook's audience includes them)
// sees it where they look for their policies, and the compliance desk sees
// how they are asked. My policies lists it with BookOpen in the icon slot,
// "In {handbook}" as its subtitle and a link to the handbook reader at its
// confirm bar; the dashboard's Needs your attention names it "{title} (in
// {handbook}, …)"; following the row lands on the reader's confirm bar;
// the policy's Record tab marks the person "Through a handbook".
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the
// community build, so the test skips itself when requiring a confirmation
// answers 402 and runs in full on the EE rig.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const PARA = `Policy text long enough to need scrolling. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10)}`;
const BODY = Array.from({ length: 10 }, (_, i) => `## Section ${i + 1}\n\n${PARA}`).join("\n\n");

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", { method: "POST", body: { ...user, role: "viewer", name } });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

async function makeGroup(page: Page, name: string, memberIds: number[]): Promise<number> {
  const made = await api(page, "/api/admin/groups", { method: "POST", body: { name } });
  expect(made.status, `group ${name} created`).toBe(201);
  const id = made.body?.group?.id;
  expect(id, "group id").toBeTruthy();
  for (const userId of memberIds) {
    const added = await api(page, `/api/admin/groups/${id}`, { method: "PATCH", body: { addUserId: userId } });
    expect(added.status, `member ${userId} added to ${name}`).toBe(200);
  }
  return id;
}

test("a policy asked only through a handbook: My policies and the dashboard point at the handbook, the row lands on the reader's confirm bar, the Record tab tags the person", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await login(page, ADMIN);
  const s = stamp();
  const viewer = { username: `e2e_hbread_${s}`, password: "E2eHbRead!12345" };
  const viewerName = `HB Reader ${s}`;
  const policyTitle = `E2E HB-only policy ${s}`;
  const handbookTitle = `E2E Reader Handbook ${s}`;
  let viewerId: number | undefined;
  let groupId: number | undefined;
  let spaceId: number | undefined;
  let docId: number | undefined;
  let handbookId: number | undefined;
  try {
    viewerId = await makeUser(page, viewer, viewerName);
    groupId = await makeGroup(page, `E2E HB readers ${s}`, [viewerId]);

    // A private space with no grants: the viewer can't open it.
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E HB private ${s}`, visibility: "private", groupIds: [] },
    });
    expect(space.status, "private space created").toBe(201);
    spaceId = space.body?.space?.id;
    expect(spaceId, "space id").toBeTruthy();

    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: spaceId, title: policyTitle, type: "policy", status: "published", content: BODY, tags: [] },
    });
    expect(made.status, "policy created in the private space").toBe(201);
    docId = made.body.doc.id;

    const req = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true, notify: false } });
    test.skip(req.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(req.status, JSON.stringify(req.body)).toBe(200);

    // A published workspace handbook for the viewer's group, holding the policy.
    const created = await api(page, "/api/handbooks", {
      method: "POST",
      body: {
        title: handbookTitle,
        space_id: null,
        introduction: "",
        audience: "groups",
        group_ids: [groupId],
        confirm_whole: false,
        require_signature: false,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    handbookId = created.body.handbook.id;
    const contents = await api(page, `/api/handbooks/${handbookId}/contents`, {
      method: "PUT",
      body: { sections: [{ title: "Policies", doc_ids: [docId] }] },
    });
    expect(contents.status, JSON.stringify(contents.body)).toBe(200);
    const published = await api(page, `/api/handbooks/${handbookId}/publish`, { method: "POST", body: { publish: true } });
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const readerHref = `/handbooks/${handbookId}/${docId}#confirm-reading`;

    const ctx = await browser.newContext();
    const vpage = await ctx.newPage();
    try {
      await login(vpage, viewer);

      // The API behind the page: the row names the handbook it is asked through.
      const mine = await api(vpage, "/api/compliance/mine");
      expect(mine.status).toBe(200);
      const rows: { id: number; state: string; via_handbook?: { id: number; title: string } | null }[] = mine.body?.rows ?? [];
      const row0 = rows.find((r) => r.id === docId);
      expect(row0, "the handbook-only policy is listed").toBeTruthy();
      expect(row0?.via_handbook).toEqual({ id: handbookId, title: handbookTitle });

      // The sidebar shows Compliance with a badge for someone whose policy
      // comes only through a handbook.
      await vpage.goto("/compliance");
      await expect(vpage.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Compliance/ }).first()).toBeVisible();

      // My policies: BookOpen in the icon slot, "In {handbook}" in the
      // subtitle, the title links to the reader's confirm bar.
      const row = vpage.getByRole("region", { name: "To confirm" }).locator("li", { hasText: policyTitle });
      await expect(row).toBeVisible();
      await expect(row.locator("svg.lucide-book-open")).toHaveCount(1);
      await expect(row.getByText(`In ${handbookTitle}`)).toBeVisible();
      const link = row.getByRole("link", { name: policyTitle });
      await expect(link).toHaveAttribute("href", readerHref);
      await expect(row.getByText(/To confirm/)).toBeVisible();

      // The filter matches the handbook's title (shown past ten rows only).
      const filter = vpage.getByLabel("Filter policies");
      if (await filter.count()) {
        await filter.fill(handbookTitle);
        await expect(row).toBeVisible();
        await filter.fill("");
      }

      // The dashboard counts it and names it in its handbook, with no space icon.
      const pending = rows.filter((r) => r.state !== "confirmed");
      await vpage.goto("/");
      const attention = vpage.getByRole("link", { name: /^\d+ polic(y needs|ies need) your read confirmation/ });
      await expect(attention).toBeVisible();
      await expect(attention).toContainText(new RegExp(`^${pending.length} polic`));
      if (pending.findIndex((r) => r.id === docId) < 3) {
        await expect(attention).toContainText(`${policyTitle} (in ${handbookTitle}`);
      }
      // Alone, the row opens the reader; with others, My policies.
      await expect(attention).toHaveAttribute("href", pending.length === 1 ? readerHref : "/compliance");

      // Following the row lands on the reader's confirm bar.
      await vpage.goto("/compliance");
      await vpage.getByRole("region", { name: "To confirm" }).getByRole("link", { name: policyTitle }).click();
      await vpage.waitForURL((u) => u.pathname === `/handbooks/${handbookId}/${docId}` && u.hash === "#confirm-reading");
      await expect(vpage.getByRole("heading", { level: 2, name: policyTitle })).toBeVisible();
      const bar = vpage.locator("#confirm-reading");
      await expect(bar).toBeVisible();
      await expect(bar).toBeInViewport();
      await expect(bar.getByRole("button", { name: /^Confirm/ })).toBeVisible();
    } finally {
      await ctx.close();
    }

    // The policy's Record tab: the viewer carries the tag, its tooltip names the handbook.
    await page.goto(`/doc/${docId}/acknowledgements`);
    const personRow = page.locator("tr", { hasText: viewerName });
    await expect(personRow).toBeVisible();
    const tag = personRow.getByText("Through a handbook");
    await expect(tag).toBeVisible();
    await expect(personRow.locator("[data-tt]", { hasText: "Through a handbook" })).toHaveAttribute(
      "data-tt",
      `Asked through ${handbookTitle}: they can't open this policy's space, so reminders link to the handbook.`
    );
    // The admin, who can open the space, is not tagged.
    await expect(page.locator("tr", { hasText: ADMIN.username }).getByText("Through a handbook")).toHaveCount(0);
  } finally {
    if (handbookId) await api(page, `/api/handbooks/${handbookId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    if (groupId) await api(page, `/api/admin/groups/${groupId}`, { method: "DELETE" });
    if (viewerId) await api(page, `/api/admin/users/${viewerId}`, { method: "DELETE" });
  }
});
