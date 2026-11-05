import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, ensureUser, api } from "./helpers";

// The handbook reader (1.18.0, H3): /handbooks/{id} opens on the
// introduction beside the contents; each policy has its own address
// (/handbooks/{id}/{docId}) with the redesigned policy page (badges,
// "Policy k of N", the facts row, "In short", the body through the
// document renderer, the end bar with "Next: …"); the contents rail marks
// the policy on screen and nests its headings; a phone gets the contents
// behind one button and never scrolls sideways. A reader who cannot open
// a policy's space reads it through the handbook while /doc/{id} stays
// closed to them. Licensed builds also confirm a policy from the bar and
// see the tick and the progress follow.

const STAMP = `E2E HB reader ${Date.now()}`;
const READER = { username: "e2e_hb_reader", password: "E2eHbReader!12345" };
const BODY = (n: string) =>
  `## Purpose\n\n${n} explains what we expect.\n\n## Scope\n\nEveryone who works here.\n\n## Details\n\nThe rest of the ${n}.`;

interface Fixture {
  spaceId?: number;
  handbookId?: number;
  docs: number[];
}

/** Builds into `f` as it goes, so a teardown after a failed step still finds what was made. */
async function setup(page: Page, f: Fixture, opts: { introduction: string }): Promise<Required<Fixture>> {
  const slug = `e2e-hb-reader-${Date.now()}`;
  const space = await api(page, "/api/admin/spaces", {
    method: "POST",
    body: { name: `${STAMP} Board`, slug, description: "", visibility: "private" },
  });
  f.spaceId = space.body?.space?.id ?? space.body?.id;
  expect(f.spaceId, "private space created").toBeTruthy();
  for (const [title, sid] of [
    ["Paid Time Off Policy", 2],
    ["Remote Work Policy", 2],
    ["Board Conduct Policy", f.spaceId!],
  ] as const) {
    const made = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: sid, title: `${STAMP} ${title}`, type: "policy", status: "published", content: BODY(title), summary: "", tags: [] },
    });
    expect(made.status, `${title} created`).toBe(201);
    f.docs.push(made.body.doc.id);
  }
  const facts = await api(page, `/api/documents/${f.docs[0]}`, {
    method: "PUT",
    body: { summary_points: ["You get **25 days** a year.", "Ask two weeks ahead."], applies_to: "All employees" },
  });
  expect(facts.status, "summary points saved").toBe(200);

  const hb = await api(page, "/api/handbooks", {
    method: "POST",
    body: { title: `${STAMP} Handbook`, space_id: null, introduction: opts.introduction, audience: "all", group_ids: [], confirm_whole: true, require_signature: false },
  });
  expect(hb.status, "handbook created").toBe(201);
  f.handbookId = hb.body.handbook.id;
  const contents = await api(page, `/api/handbooks/${f.handbookId}/contents`, {
    method: "PUT",
    body: { sections: [{ title: "Working here", doc_ids: f.docs.slice(0, 2) }, { title: "Governance", doc_ids: f.docs.slice(2) }] },
  });
  expect(contents.status, "contents saved").toBe(200);
  const pub = await api(page, `/api/handbooks/${f.handbookId}/publish`, { method: "POST", body: { publish: true } });
  expect(pub.status, "published").toBe(200);
  return f as Required<Fixture>;
}

/** The handbook, the documents (trashed, then purged) and the space. */
async function teardown(page: Page, f: Fixture) {
  if (f.handbookId) await api(page, `/api/handbooks/${f.handbookId}`, { method: "DELETE" });
  for (const id of f.docs) {
    await api(page, `/api/documents/${id}`, { method: "DELETE" });
    await api(page, `/api/trash/${id}`, { method: "DELETE" });
  }
  if (f.spaceId) await api(page, `/api/admin/spaces/${f.spaceId}`, { method: "DELETE" });
}

