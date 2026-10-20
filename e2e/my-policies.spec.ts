import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.13.0 (E1): a deadline reaches the reader as information, never a wall.
// Every person enrolled in a policy gets a due date (the cascade's days
// from assignment, 14 built in). My policies orders the To confirm group
// overdue first, then the soonest deadline, and its chips say "To confirm ·
// due {date}" or "Overdue · due {date}"; the dashboard's row counts the
// overdue ones ("· 1 overdue") and names each deadline "(due {date})"; the
// document's notice strip adds " by {date}" to its one sentence; the card
// carries a "Due {date}" / "Overdue since {date}" chip and, once overdue,
// the sentence "This was due {date}. Confirming now still records today's
// date." above the same button; the sticky bar shows "Due in n days" /
// "Overdue". Everything leaves with the pending state.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the requirement answers 402 and runs
// in full on the EE rig. The overdue case moves a deadline into the past
// through the database (no route backdates a deadline: that is the point of
// one), so it needs DATABASE_URL in the Playwright process and skips itself
// otherwise.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const PARA = `Policy text long enough to need scrolling. ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10)}`;
const BODY = Array.from({ length: 14 }, (_, i) => `## Section ${i + 1}\n\n${PARA}`).join("\n\n");

const CONFIRM = "I've read and understood this";
const POINTER_BY = /^Please read this document carefully\. You'll be asked to confirm at the end by .+\.$/;
const OVERDUE_COPY = /^This was due .+\. Confirming now still records today's date\.$/;

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

/** Turn the requirement on (the admin is enrolled with the default deadline); 402 means the community build. */
async function requireConfirmation(page: Page, docId: number): Promise<"on" | "unlicensed"> {
  const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
  if (res.status === 402) return "unlicensed";
  expect(res.status, "confirmation required").toBe(200);
  return "on";
}

/** One person's deadline on one policy moved `days` into the past, straight on the row: the one thing no route offers. */
async function backdate(docId: number, username: string, days: number): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `UPDATE policy_assignments pa SET due_at = now() - ($3::int * interval '1 day')
         FROM users u
        WHERE u.id = pa.user_id AND pa.document_id = $1 AND u.username = $2`,
      [docId, username, days]
    );
    expect(r.rowCount, "the person's row on the policy").toBe(1);
  } finally {
    await client.end();
  }
}

/** The document bar after the masthead has scrolled away. */
async function stickyBar(page: Page) {
  await page.locator("#main").evaluate((el) => el.scrollTo(0, 600));
  await page.waitForTimeout(400);
  return page.getByRole("region", { name: "Document bar" });
}

// A chip is "<icon> To confirm · due {date}": a regex in getByText runs
// against the raw text, so a chip's regex is never anchored at the start;
// the row scopes it.

