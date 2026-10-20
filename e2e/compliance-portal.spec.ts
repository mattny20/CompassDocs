import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.10.1 (A8, F7): the compliance portal asks before it sends anything.
// Request opens the shared "Require read confirmation?" question with the
// audience count and Cancel sends nothing; Remind asks "Remind N people?";
// a second reminder inside the hour is refused (429); Stop requiring tells
// with an Undo that re-requests quietly; the two CSVs download.
// 1.11.0 (G2): an unpublished policy is paused, not gone: it moves to the
// collapsed "Paused (unpublished)" group with an Unpublished chip and no
// row actions, the tiles leave it out, and republishing moves it back.
// 1.12.0 (B4): /compliance is a routed section. My policies (/compliance)
// is the first page for everyone with a policy in scope: a standing line,
// the To confirm and Confirmed groups, each row linking to the confirmation
// card; the portal's views are /compliance/overview (the tiles),
// /compliance/policies (Request, the progress list with its actions, the
// paused group, Export CSV) and /compliance/people; the sidebar's
// Compliance row carries the count of policies to confirm; a plain viewer
// with a policy in scope sees the row and only the My policies tab.
// 1.12.0 (G3): a retired policy moves to the collapsed "Retired · n" group
// under Paused with a "Retired {date}" chip, its frozen count and version,
// the reason, the record link and the CSV, no Remind / re-ask / Stop
// requiring; Un-retire asks once and restores the row with a toast; the
// live row's "Retire policy…" asks for a reason of ten characters.
// 1.12.0 (G1): the Overview's fifth tile counts policies whose next
// re-confirmation falls within 30 days; a policy with an interval shows
// "Next re-confirmation {date}" on its row.
// 1.13.0 (D1, E1, E2): a live row carries an icon button to the policy's
// Settings tab, "+n enrolled this week" once someone joins the audience,
// the deadline rule ("Due 14 days after assignment", "· 12 overdue" once
// anyone is past it) and the reminder cadence ("never reminded · next
// automatic reminder {date}", "last reminded today · …" after Remind); the
// Overview gains an Overdue confirmations tile; the People page an Overdue
// column. An overdue row needs a backdated deadline, which no API offers,
// so that path is proved in test/ack-portal.test.ts against the database.
// 1.14.0 (F1, D3, F2, F3): the Overview's tiles are Policies, Compliance,
// Overdue (with its people), Due in 7 days, Pending and Exempt, plus the
// re-confirmation tile; a "Needs attention" queue lists each person and
// reason (and each drifted policy) with its chip and actions; a live row on
// Policies carries a stacked bar with its legend, the owner and the kept
// edits on its subtitle, a set chip, and the card's Sort, "In set" and
// filter controls; the Export CSV link is an Export menu (Matrix CSV, Ledger
// CSV, Audit package (ZIP), Print…); the People page's Standing chip reads
// Compliant / "{n} outstanding" / "{n} overdue" behind a Show control and a
// filter, and each person links to their compliance record. A per-person
// queue row (overdue, never opened) needs a backdated deadline or a
// fortnight, which no API offers, so the snooze is proved on the payload
// (test/ack-attention.test.ts proves the row leaving the queue) and the
// queue's row here is the drifted policy, which a kept edit produces.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the portal answers 402 and runs in
// full on the EE rig (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the portal smoke. Read it and confirm at the end.";

// The 1.10.1 columns in place, the six attestation and re-confirmation
// columns (1.12.0, C4), the five exemption and deadline columns (1.13.0,
// D2) and the status and set columns (1.14.0, F1 and D3) appended:
// MATRIX_CSV_HEADER in src/lib/read-evidence.ts.
const MATRIX_HEADER =
  "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,version_published_by,version_approved_by,statement,signed_name,identity_proof,recert_months,effective_at,next_recert_at,exempt_reason,exempt_by,exempt_until,snoozed_until,due_at,status,set";

/** One CSV line into cells: quoted fields may hold commas and doubled quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

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

/**
 * A confirmation of the policy's current version through the API, as the
 * card posts it. The summary (GET /ack) is for editors and roster readers,
 * so `page` is the admin's; `as` is whose confirmation it is — a plain
 * viewer's page, when the test has one — and defaults to the admin's own.
 */
async function confirmThrough(page: Page, docId: number, as: Page = page): Promise<void> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status).toBe(200);
  const confirmed = await api(as, `/api/documents/${docId}/ack`, {
    method: "POST",
    body: { version_id: summary.body?.latest_version_id },
  });
  expect(confirmed.status, "confirmed").toBe(200);
}

// A chip is "<icon> Confirmed {date} · v1": its text starts with the space
// after the icon, and a regex in getByText runs against the raw text (only
// string matches are whitespace-normalised), so a chip's regex is never
// anchored at the start; the row scopes it.

/** The section's tab row: the one <nav aria-label="Compliance"> under the header. Tab names are exact: "Policies" is inside "My policies". */
const subnav = (page: Page) => page.getByRole("navigation", { name: "Compliance" });

/** The sidebar's Compliance row (expanded sidebar: the label plus the badge's sr-only sentence). */
const sidebarRow = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Compliance/ });

