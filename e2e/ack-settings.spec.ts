import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.12.0 (G1 + G3 UI): the Read confirmation page's Settings tab. Three
// cards under one Save row: Confirmation statement (C2), Re-confirmation
// (the interval, the next date prefilled from the marker, the effective
// date) and Lifecycle (the replacement, Retire policy… with its question
// and reason, Un-retire with its question and toast). The tab opens for a
// holder of document.ack_require on the policy's space (or the program
// manager) and is not found for anyone else, exactly as the route is 403.
//
// Licensed builds only: the portal answers 402 on the community build and
// the tests skip themselves (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the settings tab. Read it and confirm at the end.";

const NEXT_DATE_PAST = "The next re-confirmation date cannot be in the past.";
const REASON_TOO_SHORT = "Give a reason of at least 10 characters.";

async function makeDoc(page: Page, title: string): Promise<number> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: 1, title, type: "policy", status: "published", content: BODY, tags: [] },
  });
  expect(made.status, "document created").toBe(201);
  const id = made.body?.doc?.id;
  expect(id, "document id").toBeTruthy();
  return id;
}

/** The portal answers 402 on the community build; anything else must be 200 for the admin. */
async function portalLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/admin/compliance");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the portal").toBe(200);
  return true;
}

/** Switch the requirement on quietly through the portal's request action. */
async function requireQuietly(page: Page, docId: number): Promise<void> {
  const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
  expect(on.status, "requested quietly").toBe(200);
}

/**
 * The workspace's "Re-confirm every" default (Program settings), which the
 * first switch-on applies to a policy: set to Never for the test, so a rig
 * whose admin chose 6/12/24 still starts each policy with no cycle. Returns
 * what it was, for restoreRecertDefault in finally; undefined when the
 * settings route is not licensed (the test skips itself right after).
 */
async function neutraliseRecertDefault(page: Page): Promise<number | null | undefined> {
  const before = await api(page, "/api/admin/compliance/settings");
  if (before.status !== 200) return undefined;
  const was: number | null = before.body?.settings?.ack_defaults?.recert_months ?? null;
  if (was !== null) {
    const off = await api(page, "/api/admin/compliance/settings", {
      method: "PUT",
      body: { ack_defaults: { recert_months: null } },
    });
    expect(off.status, "the workspace interval set to Never for the test").toBe(200);
  }
  return was;
}

async function restoreRecertDefault(page: Page, was: number | null | undefined): Promise<void> {
  if (was === undefined || was === null) return;
  await api(page, "/api/admin/compliance/settings", { method: "PUT", body: { ack_defaults: { recert_months: was } } });
}

/** Focus never falls to <body> after Retire / Un-retire (STYLEGUIDE §Settings pages). */
async function expectFocusNotOnBody(page: Page, after: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body), {
      message: `focus is not on <body> after ${after}`,
    })
    .toBe(true);
}

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", { method: "POST", body: { ...user, role: "viewer", name } });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

/** A custom role with exactly these permissions, assigned to the user on space 1 (the sample space the policy is in). */
async function grantOnSpace(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e: the Settings tab's gate", permissions },
  });
  expect(role.status, `custom role ${name} created`).toBe(201);
  const roleId = role.body?.id;
  expect(roleId).toBeTruthy();
  const assigned = await api(page, "/api/admin/rbac/assignments", {
    method: "POST",
    body: { role_id: roleId, user_id: userId, space_id: 1 },
  });
  expect(assigned.status, `${name} assigned on the space`).toBe(201);
  return roleId;
}

/** 'YYYY-MM-DD' of an instant, in UTC: what the date input holds for a stored timestamp. */
const ymd = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** The settings page's card holding this heading (the innermost section). */
const card = (page: Page, heading: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) }).last();