test("a policy with a deadline: My policies names the due date, the dashboard detail says when, the strip says by when, the card carries the Due chip and the sticky bar the days left", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E due cues ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );

    // The API behind the page: the row carries the deadline, still ahead.
    const mine = await api(page, "/api/compliance/mine");
    expect(mine.status).toBe(200);
    const row0 = (mine.body?.rows ?? []).find((r: { id: number }) => r.id === docId);
    expect(row0, "the policy is listed").toBeTruthy();
    expect(row0.state).toBe("pending");
    expect(row0.due_at, "the deadline rides on the row").toBeTruthy();
    expect(Date.parse(row0.due_at)).toBeGreaterThan(Date.now());

    // My policies: the chip names the day.
    await page.goto("/compliance");
    const row = page.getByRole("region", { name: "To confirm" }).locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(/To confirm · due .+$/)).toBeVisible();

    // The dashboard: the detail names a deadline; nothing of the admin's is overdue.
    await page.goto("/");
    const attention = page.getByRole("link", { name: /^\d+ polic(y needs|ies need) your read confirmation/ });
    await expect(attention).toBeVisible();
    await expect(attention).toContainText("(due ");
    expect(await attention.textContent()).not.toMatch(/ · \d+ overdue/);

    // The document: the strip's one sentence ends with the date, the card's
    // chip says "Due {date}" with no overdue sentence, and the sticky bar
    // counts the days beside the jump link.
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("h1")).toContainText(title);
    await expect(page.getByText(POINTER_BY)).toBeVisible();
    const card = page.locator("#confirm-reading");
    await expect(card.getByText(/^Due .+$/)).toBeVisible();
    await expect(card.getByText(OVERDUE_COPY)).toHaveCount(0);
    const bar = await stickyBar(page);
    await expect(bar.getByRole("link", { name: "Confirmation pending" })).toBeVisible();
    await expect(bar.getByText(/^Due in \d+ days$/)).toBeVisible();

    // Confirming: the cues leave with the pending state.
    await card.getByRole("button", { name: CONFIRM }).click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByText(/^You confirmed version 1 on /)).toBeVisible();
    await expect(card.getByText(/^Due .+$/)).toHaveCount(0);
    await expect(bar.getByText(/^Due in \d+ days$/)).toHaveCount(0);
    await expect(bar.getByText(/^Confirmed /)).toBeVisible();
    await expect(page.getByText(POINTER_BY)).toHaveCount(0);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("an overdue policy: My policies lists it first with its Overdue chip, the dashboard counts it, the card says it was due and still records today, and the sticky chip reads Overdue", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL in the Playwright process to move a deadline into the past");
  await login(page, ADMIN);
  const suffix = stamp();
  const titleLate = `E2E overdue ${suffix}`;
  const titleSoon = `E2E due ahead ${suffix}`;
  let lateId: number | undefined;
  let soonId: number | undefined;
  try {
    soonId = await makePolicy(page, titleSoon);
    test.skip(
      (await requireConfirmation(page, soonId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    lateId = await makePolicy(page, titleLate);
    expect(await requireConfirmation(page, lateId)).toBe("on");
    await backdate(lateId, ADMIN.username, 2);

    // The API: 'overdue', listed before the one still ahead although it was
    // assigned later.
    const rows: { id: number; state: string; due_at: string | null }[] = (await api(page, "/api/compliance/mine")).body?.rows ?? [];
    const late = rows.find((r) => r.id === lateId);
    const soon = rows.find((r) => r.id === soonId);
    expect(late?.state).toBe("overdue");
    expect(Date.parse(late?.due_at ?? "")).toBeLessThan(Date.now());
    expect(soon?.state).toBe("pending");
    expect(rows.findIndex((r) => r.id === lateId)).toBeLessThan(rows.findIndex((r) => r.id === soonId));

    // My policies: the overdue row leads the group with the error chip; the
    // other keeps the warn chip with its date.
    await page.goto("/compliance");
    const group = page.getByRole("region", { name: "To confirm" });
    await expect(group.locator("li").first()).toContainText(titleLate);
    await expect(group.locator("li", { hasText: titleLate }).getByText(/Overdue · due .+$/)).toBeVisible();
    await expect(group.locator("li", { hasText: titleSoon }).getByText(/To confirm · due .+$/)).toBeVisible();

    // The dashboard: the label counts it and the detail leads with it.
    await page.goto("/");
    const attention = page.getByRole("link", { name: /^\d+ policies need your read confirmation · \d+ overdue/ });
    await expect(attention).toBeVisible();
    await expect(attention).toHaveAttribute("href", "/compliance");
    await expect(attention).toContainText(`${titleLate} (due `);

    // The document: the strip still says by when, the card's chip says
    // since when with the sentence above the button, and the sticky bar
    // says Overdue (shown at every width).
    await page.goto(`/doc/${lateId}`);
    await expect(page.locator("h1")).toContainText(titleLate);
    await expect(page.getByText(POINTER_BY)).toBeVisible();
    const card = page.locator("#confirm-reading");
    await expect(card.getByText(/^Overdue since .+$/)).toBeVisible();
    await expect(card.getByText(OVERDUE_COPY)).toBeVisible();
    await expect(card.getByRole("button", { name: CONFIRM })).toBeEnabled();
    const bar = await stickyBar(page);
    await expect(bar.getByText("Overdue", { exact: true })).toBeVisible();

    // Confirming is the same button: recorded today, the cues go, My
    // policies moves it to Confirmed and the API agrees.
    await card.getByRole("button", { name: CONFIRM }).click();
    await expect(page.locator('[role="status"]').getByText("Confirmation recorded.")).toBeVisible();
    await expect(card.getByText(/^You confirmed version 1 on /)).toBeVisible();
    await expect(card.getByText(OVERDUE_COPY)).toHaveCount(0);
    await expect(card.getByText(/^Overdue since .+$/)).toHaveCount(0);
    await expect(bar.getByText("Overdue", { exact: true })).toHaveCount(0);
    const after = ((await api(page, "/api/compliance/mine")).body?.rows ?? []).find((r: { id: number }) => r.id === lateId);
    expect(after?.state).toBe("confirmed");
    await page.goto("/compliance");
    await expect(page.getByRole("region", { name: "Confirmed" }).locator("li", { hasText: titleLate })).toBeVisible();
    await expect(page.getByRole("region", { name: "To confirm" }).locator("li", { hasText: titleLate })).toHaveCount(0);
  } finally {
    if (lateId) await api(page, `/api/documents/${lateId}`, { method: "DELETE" });
    if (soonId) await api(page, `/api/documents/${soonId}`, { method: "DELETE" });
  }
});