test("request asks with the audience count and Cancel sends nothing; Require and notify switches the policy on", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal request ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // Request lives on the Policies page of the section (B4), under the
    // shared header; the tab row lights it.
    await page.goto("/compliance/policies");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    await expect(subnav(page).getByRole("link", { name: "Policies", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Request read confirmation" })).toBeVisible();

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

    // The row shows the policy's edit default as a chip (A5), with the full
    // option sentence as its tooltip: 'ask' until anyone changes it, then
    // what the shield's popover (here the API) set.
    await expect(row.getByText("Asks editor")).toBeVisible();
    await expect(row.locator('[data-tt="When the text changes: ask the editor each time."]')).toHaveCount(1);
    const material = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { edit_default: "material" } });
    expect(material.status).toBe(200);
    expect(material.body).toMatchObject({ ok: true, ack_required: true, edit_default: "material", queued: 0 });
    expect(typeof material.body?.eligible, "every PATCH answers the full shape").toBe("number");
    await page.reload();
    await expect(row).toBeVisible();
    await expect(row.getByText("Asks when material")).toBeVisible();
    await expect(row.locator('[data-tt="When the text changes: ask only when a change looks material."]')).toHaveCount(1);
    await expect(row.getByText("Asks editor")).toHaveCount(0);

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

    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();

    // Remind: the question names the pending count and the policy, ends
    // "This cannot be undone.", and the button says what it does.
    await row.getByRole("button", { name: "Remind", exact: true }).click();
    const remind = page.getByRole("dialog", { name: /^Remind \d+ (person|people)\?$/ });
    await expect(remind).toBeVisible();
    await expect(remind.getByText(`Everyone who has not confirmed "${title}" yet`, { exact: false })).toBeVisible();
    await expect(remind.getByText("This cannot be undone.", { exact: false })).toBeVisible();
    // Cancel sends nothing.
    await remind.getByRole("button", { name: "Cancel" }).click();
    await expect(remind).toHaveCount(0);
    // Send: inside the hour after the request the server refuses, and the
    // refusal is the toast (never a silent failure).
    await row.getByRole("button", { name: "Remind", exact: true }).click();
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

test("the row's re-ask opens the question, refuses a short reason, resets the roster, and is refused inside the hour", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal reask ${stamp()}`;
  const reason = "Section 4 now applies to contractors too";
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // Required quietly: no notice, and no cooldown stamp to trip the guard.
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);

    // Nobody has confirmed: the control is off, with its tooltip, and
    // nothing can be reset.
    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    const reask = row.getByRole("button", { name: "Ask everyone to re-confirm…" });
    await expect(reask, "nothing to reset yet").toBeDisabled();
    await expect(row.locator('[data-tt="Nobody has confirmed this version yet. Use Remind."]')).toHaveCount(1);

    // The admin confirms the current version through the API; the control comes alive.
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    await confirmThrough(page, docId);
    await page.reload();
    await expect(row).toBeVisible();
    await expect(reask).toBeEnabled();

    // The question: the policy's name, the standing, one reason field, and
    // a button that says how many people it asks.
    await reask.click();
    const dialog = page.getByRole("dialog", { name: `Ask everyone to re-confirm "${title}"?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^1 of \d+ people have confirmed version 1\. This resets those confirmations/)).toBeVisible();
    const field = dialog.getByLabel("Why are readers being asked again?");
    const submit = dialog.getByRole("button", { name: "Ask 1 person to re-confirm" });
    await expect(submit).toBeVisible();

    // A short reason is refused inline; nothing is sent or audited.
    await field.fill("Too short");
    await submit.click();
    await expect(dialog.getByText("Give a reason of at least 10 characters.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect((await auditRows(page, "ack.reconfirmation_requested", docId)).length, "a refused reason writes nothing").toBe(0);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current, "and resets nothing").toBe(1);

    // Cancel sends nothing either.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.current).toBe(1);

    // A real reason: the toast counts, the roster resets, the record keeps the old row.
    await reask.click();
    await expect(dialog).toBeVisible();
    await field.fill(reason);
    await submit.click();
    await expect(page.locator('[role="status"]').getByText("1 person will be asked to re-confirm.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const after = await api(page, `/api/documents/${docId}/ack`);
    expect(after.body?.current, "everyone is pending again").toBe(0);
    expect(after.body?.pending).toBeGreaterThanOrEqual(1);
    expect(after.body?.version_id, "the marker stays on the only version").toBe(summary.body?.latest_version_id);
    expect(after.body?.last_decision?.outcome).toBe("reset");
    expect(after.body?.last_decision?.source).toBe("manual");
    expect(after.body?.last_decision?.reason).toBe(reason);
    expect(after.body?.last_decision?.confirmations_affected).toBe(1);
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(roster.status).toBe(200);
    expect(
      (roster.body?.rows ?? []).every((r: { acknowledged_at: string | null }) => !r.acknowledged_at),
      "the roster shows everyone Pending"
    ).toBe(true);
    const audited = await auditRows(page, "ack.reconfirmation_requested", docId);
    expect(audited.length).toBe(1);
    expect(audited[0].details?.reset).toBe(1);
    expect(audited[0].details?.reason).toBe(reason);
    expect(audited[0].details?.version_id).toBe(summary.body?.latest_version_id);

    // The row reloaded: 0 confirmed, so the control is off again.
    await expect(row.getByRole("button", { name: "Ask everyone to re-confirm…" })).toBeDisabled();

    // The API's own rules: the hour guard, the reason rule, and the
    // per-person list (D4): a list that is not a list, and a person with no
    // open row, are refused and write nothing.
    const again = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
      method: "POST",
      body: { reason: "Asking again straight away, for the test" },
    });
    expect(again.status, "a second ask inside the hour is 429").toBe(429);
    expect(again.body?.error).toMatch(/^Readers were asked again \d+ minutes? ago\.$/);
    const short = await api(page, `/api/documents/${docId}/ack/reconfirm`, { method: "POST", body: { reason: "short" } });
    expect(short.status).toBe(400);
    expect(short.body?.error).toBe("A reason of at least 10 characters is required.");
    const notAList = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
      method: "POST",
      body: { reason: "One person, named badly, for the test", user_ids: "1" },
    });
    expect(notAList.status).toBe(400);
    expect(notAList.body?.error).toBe("user_ids must be a list of user ids.");
    const nobody = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
      method: "POST",
      body: { reason: "One person nobody enrolled, for the test", user_ids: [2147483647] },
    });
    expect(nobody.status, "a per-person ask of someone with no open row is 400").toBe(400);
    expect(nobody.body?.error).toBe("This person isn't asked to confirm this document.");
    expect(nobody.body?.skipped).toEqual([2147483647]);
    expect((await auditRows(page, "ack.reconfirmation_requested", docId)).length, "none of the refusals is on the record").toBe(1);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("an unpublished policy is paused: it moves to the collapsed group with the chip and no actions, leaves the tiles, and comes back on republish", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal paused ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    // The admin confirms, so the row carries a confirmation the pause must keep.
    await confirmThrough(page, docId);

    type Row = { id: number; status: string; required: number; acked: number };
    const portal = async () => {
      const res = await api(page, "/api/admin/compliance");
      expect(res.status).toBe(200);
      const docs: Row[] = res.body?.docs ?? [];
      return { kpis: res.body?.kpis, docs, mine: docs.find((d) => d.id === docId) };
    };
    const live = await portal();
    expect(live.mine?.status).toBe("published");
    expect(live.mine?.acked).toBe(1);

    // Unpublish: the requirement stays on, the row stays, with its status
    // and its counts, and the tiles are the sums over the published rows
    // only (other specs run beside this one, so the invariant is checked
    // against the payload rather than against a snapshot).
    const down = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "draft" } });
    expect(down.status).toBe(200);
    expect(down.body?.doc?.status).toBe("draft");
    expect(await ackRequired(page, docId), "the requirement is not switched off").toBe(1);
    const paused = await portal();
    expect(paused.mine?.status).toBe("draft");
    expect(paused.mine?.acked, "the confirmation is kept").toBe(1);
    expect(paused.mine?.required).toBeGreaterThanOrEqual(1);
    const published = paused.docs.filter((d) => d.status === "published");
    expect(paused.kpis?.policies, "the tile counts published policies only").toBe(published.length);
    expect(paused.kpis?.required).toBe(published.reduce((n, d) => n + d.required, 0));
    expect(paused.kpis?.acked).toBe(published.reduce((n, d) => n + d.acked, 0));
    expect(paused.kpis?.outstanding).toBe(paused.kpis.required - paused.kpis.acked);

    // The Policies page: the only row with this title sits inside the
    // collapsed group, with the chip, its standing and no action at all.
    await page.goto("/compliance/policies");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    const group = page.locator("details", { hasText: "Paused (unpublished)" });
    await expect(group).toBeVisible();
    await expect(group.locator("summary")).toHaveText(/^Paused \(unpublished\) · \d+$/);
    expect(await page.locator("li", { hasText: title }).count(), "one row for the policy").toBe(1);
    const row = group.locator("li", { hasText: title });
    await expect(row).toHaveCount(1);
    await group.locator("summary").click();
    await expect(row).toBeVisible();
    await expect(row.getByText("Unpublished", { exact: true })).toBeVisible();
    await expect(
      row.locator('[data-tt="Read confirmation is paused while the document is unpublished. Confirmations are kept."]')
    ).toHaveCount(1);
    await expect(row.getByText(/^1 of \d+ (person|people) confirmed$/)).toBeVisible();
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(row.getByRole("link")).toHaveCount(0);
    // The Policies tile on the Overview page is the server's published
    // count (the payload invariant above); it is read again here because
    // other specs may have added a policy in between. The tiles are a
    // description list: the label is the term and its number the definition.
    await page.goto("/compliance/overview");
    await expect(subnav(page).getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    const tile = page.getByRole("term").filter({ hasText: /^Policies$/ }).locator("..");
    await expect(tile.getByRole("definition")).toHaveText(String((await portal()).kpis.policies));
    // The paused policy cannot be acted on through the API either.
    const remind = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "remind" } });
    expect(remind.status, "Remind needs a published document").toBe(404);

    // Republish the unchanged text: the row moves back to the live list
    // with its actions, nobody is asked again, and the group is empty.
    const up = await api(page, `/api/documents/${docId}`, { method: "PUT", body: { status: "published" } });
    expect(up.status).toBe(200);
    expect(up.body?.ack_outcome?.reset, "republishing the confirmed text asks nobody").toBe(false);
    const resumed = await portal();
    expect(resumed.mine?.status).toBe("published");
    expect(resumed.mine?.acked).toBe(1);
    await page.goto("/compliance/policies");
    const back = page.locator("li", { hasText: title });
    await expect(back).toHaveCount(1);
    await expect(page.locator("details", { hasText: "Paused (unpublished)" }).locator("li", { hasText: title })).toHaveCount(0);
    await expect(back.getByRole("button", { name: "Stop requiring" })).toBeVisible();
    await expect(back.getByRole("link", { name: "Download this policy's compliance record" })).toBeVisible();
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
    // The admin confirms the version, so one row of the matrix cites a
    // version and carries its provenance (C6).
    await confirmThrough(page, docId);

    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();

    // The Policy progress card's Export menu (1.14.0, F2; the link was the
    // page header's until the header became the section's, B4): Matrix CSV
    // is a real download with the documented name.
    await page.getByRole("button", { name: "Export" }).click();
    const [matrix] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Matrix CSV" }).click(),
    ]);
    expect(matrix.suggestedFilename()).toBe("compliance-report.csv");

    // Its content: the documented header, a row for the new policy, and on
    // the admin's confirmed row the name of whoever published the version
    // (the byline of the API-created version) with no approver.
    const text = await fetchText(page, "/api/admin/compliance?format=csv");
    expect(text.status).toBe(200);
    const lines = text.text.trim().split("\n");
    expect(lines[0]).toBe(MATRIX_HEADER);
    expect(lines.some((l) => l.startsWith(`"${title}"`)), "the policy is in the matrix").toBe(true);
    const header = cells(lines[0]);
    const publishedAt = header.indexOf("version_published_by");
    const approvedAt = header.indexOf("version_approved_by");
    const adminLine = lines
      .slice(1)
      .map(cells)
      .find((c) => c[0] === title && c[header.indexOf("username")] === ADMIN.username);
    expect(adminLine, "the admin's row for the policy").toBeTruthy();
    expect(adminLine![header.indexOf("acknowledged_at")], "it is confirmed").not.toBe("");
    expect(adminLine![publishedAt], "the version's publisher is named").not.toBe("");
    expect(adminLine![approvedAt], "no change request, no approver").toBe("");

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

