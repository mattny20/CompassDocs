import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.10.0 (B1, B2, B5): a read confirmation is recorded in a card after the
// article, where the reading ends. The notice strip carries a one-sentence
// pointer to it, the sticky bar says whether a confirmation is pending (a
// jump link whose label flips to "Confirm now" once the end has been on
// screen) or done (a chip), and nothing is ever disabled.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so the first test asserts the gate itself; the flow tests skip
// themselves when the PATCH answers 402 and run in full on the EE rig.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const PARA = `Policy text long enough to need scrolling. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10)}`;
const BODY = Array.from({ length: 14 }, (_, i) => `## Section ${i + 1}\n\n${PARA}`).join("\n\n");

const POINTER = "Please read this document carefully. You'll be asked to confirm at the end.";
const STATEMENT = "I confirm that I have read and understood this document.";
const CONFIRM = "I've read and understood this";
const CONFIRMED = /You confirmed (version \d+|reading this document) on /;

async function makePolicy(page: Page, title: string): Promise<number> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: BODY, tags: [] },
  });
  expect(made.status, "policy created").toBe(201);
  const id = made.body?.doc?.id;
  expect(id, "policy id").toBeTruthy();
  return id;
}

/** Turn the requirement on; 402 means the community build. */
async function requireConfirmation(page: Page, docId: number): Promise<"on" | "unlicensed"> {
  const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
  if (res.status === 402) return "unlicensed";
  expect(res.status, "confirmation required").toBe(200);
  expect(res.body?.ack_required).toBe(true);
  return "on";
}

