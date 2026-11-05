import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.18.0 (H4): confirm the whole handbook at /handbooks/{id}/confirm. The
// page lists every policy with where it stands for the reader, the reader
// ticks one statement (and signs when a policy asks for a signature), and
// one button confirms every policy still waiting, each as its own card
// would. test/handbook-confirm.test.ts covers the rows, the audit and the
// refusals; this spec covers the page.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so the first test asserts the gate; the flow test skips itself
// when requiring a confirmation answers 402 and runs in full on the EE rig.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const made = { docs: [] as number[], handbooks: [] as number[] };
let owner: Page | null = null;

test.afterEach(async () => {
  if (!owner) return;
  for (const id of made.handbooks) await owner.request.delete(`/api/handbooks/${id}`).catch(() => undefined);
  for (const id of made.docs) await owner.request.delete(`/api/documents/${id}`).catch(() => undefined);
  made.docs = [];
  made.handbooks = [];
});

async function makePolicy(page: Page, title: string): Promise<number> {
  const res = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: `# ${title}\n\nStaff must follow this.`, tags: [] },
  });
  expect(res.status, "policy created").toBe(201);
  made.docs.push(res.body.doc.id);
  return res.body.doc.id;
}

/** A published workspace handbook for everyone, asking for a whole-handbook confirmation. */
async function makeHandbook(page: Page, title: string, docIds: number[]): Promise<number> {
  const created = await api(page, "/api/handbooks", {
    method: "POST",
    body: { title, introduction: "", audience: "all", confirm_whole: true, require_signature: false },
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const id = created.body.handbook.id;
  made.handbooks.push(id);
  const contents = await api(page, `/api/handbooks/${id}/contents`, {
    method: "PUT",
    body: { sections: [{ title: "Policies", doc_ids: docIds }] },
  });
  expect(contents.status, JSON.stringify(contents.body)).toBe(200);
  const published = await api(page, `/api/handbooks/${id}/publish`, { method: "POST", body: { publish: true } });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

test("the confirm page has the page skeleton, and the licence gate on a community build", async ({ page }) => {
  owner = page;
  await login(page, ADMIN);
  const s = stamp();
  const doc = await makePolicy(page, `HB confirm gate ${s}`);
  const hb = await makeHandbook(page, `HB confirm gate ${s}`, [doc]);

  await page.goto(`/handbooks/${hb}/confirm`);
  await expect(page.getByRole("heading", { level: 1, name: "Confirm the handbook" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: `HB confirm gate ${s}` })).toBeVisible();
  const licensed = (await api(page, `/api/handbooks/${hb}/confirm`)).status !== 402;
  if (!licensed) {
    await expect(page.getByText("Read confirmation is an Enterprise feature.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Confirm/ })).toHaveCount(0);
  }
  // A handbook the reader may not read (here: one that does not exist) is a 404.
  const missing = await page.goto(`/handbooks/999999999/confirm`);
  expect(missing?.status(), "a handbook that does not exist").toBe(404);
});

test("one confirmation covers every waiting policy; the button waits for the tick; the done state replaces the form", async ({ page }) => {
  owner = page;
  await login(page, ADMIN);
  const s = stamp();
  const waiting = await makePolicy(page, `HB waiting ${s}`);
  const alreadyDone = await makePolicy(page, `HB done ${s}`);
  const info = await makePolicy(page, `HB info ${s}`);
  for (const id of [waiting, alreadyDone]) {
    const req = await api(page, `/api/documents/${id}/ack`, { method: "PATCH", body: { required: true, notify: false } });
    test.skip(req.status === 402, "policy_ack is not licensed on this build");
    expect(req.status).toBe(200);
  }
  const v = (await api(page, `/api/documents/${alreadyDone}/ack`)).body.latest_version_id;
  expect((await api(page, `/api/documents/${alreadyDone}/ack`, { method: "POST", body: { version_id: v } })).status).toBe(200);
  const hb = await makeHandbook(page, `HB flow ${s}`, [alreadyDone, waiting, info]);

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/handbooks/${hb}/confirm`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const list = page.getByRole("list").filter({ hasText: `HB waiting ${s}` });
  await expect(list.getByRole("listitem").filter({ hasText: `HB done ${s}` })).toContainText("Confirmed");
  await expect(list.getByRole("listitem").filter({ hasText: `HB waiting ${s}` })).toContainText("To confirm");
  await expect(list.getByRole("listitem").filter({ hasText: `HB info ${s}` })).toContainText("For information");
  await expect(page.getByText("1 confirmed · 1 to confirm · 1 for information")).toBeVisible();

  const button = page.getByRole("button", { name: "Confirm 1 policy" });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAccessibleDescription("Tick the statement above to confirm");
  // Unticked, the click sends nothing and records nothing.
  const posts: string[] = [];
  const onRequest = (r: { method: () => string; url: () => string }) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === `/api/handbooks/${hb}/confirm`) posts.push(r.url());
  };
  page.on("request", onRequest);
  await button.click();
  await expect(page.getByRole("status").getByText("1 confirmation recorded.")).toHaveCount(0);
  page.off("request", onRequest);
  expect(posts, "no confirmation was sent").toEqual([]);
  const still = await api(page, `/api/handbooks/${hb}/confirm`);
  expect(still.status).toBe(200);
  expect(still.body.counts.outstanding, "the policy is still waiting").toBe(1);

  await page.getByRole("checkbox", { name: `I have read and understood all 3 policies in HB flow ${s}, and I agree to follow them.` }).check();
  await expect(button).not.toHaveAttribute("aria-disabled", "true");
  await button.click();
  await expect(page.getByText("1 confirmation recorded.")).toBeVisible();
  await expect(page.getByText(/^You confirmed this handbook on /)).toBeVisible();
  await expect(list.getByRole("listitem").filter({ hasText: `HB waiting ${s}` })).toContainText("Confirmed");
  await expect(page.getByRole("link", { name: "View your record" })).toHaveAttribute("href", "/compliance/person/me");

  // The policy's own page agrees: its card is in the done state.
  await page.goto(`/doc/${waiting}`);
  await expect(page.getByText(/You confirmed (version \d+|reading this document) on /)).toBeVisible();
});
