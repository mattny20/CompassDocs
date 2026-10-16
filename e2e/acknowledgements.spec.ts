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
