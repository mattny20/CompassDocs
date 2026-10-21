import { test, expect, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
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

// Since 1.13.0 (E1) every enrolled person has a deadline, so the strip's one
// sentence ends " by {date}." (e2e/my-policies.spec.ts covers the cues).
const POINTER = /^Please read this document carefully\. You'll be asked to confirm at the end( by .+)?\.$/;
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
  let gateUserId: number | undefined;
  try {
    docId = await makePolicy(page, `E2E ack gate ${stamp()}`);
    const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
    if (res.status === 402) {
      expect(String(res.body?.error || "")).toContain("license");
      const post = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: 1 } });
      expect(post.status).toBe(402);
      const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
      expect(roster.status).toBe(402);
      // The 1.10.1 routes answer the same 402: the summary, the deliberate
      // re-ask (with a reason the licensed route would accept), the portal
      // and the program settings.
      expect((await api(page, `/api/documents/${docId}/ack`)).status, "GET /ack").toBe(402);
      const reconfirm = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
        method: "POST",
        body: { reason: "Section 4 now applies to contractors too" },
      });
      expect(reconfirm.status, "POST /ack/reconfirm").toBe(402);
      expect((await api(page, "/api/admin/compliance")).status, "GET /api/admin/compliance").toBe(402);
      expect((await api(page, "/api/admin/compliance/settings")).status, "GET /api/admin/compliance/settings").toBe(402);
      // The 1.12.0 routes answer the same 402 before any shape, permission
      // or state check, so the admin session is enough: the policy's
      // settings, retire and un-retire, and the person's own list.
      expect((await api(page, `/api/documents/${docId}/ack-settings`)).status, "GET /ack-settings").toBe(402);
      expect(
        (await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { signature: true } })).status,
        "PATCH /ack-settings"
      ).toBe(402);
      expect(
        (
          await api(page, `/api/documents/${docId}/ack/retire`, {
            method: "POST",
            body: { reason: "Superseded by the new expense policy" },
          })
        ).status,
        "POST /ack/retire"
      ).toBe(402);
      expect((await api(page, `/api/documents/${docId}/ack/unretire`, { method: "POST", body: {} })).status, "POST /ack/unretire").toBe(402);
      expect((await api(page, "/api/compliance/mine")).status, "GET /api/compliance/mine").toBe(402);
      // The erasure endpoint is gated the same way, so the API and the Users
      // page (which hides the button unlicensed) agree.
      const throwaway = { username: `e2e_ackgate_${stamp()}`, password: "E2eGate!12345" };
      const created = await api(page, "/api/admin/users", {
        method: "POST",
        body: { ...throwaway, role: "viewer", name: "E2E Ack Gate" },
      });
      expect(created.status, "throwaway user created").toBe(201);
      gateUserId = created.body?.user?.id;
      expect(gateUserId).toBeTruthy();
      const erase = await api(page, `/api/admin/users/${gateUserId}/anonymise-compliance`, {
        method: "POST",
        body: {},
      });
      expect(erase.status).toBe(402);
      expect(String(erase.body?.error || "")).toContain("license");
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
    if (gateUserId) await api(page, `/api/admin/users/${gateUserId}`, { method: "DELETE" });
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
    // the section, the sticky bar becomes a chip and the strip agrees. The
    // card's POST carries the self-reported latch (C3, 1.11.0): the end has
    // been on screen, so reached_end is true. It never carries a read time;
    // the server sums that from the view heartbeats.
    const [confirmPost] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/documents/${docId}/ack`)),
      card.getByRole("button", { name: CONFIRM }).click(),
    ]);
    const confirmBody = confirmPost.postDataJSON() as Record<string, unknown>;
    expect(confirmBody.reached_end, "the card reports that the end was on screen").toBe(true);
    expect(typeof confirmBody.version_id).toBe("number");
    expect("read_seconds" in confirmBody, "the client never sends a read time").toBe(false);
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Confirmation recorded" })).toBeVisible();
    await expect(card.getByText(CONFIRMED)).toBeVisible();
    // 1.14.0 (F3): the confirmed card links the reader's own record, the one
    // page every reader can open for themselves.
    await expect(card.getByRole("link", { name: "View your record" })).toHaveAttribute("href", "/compliance/person/me");
    await expect(card).toBeFocused();
    await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Document bar" }).getByText(/^Confirmed /)).toBeVisible();
    await expect(page.getByRole("link", { name: "Jump to confirmation" })).toHaveCount(0);

    // The roster counts it.
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(roster.status).toBe(200);
    const mine = (roster.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(mine?.acknowledged_at, "the admin's row is confirmed").toBeTruthy();
    expect((roster.body?.rows ?? []).filter((r: { acknowledged_at: string | null }) => r.acknowledged_at).length).toBeGreaterThanOrEqual(1);
    // The record keeps the evidence (C3): the self-reported flag as posted,
    // and a server-derived read time (the page's view was registered on
    // mount, so a whole number of seconds, possibly 0, never a client value).
    expect(mine?.reached_end, "the record keeps the self-reported flag").toBe(true);
    expect(Number.isInteger(mine?.read_seconds) && mine.read_seconds >= 0, `read_seconds is summed on the server: ${mine?.read_seconds}`).toBe(true);
    const unconfirmed = (roster.body?.rows ?? []).find((r: { acknowledged_at: string | null }) => !r.acknowledged_at);
    if (unconfirmed) {
      expect(unconfirmed.read_seconds, "a pending row has no read time").toBeNull();
      expect(unconfirmed.reached_end, "and no report").toBeNull();
    }

    // A fresh load renders the server's record, not a remembered click.
    await page.goto(`/doc/${docId}`);
    await expect(page.getByText(CONFIRMED).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Jump to confirmation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: CONFIRM })).toHaveCount(0);
    await expect(page.locator("#confirm-reading").getByRole("link", { name: "View your record" })).toHaveAttribute("href", "/compliance/person/me");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// Under sm the bar collapses to the control and the title. Two phone widths:
// the tightest common one (375) and the one most phones report (390).
for (const width of [375, 390]) {
  test(`at ${width}px the sticky bar shows the confirmation control and the title only`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 667 }, isMobile: true, hasTouch: true });
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

      // The pointer's action is full width under sm: it spans the row's
      // content box. (An absolute width cannot say this: at 375px the app
      // shell keeps the 64px rail and the page gutters, so the row itself is
      // only about 205px wide.)
      const jump = page.getByRole("link", { name: "Jump to confirmation" });
      await expect(jump).toBeVisible();
      const jumpFill = await jump.evaluate((el) => {
        const row = el.parentElement!;
        const cs = getComputedStyle(row);
        const content = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return el.getBoundingClientRect().width / content;
      });
      expect(jumpFill, "the jump link fills the row").toBeGreaterThan(0.98);

      // Scroll the masthead away: the bar carries the collapsed control and
      // the title; the toolbar and the status chip are hidden, and nothing
      // scrolls sideways.
      await page.locator("#main").evaluate((el) => el.scrollTo(0, 600));
      await page.waitForTimeout(400);
      const bar = page.getByRole("region", { name: "Document bar" });
      const control = bar.getByRole("link", { name: "Pending" });
      await expect(control).toBeVisible();
      await expect(control).toHaveAttribute("href", "#confirm-reading");
      await expect(bar.getByText(title)).toBeVisible();
      await expect(bar.getByRole("button", { name: "Edit document" })).toBeHidden();
      await expect(bar.getByText("Published", { exact: true })).toBeHidden();
      // The bar never scrolls sideways. (This belongs on #main too, but at
      // 375px the masthead's DocActions row and the Attachments header
      // overflow the page on their own, before any read-confirmation work:
      // widen the check to #main once those two rows wrap.)
      const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, "the bar does not scroll sideways").toBeLessThanOrEqual(0);

      // At the end: the card's button fills the width, and the collapsed
      // label stays one word even once the end has been on screen.
      await page.locator("#main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(400);
      const confirm = page.getByRole("button", { name: CONFIRM });
      await expect(confirm).toBeVisible();
      const confirmFill = await confirm.evaluate((el) => {
        const column = el.parentElement!; // the card's centred column
        return el.getBoundingClientRect().width / column.clientWidth;
      });
      expect(confirmFill, "the confirm button fills the card").toBeGreaterThan(0.98);
      await expect(bar.getByRole("link", { name: "Pending" })).toBeVisible();
      await expect(bar.getByRole("link", { name: "Confirm now" })).toHaveCount(0);
    } finally {
      if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
      await ctx.close();
    }
  });
}

// ── The editor (A3): the re-confirmation question on save ───────────────────
//
// A save that changes the text of a confirmed document asks how readers should
// see it, BEFORE anything is busy: Ctrl+S and Save changes both open the
// question; Escape cancels and leaves the editor dirty with Save idle; both
// choices require a change note; "keep" leaves the roster alone, "reset"
// zeroes it; a tag-only save never asks, not even after a kept edit has left
// the live text different from the confirmed version. Bulk cannot take the
// decision at all: it skips a drifted draft and says why (A2). Licensed
// builds only (see above).

const QUESTION = "How should readers see this change?";
const EDITORIAL = /^Editorial fix/;
const MATERIAL = /^Material change/;

/** Open the editor and let tiptap's markdown round-trip settle. */
async function openEditor(page: Page, docId: number) {
  await page.goto(`/doc/${docId}/edit`);
  const editor = page.locator(".tiptap").first();
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(1500);
  return editor;
}

/**
 * Click into the editor and put the caret at the very end of the document.
 * ProseMirror re-asserts its own selection 20 ms after the editor takes
 * focus (prosemirror-view's focus handler), which undoes a Control+End
 * pressed in that window and leaves the caret where the click landed; so
 * the key is pressed until no text follows the caret.
 */
async function caretToEnd(page: Page, editor: Locator) {
  await editor.click();
  await expect
    .poll(
      async () => {
        await page.keyboard.press("Control+End");
        return editor.evaluate((el) => {
          const sel = el.ownerDocument.getSelection();
          if (!sel || !sel.isCollapsed || !sel.focusNode || !el.contains(sel.focusNode)) return false;
          const after = el.ownerDocument.createRange();
          after.setStart(sel.focusNode, sel.focusOffset);
          after.setEnd(el, el.childNodes.length);
          return after.toString() === "";
        });
      },
      { message: "the caret is at the end of the document" }
    )
    .toBe(true);
}

async function openEditorAndType(page: Page, docId: number, text: string) {
  const editor = await openEditor(page, docId);
  // Into a paragraph, never a heading: a heading edit is material on its
  // own, and the typo-fix cases need an edit the measurement calls editorial.
  await editor.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

/**
 * Click Save changes and prove the question never opened: the navigation to
 * the document must win the race against the dialog. (Counting dialogs after
 * the navigation proves nothing; none can be open on the document page.)
 */
async function saveNeverAsks(page: Page, docId: number) {
  const dialog = page.getByRole("dialog", { name: QUESTION });
  await page.getByRole("button", { name: "Save changes" }).click();
  const first = await Promise.race([
    dialog.waitFor({ state: "visible", timeout: 15000 }).then(
      () => "asked" as const,
      () => "asked-timeout" as const
    ),
    page.waitForURL(`**/doc/${docId}`, { timeout: 15000 }).then(
      () => "saved" as const,
      () => "save-timeout" as const
    ),
  ]);
  expect(first, "the save went through without the question").toBe("saved");
}

/** The roster as counts: confirmed people and the audience. */
async function rosterCount(page: Page, docId: number): Promise<{ confirmed: number; total: number }> {
  const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
  expect(roster.status, "roster readable").toBe(200);
  const rows: { acknowledged_at: string | null }[] = roster.body?.rows ?? [];
  return { confirmed: rows.filter((r) => r.acknowledged_at).length, total: rows.length };
}

/** The newest audit rows (newest first) for one action on one document. */
async function auditRows(page: Page, action: string, docId: number): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(
    (r: { action: string; target_id: string | number | null }) =>
      r.action === action && Number(r.target_id) === docId
  );
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
      dialog.getByText(
        new RegExp(`^${before.confirmed} of ${before.total} (person has|people have) confirmed version \\d+ of`)
      )
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
    const keptSummary = await api(page, `/api/documents/${docId}/ack`);
    expect(keptSummary.body?.last_decision?.outcome, "the keep is a ledger row").toBe("kept");
    const keptDecisionId = keptSummary.body.last_decision.id;

    // After a kept edit the reader's confirmation cites an older version than
    // the text on screen: the card offers to re-confirm the current text.
    const again = page.getByRole("button", { name: /^Re-confirm the current text/ });
    await expect(again).toBeVisible();
    await again.click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(again).toHaveCount(0);
    expect((await rosterCount(page, docId)).confirmed).toBe(before.confirmed);

    // The live text now differs from the confirmed version, but this save
    // changes none of it: a tag-only save after a kept edit neither asks nor
    // resets. The roster is unchanged and the ledger's newest row is still
    // the keep.
    await openEditor(page, docId);
    await page.getByLabel("Tags (comma separated)").fill("e2e, kept-then-tagged");
    await saveNeverAsks(page, docId);
    const tagged = await rosterCount(page, docId);
    expect(tagged.confirmed, "a tag-only save after a kept edit resets nobody").toBe(before.confirmed);
    expect(tagged.total).toBe(before.total);
    const taggedSummary = await api(page, `/api/documents/${docId}/ack`);
    expect(taggedSummary.body?.last_decision?.id, "no new decision row").toBe(keptDecisionId);

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

    // After the reset the live text is the confirmed text again: a tag-only
    // save still never asks, and leaves the roster as the reset left it.
    await openEditor(page, docId);
    await page.getByLabel("Tags (comma separated)").fill("e2e, read-confirmation");
    await saveNeverAsks(page, docId);
    const afterTags = await rosterCount(page, docId);
    expect(afterTags.confirmed).toBe(0);
    expect(afterTags.total).toBe(before.total);

    // The API contract around the question (A2). ack_policy is 'keep' or
    // 'reset' only: the literal 'auto' is refused before any write.
    const live = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(live?.status).toBe("published");
    const refused = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${live.content}\n\nAuto is not a policy.`,
        status: "published",
        ack_policy: "auto",
        ack_reason: "ten characters or more",
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body?.error).toBe("ack_policy must be 'keep' or 'reset'.");
    const untouched = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(untouched?.content, "a refused save leaves the document untouched").toBe(live.content);
    expect(untouched?.updated_at).toBe(live.updated_at);

    // The reason is capped at the dialog's own 500 characters, whatever the
    // client sent, so the ledger and the CSV cells stay bounded.
    const capped = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${live.content}\n\nOne more editorial line.`,
        status: "published",
        ack_policy: "keep",
        ack_reason: "r".repeat(600),
        versionNote: "Capped reason check",
      },
    });
    expect(capped.status).toBe(200);
    expect(capped.body?.ack_outcome?.policy).toBe("keep");
    const cappedSummary = await api(page, `/api/documents/${docId}/ack`);
    expect(cappedSummary.body?.last_decision?.outcome).toBe("kept");
    expect(cappedSummary.body?.last_decision?.reason?.length, "the reason is capped at 500").toBe(500);

    // A no-op PUT (same title, text and tags, with the conflict token) is
    // answered with the unchanged document: "updated" does not move and no
    // document.update row claims an edit that did not happen.
    const current = (await api(page, `/api/documents/${docId}`)).body?.doc;
    const updateRowsBefore = (await auditRows(page, "document.update", docId)).length;
    const noop = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        title: current.title,
        content: current.content,
        tags: current.tags,
        base_updated_at: current.updated_at,
      },
    });
    expect(noop.status).toBe(200);
    expect(noop.body?.ack_outcome?.changed).toBe(false);
    expect(noop.body?.doc?.updated_at, "a no-op does not move 'updated'").toBe(current.updated_at);
    expect((await auditRows(page, "document.update", docId)).length, "a no-op writes no audit row").toBe(
      updateRowsBefore
    );

    // A schedule-only PUT changes nothing in the document either, but it IS
    // a write (the one PUT that bypasses the review queue), so it leaves one
    // document.update row naming the schedule.
    const archiveAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const scheduled = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        title: current.title,
        content: current.content,
        tags: current.tags,
        base_updated_at: current.updated_at,
        archive_at: archiveAt,
      },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body?.ack_outcome?.changed).toBe(false);
    const scheduleRows = await auditRows(page, "document.update", docId);
    expect(scheduleRows.length, "a schedule set is audited").toBe(updateRowsBefore + 1);
    expect(scheduleRows[0]?.details?.schedule?.archive_at).toBe(archiveAt);
    const cleared = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { archive_at: null } });
    expect(cleared.status).toBe(200);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

const BULK_SKIP_REASON = "requires a re-confirmation decision; publish it individually";

test("bulk publish skips a drifted draft that requires confirmation, and publishes an unchanged one", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E ack bulk ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    const confirmed = await api(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: summary.body?.latest_version_id },
    });
    expect(confirmed.status).toBe(200);
    const before = await rosterCount(page, docId);
    expect(before.confirmed).toBeGreaterThanOrEqual(1);

    // Unpublish, then change the text as a draft: the decision waits for the
    // publish, so nothing is asked yet and the roster is untouched.
    const unpublished = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "draft" } });
    expect(unpublished.status).toBe(200);
    expect(unpublished.body?.doc?.status).toBe("draft");
    const drifted = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: `${BODY}\n\nThe cap is now 75.`, versionNote: "Draft edit before a bulk publish" },
    });
    expect(drifted.status).toBe(200);
    expect(drifted.body?.ack_outcome?.reset, "a draft edit decides nothing").toBe(false);
    expect((await rosterCount(page, docId)).confirmed).toBe(before.confirmed);

    // Bulk cannot take the decision for the editor: the document is skipped
    // with the exact reason, stays a draft, and nobody is reset.
    const skipped = await api(page, "/api/documents/bulk", {
      method: "POST",
      body: { action: "status", status: "published", ids: [docId] },
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body?.updated).toBe(0);
    expect(skipped.body?.skipped).toEqual([{ id: docId, title, reason: BULK_SKIP_REASON }]);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.status).toBe("draft");
    expect((await rosterCount(page, docId)).confirmed).toBe(before.confirmed);

    // With the confirmed text back there is nothing to decide: bulk publishes
    // it, and republishing the text people confirmed asks nobody again.
    const restored = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: { content: BODY, versionNote: "Back to the confirmed text" },
    });
    expect(restored.status).toBe(200);
    const published = await api(page, "/api/documents/bulk", {
      method: "POST",
      body: { action: "status", status: "published", ids: [docId] },
    });
    expect(published.status).toBe(200);
    expect(published.body?.updated).toBe(1);
    expect(published.body?.skipped).toEqual([]);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.status).toBe("published");
    const after = await rosterCount(page, docId);
    expect(after.confirmed, "republishing the confirmed text asks nobody again").toBe(before.confirmed);
    expect(after.total).toBe(before.total);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// ── The shield popover (A5, 1.10.1) ─────────────────────────────────────────
//
// The shield in the document's action row opens the Read confirmation
// popover: the "Require readers to confirm" switch, the status line with
// "View record", the "When the text changes" select and the re-ask button.
// Switching on asks first (the shared question) and Cancel leaves the switch
// off; "Require quietly" switches on and tells nobody; switching off tells
// with Undo; the select changes what the editor does on the next text save.
// Licensed builds only (see above).

const SHIELD = "Read confirmation settings";
const SWITCH = "Require readers to confirm";
const EDIT_DEFAULT = "When the text changes";

/** GET /ack answers 402 on the community build; the admin reads it otherwise. */
async function ackLicensed(page: Page, docId: number): Promise<boolean> {
  const res = await api(page, `/api/documents/${docId}/ack`);
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the summary").toBe(200);
  return true;
}

async function ackRequiredFlag(page: Page, docId: number): Promise<number> {
  const res = await api(page, `/api/documents/${docId}`);
  expect(res.status).toBe(200);
  return Number(res.body?.doc?.ack_required);
}

test("the shield popover: switching on asks first and Cancel leaves it off; Require quietly tells nobody; the edit default saves; switching off tells, with Undo", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack popover ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await ackLicensed(page, docId)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);

    // The shield is a popup trigger with the house tooltip and name; the
    // panel holds the four controls under its heading.
    const shield = page.getByRole("button", { name: SHIELD }).first();
    await expect(shield).toHaveAttribute("aria-haspopup", "dialog");
    await expect(shield).toHaveAttribute("aria-expanded", "false");
    await shield.click();
    const panel = page.getByRole("dialog", { name: "Read confirmation" });
    await expect(panel).toBeVisible();
    await expect(shield).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
    const toggle = panel.getByRole("switch", { name: SWITCH });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const select = panel.getByLabel(EDIT_DEFAULT);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("ask");
    await expect(select.locator("option", { hasText: "(workspace default)" })).toHaveCount(1);
    await expect(panel.getByRole("link", { name: "View record" })).toHaveCount(0);

    // Switching on asks first: the shared question with the audience count
    // and three answers. Cancel sends nothing and leaves the switch off and
    // idle; the popover stays open.
    await toggle.click();
    const question = page.getByRole("dialog", { name: "Require read confirmation?" });
    await expect(question).toBeVisible();
    await expect(
      question.getByText(/^Everyone who can see this space \(\d+ (person|people)\) will be asked to read and confirm this document\.$/)
    ).toBeVisible();
    await expect(question.getByRole("button", { name: "Require and notify" })).toBeVisible();
    await expect(question.getByRole("button", { name: "Require quietly" })).toBeVisible();
    await question.getByRole("button", { name: "Cancel" }).click();
    await expect(question).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    expect(await ackRequiredFlag(page, docId), "Cancel leaves the requirement off").toBe(0);
    expect((await auditRows(page, "document.ack_required", docId)).length, "Cancel writes no audit row").toBe(0);

    // Require quietly: the switch flips only on the answer, the status line
    // says nobody was told, the record link appears, the audit row says
    // notify: false.
    await toggle.click();
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Require quietly" }).click();
    await expect(page.locator('[role="status"]').getByText("Read confirmation required. No notice sent.")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByText(/^Required .+ by .+ \(no notice sent\)/)).toBeVisible();
    await expect(panel.getByRole("link", { name: "View record" })).toHaveAttribute(
      "href",
      `/doc/${docId}/acknowledgements`
    );
    expect(await ackRequiredFlag(page, docId)).toBe(1);
    const quiet = await auditRows(page, "document.ack_required", docId);
    expect(quiet.length).toBe(1);
    expect(quiet[0].details?.notify).toBe(false);
    expect(typeof quiet[0].details?.eligible).toBe("number");
    expect(quiet[0].details?.queued).toBe(0);
    // Nobody was told, so Remind is not blocked (the quiet path stamps no cooldown).
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.body?.required).toBe(true);
    expect(summary.body?.workspace_edit_default, "the workspace value travels").toBeTruthy();
    expect(typeof summary.body?.keep_reason_required).toBe("boolean");

    // The edit default: the select saves on change and the audit row
    // carries the move.
    await select.selectOption("reset");
    await expect(page.locator('[role="status"]').getByText("Setting saved.")).toBeVisible();
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.edit_default).toBe("reset");
    const changed = await auditRows(page, "ack.edit_default_set", docId);
    expect(changed.length).toBe(1);
    expect(changed[0].details?.from).toBe("ask");
    expect(changed[0].details?.to).toBe("reset");

    // Switching off is reversible: no question, a toast with Undo, the
    // record kept, the audit row carrying the standing; Undo re-requires
    // quietly.
    await toggle.click();
    const stopped = page.locator('[role="status"]').getByText("Read confirmation no longer required for this document");
    await expect(stopped).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await ackRequiredFlag(page, docId)).toBe(0);
    const removed = await auditRows(page, "document.ack_removed", docId);
    expect(removed.length).toBe(1);
    expect(typeof removed[0].details?.acked).toBe("number");
    expect(removed[0].details?.required).toBeGreaterThanOrEqual(1);
    await page.locator('[role="status"]').getByRole("button", { name: "Undo" }).click();
    await expect(
      page.locator('[role="status"]').getByText("Read confirmation required again. No notice sent.")
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await ackRequiredFlag(page, docId)).toBe(1);
    const undone = await auditRows(page, "document.ack_required", docId);
    expect(undone.length, "the undo is on the record").toBe(2);
    expect(undone[0].details?.notify, "and it sent nothing").toBe(false);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.edit_default, "the document's own choice survives the toggle").toBe("reset");

    // Escape closes the popover and hands focus back to the shield.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(shield).toHaveAttribute("aria-expanded", "false");

    // Reopened, the server's sentence takes over, and because nobody has
    // been told it says so instead of naming a day on which nobody was asked.
    await shield.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/^0 of \d+ confirmed · (v\d+|current version) · no notice sent yet/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // The API contract: a body with no known field, or a wrong type, is 400.
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: {} })).status).toBe(400);
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: "yes" } })).status).toBe(400);
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { edit_default: "never" } })).status).toBe(400);
    const both = await api(page, `/api/documents/${docId}/ack`, {
      method: "PATCH",
      body: { required: true, edit_default: "material" },
    });
    expect(both.status).toBe(200);
    expect(both.body?.ack_required).toBe(true);
    expect(both.body?.edit_default).toBe("material");
    expect(both.body?.queued, "already on: nothing queued").toBe(0);
    // The no-op is not on the record: the switch-on and the undo wrote the
    // two document.ack_required rows, and re-requiring what is already
    // required writes no third.
    expect((await auditRows(page, "document.ack_required", docId)).length, "a no-op writes no audit row").toBe(2);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("the edit default changes the editor's behaviour: 'reset' never asks and needs the note; 'material' keeps a typo fix quietly and asks for a number change", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const title = `E2E ack edit default ${stamp()}`;
  let docId: number | undefined;
  // The workspace's "Require a reason for editorial fixes too", restored in
  // finally: the setting is shared by every test on the rig.
  let keepReasonBefore: boolean | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    const confirmLatest = async () => {
      const s = await api(page, `/api/documents/${docId}/ack`);
      expect(s.status).toBe(200);
      const r = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: s.body.latest_version_id } });
      expect(r.status).toBe(200);
    };
    await confirmLatest();
    const before = await rosterCount(page, docId);
    expect(before.confirmed).toBeGreaterThanOrEqual(1);

    // 'reset': the change-note help says so; a save with no note stops at
    // the field; with a note it saves without a question and asks everyone.
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { edit_default: "reset" } })).status).toBe(200);
    await openEditorAndType(page, docId, " Edited under reset.");
    await expect(page.getByText("Every change to the text asks everyone to re-confirm, so a change note is required.")).toBeVisible();
    const dialog = page.getByRole("dialog", { name: QUESTION });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /at least 10 characters/ })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toContain(`/doc/${docId}/edit`);
    await expect(page.getByLabel("Change note")).toBeFocused();
    await page.getByLabel("Change note").fill("Cap raised; everyone must read the new figure");
    await saveNeverAsks(page, docId);
    await expect(
      page
        .locator('[role="status"]')
        .getByText(new RegExp(`^Saved\\. ${before.confirmed} (person|people) will be asked to re-confirm\\.$`))
    ).toBeVisible();
    const afterReset = await rosterCount(page, docId);
    expect(afterReset.confirmed, "everyone was asked again").toBe(0);
    const resetSummary = await api(page, `/api/documents/${docId}/ack`);
    expect(resetSummary.body?.last_decision?.outcome).toBe("reset");
    expect(resetSummary.body?.last_decision?.source).toBe("edit");
    expect(resetSummary.body?.last_decision?.reason).toBe("Cap raised; everyone must read the new figure");

    // 'material': a one-word fix in a long text looks editorial, so it is
    // saved unasked as an editorial fix and recorded from the document's
    // setting; a changed number opens the question with the setting's note.
    await confirmLatest();
    const confirmed = (await rosterCount(page, docId)).confirmed;
    expect(confirmed).toBeGreaterThanOrEqual(1);
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { edit_default: "material" } })).status).toBe(200);
    await openEditorAndType(page, docId, " Done.");
    await expect(page.getByText(/only when the change looks material/)).toBeVisible();
    await saveNeverAsks(page, docId);
    await expect(
      page.locator('[role="status"]').getByText("Saved as an editorial fix (document setting). Confirmations kept.")
    ).toBeVisible();
    expect((await rosterCount(page, docId)).confirmed, "kept").toBe(confirmed);
    const keptSummary = await api(page, `/api/documents/${docId}/ack`);
    expect(keptSummary.body?.last_decision?.outcome).toBe("kept");
    expect(keptSummary.body?.last_decision?.source, "the setting decided").toBe("default");

    await openEditorAndType(page, docId, " The cap is now 75.");
    await page.keyboard.press("Control+s");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: MATERIAL })).toBeChecked();
    await expect(
      dialog.getByText("This document asks only when a change looks material (its read confirmation setting).")
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect((await rosterCount(page, docId)).confirmed, "Cancel changes nothing").toBe(confirmed);

    // The keep side's reason rule follows the workspace setting (E4) through
    // PUT /api/documents/{id}: with "Require a reason for editorial fixes
    // too" off, a keep saves with a four-character note; a reset with the
    // same note is still refused before any write.
    const settingsBefore = await api(page, "/api/admin/compliance/settings");
    expect(settingsBefore.status, "program settings readable").toBe(200);
    keepReasonBefore = Boolean(settingsBefore.body?.settings?.ack_defaults?.keep_reason_required);
    const relaxed = await api(page, "/api/admin/compliance/settings", {
      method: "PUT",
      body: { ack_defaults: { keep_reason_required: false } },
    });
    expect(relaxed.status).toBe(200);
    expect(relaxed.body?.settings?.ack_defaults?.keep_reason_required).toBe(false);
    const live = (await api(page, `/api/documents/${docId}`)).body?.doc;
    const keptShort = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${live.content}\n\nOne more editorial line.`,
        status: "published",
        ack_policy: "keep",
        ack_reason: "typo",
        versionNote: "Keep with a short note",
      },
    });
    expect(keptShort.status, "a keep needs no long note when the workspace excuses editorial fixes").toBe(200);
    expect(keptShort.body?.ack_outcome?.policy).toBe("keep");
    expect((await rosterCount(page, docId)).confirmed, "kept").toBe(confirmed);
    const resetShort = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${live.content}\n\nAnother line, a reset this time.`,
        status: "published",
        ack_policy: "reset",
        ack_reason: "typo",
      },
    });
    expect(resetShort.status, "a reset always needs its note").toBe(400);
    expect(resetShort.body?.error).toMatch(/at least 10 characters/);
    expect((await rosterCount(page, docId)).confirmed, "a refused reset changes nothing").toBe(confirmed);
  } finally {
    if (keepReasonBefore !== undefined) {
      await api(page, "/api/admin/compliance/settings", {
        method: "PUT",
        body: { ack_defaults: { keep_reason_required: keepReasonBefore } },
      });
    }
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("API: a no-op merge still records the branch, and GET /ack on a draft follows the draft rule", async ({
  page,
  browser,
}) => {
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E ack api ${suffix}`;
  const reader = { username: `e2e_ackdraft_${suffix}`, password: "E2eDraft!12345" };
  let docId: number | undefined;
  let branchId: number | undefined;
  let userId: number | undefined;
  let roleId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // A branch merged with its text unchanged has nothing to merge: the
    // source comes back unchanged (no version, no decision), but the branch
    // still moves to the Trash and that lifecycle is on the audit record.
    const branched = await api(page, `/api/documents/${docId}/branch`, { method: "POST" });
    expect(branched.status, "branch created").toBe(200);
    branchId = branched.body?.branch?.id;
    expect(branchId).toBeTruthy();
    const merged = await api(page, `/api/documents/${branchId}/merge`, { method: "POST", body: {} });
    expect(merged.status).toBe(200);
    expect(merged.body?.ack_outcome?.changed, "nothing to merge").toBe(false);
    expect((await api(page, `/api/documents/${branchId}`)).status, "the branch left the live set").toBe(404);
    const mergeRows = await auditRows(page, "document.branch_merge", docId);
    expect(mergeRows[0]?.details, "the merge is on the record, marked as a no-op").toEqual({
      branchId,
      changed: false,
      ack_policy: null,
      confirmations_reset: 0,
    });
    // Purging it proves it went to the Trash (and cleans it up).
    const purged = await api(page, `/api/trash/${branchId}`, { method: "DELETE" });
    expect(purged.status, "the branch was in the Trash").toBe(200);
    branchId = undefined;

    // GET /ack hides a draft from anyone who may not read drafts, exactly as
    // GET /api/documents/{id} does: a custom role holding document.update
    // but not document.read_draft is answered 404; the admin reads it.
    const unpublished = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "draft" } });
    expect(unpublished.status).toBe(200);
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...reader, role: "viewer", name: "E2E Draft Reader" },
    });
    expect(created.status, "reader created").toBe(201);
    userId = created.body?.user?.id;
    expect(userId).toBeTruthy();
    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: {
        name: `E2E Ack Editor ${suffix}`,
        description: "Edits documents but may not see drafts",
        permissions: ["document.update"],
      },
    });
    expect(role.status, "custom role created").toBe(201);
    roleId = role.body?.id;
    expect(roleId).toBeTruthy();
    const assigned = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: roleId, user_id: userId },
    });
    expect(assigned.status, "role assigned").toBe(201);
    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);
      const hidden = await api(rpage, `/api/documents/${docId}/ack`);
      expect(hidden.status, "a draft is hidden from someone who may not read drafts").toBe(404);
    } finally {
      await rctx.close();
    }
    expect((await api(page, `/api/documents/${docId}/ack`)).status, "the admin still reads the draft's summary").toBe(200);

    // Republishing the unchanged text decides nothing.
    const republished = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "published" } });
    expect(republished.status).toBe(200);
    expect(republished.body?.ack_outcome?.reset, "republishing unchanged text asks nobody").toBe(false);
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (userId) await api(page, `/api/admin/users/${userId}`, { method: "DELETE" });
    if (branchId) await api(page, `/api/trash/${branchId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// ── What changed since you confirmed (B3, 1.11.0) ───────────────────────────
//
// A re-confirmation never looks like a first request. After a material
// change the strip says the document changed since the reader confirmed it
// (with the day), the sticky control reads "Re-confirm needed", and the card
// carries the change note above the statement plus a disclosure listing the
// versions since the confirmed one, the rendered diff against it with a
// "+n / −n lines" header, and a link that opens the same compare in version
// history. A manual re-ask with no text change shows the manager's reason
// and no disclosure: nothing changed to show. Licensed builds only (see
// above).

const CHANGED_SINCE = /^This document changed since you confirmed it on .+\. Please read the changes and confirm again( by .+)?\.$/;
const ASKED_AGAIN = /^Everyone was asked to confirm this document again on .+\. Please read it and confirm again( by .+)?\.$/;
const ASKED_YOU = /^.+ asked you to confirm this document again on .+\. Please read it and confirm again( by .+)?\.$/;

/** Confirm the newest version through the API; returns that version's id. */
async function confirmLatestVersion(page: Page, docId: number): Promise<number> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status, "summary readable").toBe(200);
  const versionId = summary.body?.latest_version_id;
  expect(versionId, "the latest version id").toBeTruthy();
  const confirmed = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: versionId } });
  expect(confirmed.status, "confirmed").toBe(200);
  return versionId;
}

test("re-confirmation after a material change: the strip names the day, the sticky control says re-confirm, the card shows the note, the diff and the history compare", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack since ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    const v1 = await confirmLatestVersion(page, docId);
    expect((await rosterCount(page, docId)).confirmed).toBe(1);

    // A material change with the decision taken through the API: the
    // confirmation lapses and the ledger keeps the note.
    const NOTE = "Expense cap raised to 75; receipts required over 20";
    const edited = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${BODY}\n\nThe cap is now 75.`,
        status: "published",
        ack_policy: "reset",
        ack_reason: NOTE,
        versionNote: NOTE,
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body?.ack_outcome?.reset, "everyone was asked again").toBe(true);
    expect((await rosterCount(page, docId)).confirmed).toBe(0);

    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);

    // The strip: one sentence naming the day, the same one action; the
    // first-request sentence is gone.
    await expect(page.getByText(CHANGED_SINCE)).toBeVisible();
    await expect(page.getByText(POINTER)).toHaveCount(0);
    const jump = page.getByRole("link", { name: "Jump to confirmation" });
    await expect(jump).toBeVisible();
    await expect(jump).toHaveAttribute("href", "#confirm-reading");

    // The sticky control, before the end has been on screen: still a jump
    // link, with the re-confirmation label.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, 600));
    await page.waitForTimeout(400);
    const sticky = page.getByRole("link", { name: "Re-confirm needed" });
    await expect(sticky).toBeVisible();
    await expect(sticky).toHaveAttribute("href", "#confirm-reading");
    await expect(page.getByRole("link", { name: "Confirmation pending" })).toHaveCount(0);

    // The card: the change note above the statement, then the disclosure
    // with the version since, the diff header, the added text and the link.
    const card = page.locator("#confirm-reading");
    await expect(card.getByRole("heading", { name: "Confirm you've read this document" })).toBeVisible();
    await expect(card.getByText(new RegExp(`^Updated .+ by .+: "${NOTE}"$`))).toBeVisible();
    await expect(card.getByText(STATEMENT)).toBeVisible();
    const details = card.locator("details");
    await expect(details).toHaveCount(1);
    const disclosure = details.locator("summary");
    await expect(disclosure).toHaveText("What changed since you last confirmed (1 version)");
    await disclosure.click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText(/^Compared with version 1, which you confirmed on /)).toBeVisible();
    await expect(details.getByText("v2", { exact: true })).toBeVisible();
    await expect(details.getByText(NOTE, { exact: true })).toBeVisible();
    await expect(details.getByText(/^\+\d+ \/ −\d+ lines$/)).toBeVisible();
    // The added paragraph renders inside the card's diff (the article shows
    // it too, so the check stays inside the disclosure).
    await expect(details.getByText("The cap is now 75.")).toBeVisible();
    const open = details.getByRole("link", { name: "Open in version history" });
    await expect(open).toHaveAttribute("href", `/doc/${docId}/history?from=${v1}&to=current`);

    // The link opens the same compare: the confirmed version against the
    // current one, both radios already set.
    await open.click();
    await page.waitForURL(`**/doc/${docId}/history?from=${v1}&to=current`);
    await expect(page.getByText(/Original v1 → modified v2/)).toBeVisible();
    await expect(page.getByRole("radio", { name: "Original: version 1" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Modified: version 2" })).toBeChecked();

    // Back on the document, confirming records version 2 and the three
    // surfaces agree again.
    await page.goto(`/doc/${docId}`);
    await expect(page.getByText(CHANGED_SINCE)).toBeVisible();
    await card.getByRole("button", { name: CONFIRM }).click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByText(/^You confirmed version 2 on /)).toBeVisible();
    await expect(page.getByText(CHANGED_SINCE)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Re-confirm needed" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Document bar" }).getByText(/^Confirmed /)).toBeVisible();
    expect((await rosterCount(page, docId)).confirmed).toBe(1);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a manual re-ask with no text change: the reason line, an honest strip sentence and no disclosure", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack manual ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    await confirmLatestVersion(page, docId);
    expect((await rosterCount(page, docId)).confirmed).toBe(1);

    // Ask everyone to re-confirm without editing (A7): no version is
    // written, the confirmation lapses, the reason is on the ledger.
    const REASON = "Section 4 now applies to contractors too";
    const asked = await api(page, `/api/documents/${docId}/ack/reconfirm`, { method: "POST", body: { reason: REASON } });
    expect(asked.status, "the re-ask was accepted").toBe(200);
    expect(asked.body?.ok).toBe(true);
    expect((await rosterCount(page, docId)).confirmed).toBe(0);

    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);

    // The strip does not claim the document changed: it says who asked.
    await expect(page.getByText(ASKED_AGAIN)).toBeVisible();
    await expect(page.getByText(CHANGED_SINCE)).toHaveCount(0);
    await expect(page.getByText(POINTER)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jump to confirmation" })).toBeVisible();

    // The card: the manager's reason in place of the disclosure, the
    // statement under it, no diff and no history link.
    const card = page.locator("#confirm-reading");
    await expect(card.getByText(new RegExp(`^.+ asked everyone to confirm this document again on .+: "${REASON}"$`))).toBeVisible();
    await expect(card.getByText(STATEMENT)).toBeVisible();
    await expect(card.locator("details")).toHaveCount(0);
    await expect(card.getByRole("link", { name: "Open in version history" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: CONFIRM })).toBeEnabled();

    // The sticky control still says a re-confirmation is needed.
    await page.locator("#main").evaluate((el) => el.scrollTo(0, 600));
    await page.waitForTimeout(400);
    await expect(page.getByRole("link", { name: "Re-confirm needed" })).toBeVisible();

    // Confirming records the same version again; the ledger keeps both rows.
    await card.getByRole("button", { name: CONFIRM }).click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByText(/^You confirmed version 1 on /)).toBeVisible();
    await expect(page.getByText(ASKED_AGAIN)).toHaveCount(0);
    expect((await rosterCount(page, docId)).confirmed).toBe(1);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.13.0 (D4): a per-person re-ask lapses one person's confirmation and
