import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.14.0 (F5): the compliance portal works in bulk. The Policies list gains
// a checkbox per live row and a "Select all shown" header checkbox that
// respects the filter and the sort (shift-click selects a range in that
// order); while anything is checked a bar "{n} policies selected" offers
// Remind, Set deadline…, Set owner…, Set reminders…, Ask everyone to
// re-confirm…, Add to set… and Export CSV (selected). Remind asks first with
// the counts the server will act on ("Across 1 policy. 1 policy is skipped
// because it was reminded within the hour. This cannot be undone.") and
// toasts "Reminders queued for N people · 1 policy skipped"; the re-ask is
// ONE question with the reason inside it, refused inline under ten
// characters. The People table gains the same column and a bar "{n} people
// selected" (Remind about everything outstanding, Ask to re-confirm…,
// Exempt from…, Extend due…). Everything posts to
// POST /api/admin/compliance/bulk, which queues notices and never sends
// mail in the request; a program_read-only role gets 403 from it and sees
// no checkbox and no bar on either page.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the portal answers 402 and runs in
// full on the EE rig (as e2e/compliance-portal.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the bulk smoke. Read it and confirm at the end.";

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

/** The newest audit rows (newest first) for one action on one document. */
async function auditRows(page: Page, action: string, docId: number): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(
    (r: { action: string; target_id: string | number | null }) => r.action === action && Number(r.target_id) === docId
  );
}

/** A confirmation of the policy's current version through the API, as the card posts it (the admin's own). */
async function confirmThrough(page: Page, docId: number): Promise<void> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status).toBe(200);
  const confirmed = await api(page, `/api/documents/${docId}/ack`, {
    method: "POST",
    body: { version_id: summary.body?.latest_version_id },
  });
  expect(confirmed.status, "confirmed").toBe(200);
}

/** A custom role with exactly these permissions, assigned to the user (e2e/compliance-rbac.spec.ts's helper). */
async function grantRole(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e: the bulk bars", permissions },
  });
  expect(role.status, `custom role ${name} created`).toBe(201);
  const roleId = role.body?.id;
  expect(roleId).toBeTruthy();
  const assigned = await api(page, "/api/admin/rbac/assignments", {
    method: "POST",
    body: { role_id: roleId, user_id: userId },
  });
  expect(assigned.status, `${name} assigned`).toBe(201);
  return roleId;
}

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", {
    method: "POST",
    body: { ...user, role: "viewer", name },
  });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

/** The Policies bar: the one region named for the checked policies. */
const policyBar = (page: Page) => page.getByRole("region", { name: "Selected policies" });
const peopleBar = (page: Page) => page.getByRole("region", { name: "Selected people" });