test("read confirmation: the entitlement gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, `E2E ack gate ${stamp()}`);
    const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    if (res.status === 402) {
      expect(String(res.body?.error || "")).toContain("license");
      const post = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: 1 } });
      expect(post.status).toBe(402);
      const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
      expect(roster.status).toBe(402);
      // The page shows none of the reader chrome.
      await page.goto(`/doc/${docId}`);
      await expect(page.locator("h1")).toContainText("E2E ack gate");
      await expect(page.locator("#confirm-reading")).toHaveCount(0);
      await expect(page.getByText(POINTER)).toHaveCount(0);
      await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(0);
    } else {
      expect(res.status).toBe(200);
      expect(res.body?.ack_required).toBe(true);
    }
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("admin requires confirmation; the reader is pointed to the card, confirms there, and the roster counts it", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E ack flow ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // The API contract (A1) before any confirmation exists: the version id
    // is required, and the wrong one is stale.
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: {} })).status).toBe(400);
    const stale = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: -1 } });
    expect(stale.status).toBe(409);
    expect(stale.body?.stale).toBe(true);

    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);

    // The pointer row: one sentence, one action, and no live button there.
    await expect(page.getByText(POINTER)).toBeVisible();
    const jump = page.getByRole("link", { name: "Jump to confirmation" });
    await expect(jump).toBeVisible();
    await expect(jump).toHaveAttribute("href", "#confirm-reading");
    await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(1);

    // The card: after the article, before "Was this helpful?", the statement
    // beside the button and the version being confirmed.
    const card = page.locator("#confirm-reading");
    await expect(card).toHaveAttribute("aria-labelledby", "confirm-reading-title");
    await expect(card.getByRole("heading", { name: "Confirm you've read this document" })).toBeVisible();
    await expect(card.getByText(STATEMENT)).toBeVisible();
    await expect(card.getByText(/published .+ by /)).toBeVisible();
    await expect(card.getByRole("button", { name: CONFIRM })).toBeEnabled();
    const order = await page.evaluate(() => {
      const article = document.querySelector("article.doc-read");
      const section = document.getElementById("confirm-reading");
      const feedback = Array.from(document.querySelectorAll("span")).find((s) => s.textContent === "Was this helpful?");
      return {
        afterArticle: Boolean(article && section && article.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING),
        beforeFeedback: Boolean(section && feedback && section.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(order.afterArticle, "the card follows the article").toBe(true);
    expect(order.beforeFeedback, "the card precedes the feedback row").toBe(true);

    // Jump: the section lands clear of the sticky bar and takes focus.
    await jump.click();
    await page.waitForTimeout(700);
    await expect(card).toBeFocused();
    const top = await card.evaluate((el) => el.getBoundingClientRect().top);
    expect(top, "the card is near the top of the viewport").toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(200);

    // The end has been on screen: the sticky control now says "Confirm now",
    // still a jump link, never a recorder.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(400);
    const stickyNow = page.getByRole("link", { name: "Confirm now" });
    await expect(stickyNow).toBeVisible();
    await expect(stickyNow).toHaveAttribute("href", "#confirm-reading");
    await expect(page.getByRole("link", { name: "Confirmation pending" })).toHaveCount(0);

    // Confirm: a toast announces, the card shows the record, focus stays on
    // the section, the sticky bar becomes a chip and the strip agrees.
    await card.getByRole("button", { name: CONFIRM }).click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Confirmation recorded" })).toBeVisible();
    await expect(card.getByText(CONFIRMED)).toBeVisible();
    await expect(card.getByRole("link", { name: "View your record" })).toHaveAttribute("href", "/compliance");
    await expect(card).toBeFocused();
    await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(0);
    await expect(page.locator("div.sticky.top-0").getByText(/^Confirmed /)).toBeVisible();
    await expect(page.getByRole("link", { name: "Jump to confirmation" })).toHaveCount(0);

    // The roster counts it.
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(roster.status).toBe(200);
    const mine = (roster.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(mine?.acknowledged_at, "the admin's row is confirmed").toBeTruthy();
    expect((roster.body?.rows ?? []).filter((r: { acknowledged_at: string | null }) => r.acknowledged_at).length).toBeGreaterThanOrEqual(1);

    // A fresh load renders the server's record, not a remembered click.
    await page.goto(`/doc/${docId}`);
    await expect(page.getByText(CONFIRMED).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Jump to confirmation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(0);
    await expect(page.locator("#confirm-reading").getByRole("link", { name: "View your record" })).toBeVisible();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("at 375px the sticky bar shows the confirmation control and the title only", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const title = `E2E ack phone ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);

    // The pointer's action is full width under sm.
    const jump = page.getByRole("link", { name: "Jump to confirmation" });
    await expect(jump).toBeVisible();
    expect((await jump.boundingBox())!.width, "the jump link fills the row").toBeGreaterThan(250);

    // Scroll the masthead away: the bar carries the collapsed control and
    // the title; the toolbar and the status chip are hidden, and nothing
    // scrolls sideways.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, 600));
    await page.waitForTimeout(400);
    const bar = page.locator("div.sticky.top-0");
    const control = bar.getByRole("link", { name: "Pending" });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("href", "#confirm-reading");
    await expect(bar.getByText(title)).toBeVisible();
    await expect(bar.getByRole("button", { name: "Edit document" })).toBeHidden();
    await expect(bar.getByText("Published", { exact: true })).toBeHidden();
    const overflow = await page.locator("#main").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);

    // At the end: the card's button fills the width, and the collapsed
    // label stays one word even once the end has been on screen.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(400);
    const confirm = page.getByRole("button", { name: CONFIRM });
    await expect(confirm).toBeVisible();
    expect((await confirm.boundingBox())!.width, "the confirm button fills the card").toBeGreaterThan(250);
    await expect(bar.getByRole("link", { name: "Pending" })).toBeVisible();
    await expect(bar.getByRole("link", { name: "Confirm now" })).toHaveCount(0);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});

// ── The editor (A3): the re-confirmation question on save ───────────────────
//
// A save that changes the text of a confirmed document asks how readers should
// see it, BEFORE anything is busy: Ctrl+S and Save changes both open the
// question; Escape cancels and leaves the editor dirty with Save idle; both
// choices require a change note; "keep" leaves the roster alone, "reset"
// zeroes it; a tag-only save never asks. Licensed builds only (see above).

const QUESTION = "How should readers see this change?";
const EDITORIAL = /^Editorial fix/;
const MATERIAL = /^Material change/;

async function openEditorAndType(page: Page, docId: number, text: string) {
  await page.goto(`/doc/${docId}/edit`);
  const editor = page.locator(".tiptap").first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  // Let tiptap's markdown round-trip settle before the change is made.
  await page.waitForTimeout(1500);
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

/** The roster as counts: confirmed people and the audience. */
async function rosterCount(page: Page, docId: number): Promise<{ confirmed: number; total: number }> {
  const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
  expect(roster.status, "roster readable").toBe(200);
  const rows: { acknowledged_at: string | null }[] = roster.body?.rows ?? [];
  return { confirmed: rows.filter((r) => r.acknowledged_at).length, total: rows.length };
}

test("editing a confirmed document: Ctrl+S asks, Escape keeps the editor dirty, keep and reset do what they say, a tag-only save never asks", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack editor ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // GET /ack: the summary for people who may edit; ?baseline=1 adds the
    // confirmed text. The admin confirms the latest version so the roster
    // has one current confirmation to keep or reset.
    const withBaseline = await api(page, `/api/documents/${docId}/ack?baseline=1`);
    expect(withBaseline.status).toBe(200);
    expect(withBaseline.body?.required).toBe(true);
    expect(withBaseline.body?.edit_default).toBe("ask");
    expect(typeof withBaseline.body?.baseline?.content, "the baseline text travels").toBe("string");
    expect(withBaseline.body?.latest_version_id, "the latest version id").toBeTruthy();
    const confirmed = await api(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: withBaseline.body.latest_version_id },
    });
    expect(confirmed.status).toBe(200);
    const before = await rosterCount(page, docId);
    expect(before.confirmed).toBeGreaterThanOrEqual(1);
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    expect(summary.body?.current).toBe(before.confirmed);
    expect(summary.body?.eligible).toBe(before.total);

    // The editor shows the count beside the status, and the change note is
    // the relabelled textarea.
    await openEditorAndType(page, docId, " Edited once.");
    const header = page.locator("h1", { hasText: "Edit document" }).locator("..");
    await expect(header.getByText(`Read confirmation · ${before.confirmed} of ${before.total}`)).toBeVisible();
    await expect(page.getByLabel("Change note")).toHaveAttribute("maxlength", "500");
    await expect(page.getByText("Saving will ask whether readers must re-confirm.")).toBeVisible();

    // Ctrl+S opens the question; Escape cancels, the editor stays dirty and
    // Save is idle (never "Saving…").
    await page.keyboard.press("Control+s");
    const dialog = page.getByRole("dialog", { name: QUESTION });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(new RegExp(`^${before.confirmed} of ${before.total} people have confirmed version \\d+ of`))
    ).toBeVisible();
    await expect(dialog.getByRole("radio", { name: EDITORIAL })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: MATERIAL })).toBeVisible();
    await expect(dialog.getByText(/^(Looks editorial|Looks material|Borderline)/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Show changes" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toContain(`/doc/${docId}/edit`);
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeEnabled();
    await expect(page.getByRole("button", { name: /Saving/ })).toHaveCount(0);

    // Keep: the button says what it does, an empty note is refused, a note
    // saves, the toast reports the outcome and the roster is untouched.
    await save.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: EDITORIAL }).check();
    const keep = dialog.getByRole("button", { name: "Save. Keep confirmations" });
    await expect(keep).toBeVisible();
    await dialog.getByLabel("Change note").fill("");
    await keep.click();
    await expect(dialog.getByRole("alert")).toHaveText(/at least 10 characters/);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Change note")).toBeFocused();
    await dialog.getByLabel("Change note").fill("Fixed a typo in the first section");
    await keep.click();
    await page.waitForURL(`**/doc/${docId}`, { timeout: 15000 });
    await expect(
      page.locator('[role="status"]').getByText("Saved as an editorial fix. Confirmations kept.")
    ).toBeVisible();
    const kept = await rosterCount(page, docId);
    expect(kept.confirmed, "a kept edit leaves the roster alone").toBe(before.confirmed);
    expect(kept.total).toBe(before.total);

    // After a kept edit the reader's confirmation cites an older version than
    // the text on screen: the card offers to re-confirm the current text.
    const again = page.getByRole("button", { name: /^Re-confirm the current text/ });
    await expect(again).toBeVisible();
    await again.click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(again).toHaveCount(0);
    expect((await rosterCount(page, docId)).confirmed).toBe(before.confirmed);

    // Reset: the primary names the people asked, the toast says so, and the
    // roster is zeroed.
    await openEditorAndType(page, docId, " The cap is now 75.");
    await page.keyboard.press("Control+s");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: MATERIAL }).check();
    const reset = dialog.getByRole("button", {
      name: new RegExp(`^Save and ask ${before.confirmed} (person|people) to re-confirm$`),
    });
    await expect(reset).toBeVisible();
    await dialog.getByLabel("Change note").fill("Expense cap raised to 75; receipts required over 20");
    await reset.click();
    await page.waitForURL(`**/doc/${docId}`, { timeout: 15000 });
    await expect(
      page
        .locator('[role="status"]')
        .getByText(new RegExp(`^Saved\\. ${before.confirmed} (person|people) will be asked to re-confirm\\.$`))
    ).toBeVisible();
    const after = await rosterCount(page, docId);
    expect(after.confirmed, "a reset zeroes the roster").toBe(0);
    expect(after.total).toBe(before.total);

    // A tag-only save never asks.
    await page.goto(`/doc/${docId}/edit`);
    await page.locator(".tiptap").first().waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.getByLabel("Tags (comma separated)").fill("e2e, read-confirmation");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(`**/doc/${docId}`, { timeout: 15000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await rosterCount(page, docId)).total).toBe(before.total);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