// leaves the document marker alone, so the page tells each reader their own
// story: the person asked reads who asked them and why; someone lapsed by an
// earlier whole-audience ask reads that one, never the other person's reason.
test("a per-person re-ask: the person asked reads their own reason on the strip and the card; someone lapsed by the earlier whole-audience ask reads that one", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E ack per-person ${suffix}`;
  const viewer = { username: `e2e_reask_${suffix}`, password: "E2eReask!12345" };
  let docId: number | undefined;
  let viewerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    // A viewer created after the switch-on is enrolled on arrival (D1).
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...viewer, role: "viewer", name: "E2E Re-ask Viewer" },
    });
    expect(created.status, "viewer created").toBe(201);
    viewerId = created.body?.user?.id;
    expect(viewerId).toBeTruthy();

    const ctx = await browser.newContext();
    try {
      const vpage = await ctx.newPage();
      await login(vpage, viewer);

      // Both confirm; then everyone is asked again (A7) and both lapse.
      const versionId = await confirmLatestVersion(page, docId);
      const confirmAs = async (as: Page) => {
        const r = await api(as, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: versionId } });
        expect(r.status, "confirmed").toBe(200);
      };
      await confirmAs(vpage);
      expect((await rosterCount(page, docId)).confirmed).toBe(2);
      const ALL = "Section 4 now applies to contractors too";
      const everyone = await api(page, `/api/documents/${docId}/ack/reconfirm`, { method: "POST", body: { reason: ALL } });
      expect(everyone.status, "everyone asked").toBe(200);
      expect((await rosterCount(page, docId)).confirmed).toBe(0);

      // The viewer confirms again; then the viewer alone is asked again (D4).
      await confirmAs(vpage);
      expect((await rosterCount(page, docId)).confirmed).toBe(1);
      const ONE = "Your confirmation took three seconds; please read it properly";
      const one = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
        method: "POST",
        body: { reason: ONE, user_ids: [viewerId] },
      });
      expect(one.status, "one person asked").toBe(200);
      expect(one.body?.user_ids).toEqual([viewerId]);
      expect(one.body?.skipped).toEqual([]);
      expect((await rosterCount(page, docId)).confirmed).toBe(0);

      // The viewer: their own sentence on the strip, the asker's reason on
      // the card, no disclosure (nothing changed to show), the sticky link.
      await vpage.goto(`/doc/${docId}`);
      await expect(vpage.locator("h1")).toContainText(title);
      await expect(vpage.getByText(ASKED_YOU)).toBeVisible();
      await expect(vpage.getByText(ASKED_AGAIN)).toHaveCount(0);
      const vcard = vpage.locator("#confirm-reading");
      await expect(vcard.getByText(new RegExp(`^.+ asked you to confirm this document again on .+: "${ONE}"$`))).toBeVisible();
      await expect(vcard.locator("details")).toHaveCount(0);
      await vpage.locator("#main").evaluate((el) => el.scrollTo(0, 600));
      await vpage.waitForTimeout(400);
      await expect(vpage.getByRole("link", { name: "Re-confirm needed" })).toBeVisible();

      // The admin, lapsed by the whole-audience ask: that sentence and that
      // reason, and nothing of the viewer's.
      await page.goto(`/doc/${docId}`);
      await expect(page.getByText(ASKED_AGAIN)).toBeVisible();
      await expect(page.getByText(ASKED_YOU)).toHaveCount(0);
      const card = page.locator("#confirm-reading");
      await expect(card.getByText(new RegExp(`^.+ asked everyone to confirm this document again on .+: "${ALL}"$`))).toBeVisible();
      await expect(card.getByText(ONE)).toHaveCount(0);

      // The viewer confirms the same version again: current, and the
      // ledger keeps every row.
      await vcard.getByRole("button", { name: CONFIRM }).click();
      await expect(vpage.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
      await expect(vcard.getByText(/^You confirmed version 1 on /)).toBeVisible();
      await expect(vpage.getByText(ASKED_YOU)).toHaveCount(0);
      expect((await rosterCount(page, docId)).confirmed).toBe(1);
    } finally {
      await ctx.close();
    }
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (viewerId) await api(page, `/api/admin/users/${viewerId}`, { method: "DELETE" });
  }
});

// 1.11.0 (H2): the schedule hint. Arming "Publish automatically at" on a
// draft that requires read confirmation, whose text differs from the version
// people confirmed, says now what the scheduler will do when it fires (nobody
// is there to be asked then): everyone is asked again, or, under the
// document's 'material' setting, an editorial-looking change is kept. The
// hint goes when the text equals the confirmed version again.
test("the schedule hint says what publishing on schedule will do to confirmations", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack schedule hint ${stamp()}`;
  const PUBLISH_AT = "2030-01-01T09:00";
  const SCHEDULE_FIELD = "Publish automatically at (optional)";
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    await confirmLatestVersion(page, docId);
    expect((await rosterCount(page, docId)).confirmed).toBe(1);
    // Taken down as a draft (a status change alone asks nothing and writes
    // no version), so the editor shows the schedule field.
    const down = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "draft" } });
    expect(down.status).toBe(200);
    expect(down.body?.doc?.status).toBe("draft");

    // A change plus a time: the ask variant, naming the people and the version.
    // Typed at the very end of the document (caretToEnd), so the same keys
    // can take it out again: End alone stops at the end of a wrapped line.
    const editor = await openEditor(page, docId);
    await caretToEnd(page, editor);
    await page.keyboard.type(" Done.");
    await page.getByLabel(SCHEDULE_FIELD).fill(PUBLISH_AT);
    await expect(
      page.getByText(/^Publishing on schedule will ask 1 person to re-confirm: the text changed since version 1\.$/)
    ).toBeVisible();

    // The change undone: the text equals the confirmed version again, and
    // the hint goes (the time is still set).
    await caretToEnd(page, editor);
    for (let i = 0; i < " Done.".length; i++) await page.keyboard.press("Backspace");
    await expect(page.getByText(/^Publishing on schedule/)).toHaveCount(0);
    await expect(page.getByLabel(SCHEDULE_FIELD)).toHaveValue(PUBLISH_AT);

    // Under 'material' an editorial-looking change is kept, and the hint
    // says so. The editor reads the setting and the confirmed text once per
    // session, so it is reopened (the leave guard is answered).
    expect((await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { edit_default: "material" } })).status).toBe(200);
    page.once("dialog", (d) => void d.accept());
    await openEditorAndType(page, docId, " Done.");
    await page.getByLabel(SCHEDULE_FIELD).fill(PUBLISH_AT);
    await expect(
      page.getByText("Publishing on schedule will keep confirmations: the change since version 1 looks editorial (document setting).")
    ).toBeVisible();
    await expect(page.getByText(/will ask .* to re-confirm/)).toHaveCount(0);
    // Nothing was published or decided by looking.
    expect((await rosterCount(page, docId)).confirmed).toBe(1);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.status).toBe("draft");
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.11.0 (H2): the admin import page. A published document that requires
// read confirmation is never overwritten by accident: with the box off it is
// left unchanged and listed by name, while an ordinary document in the same
// zip is updated; with the box on it is overwritten and its edit default
// decides (under the recommended default everyone is asked again).
test("importing a zip leaves a confirmed policy unchanged unless the box is ticked, then asks its readers again", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const policyTitle = `E2E import policy ${stamp()}`;
  const plainTitle = `E2E import plain ${stamp()}`;
  const IMPORTED_POLICY = `${BODY}\n\nImported paragraph.`;
  const IMPORTED_PLAIN = "Plain text, imported.";
  let docId: number | undefined;
  let plainId: number | undefined;
  try {
    docId = await makePolicy(page, policyTitle);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    await confirmLatestVersion(page, docId);
    expect((await rosterCount(page, docId)).confirmed).toBe(1);
    const plain = await api(page, "/api/documents", {
      method: "POST",
      body: { space_id: 1, title: plainTitle, type: "knowledge", status: "published", content: "Plain text.", tags: [] },
    });
    expect(plain.status, "plain document created").toBe(201);
    plainId = plain.body?.doc?.id;
    const spaces = await api(page, "/api/admin/spaces");
    const spaceSlug: string | undefined = (spaces.body?.spaces ?? []).find((s: { id: number }) => s.id === 1)?.slug;
    expect(spaceSlug, "the space's slug").toBeTruthy();

    // The zip: both documents by title in the same space, each with a changed
    // text (documents are matched by space and title slug).
    const md = (t: string, type: string, body: string) =>
      `---\ntitle: ${JSON.stringify(t)}\ntype: ${type}\nstatus: published\nspace: ${spaceSlug}\n---\n${body}`;
    const zip = new JSZip();
    zip.file(`documents/${spaceSlug}/policy.md`, md(policyTitle, "policy", IMPORTED_POLICY));
    zip.file(`documents/${spaceSlug}/plain.md`, md(plainTitle, "knowledge", IMPORTED_PLAIN));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    await page.goto("/admin/data");
    await expect(page.getByRole("heading", { name: "Backup & transfer" })).toBeVisible();
    const box = page.getByRole("checkbox", { name: /^Also overwrite documents that require read confirmation/ });
    await expect(box, "off by default").not.toBeChecked();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "e2e-import.zip", mimeType: "application/zip", buffer });
    await page.getByRole("button", { name: "Import", exact: true }).click();

    // Box off: the policy is left unchanged and named; the plain document is updated.
    await expect(page.getByText("1 policy that requires read confirmation was left unchanged.")).toBeVisible();
    await expect(page.getByText(/will ask people to re-confirm/)).toHaveCount(0);
    await page.locator("summary", { hasText: /warning/ }).click();
    const listed = page.locator("li", { hasText: policyTitle });
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText("requires read confirmation and was left unchanged");
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content, "the policy is untouched").toBe(BODY);
    expect((await api(page, `/api/documents/${plainId}`)).body?.doc?.content?.trim(), "the plain document was updated").toBe(IMPORTED_PLAIN);
    expect((await rosterCount(page, docId)).confirmed, "the confirmation stands").toBe(1);

    // Box on: the policy is overwritten and, under the recommended default,
    // its readers are asked again; the row is from source "import".
    await box.check();
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("1 policy will ask people to re-confirm.")).toBeVisible();
    await expect(page.getByText(/(was|were) left unchanged\./)).toHaveCount(0);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.content?.trim()).toBe(IMPORTED_POLICY);
    expect((await rosterCount(page, docId)).confirmed, "the confirmation lapsed").toBe(0);
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.body?.last_decision?.outcome).toBe("reset");
    expect(summary.body?.last_decision?.source).toBe("import");
  } finally {
    if (plainId) await api(page, `/api/documents/${plainId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.12.0 (C2): a policy's own confirmation statement and the typed
// signature. The settings route validates and answers what the document
// holds; the card renders the statement and, when a signature is required,
// the Sign to confirm block gates the button until the typed name matches;
// the record keeps the name and how the signer was identified; the
// Settings tab shows the same two settings.
test("a policy with a typed signature: the button waits for the name, the record keeps it, and a per-document statement shows on the card and the Settings tab", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E ack signature ${stamp()}`;
  const custom = "I have read this document and will comply with it.";
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // The settings route: the defaults, then the validation, then the two
    // settings set through PATCH.
    const before = await api(page, `/api/documents/${docId}/ack-settings`);
    expect(before.status).toBe(200);
    expect(before.body?.statement).toBeNull();
    expect(before.body?.signature).toBe(false);
    expect(before.body?.statement_default).toBe(STATEMENT);
    expect((await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { signature: "yes" } })).status).toBe(400);
    expect((await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { statement: "x".repeat(501) } })).status).toBe(400);
    const set = await api(page, `/api/documents/${docId}/ack-settings`, {
      method: "PATCH",
      body: { statement: custom, signature: true },
    });
    expect(set.status, "statement and signature saved").toBe(200);
    expect(set.body?.statement).toBe(custom);
    expect(set.body?.signature).toBe(true);

    // The card: the policy's own statement (not the workspace default), the
    // Sign to confirm block, and a button that waits for the name.
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);
    const card = page.locator("#confirm-reading");
    await expect(card.getByText(custom)).toBeVisible();
    await expect(card.getByText(STATEMENT)).toHaveCount(0);
    await expect(card.getByRole("heading", { name: "Sign to confirm" })).toBeVisible();
    const button = card.getByRole("button", { name: CONFIRM });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(card.getByText("Sign above to confirm")).toBeVisible();
    // The help names the account's own name: the name the signature must match.
    const help = (await card.getByText(/^Exactly as it appears on your account: /).textContent()) ?? "";
    const expected = help.replace(/^Exactly as it appears on your account: /, "").trim();
    expect(expected, "the account name on the help line").toBeTruthy();

    const name = card.getByLabel("Type your full name to sign");
    await name.fill("Somebody Else");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    // A click while gated records nothing and sends nothing. The click is
    // forced: Playwright's actionability treats aria-disabled as disabled
    // and would wait for the gate to lift, which is the opposite of the point.
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes(`/api/documents/${docId}/ack`)) posted += 1;
    });
    await button.click({ force: true });
    await page.waitForTimeout(300);
    expect(posted, "no POST while the name does not match").toBe(0);

    await name.fill(expected.toUpperCase());
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await expect(card.getByText("Sign above to confirm")).toHaveCount(0);

    // The admin is a local account: the password is re-checked. One wrong
    // password (the sign-in throttle counts it; the right one clears it).
    const password = card.getByLabel("Re-enter your account password");
    await password.fill("not-the-password");
    await button.click();
    await expect(page.locator('[role="alert"]').getByText(/Password check failed/)).toBeVisible();
    await expect(card.getByRole("button", { name: CONFIRM })).toHaveCount(1);

    await password.fill(ADMIN.password);
    const [confirmPost] = await Promise.all([
      page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/documents/${docId}/ack`) && !r.url().includes("ack-settings")),
      button.click(),
    ]);
    const confirmBody = confirmPost.postDataJSON() as Record<string, unknown>;
    expect(confirmBody.signed_name).toBe(expected.toUpperCase());
    expect(typeof confirmBody.password).toBe("string");
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Confirmation recorded" })).toBeVisible();
    await expect(card.getByText(/signed as /)).toBeVisible();

    // The record keeps the name as typed and how the signer was identified;
    // the statement stored is the one served.
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(roster.status).toBe(200);
    const mine = (roster.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(mine?.signed_name).toBe(expected.toUpperCase());
    expect(mine?.identity_proof).toBe("password");
    expect(mine?.statement_text).toBe(custom);

    // A fresh load shows the record's name, not a remembered click.
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("#confirm-reading").getByText(/signed as /)).toBeVisible();

    // The Settings tab holds the same two settings, under the shared header.
    await page.goto(`/doc/${docId}/acknowledgements/settings`);
    await expect(page.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Read confirmation" }).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByLabel("Confirmation statement")).toHaveValue(custom);
    await expect(page.getByRole("switch", { name: "Require typed signature" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