test("the reader: introduction, contents, one address per policy, the policy page, and a phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const made: Fixture = { docs: [] };
  try {
    const f = await setup(page, made, { introduction: "Welcome. Read each policy, then confirm the handbook." });

    await page.goto(`/handbooks/${f.handbookId}`);
    await expect(page.getByRole("heading", { level: 1, name: `${STAMP} Handbook` })).toBeVisible();
    await expect(page.getByText(/3 policies in 2 sections · updated .* · for the whole workspace/)).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Handbook contents" });
    await expect(nav.getByRole("link", { name: "Introduction" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Introduction" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Print or save as PDF" })).toHaveAttribute("href", `/handbooks/${f.handbookId}/print?print=1`);

    // Start reading → the first policy at its own address.
    await page.getByRole("link", { name: /Start reading/ }).click();
    await page.waitForURL(`**/handbooks/${f.handbookId}/${f.docs[0]}`);
    await expect(page.getByRole("heading", { level: 2, name: `${STAMP} Paid Time Off Policy` })).toBeVisible();
    await expect(page.getByText("Policy 1 of 3", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Paid Time Off Policy/ })).toHaveAttribute("aria-current", "page");
    // The facts row and "In short".
    const facts = page.locator("dl");
    await expect(facts.getByText("Applies to")).toBeVisible();
    await expect(facts.getByText("All employees")).toBeVisible();
    await expect(page.getByRole("region", { name: "In short" })).toContainText("You get 25 days a year.");
    await expect(page.getByRole("region", { name: "In short" }).locator("strong")).toHaveText("25 days");
    // The policy's own headings nest under it in the rail, with "In short" first.
    const onThis = nav.getByRole("list", { name: "On this policy" });
    await expect(onThis.getByRole("link")).toHaveText(["In short", "Purpose", "Scope", "Details"]);
    // The body is the document renderer's (no title repeated): its own
    // headings, whatever level the page's heading ladder puts them at.
    await expect(page.locator("article.doc-read").getByRole("heading")).toHaveText(["Purpose", "Scope", "Details"]);

    // Next → the second policy; its address can be opened directly.
    await page.getByRole("link", { name: `Next: ${STAMP} Remote Work Policy` }).click();
    await page.waitForURL(`**/handbooks/${f.handbookId}/${f.docs[1]}`);
    await expect(page.getByText("Policy 2 of 3", { exact: true })).toBeVisible();
    await page.goto(`/handbooks/${f.handbookId}/${f.docs[2]}`);
    await expect(page.getByRole("heading", { level: 2, name: `${STAMP} Board Conduct Policy` })).toBeVisible();

    // A document that isn't in the handbook, and a handbook that doesn't exist, are 404s.
    expect((await page.goto(`/handbooks/${f.handbookId}/1`))?.status()).toBe(404);
    expect((await page.goto(`/handbooks/999999999`))?.status()).toBe(404);

    // A phone: the contents fold behind one button; nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/handbooks/${f.handbookId}/${f.docs[0]}`);
    const toggle = nav.getByRole("button", { name: /Contents · Policy 1 of 3/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("link", { name: /Remote Work Policy/ })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("link", { name: /Remote Work Policy/ })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const m = document.querySelector("main")!;
      return m.scrollWidth - m.clientWidth;
    });
    expect(overflow, "no sideways scroll at 375px").toBeLessThanOrEqual(0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await teardown(page, made);
    await ctx.close();
  }
});

test("a handbook opens its policies: a reader outside the space reads it here, while /doc/{id} stays closed", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, ADMIN);
  await ensureUser(admin, READER, "viewer", "E2E Handbook Reader");
  const made: Fixture = { docs: [] };
  const readerCtx = await browser.newContext();
  try {
    // No introduction: /handbooks/{id} opens at the first policy.
    const f = await setup(admin, made, { introduction: "" });
    const reader = await readerCtx.newPage();
    await login(reader, READER);
    await reader.goto(`/handbooks/${f.handbookId}`);
    await reader.waitForURL(`**/handbooks/${f.handbookId}/${f.docs[0]}`);

    const secret = f.docs[2];
    expect((await reader.goto(`/doc/${secret}`))?.status(), "the space stays closed").toBe(404);
    await reader.goto(`/handbooks/${f.handbookId}/${secret}`);
    await expect(reader.getByRole("heading", { level: 2, name: `${STAMP} Board Conduct Policy` })).toBeVisible();
    await expect(reader.locator("article.doc-read")).toContainText("The rest of the Board Conduct Policy.");
    // No "Edit" for a reader.
    await expect(reader.getByRole("link", { name: "Edit" })).toHaveCount(0);

    // Unpublished, the handbook is gone for its readers.
    const unpub = await api(admin, `/api/handbooks/${f.handbookId}/publish`, { method: "POST", body: { publish: false } });
    expect(unpub.status).toBe(200);
    expect((await reader.goto(`/handbooks/${f.handbookId}/${f.docs[0]}`))?.status()).toBe(404);
    // Its editor still previews the draft, told so.
    await admin.goto(`/handbooks/${f.handbookId}/${f.docs[0]}`);
    await expect(admin.getByText("This handbook is a draft. Only its editors can see it until it is published.")).toBeVisible();
  } finally {
    await teardown(admin, made);
    await readerCtx.close();
    await adminCtx.close();
  }
});

test("licensed: confirm a policy from the bar; the status, the tick and the progress follow", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const made: Fixture = { docs: [] };
  try {
    const f = await setup(page, made, { introduction: "" });
    const on = await api(page, `/api/documents/${f.docs[0]}/ack`, { method: "PATCH", body: { required: true } });
    test.skip(on.status === 402, "policy_ack is not licensed in this build; the EE rig runs the flow");
    expect(on.status).toBe(200);

    await page.goto(`/handbooks/${f.handbookId}/${f.docs[0]}`);
    const nav = page.getByRole("navigation", { name: "Handbook contents" });
    await expect(nav.getByRole("progressbar", { name: "Policies confirmed" })).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByText("To confirm", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Confirm handbook" }).first()).toBeVisible();

    const bar = page.getByRole("region", { name: "Confirm this policy" });
    const confirm = bar.getByRole("button", { name: "Confirm" });
    // Not ticked: the button explains itself and records nothing.
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await expect(bar.getByText("Tick the statement to confirm")).toBeVisible();
    await bar.getByRole("checkbox").check();
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await confirm.click();
    await expect(page.getByText("Confirmation recorded.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Confirmation recorded" })).toContainText("You confirmed version 1");
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Paid Time Off Policy/ })).toContainText("(confirmed)");
    await expect(nav.getByRole("progressbar", { name: "Policies confirmed" })).toHaveAttribute("aria-valuenow", "1");

    // A policy that asks nobody says so.
    await page.goto(`/handbooks/${f.handbookId}/${f.docs[1]}`);
    await expect(page.getByText("For information. This policy doesn't ask you to confirm it.")).toBeVisible();
  } finally {
    if (made.docs[0]) await api(page, `/api/documents/${made.docs[0]}/ack`, { method: "PATCH", body: { required: false } });
    await teardown(page, made);
    await ctx.close();
  }
});