test("My policies: the standing line, the two groups, the row's link to the confirmation card, the sidebar badge and the dashboard row", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E my policies ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);

    // The API behind the page: the admin's own standing, 'pending' on the
    // new policy, with the counts the standing line shows.
    const mine = await api(page, "/api/compliance/mine");
    expect(mine.status).toBe(200);
    expect(typeof mine.body?.total).toBe("number");
    expect(typeof mine.body?.confirmed).toBe("number");
    const row0 = (mine.body?.rows ?? []).find((r: { id: number }) => r.id === docId);
    expect(row0, "the policy is listed").toBeTruthy();
    expect(row0.state).toBe("pending");
    expect(row0.acknowledged_at).toBeNull();
    expect(row0.prior_acknowledged_at).toBeNull();
    expect(row0.rev).toBeNull();

    // /compliance is My policies: the section header, the lit tab, the
    // standing line and the bar, and the policy in the To confirm group with
    // its chip and its link to the confirmation card.
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    await expect(subnav(page).getByRole("link", { name: "My policies", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(/^\d+ of \d+ polic(y|ies) confirmed$/)).toBeVisible();
    const toConfirm = page.getByRole("region", { name: "To confirm" });
    await expect(toConfirm.getByRole("heading", { name: "To confirm" })).toBeVisible();
    const row = toConfirm.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/doc/${docId}#confirm-reading`);
    // The chip carries the deadline since 1.13.0 (E1): "To confirm · due {date}".
    await expect(row.getByText(/To confirm( · due .+)?$/)).toBeVisible();
    await expect(row.getByText(/^.+ · Updated /)).toBeVisible();
    // No history, print or CSV here (those wait for the person record).
    await expect(page.getByRole("link", { name: /Export CSV/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Print/ })).toHaveCount(0);

    // The sidebar's Compliance row counts the policies to confirm, and the
    // dashboard's row leads to the one policy or to My policies.
    await expect(sidebarRow(page)).toHaveAccessibleName(/^Compliance \d+ policies to confirm$/);
    await page.goto("/");
    const attention = page.getByRole("link", { name: /^\d+ polic(y needs|ies need) your read confirmation/ });
    await expect(attention).toBeVisible();
    const label = (await attention.textContent()) ?? "";
    const href = (await attention.getAttribute("href")) ?? "";
    if (/^1 policy needs/.test(label)) expect(href).toBe(`/doc/${docId}#confirm-reading`);
    else expect(href).toBe("/compliance");

    // Confirmed through the API: the row moves to the Confirmed group with
    // the date and the version, and the API agrees.
    await confirmThrough(page, docId);
    await page.goto("/compliance");
    const confirmedGroup = page.getByRole("region", { name: "Confirmed" });
    const done = confirmedGroup.locator("li", { hasText: title });
    await expect(done).toBeVisible();
    await expect(done.getByText(/Confirmed .+ · v1$/)).toBeVisible();
    await expect(page.getByRole("region", { name: "To confirm" }).locator("li", { hasText: title })).toHaveCount(0);
    const after = (await api(page, "/api/compliance/mine")).body?.rows?.find((r: { id: number }) => r.id === docId);
    expect(after?.state).toBe("confirmed");
    expect(after?.rev).toBe(1);
    expect(after?.acknowledged_at).toBeTruthy();
    // Everything confirmed (on a quiet rig): the up-to-date line under the group.
    if ((await page.getByRole("region", { name: "To confirm" }).count()) === 0) {
      await expect(confirmedGroup.getByText(/^You're up to date\. \d+ polic(y|ies) confirmed\.$/)).toBeVisible();
    }

    // A re-ask lapses the confirmation: the chip says when they last confirmed.
    const reask = await api(page, `/api/documents/${docId}/ack/reconfirm`, {
      method: "POST",
      body: { reason: "Section 4 now applies to contractors too" },
    });
    expect(reask.status, "re-asked").toBe(200);
    await page.goto("/compliance");
    const changed = page.getByRole("region", { name: "To confirm" }).locator("li", { hasText: title });
    await expect(changed).toBeVisible();
    await expect(changed.getByText(/Changed since you confirmed \S+/)).toBeVisible();
    const lapsed = (await api(page, "/api/compliance/mine")).body?.rows?.find((r: { id: number }) => r.id === docId);
    expect(lapsed?.state).toBe("reconfirm");
    expect(lapsed?.acknowledged_at).toBeNull();
    expect(lapsed?.prior_acknowledged_at).toBeTruthy();
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a viewer with a policy in scope sees the Compliance row with its badge and only the My policies tab; the portal's pages are not found", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E my policies viewer ${suffix}`;
  const viewer = { username: `e2e_mypol_${suffix}`, password: "E2eMine!12345" };
  let docId: number | undefined;
  let viewerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...viewer, role: "viewer", name: "E2E My Policies Viewer" },
    });
    expect(created.status, "viewer created").toBe(201);
    viewerId = created.body?.user?.id;
    expect(viewerId).toBeTruthy();

    const ctx = await browser.newContext();
    try {
      const vpage = await ctx.newPage();
      await login(vpage, viewer);

      // The sidebar shows the section (a policy in scope, no section grant)
      // and the badge counts the policy to confirm.
      await expect(sidebarRow(vpage)).toBeVisible();
      await expect(sidebarRow(vpage)).toHaveAccessibleName(/^Compliance \d+ policies to confirm$/);

      // My policies lists it; the tab row holds My policies and nothing else.
      await vpage.goto("/compliance");
      await expect(vpage.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      const tabs = subnav(vpage).getByRole("link");
      await expect(tabs).toHaveCount(1);
      await expect(tabs.first()).toHaveText("My policies");
      const row = vpage.getByRole("region", { name: "To confirm" }).locator("li", { hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/doc/${docId}#confirm-reading`);
      await expect(row.getByText(/To confirm( · due .+)?$/)).toBeVisible();

      // The person's own API opens; the portal's does not, and its pages
      // answer the shell's not-found page, as /training/person does.
      const mine = await api(vpage, "/api/compliance/mine");
      expect(mine.status).toBe(200);
      expect(mine.body?.rows?.some((r: { id: number; state: string }) => r.id === docId && r.state === "pending")).toBe(true);
      expect((await api(vpage, "/api/admin/compliance")).status, "the portal needs program_read").toBe(403);
      for (const path of ["/compliance/overview", "/compliance/policies", "/compliance/people", "/compliance/settings"]) {
        await vpage.goto(path);
        await expect(vpage.getByRole("heading", { name: "Page not found" }), path).toBeVisible();
      }

      // Confirmed as the viewer (the card's POST; the summary it cites is
      // the admin's to read): the row moves to Confirmed and the badge
      // drops with it (the only policy this account owes on a quiet rig).
      await confirmThrough(page, docId, vpage);
      await vpage.goto("/compliance");
      await expect(vpage.getByRole("region", { name: "Confirmed" }).locator("li", { hasText: title })).toBeVisible();
      if ((await vpage.getByRole("region", { name: "To confirm" }).count()) === 0) {
        await expect(sidebarRow(vpage)).toHaveAccessibleName("Compliance");
      }
    } finally {
      await ctx.close();
    }
  } finally {
    if (viewerId) await api(page, `/api/admin/users/${viewerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a retired policy sits in the collapsed Retired group with its chip, count and reason and no row actions but Un-retire; Un-retire restores it; the live row's Retire policy… asks for a reason", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const title = `E2E portal retired ${stamp()}`;
  const REASON = "Superseded by the new expense policy";
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    // The admin confirms, so the retirement freezes one confirmation of version 1.
    await confirmThrough(page, docId);

    // Retired through the API: the requirement is off, the row stays in the
    // payload as retired, and the tiles leave it out.
    const retired = await api(page, `/api/documents/${docId}/ack/retire`, { method: "POST", body: { reason: REASON } });
    expect(retired.status, "retired").toBe(200);
    expect(retired.body).toMatchObject({ ok: true, acked: 1, rev: 1 });
    expect(await ackRequired(page, docId)).toBe(0);
    // The portal's POST refuses every action on a retired policy, and
    // nothing is switched on behind the refusal: un-retire is the only way
    // back.
    for (const action of ["request", "remind", "stop"] as const) {
      const r = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action, notify: false } });
      expect(r.status, `${action} on a retired policy`).toBe(409);
      expect(r.body?.error).toBe("This policy is retired. Un-retire it first.");
    }
    expect(await ackRequired(page, docId), "nothing switched on").toBe(0);
    const view = await api(page, "/api/admin/compliance");
    expect(view.status).toBe(200);
    const row0 = (view.body?.docs ?? []).find((d: { id: number }) => d.id === docId);
    expect(row0?.ack_retired_at).toBeTruthy();
    expect(row0?.ack_retired_reason).toBe(REASON);
    expect(row0?.retired_rev).toBe(1);
    const live = (view.body?.docs ?? []).filter(
      (d: { status: string; ack_retired_at: string | null }) => d.status === "published" && d.ack_retired_at === null
    );
    expect(view.body?.kpis?.policies, "the tile counts live policies only").toBe(live.length);

    // The Policies page: the only row with this title sits inside the
    // collapsed Retired group, after Paused, with the chip, the frozen
    // standing, the reason, the record link and the CSV, and no Remind,
    // re-ask or Stop requiring.
    await page.goto("/compliance/policies");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    const group = page.locator("details", { hasText: /Retired · \d+/ });
    await expect(group).toBeVisible();
    await expect(group.locator("summary")).toHaveText(/^Retired · \d+$/);
    expect(await page.locator("li", { hasText: title }).count(), "one row for the policy").toBe(1);
    const row = group.locator("li", { hasText: title });
    await expect(row).toHaveCount(1);
    await group.locator("summary").click();
    await expect(row).toBeVisible();
    await expect(row.getByText(/Retired \S/)).toBeVisible();
    await expect(row.getByText(/^1 of \d+ (person|people) confirmed v1$/)).toBeVisible();
    await expect(row.getByText(REASON)).toBeVisible();
    await expect(row.getByRole("link", { name: "View record" })).toHaveAttribute("href", `/doc/${docId}/acknowledgements`);
    await expect(row.getByRole("link", { name: "Download this policy's compliance record" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Remind", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Ask everyone to re-confirm…" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Stop requiring" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Retire policy…" })).toHaveCount(0);
    const unretire = row.getByRole("button", { name: "Un-retire" });
    await expect(unretire).toBeVisible();

    // Un-retire asks once; Cancel changes nothing.
    await unretire.click();
    const resume = page.getByRole("dialog", { name: `Resume read confirmation for "${title}"?` });
    await expect(resume).toBeVisible();
    await expect(resume.getByText("Confirmations made before it was retired stay on record.", { exact: false })).toBeVisible();
    await resume.getByRole("button", { name: "Cancel" }).click();
    await expect(resume).toHaveCount(0);
    expect(await ackRequired(page, docId), "Cancel leaves the policy retired").toBe(0);

    // Resume: the toast carries the standing, the requirement is back, the
    // row returns to the live list with its actions, and the group lets go.
    await unretire.click();
    await expect(resume).toBeVisible();
    await resume.getByRole("button", { name: "Resume" }).click();
    await expect(
      page.locator('[role="status"]').getByText(/^Policy resumed: 1 of \d+ confirmations still current$/)
    ).toBeVisible();
    expect(await ackRequired(page, docId)).toBe(1);
    const back = page.locator("li", { hasText: title });
    await expect(back).toHaveCount(1);
    await expect(page.locator("details", { hasText: /Retired · \d+/ }).locator("li", { hasText: title })).toHaveCount(0);
    await expect(back.getByRole("button", { name: "Stop requiring" })).toBeVisible();
    // Un-retire unmounted the button that was used; focus lands on the
    // resumed row's disclosure button, never on <body>.
    await expect(back.locator("button[aria-expanded]"), "focus after the un-retire toast").toBeFocused();
    const after = (await api(page, "/api/admin/compliance")).body?.docs?.find((d: { id: number }) => d.id === docId);
    expect(after?.ack_retired_at).toBeNull();
    expect(after?.acked, "the prior confirmation is current again").toBe(1);

    // The live row's own Retire policy…: the question names the standing,
    // Cancel sends nothing, a short reason is refused inline, a real one
    // retires with a toast and the row goes back to the group.
    const retire = back.getByRole("button", { name: "Retire policy…" });
    await expect(retire).toBeVisible();
    await retire.click();
    const dialog = page.getByRole("dialog", { name: `Retire "${title}"?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^1 of \d+ people have confirmed version 1\. Retiring stops asking anyone to confirm/)).toBeVisible();
    const field = dialog.getByLabel("Why is this policy being retired?");
    const submit = dialog.getByRole("button", { name: "Retire policy" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await ackRequired(page, docId), "Cancel retires nothing").toBe(1);
    await retire.click();
    await expect(dialog).toBeVisible();
    await field.fill("Too short");
    await submit.click();
    await expect(dialog.getByText("Give a reason of at least 10 characters.")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(await ackRequired(page, docId), "a refused reason retires nothing").toBe(1);
    await field.fill(REASON);
    await submit.click();
    await expect(
      page.locator('[role="status"]').getByText(/^Policy retired: 1 of \d+ confirmations on record$/)
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(await ackRequired(page, docId)).toBe(0);
    const movedRow = page.locator("details", { hasText: /Retired · \d+/ }).locator("li", { hasText: title });
    await expect(movedRow).toHaveCount(1);
    // Retire unmounted the button that was used; the group opens and focus
    // lands on the moved row's "View record", never on <body>.
    await expect(movedRow.getByRole("link", { name: "View record" }), "focus after the retire toast").toBeFocused();
    const audited = await auditRows(page, "ack.retired", docId);
    expect(audited.length, "both retirements are on the record").toBe(2);
    expect(audited[0].details?.reason).toBe(REASON);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("the Overview's fifth tile counts re-confirmations due in 30 days, and a policy with an interval shows its next date on the row", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  const title = `E2E portal recert ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);

    type Row = { id: number; status: string; ack_retired_at: string | null; ack_recert_months: number | null; ack_next_recert_at: string | null };
    const portal = async () => {
      const res = await api(page, "/api/admin/compliance");
      expect(res.status).toBe(200);
      const docs: Row[] = res.body?.docs ?? [];
      // The tile's rule, recomputed from the payload: live rows whose next
      // date falls within 30 days (other specs add policies beside this one).
      const limit = Date.now() + 30 * 86_400_000;
      const due = docs.filter(
        (d) =>
          d.status === "published" &&
          d.ack_retired_at === null &&
          d.ack_recert_months !== null &&
          d.ack_next_recert_at !== null &&
          new Date(d.ack_next_recert_at).getTime() <= limit
      ).length;
      return { kpis: res.body?.kpis, mine: docs.find((d) => d.id === docId), due };
    };
    const before = await portal();
    expect(typeof before.kpis?.recert_due_30, "the fifth number is in the payload").toBe("number");
    expect(before.kpis.recert_due_30).toBe(before.due);

    // A yearly interval through the Settings tab's route: the next date is
    // scheduled a year from the marker, and the row says so.
    const yearly = await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { recert_months: 12 } });
    expect(yearly.status, "the interval is set").toBe(200);
    const withCycle = await portal();
    expect(withCycle.mine?.ack_recert_months).toBe(12);
    expect(withCycle.mine?.ack_next_recert_at).toBeTruthy();
    expect(new Date(withCycle.mine!.ack_next_recert_at!).getTime(), "a year out, not within 30 days").toBeGreaterThan(
      Date.now() + 31 * 86_400_000
    );
    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(/· Next re-confirmation \S/)).toBeVisible();
    // The Record tab's subtitle counts the cycle and names the cadence.
    await page.goto(`/doc/${docId}/acknowledgements`);
    await expect(page.getByText(/· Cycle 1 · annual$/)).toBeVisible();

    // The next date moved to tomorrow: the policy joins the tile's count,
    // and the Overview shows the server's number.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const soon = await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { next_recert_at: tomorrow } });
    expect(soon.status, "the next date moved").toBe(200);
    const dueSoon = await portal();
    expect(dueSoon.kpis.recert_due_30).toBeGreaterThanOrEqual(1);
    expect(dueSoon.kpis.recert_due_30).toBe(dueSoon.due);
    await page.goto("/compliance/overview");
    await expect(subnav(page).getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    const tile = page.getByRole("term").filter({ hasText: "Re-confirmation due in 30 days" }).locator("..");
    await expect(tile.getByRole("definition")).toHaveText(String((await portal()).kpis.recert_due_30));

    // A retired policy leaves the count, whatever its date.
    const retired = await api(page, `/api/documents/${docId}/ack/retire`, {
      method: "POST",
      body: { reason: "Retired for the re-confirmation tile test" },
    });
    expect(retired.status).toBe(200);
    const afterRetire = await portal();
    expect(afterRetire.kpis.recert_due_30).toBe(afterRetire.due);
    expect(afterRetire.kpis.recert_due_30).toBe(dueSoon.kpis.recert_due_30 - 1);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a live row links to the policy's Settings tab, counts the people enrolled this week, reads its deadline rule and its reminder cadence; the Overview's Overdue tile and the People page's Overdue column carry the server's numbers", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E portal due ${suffix}`;
  const joiner = { username: `e2e_joiner_${suffix}`, password: "E2eJoin!12345" };
  let docId: number | undefined;
  let joinerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    // Required quietly: no notice and no reminder stamp, so the cadence
    // line starts from "never reminded" and Remind is allowed below.
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);

    type Row = {
      id: number;
      status: string;
      ack_retired_at: string | null;
      required: number;
      overdue: number;
      enrolled_week: number;
      due_rule: { due_days: number | null; due_at: string | null; resolved_days: number } | null;
      reminder: { last_reminded_at: string | null; next_reminder_at: string | null } | null;
    };
    const portal = async () => {
      const res = await api(page, "/api/admin/compliance");
      expect(res.status).toBe(200);
      const docs: Row[] = res.body?.docs ?? [];
      const live = docs.filter((d) => d.status === "published" && d.ack_retired_at === null);
      return { kpis: res.body?.kpis, users: res.body?.users ?? [], mine: docs.find((d) => d.id === docId)!, live };
    };

    // The payload: the four new row fields with their shapes, the overdue
    // sum over the live rows, and a per-person overdue count. A policy
    // switched on a moment ago has nobody overdue and everyone it asks
    // enrolled this week.
    const first = await portal();
    expect(first.mine, "the policy is in the payload").toBeTruthy();
    expect(first.mine.overdue, "nobody is past a deadline set a moment ago").toBe(0);
    expect(first.mine.enrolled_week, "everyone the switch-on enrolled joined this week").toBe(first.mine.required);
    expect(first.mine.due_rule).toMatchObject({ due_days: null, due_at: null });
    expect(first.mine.due_rule!.resolved_days, "the cascade settles on a number of days").toBeGreaterThanOrEqual(1);
    expect(first.mine.reminder?.last_reminded_at, "a quiet request reminds nobody").toBeNull();
    expect(first.mine.reminder?.next_reminder_at, "the sweep has a date for the first reminder").toBeTruthy();
    expect(typeof first.kpis?.overdue, "the Overdue tile's number is in the payload").toBe("number");
    expect(first.kpis.overdue).toBe(first.live.reduce((n, d) => n + d.overdue, 0));
    const me = first.users.find((u: { username: string }) => u.username === ADMIN.username);
    expect(typeof me?.overdue, "every person carries an overdue count").toBe("number");

    // The row: the icon button to the Settings tab, the audience line with
    // the deadline rule (no overdue suffix), the cadence line.
    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    const settings = row.getByRole("link", { name: "Read confirmation settings" });
    await expect(settings).toHaveAttribute("href", `/doc/${docId}/acknowledgements/settings`);
    await expect(row.locator('[data-tt="Read confirmation settings"]')).toHaveCount(1);
    await expect(row.getByText(/· Due \d+ days after assignment$/)).toBeVisible();
    await expect(row.getByText(/\d+ overdue/)).toHaveCount(0);
    await expect(row.getByText(/^never reminded · next automatic reminder \S/)).toBeVisible();
    await settings.click();
    await page.waitForURL(`**/doc/${docId}/acknowledgements/settings`);
    await expect(page.getByRole("heading", { name: "Confirmation statement" })).toBeVisible();

    // A new account joins the audience (D1 enrols it on arrival): the row's
    // count rises by one and the line says so.
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...joiner, role: "viewer", name: "E2E Portal Joiner" },
    });
    expect(created.status, "joiner created").toBe(201);
    joinerId = created.body?.user?.id;
    expect(joinerId).toBeTruthy();
    const joined = await portal();
    expect(joined.mine.enrolled_week, "one more person enrolled this week").toBe(first.mine.enrolled_week + 1);
    expect(joined.mine.required).toBe(first.mine.required + 1);
    await page.goto("/compliance/policies");
    await expect(row.getByText(`+${joined.mine.enrolled_week} enrolled this week`)).toBeVisible();

    // The policy's own rule through the Settings tab's route (E1): the row
    // reads the new number of days; the payload carries it as the policy's
    // own, and nobody is overdue on a deadline still ahead.
    const days = await api(page, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { due_days: 5 } });
    expect(days.status, "the deadline rule is set").toBe(200);
    const ruled = await portal();
    expect(ruled.mine.due_rule).toMatchObject({ due_days: 5, due_at: null, resolved_days: 5 });
    expect(ruled.mine.overdue).toBe(0);
    await page.goto("/compliance/policies");
    await expect(row.getByText(/· Due 5 days after assignment$/)).toBeVisible();

    // Remind: the question, the toast, and the cadence line now dated from
    // the reminder the people just got (the manual Remind stamps the rows).
    await row.getByRole("button", { name: "Remind", exact: true }).click();
    const remind = page.getByRole("dialog", { name: /^Remind \d+ (person|people)\?$/ });
    await expect(remind).toBeVisible();
    await remind.getByRole("button", { name: "Send reminders" }).click();
    await expect(page.locator('[role="status"]').getByText(/^Reminders queued for \d+ (person|people)\.$/)).toBeVisible();
    await expect(row.getByText(/^last reminded today · next automatic reminder \S/)).toBeVisible();
    const reminded = await portal();
    expect(reminded.mine.reminder?.last_reminded_at, "the summary carries the stamp").toBeTruthy();

    // The Overview's Overdue tile is the server's number, and the People
    // page's Overdue column reads 0 for the admin on a quiet rig (the
    // chip appears only past a deadline, which test/ack-portal.test.ts
    // proves against the database).
    await page.goto("/compliance/overview");
    await expect(subnav(page).getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    const tile = page.getByRole("term").filter({ hasText: /^Overdue$/ }).locator("..");
    await expect(tile.getByRole("definition")).toContainText(String((await portal()).kpis.overdue));
    await page.goto("/compliance/people");
    await expect(page.getByRole("columnheader", { name: "Overdue" })).toBeVisible();
    const adminRow = page.getByRole("row").filter({ hasText: me?.name || ADMIN.username }).first();
    if ((me?.overdue ?? 0) === 0 && (await adminRow.count()) > 0) {
      await expect(adminRow.getByText(/\d+ overdue/)).toHaveCount(0);
    }
  } finally {
    if (joinerId) await api(page, `/api/admin/users/${joinerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.13.0 (D2): the roster inside the portal's expand row on a phone. Its
// Show control grew to five choices (All / Pending / Overdue / Confirmed /
// Exempt), which a Segmented cannot wrap, so the toolbar above the table
// (View / Show / Filter people) must fit inside the card at the tightest
// common width; the table itself scrolls inside its own wrapper, by design.
test("at 375px the expanded policy row's roster toolbar fits without sideways scroll", async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const title = `E2E portal phone ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);

    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await row.locator("button[aria-expanded]").click();
    const roster = page.locator(`[data-roster="${docId}"]`);
    await expect(roster).toBeVisible();
    const show = roster.getByRole("radiogroup", { name: "Show" });
    await expect(show.getByRole("radio", { name: "Exempt", exact: true })).toBeVisible();
    const toolbar = show.locator("..");
    const overflow = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the roster toolbar does not scroll sideways").toBeLessThanOrEqual(0);
    const spill = await show.evaluate((el) => el.getBoundingClientRect().right - el.closest("[data-roster]")!.getBoundingClientRect().right);
    expect(spill, "the Show control stays inside the roster's box").toBeLessThanOrEqual(0);
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    await ctx.close();
  }
});