test("the Settings tab: the three cards save through one Save row; a past next date is refused inline and by the route; Retire asks and retires, Un-retire resumes", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E ack settings ${suffix}`;
  const replacementTitle = `E2E ack settings replacement ${suffix}`;
  const custom = "I have read this policy and will comply with it.";
  const REASON = "Superseded by the new expense policy";
  let docId: number | undefined;
  let replacementId: number | undefined;
  let recertDefaultBefore: number | null | undefined;
  try {
    docId = await makeDoc(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    replacementId = await makeDoc(page, replacementTitle);
    // The switch-on applies the workspace interval: Never for the test, so
    // "no cycle yet" and the Select's "" below hold on any rig.
    recertDefaultBefore = await neutraliseRecertDefault(page);
    await requireQuietly(page, docId);

    // The tab, under the shared header, with the Settings link lit.
    await page.goto(`/doc/${docId}/acknowledgements/settings`);
    await expect(page.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Read confirmation" }).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    const save = page.getByRole("button", { name: "Save settings" });
    await expect(save, "nothing to save yet").toBeDisabled();

    // The statement card: the statement and the signature save together;
    // the route holds them; the row is clean again.
    await page.getByLabel("Confirmation statement").fill(custom);
    await page.getByRole("switch", { name: "Require typed signature" }).click();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Settings saved.")).toBeVisible();
    await expect(save).toBeDisabled();
    let settings = await api(page, `/api/documents/${docId}/ack-settings`);
    expect(settings.status).toBe(200);
    expect(settings.body?.statement).toBe(custom);
    expect(settings.body?.signature).toBe(true);
    expect(settings.body?.recert_months, "no cycle yet").toBeNull();
    expect(settings.body?.next_recert_at).toBeNull();
    expect(settings.body?.effective_at, "the switch-on dated the policy").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const marker: string = settings.body?.marker;
    expect(marker).toBeTruthy();
    // The signature off again, so the confirmation below needs no typed name.
    await page.getByRole("switch", { name: "Require typed signature" }).click();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Settings saved.").last()).toBeVisible();
    expect((await api(page, `/api/documents/${docId}/ack-settings`)).body?.signature).toBe(false);

    // The Re-confirmation card: Never shows no date field; choosing an
    // interval shows "Next re-confirmation" prefilled with the marker plus
    // the interval (a policy switched on moments ago: never pushed out);
    // the workspace default is marked on exactly one option.
    const interval = page.getByLabel("Re-confirm every");
    await expect(interval).toHaveValue("");
    await expect(interval.locator("option", { hasText: "(workspace default)" })).toHaveCount(1);
    await expect(page.getByLabel("Next re-confirmation")).toHaveCount(0);
    await interval.selectOption("12");
    const nextDate = page.getByLabel("Next re-confirmation");
    await expect(nextDate).toBeVisible();
    // The marker plus twelve months, the day clamped the way make_interval
    // clamps it (29 Feb + 12 months = 28 Feb).
    const m = new Date(marker);
    const lastDay = new Date(Date.UTC(m.getUTCFullYear() + 1, m.getUTCMonth() + 1, 0)).getUTCDate();
    const expectedNext = new Date(Date.UTC(m.getUTCFullYear() + 1, m.getUTCMonth(), Math.min(m.getUTCDate(), lastDay)));
    await expect(nextDate).toHaveValue(ymd(expectedNext.toISOString()));
    await expect(page.getByText("Everyone is asked again on this date. A material change restarts the interval.")).toBeVisible();
    await expect(page.getByText(/^People last re-confirmed \d+ months ago/)).toHaveCount(0);

    // A past date is refused inline: the field's own alert, Save disabled.
    await nextDate.fill("2020-01-01");
    await expect(page.getByRole("alert").filter({ hasText: NEXT_DATE_PAST })).toBeVisible();
    await expect(save).toBeDisabled();
    // And by the route, with the same sentence.
    const past = await api(page, `/api/documents/${docId}/ack-settings`, {
      method: "PATCH",
      body: { recert_months: 12, next_recert_at: "2020-01-01" },
    });
    expect(past.status).toBe(400);
    expect(past.body?.error).toBe(NEXT_DATE_PAST);
    expect((await api(page, `/api/documents/${docId}/ack-settings`)).body?.recert_months, "a refused PATCH changes nothing").toBeNull();

    // A date a year and a day out saves with the interval; the route holds
    // both, and the field shows the stored date on reload.
    const chosen = new Date(expectedNext.getTime() + 86_400_000);
    await nextDate.fill(ymd(chosen.toISOString()));
    await expect(page.getByRole("alert").filter({ hasText: NEXT_DATE_PAST })).toHaveCount(0);
    await page.getByLabel("Effective date").fill("2026-01-01");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Settings saved.").last()).toBeVisible();
    settings = await api(page, `/api/documents/${docId}/ack-settings`);
    expect(settings.body?.recert_months).toBe(12);
    expect(ymd(settings.body?.next_recert_at)).toBe(ymd(chosen.toISOString()));
    expect(settings.body?.effective_at).toBe("2026-01-01");
    await page.reload();
    await expect(page.getByLabel("Re-confirm every")).toHaveValue("12");
    await expect(page.getByLabel("Next re-confirmation")).toHaveValue(ymd(chosen.toISOString()));
    await expect(page.getByLabel("Effective date")).toHaveValue("2026-01-01");

    // The document page: the card's meta line and the shield popover's
    // status line read the cycle.
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("#confirm-reading").getByText(/^Effective .+ · re-confirm yearly$/)).toBeVisible();
    await page.getByRole("button", { name: "Read confirmation settings" }).first().click();
    const panel = page.getByRole("dialog", { name: "Read confirmation" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Re-confirm yearly · next /)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // One confirmation, so the retirement has a count to freeze.
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    const confirmed = await api(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: summary.body?.latest_version_id },
    });
    expect(confirmed.status, "confirmed").toBe(200);

    // The Lifecycle card: the replacement is picked and saved like any field.
    await page.goto(`/doc/${docId}/acknowledgements/settings`);
    const lifecycle = card(page, "Lifecycle");
    await expect(lifecycle).toBeVisible();
    const picker = lifecycle.getByRole("combobox", { name: "Replaced by" });
    await picker.fill(replacementTitle);
    await page.getByRole("option", { name: new RegExp(replacementTitle) }).click();
    await expect(lifecycle.getByText(replacementTitle)).toBeVisible();
    await expect(lifecycle.getByRole("button", { name: "Clear replacement" })).toBeVisible();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Settings saved.").last()).toBeVisible();
    settings = await api(page, `/api/documents/${docId}/ack-settings`);
    expect(settings.body?.superseded_by).toBe(replacementId);
    expect(settings.body?.superseded_by_title).toBe(replacementTitle);

    // Retire: the question names the standing; a short reason stops at the
    // field; a reason retires it, the card shows who and why, and the
    // document is retired with its replacement.
    await lifecycle.getByRole("button", { name: "Retire policy…" }).click();
    const question = page.getByRole("dialog", { name: `Retire "${title}"?` });
    await expect(question).toBeVisible();
    await expect(question.getByText(/^1 of \d+ people have confirmed version 1\. Retiring stops asking anyone to confirm/)).toBeVisible();
    const reason = question.getByLabel("Why is this policy being retired?");
    await expect(question.getByText("Shown on the compliance record and in exports")).toBeVisible();
    await reason.fill("short");
    await question.getByRole("button", { name: "Retire policy", exact: true }).click();
    await expect(question.getByRole("alert")).toHaveText(REASON_TOO_SHORT);
    await expect(question).toBeVisible();
    await reason.fill(REASON);
    await question.getByRole("button", { name: "Retire policy", exact: true }).click();
    // The portal row's sentence, word for word.
    await expect(page.locator('[role="status"]').getByText(/^Policy retired: 1 of \d+ confirmations on record$/)).toBeVisible();
    await expectFocusNotOnBody(page, "Retire");
    await expect(question).toHaveCount(0);
    await expect(lifecycle.getByText(/^Retired .+ by /)).toBeVisible();
    await expect(lifecycle.getByText(REASON)).toBeVisible();
    await expect(lifecycle.getByRole("button", { name: "Un-retire" })).toBeVisible();
    await expect(lifecycle.getByRole("button", { name: "Retire policy…" })).toHaveCount(0);
    const retiredDoc = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(retiredDoc?.ack_required).toBe(0);
    expect(retiredDoc?.ack_retired_at).toBeTruthy();
    expect(retiredDoc?.ack_retired_reason).toBe(REASON);
    expect(retiredDoc?.ack_superseded_by).toBe(replacementId);

    // The Record tab stays open, read-only; the document page shows the
    // neutral row with the replacement as a link, and no card.
    await page.goto(`/doc/${docId}/acknowledgements`);
    await expect(page.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Read confirmation" }).getByRole("link", { name: "Record" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await page.goto(`/doc/${docId}`);
    await expect(page.getByText(/^Retired \S.* · replaced by /)).toBeVisible();
    await expect(page.getByRole("link", { name: replacementTitle })).toHaveAttribute("href", `/doc/${replacementId}`);
    await expect(page.locator("#confirm-reading")).toHaveCount(0);

    // Un-retire: the question, then the toast with the standing; the card
    // offers Retire again; the requirement is back and the replacement is
    // cleared (a policy that is live again is not replaced by anything).
    await page.goto(`/doc/${docId}/acknowledgements/settings`);
    await lifecycle.getByRole("button", { name: "Un-retire" }).click();
    const resume = page.getByRole("dialog", { name: `Resume read confirmation for "${title}"?` });
    await expect(resume).toBeVisible();
    await expect(
      resume.getByText(
        "Confirmations made before it was retired stay on record. If the text changed while it was retired, people whose confirmation is older than the current version are asked again."
      )
    ).toBeVisible();
    await resume.getByRole("button", { name: "Resume" }).click();
    const toasts = page.locator('[role="status"]');
    await expect(toasts.getByText(/^Policy resumed: 1 of \d+ confirmations still current$/)).toBeVisible();
    await expectFocusNotOnBody(page, "Un-retire");
    // One confirmation is still current, so the toast offers the re-ask
    // (the live region holds every ok toast; the action is its button).
    await expect(toasts.getByRole("button", { name: "Ask everyone to re-confirm…" })).toBeVisible();
    await expect(resume).toHaveCount(0);
    await expect(lifecycle.getByRole("button", { name: "Retire policy…" })).toBeVisible();
    await expect(lifecycle.getByRole("button", { name: "Un-retire" })).toHaveCount(0);
    await expect(lifecycle.getByRole("combobox", { name: "Replaced by" })).toBeVisible();
    const resumedDoc = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(resumedDoc?.ack_required).toBe(1);
    expect(resumedDoc?.ack_retired_at).toBeNull();
    expect(resumedDoc?.ack_superseded_by).toBeNull();
    expect((await api(page, `/api/documents/${docId}/ack-settings`)).body?.superseded_by).toBeNull();
    await page.goto(`/doc/${docId}`);
    await expect(page.getByText(/^Retired \S/)).toHaveCount(0);
    await expect(page.locator("#confirm-reading")).toHaveCount(1);
  } finally {
    await restoreRecertDefault(page, recertDefaultBefore);
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (replacementId) await api(page, `/api/documents/${replacementId}`, { method: "DELETE" });
  }
});

test("the Settings tab's gate: a holder of document.ack_require on the space opens it and saves; a roster reader without it is not found and the route is 403", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E ack settings gate ${suffix}`;
  const approver = { username: `e2e_ackset_${suffix}`, password: "E2eSet!12345" };
  const reader = { username: `e2e_ackread_${suffix}`, password: "E2eRead!12345" };
  const custom = "I have read this policy and understood every clause.";
  let docId: number | undefined;
  let approverId: number | undefined;
  let readerId: number | undefined;
  let approverRole: number | undefined;
  let readerRole: number | undefined;
  let recertDefaultBefore: number | null | undefined;
  try {
    docId = await makeDoc(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    // Never for the test: "nothing changed hands" below reads recert_months.
    recertDefaultBefore = await neutraliseRecertDefault(page);
    await requireQuietly(page, docId);

    // The record's own permission plus the requirement's: the tab opens and
    // the statement card saves.
    approverId = await makeUser(page, approver, "E2E Settings Approver");
    approverRole = await grantOnSpace(
      page,
      `E2E Settings Approver ${suffix}`,
      ["document.ack_roster_read", "document.ack_require"],
      approverId
    );
    const actx = await browser.newContext();
    try {
      const apage = await actx.newPage();
      await login(apage, approver);
      await apage.goto(`/doc/${docId}/acknowledgements/settings`);
      await expect(apage.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
      await expect(apage.getByRole("navigation", { name: "Read confirmation" }).getByRole("link", { name: "Settings" })).toHaveAttribute(
        "aria-current",
        "page"
      );
      await expect(card(apage, "Confirmation statement")).toBeVisible();
      await expect(card(apage, "Re-confirmation")).toBeVisible();
      await expect(card(apage, "Lifecycle")).toBeVisible();
      await apage.getByLabel("Confirmation statement").fill(custom);
      await apage.getByRole("button", { name: "Save settings" }).click();
      await expect(apage.locator('[role="status"]').getByText("Settings saved.")).toBeVisible();
      expect((await api(apage, `/api/documents/${docId}/ack-settings`)).body?.statement).toBe(custom);
    } finally {
      await actx.close();
    }

    // The record's permission alone: the Record tab opens with no Settings
    // link, the Settings tab is the shell's not-found page, the route is 403.
    readerId = await makeUser(page, reader, "E2E Settings Reader");
    readerRole = await grantOnSpace(page, `E2E Settings Reader ${suffix}`, ["document.ack_roster_read"], readerId);
    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);
      await rpage.goto(`/doc/${docId}/acknowledgements`);
      await expect(rpage.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
      const tabs = rpage.getByRole("navigation", { name: "Read confirmation" });
      await expect(tabs.getByRole("link", { name: "Record" })).toBeVisible();
      await expect(tabs.getByRole("link", { name: "Settings" })).toHaveCount(0);
      await rpage.goto(`/doc/${docId}/acknowledgements/settings`);
      await expect(rpage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      expect((await api(rpage, `/api/documents/${docId}/ack-settings`)).status, "GET needs the requirement's key").toBe(403);
      const patched = await api(rpage, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { recert_months: 12 } });
      expect(patched.status, "and so does PATCH").toBe(403);
    } finally {
      await rctx.close();
    }
    expect((await api(page, `/api/documents/${docId}/ack-settings`)).body?.recert_months, "nothing changed hands").toBeNull();
  } finally {
    await restoreRecertDefault(page, recertDefaultBefore);
    if (approverRole) await api(page, `/api/admin/rbac/roles/${approverRole}`, { method: "DELETE" });
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (approverId) await api(page, `/api/admin/users/${approverId}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