test("bulk remind asks with the skipped count and toasts what was queued; the API answers the documents-bulk shape", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const titleA = `E2E bulk ${suffix} stamped`;
  const titleB = `E2E bulk ${suffix} fresh`;
  let docA: number | undefined;
  let docB: number | undefined;
  try {
    docA = await makePolicy(page, titleA);
    docB = await makePolicy(page, titleB);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // A requested with notices: that stamps the one-hour Remind window. B
    // requested quietly: no stamp, so B is the one the bulk Remind reaches.
    const onA = await api(page, "/api/admin/compliance", { method: "POST", body: { docId: docA, action: "request" } });
    expect(onA.status, "A requested").toBe(200);
    const onB = await api(page, "/api/admin/compliance", { method: "POST", body: { docId: docB, action: "request", notify: false } });
    expect(onB.status, "B requested quietly").toBe(200);

    await page.goto("/compliance/policies");
    const rowA = page.locator("li", { hasText: titleA });
    const rowB = page.locator("li", { hasText: titleB });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // Nothing checked: no bar. Check both rows: the bar counts them.
    await expect(policyBar(page)).toHaveCount(0);
    await rowA.getByRole("checkbox", { name: `Select ${titleA}` }).check();
    await expect(policyBar(page)).toBeVisible();
    await expect(policyBar(page).getByText("1 policy selected")).toBeVisible();
    await rowB.getByRole("checkbox", { name: `Select ${titleB}` }).check();
    await expect(policyBar(page).getByText("2 policies selected")).toBeVisible();
    for (const name of ["Set deadline…", "Set owner…", "Set reminders…", "Add to set…", "Export CSV (selected)"]) {
      await expect(policyBar(page).getByRole("button", { name })).toBeVisible();
    }

    // Remind: the question names the people it will reach, the policies it
    // acts on and the one skipped because it was reminded within the hour,
    // and ends with the mail sentence. Cancel sends nothing.
    await policyBar(page).getByRole("button", { name: "Remind", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^Remind \d+ (person|people)\?$/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Across 1 policy.", { exact: false })).toBeVisible();
    await expect(dialog.getByText("1 policy is skipped because it was reminded within the hour.", { exact: false })).toBeVisible();
    await expect(dialog.getByText("This cannot be undone.", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await auditRows(page, "ack.reminder_sent", docB)).length, "Cancel sends nothing").toBe(0);
    await expect(policyBar(page).getByText("2 policies selected"), "the selection survives Cancel").toBeVisible();

    // Send: the toast says what was queued and what was skipped; the
    // selection clears; the answer is queued, not delivered.
    await policyBar(page).getByRole("button", { name: "Remind", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Send reminders" }).click();
    await expect(page.locator('[role="status"]').getByText(/^Reminders queued for \d+ (person|people) · 1 policy skipped$/)).toBeVisible();
    await expect(policyBar(page)).toHaveCount(0);
    await expect(rowB.getByRole("checkbox", { name: `Select ${titleB}` })).not.toBeChecked();

    // The API, in the documents-bulk shape: B is now inside the hour too.
    const again = await api(page, "/api/admin/compliance/bulk", { method: "POST", body: { action: "remind", doc_ids: [docA, docB, 2147483647] } });
    expect(again.status).toBe(200);
    expect(again.body?.ok).toBe(true);
    expect(again.body?.action).toBe("remind");
    expect(again.body?.done).toBe(0);
    expect(again.body?.queued).toBe(0);
    const skipped: { id: number; title: string; reason: string }[] = again.body?.skipped ?? [];
    expect(skipped.length).toBe(3);
    expect(skipped.find((s) => s.id === docB)?.reason).toMatch(/^reminded \d+ minutes? ago$/);
    expect(skipped.find((s) => s.id === 2147483647)).toEqual({ id: 2147483647, title: "#2147483647", reason: "not found" });
    const unknown = await api(page, "/api/admin/compliance/bulk", { method: "POST", body: { action: "frobnicate", doc_ids: [docB] } });
    expect(unknown.status).toBe(400);
    expect(unknown.body?.error).toBe("Unknown bulk action.");

    // Export CSV (selected): the matrix narrowed to the chosen policies.
    const csv = await page.evaluate(async (ids) => {
      const res = await fetch(`/api/admin/compliance?format=csv&doc_ids=${ids.join(",")}`);
      return { status: res.status, text: await res.text() };
    }, [docB]);
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.startsWith(`"${titleB}"`) || l.startsWith(`${titleB},`)), "only the chosen policy's rows").toBe(true);
  } finally {
    if (docA) await api(page, `/api/documents/${docA}`, { method: "DELETE" });
    if (docB) await api(page, `/api/documents/${docB}`, { method: "DELETE" });
  }
});

test("bulk re-ask is one question that refuses a short reason inline; the API skips a policy inside the hour with the minutes", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E bulk reask ${suffix}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    // Required quietly and confirmed by the admin, so there is a confirmation to reset.
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    await confirmThrough(page, docId);

    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole("checkbox", { name: `Select ${title}` }).check();
    await policyBar(page).getByRole("button", { name: "Ask everyone to re-confirm…" }).click();

    // One dialog: the titles, the numbers, the reason field, the button naming the people.
    const dialog = page.getByRole("dialog", { name: "Ask people to re-confirm 1 policy?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. This resets 1 confirmation and notifies \\d+ (person|people)\\.$`))).toBeVisible();
    const field = dialog.getByLabel("Why are readers being asked again?");
    const submit = dialog.getByRole("button", { name: /^Ask \d+ (person|people) to re-confirm$/ });
    await expect(submit).toBeVisible();

    // A short reason is refused inline; the dialog stays; nothing is written.
    await field.fill("Too short");
    await submit.click();
    await expect(dialog.getByText("Give a reason of at least 10 characters.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await auditRows(page, "ack.reconfirmation_requested", docId)).length, "a refused reason writes nothing").toBe(0);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current, "and resets nothing").toBe(1);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(policyBar(page).getByText("1 policy selected"), "the selection survives Cancel").toBeVisible();

    // The API's own rules: a short reason is 400 with the sentence; a real
    // one runs the atomic reset per policy and answers the shape.
    const short = await api(page, "/api/admin/compliance/bulk", { method: "POST", body: { action: "reask", doc_ids: [docId], params: { reason: "short" } } });
    expect(short.status).toBe(400);
    expect(short.body?.error).toBe("A reason of at least 10 characters is required.");
    const asked = await api(page, "/api/admin/compliance/bulk", {
      method: "POST",
      body: { action: "reask", doc_ids: [docId], params: { reason: "Section 4 now applies to contractors too" } },
    });
    expect(asked.status).toBe(200);
    expect(asked.body?.done).toBe(1);
    expect(asked.body?.reset).toBe(1);
    expect(asked.body?.queued).toBeGreaterThanOrEqual(1);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current, "everyone is pending again").toBe(0);
    expect((await auditRows(page, "ack.reconfirmation_requested", docId)).length).toBe(1);
    // Inside the hour the policy is skipped with the minutes, not refused.
    const held = await api(page, "/api/admin/compliance/bulk", {
      method: "POST",
      body: { action: "reask", doc_ids: [docId], params: { reason: "Asking again straight away, for the test" } },
    });
    expect(held.status).toBe(200);
    expect(held.body?.done).toBe(0);
    expect(held.body?.skipped?.[0]?.reason).toMatch(/^(asked again \d+ minutes? ago|nobody has confirmed this version yet)$/);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a program_read-only role sees no checkbox and no bar on Policies or People, and the bulk route answers 403", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E bulk reader ${suffix}`;
  const reader = { username: `e2e_bulkread_${suffix}`, password: "E2eRead!12345" };
  let docId: number | undefined;
  let readerRole: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    const readerId = await makeUser(page, reader, "E2E Bulk Reader");
    readerRole = await grantRole(page, `E2E Bulk Reader ${suffix}`, ["compliance.program_read"], readerId);

    // The admin sees the checkboxes.
    await page.goto("/compliance/policies");
    await expect(page.getByRole("checkbox", { name: "Select all shown" })).toBeVisible();
    await expect(page.locator("li", { hasText: title }).getByRole("checkbox", { name: `Select ${title}` })).toBeVisible();

    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);
      const refused = await api(rpage, "/api/admin/compliance/bulk", { method: "POST", body: { action: "remind", doc_ids: [docId] } });
      expect(refused.status, "the bulk route needs program_manage").toBe(403);
      expect((await api(rpage, `/api/admin/compliance/bulk?user_ids=${readerId}`)).status, "and so does its read").toBe(403);

      await rpage.goto("/compliance/policies");
      const main = rpage.locator("#main");
      await expect(main.locator("li", { hasText: title })).toBeVisible();
      await expect(main.getByRole("checkbox", { name: "Select all shown" })).toHaveCount(0);
      await expect(main.getByRole("checkbox", { name: /^Select / })).toHaveCount(0);
      await expect(policyBar(rpage)).toHaveCount(0);

      await rpage.goto("/compliance/people");
      await expect(rpage.getByRole("navigation", { name: "Compliance" }).getByRole("link", { name: "People", exact: true })).toHaveAttribute(
        "aria-current",
        "page"
      );
      await expect(main.getByRole("columnheader", { name: "Overdue" })).toBeVisible();
      await expect(main.getByRole("checkbox", { name: "Select all shown" })).toHaveCount(0);
      await expect(main.getByRole("checkbox", { name: /^Select / })).toHaveCount(0);
      await expect(peopleBar(rpage)).toHaveCount(0);
    } finally {
      await rctx.close();
    }
  } finally {
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("'Select all shown' respects the filter, shift-click selects the range shown, and the People bar counts people", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const titleA = `E2E bulk filter ${suffix} alpha`;
  const titleB = `E2E bulk filter ${suffix} beta`;
  let docA: number | undefined;
  let docB: number | undefined;
  try {
    docA = await makePolicy(page, titleA);
    docB = await makePolicy(page, titleB);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    for (const docId of [docA, docB]) {
      const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
      expect(on.status, "requested quietly").toBe(200);
    }

    await page.goto("/compliance/policies");
    const rowA = page.locator("li", { hasText: titleA });
    const rowB = page.locator("li", { hasText: titleB });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    const filter = page.getByRole("textbox", { name: "Filter policies" });
    const selectAll = page.getByRole("checkbox", { name: "Select all shown" });

    // Filter to the one row, select all shown: one policy, not every policy on the page.
    await filter.fill(`${suffix} alpha`);
    await expect(page.getByText(/^1 of \d+ policies$/)).toBeVisible();
    await selectAll.check();
    await expect(policyBar(page).getByText("1 policy selected")).toBeVisible();
    await expect(rowA.getByRole("checkbox", { name: `Select ${titleA}` })).toBeChecked();
    // The filter cleared: the other row is still unchecked and the count holds.
    await filter.fill("");
    await expect(rowB.getByRole("checkbox", { name: `Select ${titleB}` })).not.toBeChecked();
    await expect(policyBar(page).getByText("1 policy selected")).toBeVisible();
    await expect(selectAll, "not every shown row is selected").not.toBeChecked();

    // Clear selection, then a shift-click range over what the filter shows
    // (both rows share the stamp, so the range is exactly the two).
    await policyBar(page).getByRole("button", { name: "Clear selection" }).click();
    await expect(policyBar(page)).toHaveCount(0);
    await filter.fill(`E2E bulk filter ${suffix}`);
    await expect(page.getByText(/^2 of \d+ policies$/)).toBeVisible();
    const first = page.locator("li", { hasText: `E2E bulk filter ${suffix}` }).first();
    const last = page.locator("li", { hasText: `E2E bulk filter ${suffix}` }).last();
    await first.getByRole("checkbox", { name: /^Select / }).click();
    await last.getByRole("checkbox", { name: /^Select / }).click({ modifiers: ["Shift"] });
    await expect(policyBar(page).getByText("2 policies selected")).toBeVisible();
    await expect(selectAll).toBeChecked();
    // Selecting all shown again clears them.
    await selectAll.uncheck();
    await expect(policyBar(page)).toHaveCount(0);

    // The People page: a checkbox per person, the bar in people, the four
    // actions. The admin's row is found by their name (the Person cell shows
    // the display name, else the username), as the portal spec finds it.
    await page.goto("/compliance/people");
    const users: { username: string; name: string }[] = (await api(page, "/api/admin/compliance")).body?.users ?? [];
    const me = users.find((u) => u.username === ADMIN.username);
    const adminRow = page.getByRole("row").filter({ hasText: me?.name || ADMIN.username }).first();
    await expect(adminRow).toBeVisible();
    await adminRow.getByRole("checkbox", { name: /^Select / }).check();
    await expect(peopleBar(page).getByText("1 person selected")).toBeVisible();
    for (const name of ["Remind about everything outstanding", "Ask to re-confirm…", "Exempt from…", "Extend due…"]) {
      await expect(peopleBar(page).getByRole("button", { name })).toBeVisible();
    }
    // Exempt from…: the policies the person owes, from the bulk route's read; Cancel writes nothing.
    await peopleBar(page).getByRole("button", { name: "Exempt from…" }).click();
    const exempt = page.getByRole("dialog", { name: "Exempt 1 person from…" });
    await expect(exempt).toBeVisible();
    await expect(exempt.getByRole("checkbox", { name: new RegExp(titleA) })).toBeVisible();
    await exempt.getByRole("button", { name: "Cancel" }).click();
    await expect(exempt).toHaveCount(0);
    await peopleBar(page).getByRole("button", { name: "Clear selection" }).click();
    await expect(peopleBar(page)).toHaveCount(0);
  } finally {
    if (docA) await api(page, `/api/documents/${docA}`, { method: "DELETE" });
    if (docB) await api(page, `/api/documents/${docB}`, { method: "DELETE" });
  }
});