// 1.14.0 (F1): the seven tiles over the live policies and the Needs
// attention queue. The portal's assignments route exempts and snoozes the
// joiner's row (D2), the kept edit drifts the policy (C1), and the queue's
// own "Ask everyone to re-confirm…" clears the drift row.
test("the Overview's tiles carry the server's numbers, an exempt row counts in Exempt, a snooze moves only the snoozed count, and a drifted policy is a queue row whose re-ask clears it", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E portal tiles ${suffix}`;
  const joiner = { username: `e2e_tiles_${suffix}`, password: "E2eTile!12345" };
  let docId: number | undefined;
  let joinerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    // A joiner enrolled on arrival (D1): an open row of a plain viewer to
    // exempt and snooze without touching the admin's own.
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...joiner, role: "viewer", name: "E2E Tiles Joiner" },
    });
    expect(created.status, "joiner created").toBe(201);
    joinerId = created.body?.user?.id;
    expect(joinerId).toBeTruthy();

    type Kpis = {
      policies: number;
      pct: number;
      outstanding: number;
      overdue: number;
      overdue_people: number;
      due_7d: number;
      pending: number;
      exempt: number;
      escalated: number;
      snoozed: number;
      drifted: number;
      recert_due_30: number;
    };
    type QueueRow = { reason: string; document_id: number; user_id: number | null; detail: string | null };
    type Doc = { id: number; drift_pct: number | string; kept_since_reset: number };
    const portal = async () => {
      const res = await api(page, "/api/admin/compliance");
      expect(res.status).toBe(200);
      return {
        kpis: res.body?.kpis as Kpis,
        attention: res.body?.attention as { rows: QueueRow[]; total: number; snoozed: number },
        docs: (res.body?.docs ?? []) as Doc[],
      };
    };
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(roster.status).toBe(200);
    const joinerRow = (roster.body?.rows ?? []).find((r: { id: number }) => r.id === joinerId);
    expect(joinerRow, "the joiner is on the roster").toBeTruthy();
    const assignmentId = Number(joinerRow.assignment_id);
    expect(assignmentId).toBeGreaterThan(0);

    // The payload: the seven keys, pending as the new name of outstanding,
    // and the queue beside the tiles.
    const first = await portal();
    for (const key of ["overdue_people", "due_7d", "pending", "exempt", "escalated", "snoozed", "drifted"] as const) {
      expect(typeof first.kpis[key], key).toBe("number");
    }
    expect(first.kpis.pending).toBe(first.kpis.outstanding);
    expect(Array.isArray(first.attention?.rows), "the queue is in the payload").toBe(true);
    expect(typeof first.attention.total).toBe("number");
    expect(typeof first.attention.snoozed).toBe("number");

    // The tiles: a description list, the label the term and the server's
    // number its definition; Overdue carries the people behind it.
    await page.goto("/compliance/overview");
    await expect(subnav(page).getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    const tile = (label: string) =>
      page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").getByRole("definition");
    const k = (await portal()).kpis;
    await expect(tile("Policies")).toHaveText(String(k.policies));
    await expect(tile("Compliance")).toHaveText(`${k.pct}%`);
    await expect(tile("Overdue")).toContainText(String(k.overdue));
    await expect(tile("Overdue")).toContainText(/\d+ (person|people)$/);
    await expect(tile("Due in 7 days")).toHaveText(String(k.due_7d));
    await expect(tile("Pending")).toHaveText(String(k.pending));
    await expect(tile("Exempt")).toHaveText(String(k.exempt));
    // The seventh tile (G1) stays beside the six.
    await expect(tile("Re-confirmation due in 30 days")).toHaveText(String(k.recert_due_30));
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();

    // Exempt the joiner (D2): Exempt rises by one and Pending drops by one
    // (the row leaves the denominator); the tiles follow on reload.
    const exempted = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "exempt", assignment_ids: [assignmentId], reason: "E2E exemption for the Exempt tile" },
    });
    expect(exempted.status, "exempted").toBe(200);
    expect(exempted.body?.changed).toEqual([assignmentId]);
    const afterExempt = await portal();
    expect(afterExempt.kpis.exempt).toBe(first.kpis.exempt + 1);
    expect(afterExempt.kpis.pending).toBe(first.kpis.pending - 1);
    await page.reload();
    await expect(tile("Exempt")).toHaveText(String(afterExempt.kpis.exempt));
    await expect(tile("Pending")).toHaveText(String(afterExempt.kpis.pending));

    // Pending again, then snoozed: the D2 invariant on the tiles. Only the
    // snoozed count moves; Overdue, Pending and Exempt hold.
    const unexempted = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "unexempt", assignment_ids: [assignmentId] },
    });
    expect(unexempted.status, "pending again").toBe(200);
    const open = await portal();
    expect(open.kpis.pending).toBe(first.kpis.pending);
    expect(open.kpis.exempt).toBe(first.kpis.exempt);
    const snoozed = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "snooze", assignment_ids: [assignmentId], days: 7 },
    });
    expect(snoozed.status, "snoozed").toBe(200);
    expect(snoozed.body?.until).toBeTruthy();
    const afterSnooze = await portal();
    expect(afterSnooze.kpis.snoozed).toBe(open.kpis.snoozed + 1);
    expect(afterSnooze.kpis.overdue).toBe(open.kpis.overdue);
    expect(afterSnooze.kpis.pending).toBe(open.kpis.pending);
    expect(afterSnooze.kpis.exempt).toBe(open.kpis.exempt);
    await page.reload();
    await expect(tile("Overdue")).toContainText(String(afterSnooze.kpis.overdue));
    await expect(tile("Pending")).toHaveText(String(afterSnooze.kpis.pending));

    // A drifted policy (C1 into F1): the admin confirms v1, then a material
    // edit is kept against the suggestion, moving the text past the re-ask
    // threshold. The queue lists the policy once, at the top, with the
    // drift chip, the policy linking to its Record tab, and the deliberate
    // re-ask as its one action.
    await confirmThrough(page, docId);
    const kept = await api(page, `/api/documents/${docId}`, {
      method: "PUT",
      body: {
        content: `${BODY}\n\nContractors and temporary staff must also read and confirm this policy every year, before any site access is granted.`,
        status: "published",
        ack_policy: "keep",
        ack_reason: "Keeping the confirmations for the queue test",
        versionNote: "Drift for the queue",
      },
    });
    expect(kept.status, "the edit is kept").toBe(200);
    expect(kept.body?.ack_outcome?.policy).toBe("keep");
    const drifted = await portal();
    const mine = drifted.docs.find((d) => d.id === docId);
    expect(Number(mine?.drift_pct), "the kept edit drifted the text past the threshold").toBeGreaterThanOrEqual(5);
    expect(mine?.kept_since_reset).toBe(1);
    expect(drifted.kpis.drifted).toBeGreaterThanOrEqual(1);
    const queued = drifted.attention.rows.find((r) => r.reason === "drifted" && r.document_id === docId);
    expect(queued, "the policy is a queue row").toBeTruthy();
    expect(queued!.detail).toMatch(/^\d+(\.\d+)?% since v1$/);
    expect(queued!.user_id, "a policy-level row names nobody").toBeNull();

    await page.reload();
    const queue = page.locator("#needs-attention");
    await expect(queue.getByText(/^(showing \d+ of \d+|\d+)( · \d+ snoozed)?$/)).toBeVisible();
    const row = queue.locator("li", { hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row.getByText(`Confirmed text drifted ${queued!.detail}`)).toBeVisible();
    await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/doc/${docId}/acknowledgements`);
    await expect(row.getByRole("button", { name: "Snooze" })).toHaveCount(0);
    const reask = row.getByRole("button", { name: "Ask everyone to re-confirm…" });
    await expect(reask).toBeEnabled();
    await reask.click();
    const dialog = page.getByRole("dialog", { name: `Ask everyone to re-confirm "${title}"?` });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Why are readers being asked again?").fill("The contractor clause changed what everyone agreed to");
    await dialog.getByRole("button", { name: "Ask 1 person to re-confirm" }).click();
    await expect(page.locator('[role="status"]').getByText("1 person will be asked to re-confirm.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // The marker moved to the kept text: nothing has drifted since, and
    // the row is gone from the queue and the payload.
    await expect(row).toHaveCount(0);
    const cleared = await portal();
    expect(cleared.attention.rows.some((r) => r.document_id === docId && r.reason === "drifted")).toBe(false);
    expect(cleared.docs.find((d) => d.id === docId)?.kept_since_reset).toBe(0);
  } finally {
    if (joinerId) await api(page, `/api/admin/users/${joinerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.14.0 (F1, D3, F2): the live row's stacked bar and legend, the Sort and
// filter controls, the set chip and "In set" once a set names the policy
// (through the sets routes), and the Export menu with its four items.
test("a live row's stacked bar and legend, the Sort and the filter, the set chip and In set after a set is assigned, and the Export menu's four items", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E portal bar ${suffix}`;
  const setName = `E2E onboarding set ${suffix}`;
  let docId: number | undefined;
  let setId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    // One confirmation, so the bar has a confirmed segment beside the pending one.
    await confirmThrough(page, docId);

    type Doc = {
      id: number;
      required: number;
      acked: number;
      confirmed: number;
      pending: number;
      overdue: number;
      exempt: number;
      owner_name: string | null;
      set_names: string[];
      edit_default: string;
    };
    const view = await api(page, "/api/admin/compliance");
    expect(view.status).toBe(200);
    const mine = (view.body?.docs ?? []).find((d: Doc) => d.id === docId) as Doc | undefined;
    expect(mine, "the policy is in the payload").toBeTruthy();
    expect(mine!.confirmed).toBe(1);
    expect(mine!.pending).toBe(mine!.required - 1);
    expect(mine!.exempt).toBe(0);
    expect(mine!.set_names).toEqual([]);
    expect(mine!.edit_default).toBe("ask");

    // The row: the bar's accessible name and its legend carry the same four
    // numbers; the owner (whoever switched the requirement on, by the
    // cascade's last tier) sits on the subtitle when the server names one.
    await page.goto("/compliance/policies");
    const row = page.locator("li", { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByRole("img", { name: `1 confirmed, ${mine!.pending} pending, 0 overdue, 0 exempt` })).toBeVisible();
    await expect(row.getByText(`1 confirmed · ${mine!.pending} pending · 0 overdue · 0 exempt`)).toBeVisible();
    if (mine!.owner_name) await expect(row.getByText(`· owner ${mine!.owner_name}`)).toBeVisible();
    await expect(row.getByText("Asks editor")).toBeVisible();

    // Sort: the four orders, by their captioned Select; the row stays
    // wherever the order puts it. Filter: the one row and its count.
    const sort = page.getByRole("combobox", { name: "Sort" });
    await expect(sort.locator("option")).toHaveText(["Most overdue", "Lowest compliance", "Due soonest", "Title A-Z"]);
    await sort.selectOption("title");
    await expect(row).toBeVisible();
    await sort.selectOption("due");
    await expect(row).toBeVisible();
    const filter = page.getByRole("textbox", { name: "Filter policies" });
    await filter.fill(title);
    await expect(page.getByText(/^1 of \d+ policies$/)).toBeVisible();
    await expect(row).toBeVisible();
    await filter.fill(`${title} nothing like this`);
    await expect(page.getByText("No policies match your filter.")).toBeVisible();
    await filter.fill("");
    await expect(row).toBeVisible();

    // A set that names the policy (D3): created and assigned to the admin
    // through the sets routes. The policy is in space mode, so the set does
    // not narrow it; the row still shows the set chip, and "In set" narrows
    // the list to the set's policies.
    const made = await api(page, "/api/admin/compliance/sets", {
      method: "POST",
      body: { name: setName, doc_ids: [docId], assign_new_members: false },
    });
    expect(made.status, "set created").toBe(201);
    setId = made.body?.set?.id;
    expect(setId).toBeTruthy();
    const me = (view.body?.users ?? []).find((u: { username: string }) => u.username === ADMIN.username);
    expect(me?.id, "the admin's own row").toBeTruthy();
    const assigned = await api(page, `/api/admin/compliance/sets/${setId}`, { method: "POST", body: { user_ids: [me.id] } });
    expect(assigned.status, "set assigned").toBe(200);
    expect(assigned.body?.policies).toBe(1);
    expect(Array.isArray(assigned.body?.not_narrowed)).toBe(true);
    const tagged = (await api(page, "/api/admin/compliance")).body?.docs?.find((d: Doc) => d.id === docId) as Doc | undefined;
    expect(tagged?.set_names).toEqual([setName]);
    await page.reload();
    await expect(row).toBeVisible();
    await expect(row.getByText(setName)).toBeVisible();
    const inSet = page.getByRole("combobox", { name: "In set" });
    await expect(inSet).toBeVisible();
    await inSet.selectOption({ label: setName });
    await expect(row).toBeVisible();
    await expect(page.getByText(/^1 policies$/)).toBeVisible();
    await inSet.selectOption("");

    // The Export menu (F2): a menu button with the four items in order,
    // Matrix CSV a real download; the old link is gone.
    await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
    const exportButton = page.getByRole("button", { name: "Export" });
    await expect(exportButton).toHaveAttribute("aria-haspopup", "menu");
    await expect(exportButton).toHaveAttribute("aria-expanded", "false");
    await exportButton.click();
    const menu = page.getByRole("menu", { name: "Export" });
    await expect(menu).toBeVisible();
    await expect(exportButton).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem")).toHaveText(["Matrix CSV", "Ledger CSV", "Audit package (ZIP)", "Print…"]);
    const [matrix] = await Promise.all([page.waitForEvent("download"), menu.getByRole("menuitem", { name: "Matrix CSV" }).click()]);
    expect(matrix.suggestedFilename()).toBe("compliance-report.csv");
    await expect(menu).toHaveCount(0);
    await exportButton.click();
    const [pack] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "Audit package (ZIP)" }).click(),
    ]);
    expect(pack.suggestedFilename()).toMatch(/^compliance-audit-package-\d{4}-\d{2}-\d{2}\.zip$/);
  } finally {
    if (setId) await api(page, `/api/admin/compliance/sets/${setId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.14.0 (F1, F3): the People page's Standing chip, its Show control and
// filter, and the person's link to their compliance record.
test("the People page's Standing chip, its Show control and filter, and the person's record link", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E portal standing ${suffix}`;
  const joiner = { username: `e2e_standing_${suffix}`, password: "E2eStand!12345" };
  const joinerName = "E2E Standing Joiner";
  let docId: number | undefined;
  let joinerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    const created = await api(page, "/api/admin/users", {
      method: "POST",
      body: { ...joiner, role: "viewer", name: joinerName },
    });
    expect(created.status, "joiner created").toBe(201);
    joinerId = created.body?.user?.id;
    expect(joinerId).toBeTruthy();

    type Person = { id: number; required: number; acked: number; overdue: number; exempt: number };
    const personRow = async (): Promise<Person> => {
      const res = await api(page, "/api/admin/compliance");
      expect(res.status).toBe(200);
      const u = (res.body?.users ?? []).find((x: Person) => x.id === joinerId);
      expect(u, "the joiner has a row").toBeTruthy();
      return u;
    };
    // The chip's rule, from the payload: everything confirmed is Compliant,
    // anything overdue "{n} overdue", else "{n} outstanding".
    const standing = (u: Person) =>
      u.acked >= u.required ? "Compliant" : u.overdue > 0 ? `${u.overdue} overdue` : `${u.required - u.acked} outstanding`;
    const before = await personRow();
    expect(before.required).toBeGreaterThanOrEqual(1);
    expect(before.acked).toBe(0);
    expect(typeof before.exempt).toBe("number");

    await page.goto("/compliance/people");
    await expect(subnav(page).getByRole("link", { name: "People", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("columnheader", { name: "Standing" })).toBeVisible();
    const show = page.getByRole("radiogroup", { name: "Show" });
    await expect(show.getByRole("radio")).toHaveText(["All", "Outstanding", "Overdue", "Compliant"]);
    const filter = page.getByRole("textbox", { name: "Filter people" });
    await filter.fill(joiner.username);
    await expect(page.getByText(/^1 of \d+ people$/)).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: joinerName });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("link", { name: joinerName })).toHaveAttribute("href", `/compliance/person/${joinerId}`);
    await expect(row.getByText(standing(before), { exact: true })).toBeVisible();
    // Compliant hides the joiner (nothing confirmed), Outstanding shows them,
    // Overdue follows their overdue count.
    await show.getByRole("radio", { name: "Compliant" }).click();
    await expect(row).toHaveCount(0);
    await show.getByRole("radio", { name: "Overdue" }).click();
    await expect(row).toHaveCount(before.overdue > 0 ? 1 : 0);
    await show.getByRole("radio", { name: "Outstanding" }).click();
    await expect(row).toHaveCount(1);

    // Confirmed as the joiner: the chip follows the payload (Compliant when
    // this is the only policy they owe, on a quiet rig).
    const ctx = await browser.newContext();
    try {
      const vpage = await ctx.newPage();
      await login(vpage, joiner);
      await confirmThrough(page, docId, vpage);
    } finally {
      await ctx.close();
    }
    const after = await personRow();
    expect(after.acked).toBe(before.acked + 1);
    await page.reload();
    await page.getByRole("textbox", { name: "Filter people" }).fill(joiner.username);
    const again = page.getByRole("row").filter({ hasText: joinerName });
    await expect(again).toHaveCount(1);
    await expect(again.getByText(standing(after), { exact: true })).toBeVisible();
    if (after.acked >= after.required) {
      await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Compliant" }).click();
      await expect(again).toHaveCount(1);
    }
  } finally {
    if (joinerId) await api(page, `/api/admin/users/${joinerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
