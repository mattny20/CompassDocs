import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.10.1 (A8, F7): the compliance portal asks before it sends anything.
// Request opens the shared "Require read confirmation?" question with the
// audience count and Cancel sends nothing; Remind asks "Remind N people?";
// a second reminder inside the hour is refused (429); Stop requiring tells
// with an Undo that re-requests quietly; the two CSVs download.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the portal answers 402 and runs in
// full on the EE rig (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the portal smoke. Read it and confirm at the end.";

const MATRIX_HEADER =
  "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked";

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

/** The portal answers 402 on the community build; anything else must be 200 for the admin. */
async function portalLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/admin/compliance");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the portal").toBe(200);
  return true;
}

async function ackRequired(page: Page, docId: number): Promise<number> {
  const res = await api(page, `/api/documents/${docId}`);
  expect(res.status).toBe(200);
  return Number(res.body?.doc?.ack_required);
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

/** A text download through the page's session cookie (api() parses JSON only). */
async function fetchText(page: Page, path: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, text: await res.text() };
  }, path);
}

test("request asks with the audience count and Cancel sends nothing; Require and notify switches the policy on", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal request ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    await expect(page.getByText("Policies requiring confirmation")).toBeVisible();

    // Pick the document; the primary names the action in the glossary's words.
    const picker = page.getByRole("combobox", { name: "Document" });
    await picker.fill(title);
    await page.getByRole("option", { name: title }).click();
    const request = page.getByRole("button", { name: "Request read confirmation" });
    await expect(request).toBeEnabled();

    // The question: the document's title, the audience count, three answers.
    await request.click();
    const dialog = page.getByRole("dialog", { name: `Require read confirmation for "${title}"?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/\(\d+ (person|people)\) will be asked to read and confirm it\./)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Require and notify" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Require quietly" })).toBeVisible();

    // Cancel: nothing is sent, nothing is switched on, nothing is audited,
    // and the choice stays so the person can ask again.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await ackRequired(page, docId), "Cancel leaves the requirement off").toBe(0);
    expect((await auditRows(page, "document.ack_required", docId)).length, "Cancel writes no audit row").toBe(0);
    await expect(request).toBeEnabled();
    await expect(page.locator("li", { hasText: title })).toHaveCount(0);

    // Require and notify: the toast names the people, the requirement is on,
    // the policy joins the progress list, and the audit row says notify.
    await request.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Require and notify" }).click();
    await expect(
      page.locator('[role="status"]').getByText(/^Read confirmation required: \d+ (person|people) will be notified\.$/)
    ).toBeVisible();
    expect(await ackRequired(page, docId)).toBe(1);
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    const required = await auditRows(page, "document.ack_required", docId);
    expect(required.length).toBe(1);
    expect(required[0].details?.notify).toBe(true);
    expect(typeof required[0].details?.eligible).toBe("number");

    // A second request for the same policy is refused by the API.
    const again = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request" } });
    expect(again.status).toBe(400);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("remind asks 'Remind N people?' and is refused inside the hour; stop requiring tells, with Undo", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal remind ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // Switch it on through the API with notices: that stamps the one-hour
    // cooldown, which is what the Remind refusal below depends on.
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request" } });
    expect(on.status, "requested").toBe(200);
    expect(on.body?.ok).toBe(true);
    expect(typeof on.body?.queued, "the request answers with the queued count").toBe("number");

    await page.goto("/compliance");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();

    // Remind: the question names the pending count and the policy, ends
    // "This cannot be undone.", and the button says what it does.
    await row.getByRole("button", { name: "Remind" }).click();
    const remind = page.getByRole("dialog", { name: /^Remind \d+ (person|people)\?$/ });
    await expect(remind).toBeVisible();
    await expect(remind.getByText(`Everyone who has not confirmed "${title}" yet`, { exact: false })).toBeVisible();
    await expect(remind.getByText("This cannot be undone.", { exact: false })).toBeVisible();
    // Cancel sends nothing.
    await remind.getByRole("button", { name: "Cancel" }).click();
    await expect(remind).toHaveCount(0);
    // Send: inside the hour after the request the server refuses, and the
    // refusal is the toast (never a silent failure).
    await row.getByRole("button", { name: "Remind" }).click();
    await expect(remind).toBeVisible();
    await remind.getByRole("button", { name: "Send reminders" }).click();
    await expect(page.locator('[role="alert"]').getByText(/less than an hour ago/)).toBeVisible();
    const tooSoon = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "remind" } });
    expect(tooSoon.status, "a reminder inside the hour is 429").toBe(429);

    // Stop requiring: no question (it is reversible), a toast with Undo, the
    // requirement off, the record kept, the audit row carrying the standing.
    await row.getByRole("button", { name: "Stop requiring" }).click();
    const stopped = page.locator('[role="status"]').getByText(`Read confirmation no longer required for "${title}"`);
    await expect(stopped).toBeVisible();
    expect(await ackRequired(page, docId)).toBe(0);
    await expect(row).toHaveCount(0);

    // Undo re-requests quietly: the requirement returns, nobody is notified.
    // (The toast with Undo stays ten seconds; the audit checks come after.)
    await page.locator('[role="status"]').getByRole("button", { name: "Undo" }).click();
    await expect(
      page.locator('[role="status"]').getByText(`Read confirmation required again for "${title}". No notice sent.`)
    ).toBeVisible();
    expect(await ackRequired(page, docId)).toBe(1);
    await expect(page.locator("li", { hasText: title })).toBeVisible();

    // Both steps are on the record: the removal with the standing at that
    // moment, the undo with notify: false.
    const removed = await auditRows(page, "document.ack_removed", docId);
    expect(removed.length).toBe(1);
    expect(typeof removed[0].details?.acked).toBe("number");
    expect(removed[0].details?.required).toBeGreaterThanOrEqual(1);
    const quiet = await auditRows(page, "document.ack_required", docId);
    expect(quiet.length, "the undo is on the record").toBe(2);
    expect(quiet[0].details?.notify, "and it sent nothing").toBe(false);

    // Stop on a policy that is not required is refused by the API.
    await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "stop" } });
    const twice = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "stop" } });
    expect(twice.status).toBe(400);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("the matrix and the per-policy record download as CSV", async ({ page }) => {
  await login(page, ADMIN);
  const title = `E2E portal csv ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status).toBe(200);

    await page.goto("/compliance");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();

    // The header's Export CSV is a real download with the documented name.
    const [matrix] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export CSV" }).click(),
    ]);
    expect(matrix.suggestedFilename()).toBe("compliance-report.csv");

    // Its content: the documented header, and a row for the new policy.
    const text = await fetchText(page, "/api/admin/compliance?format=csv");
    expect(text.status).toBe(200);
    const lines = text.text.trim().split("\n");
    expect(lines[0]).toBe(MATRIX_HEADER);
    expect(lines.some((l) => l.startsWith(`"${title}"`)), "the policy is in the matrix").toBe(true);

    // The per-policy record from the row.
    const [record] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("link", { name: "Download this policy's compliance record" }).click(),
    ]);
    expect(record.suggestedFilename()).toBe(`acknowledgements-doc-${docId}.csv`);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
