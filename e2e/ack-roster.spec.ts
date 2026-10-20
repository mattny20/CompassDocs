import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.13.0 (D2, D4, E1): the Record tab's roster (AckRoster) carries each
// person's assignment. Columns Due (the deadline the policy's rule gave the
// row; blank without one) and Exemption (the reason, who recorded it and
// until when; a per-person re-ask's reason; a snooze); the Show filter gains
// Overdue and Exempt; a viewer who may act gets a leading checkbox column,
// row actions as icon buttons (Extend due date…, Exempt…, Remove exemption,
// Pause reminders until {date} / Unsnooze, Ask to re-confirm…) and a bulk
// bar "{n} selected" with the same actions over the checked rows. Every
// action tells and offers Undo (the inverse call); the re-ask offers none.
//
// The admin is the viewer (program_manage and the space key alike) and
// cannot exempt their own row (the server's rule), so a second account in
// the sample space is the person exempted, extended and snoozed; the
// admin's own confirmed row is the one asked to re-confirm. Licensed builds
// only: the requirement answers 402 on the community build and the test
// skips itself (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the roster check. Read it and confirm at the end.";

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

/** Turn the requirement on quietly; 402 means the community build. */
async function requireConfirmation(page: Page, docId: number): Promise<"on" | "unlicensed"> {
  const res = await api(page, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
  if (res.status === 402) return "unlicensed";
  expect(res.status, "confirmation required").toBe(200);
  return "on";
}

/** The admin confirms the newest version through the API. */
async function confirmLatest(page: Page, docId: number): Promise<number> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status).toBe(200);
  const versionId = summary.body?.latest_version_id;
  expect(versionId, "the newest version id").toBeTruthy();
  const confirmed = await api(page, `/api/documents/${docId}/ack`, { method: "POST", body: { version_id: versionId } });
  expect(confirmed.status, "confirmed").toBe(200);
  return versionId;
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

/** The JSON roster row of one person (AckStatusRow as the route spreads it). */
async function rosterRow(page: Page, docId: number, username: string): Promise<Record<string, any>> {
  const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
  expect(roster.status).toBe(200);
  const row = (roster.body?.rows ?? []).find((r: { username: string }) => r.username === username);
  expect(row, `${username} is on the roster`).toBeTruthy();
  return row;
}

test("the Record tab: Due and Exemption columns, the Overdue and Exempt filters, Extend / Exempt / Snooze with Undo, Ask to re-confirm… with its chip, and the bulk bar over two rows", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E ack roster ${suffix}`;
  const PERSON = `E2E Roster Person ${suffix}`;
  const person = { username: `e2e_roster_${suffix}`, password: "E2eRoster!12345" };
  let docId: number | undefined;
  let personId: number | undefined;
  try {
    // The person first, then the policy: switching the requirement on
    // enrols everyone who can see the sample space (D1), the admin and the
    // person alike, each with a due date from the workspace's rule (E1).
    personId = await makeUser(page, person, PERSON);
    docId = await makePolicy(page, title);
    test.skip(
      (await requireConfirmation(page, docId)) === "unlicensed",
      "policy_ack is not licensed in this build; the EE rig runs the flow"
    );
    await confirmLatest(page, docId);
    const personRow = await rosterRow(page, docId, person.username);
    expect(personRow.assignment_id, "the row carries its assignment id").toBeTruthy();
    expect(personRow.due_at, "and a deadline from the rule").toBeTruthy();
    expect(personRow.exempt).toBe(false);
    const adminRow = await rosterRow(page, docId, ADMIN.username);
    expect(adminRow.acknowledged_at, "the admin's row is confirmed").toBeTruthy();
    const roster = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(typeof roster.body?.defaults?.overdue_grace_days, "the JSON carries the policy's grace for the portal").toBe("number");

    await page.goto(`/doc/${docId}/acknowledgements`);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { name: "Read confirmation" })).toBeVisible();
    const status = page.locator('[role="status"]');
    const rows = main.locator("tbody tr");
    const row = main.locator("tbody tr", { hasText: PERSON });
    // The admin's row by its checkbox's accessible name ("Select {name}"):
    // the cell shows the account's display name, which the rig provisions.
    const adminName: string = adminRow.name || ADMIN.username;
    const mine = rows.filter({ has: page.getByRole("checkbox", { name: `Select ${adminName}`, exact: true }) });
    // A toast's Undo, by the toast's own text: action toasts stay ten
    // seconds and several may be up at once.
    const undoOn = (text: string | RegExp) => status.locator("div", { hasText: text }).getByRole("button", { name: "Undo" });

    // The columns: Due (the person's deadline, formatted) and Exemption
    // (blank until something is recorded); the five Show choices.
    await expect(main.getByRole("columnheader", { name: "Due" })).toBeVisible();
    await expect(main.getByRole("columnheader", { name: "Exemption" })).toBeVisible();
    const dueCell = row.getByRole("cell").nth(4);
    await expect(dueCell).not.toHaveText("");
    await expect(row).toContainText("Pending");
    const show = main.getByRole("radiogroup", { name: "Show" });
    for (const name of ["All", "Pending", "Overdue", "Confirmed", "Exempt"]) {
      await expect(show.getByRole("radio", { name, exact: true })).toBeVisible();
    }
    // Nobody is overdue the day a 14-day rule enrolled them, and nobody is
    // exempt yet: both filters leave the table empty with their own line.
    await show.getByRole("radio", { name: "Overdue", exact: true }).click();
    await expect(main.getByText("Nobody is overdue.")).toBeVisible();
    await show.getByRole("radio", { name: "Exempt", exact: true }).click();
    await expect(main.getByText("Nobody is exempt from this policy.")).toBeVisible();
    await show.getByRole("radio", { name: "All", exact: true }).click();
    await expect(row).toBeVisible();

    // The checkbox column and the actions are there for the admin.
    await expect(main.getByRole("checkbox", { name: "Select all people on this page" })).toBeVisible();
    await expect(row.getByRole("checkbox", { name: `Select ${PERSON}` })).toBeVisible();

    // Exempt… with Undo: the dialog (reason required, an optional date), the
    // toast, the chip, the Exemption cell, the Exempt filter; Undo removes it.
    await row.getByRole("button", { name: "Exempt…" }).click();
    const exemptDialog = page.getByRole("dialog", { name: `Exempt ${PERSON} from this policy` });
    await expect(exemptDialog).toBeVisible();
    await exemptDialog.getByRole("button", { name: "Exempt", exact: true }).click();
    await expect(exemptDialog.getByText("Enter a value.")).toBeVisible();
    await exemptDialog.getByLabel("Reason").fill("On leave");
    await exemptDialog.getByLabel("Until (optional)").fill("2099-12-01");
    await exemptDialog.getByRole("button", { name: "Exempt", exact: true }).click();
    await expect(exemptDialog).toHaveCount(0);
    await expect(status.getByText(`Exempted ${PERSON} from "${title}"`)).toBeVisible();
    await expect(row).toContainText("Exempt");
    await expect(row).toContainText("On leave until");
    await expect(row.getByText("Pending")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Remove exemption" })).toBeVisible();
    expect((await rosterRow(page, docId, person.username)).exempt, "the server agrees").toBe(true);
    await show.getByRole("radio", { name: "Exempt", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(PERSON);
    await show.getByRole("radio", { name: "All", exact: true }).click();
    await undoOn(`Exempted ${PERSON} from`).click();
    await expect(status.getByText(`Exemption undone: ${PERSON} is pending again.`)).toBeVisible();
    await expect(row.getByText("Pending")).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Exempt…" })).toBeVisible();
    expect((await rosterRow(page, docId, person.username)).exempt).toBe(false);

    // Extend due date… with Undo: 7 days by default, the Due cell moves,
    // Undo puts it back.
    const dueBefore = (await rosterRow(page, docId, person.username)).due_at as string;
    await row.getByRole("button", { name: "Extend due date…" }).click();
    const extendDialog = page.getByRole("dialog", { name: "Extend due date" });
    await expect(extendDialog).toBeVisible();
    await expect(extendDialog.getByLabel("Days")).toHaveValue("7");
    await extendDialog.getByLabel("Reason (optional)").fill("Audit week");
    await extendDialog.getByRole("button", { name: "Extend", exact: true }).click();
    await expect(extendDialog).toHaveCount(0);
    await expect(status.getByText(`Extended the deadline for ${PERSON} by 7 days`)).toBeVisible();
    const dueAfter = (await rosterRow(page, docId, person.username)).due_at as string;
    expect(new Date(dueAfter).getTime() - new Date(dueBefore).getTime(), "seven days later").toBe(7 * 86_400_000);
    await undoOn(`Extended the deadline for ${PERSON}`).click();
    await expect(status.getByText(`Extension undone: the deadline for ${PERSON} is back to its previous date.`)).toBeVisible();
    expect((await rosterRow(page, docId, person.username)).due_at, "back to the date before").toBe(dueBefore);

    // Snooze (no dialog, a week) and Unsnooze: the Exemption cell says
    // "Snoozed until …", the invariant is spelled out under the table,
    // and nothing else about the row changes.
    await row.getByRole("button", { name: /^Pause reminders until / }).click();
    await expect(status.getByText(new RegExp(`^Snoozed reminders for ${PERSON} until `))).toBeVisible();
    await expect(row).toContainText("Snoozed until");
    await expect(row.getByText("Pending")).toHaveCount(1);
    await expect(main.getByText(/^Snoozing only pauses automatic reminders/)).toBeVisible();
    expect((await rosterRow(page, docId, person.username)).snoozed_until).toBeTruthy();
    await row.getByRole("button", { name: /^Unsnooze/ }).click();
    await expect(status.getByText(`Reminders resume for ${PERSON}.`)).toBeVisible();
    await expect(row.getByText(/Snoozed until/)).toHaveCount(0);
    expect((await rosterRow(page, docId, person.username)).snoozed_until).toBeNull();

    // Ask to re-confirm… on the admin's confirmed row: the dialog's question
    // and body, a short reason refused inline, then the toast, the row
    // Pending again with the "Asked again {date}" chip and the reason in
    // the Exemption cell; the document marker stays where it was.
    const markerBefore = (await api(page, `/api/documents/${docId}/ack`)).body?.version_id;
    await expect(mine).toContainText("Confirmed");
    await mine.getByRole("button", { name: "Ask to re-confirm…" }).click();
    const reaskDialog = page.getByRole("dialog", { name: /^Ask .* to re-confirm "/ });
    await expect(reaskDialog).toBeVisible();
    await expect(reaskDialog.getByText(/^Their confirmation of version \d+ stays in the record\. They are asked to read the document and confirm again\.$/)).toBeVisible();
    const why = reaskDialog.getByLabel("Why is this person being asked again?");
    await why.fill("Too short");
    await reaskDialog.getByRole("button", { name: "Ask to re-confirm", exact: true }).click();
    await expect(reaskDialog.getByText("Give a reason of at least 10 characters.")).toBeVisible();
    await why.fill("Please read the new travel section");
    await reaskDialog.getByRole("button", { name: "Ask to re-confirm", exact: true }).click();
    await expect(reaskDialog).toHaveCount(0);
    await expect(status.getByText(/will be asked to re-confirm\.$/)).toBeVisible();
    await expect(mine).toContainText("Pending");
    await expect(mine).toContainText(/Asked again \S/);
    await expect(mine).toContainText("Please read the new travel section");
    const adminAfter = await rosterRow(page, docId, ADMIN.username);
    expect(adminAfter.acknowledged_at, "the confirmation lapsed for this person").toBeNull();
    expect(adminAfter.asked_again_at).toBeTruthy();
    expect(adminAfter.asked_again_reason).toBe("Please read the new travel section");
    expect((await api(page, `/api/documents/${docId}/ack`)).body?.version_id, "the marker did not move").toBe(markerBefore);
    expect((await rosterRow(page, docId, person.username)).asked_again_at, "nobody else was asked").toBeNull();

    // The bulk bar over two rows: both checked, "2 selected", Extend… over
    // both, the toast counts two deadlines, Undo puts both back.
    await row.getByRole("checkbox", { name: `Select ${PERSON}` }).check();
    await mine.getByRole("checkbox").check();
    const bar = main.getByRole("region", { name: "Selected people" });
    await expect(bar).toBeVisible();
    await expect(bar.getByText("2 selected")).toBeVisible();
    for (const name of ["Extend…", "Exempt…", "Snooze"]) {
      await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(bar.getByRole("button", { name: "Ask to re-confirm…" }), "nobody selected is confirmed").toHaveCount(0);
    const personDue = (await rosterRow(page, docId, person.username)).due_at as string;
    const adminDue = adminAfter.due_at as string;
    await bar.getByRole("button", { name: "Extend…", exact: true }).click();
    const bulkDialog = page.getByRole("dialog", { name: "Extend due dates for 2 people" });
    await expect(bulkDialog).toBeVisible();
    await bulkDialog.getByRole("button", { name: "Extend", exact: true }).click();
    await expect(bulkDialog).toHaveCount(0);
    await expect(status.getByText("Extended 2 deadlines by 7 days")).toBeVisible();
    await expect(bar, "a successful action clears the selection").toHaveCount(0);
    expect(new Date((await rosterRow(page, docId, person.username)).due_at).getTime() - new Date(personDue).getTime()).toBe(7 * 86_400_000);
    expect(new Date((await rosterRow(page, docId, ADMIN.username)).due_at).getTime() - new Date(adminDue).getTime()).toBe(7 * 86_400_000);
    await undoOn("Extended 2 deadlines by 7 days").click();
    await expect(status.getByText("Extension undone: 2 deadlines are back to their previous dates.")).toBeVisible();
    expect((await rosterRow(page, docId, person.username)).due_at).toBe(personDue);
    expect((await rosterRow(page, docId, ADMIN.username)).due_at).toBe(adminDue);

    // The select-all header checkbox takes the page; Clear selection empties it.
    await main.getByRole("checkbox", { name: "Select all people on this page" }).check();
    await expect(main.getByRole("region", { name: "Selected people" })).toBeVisible();
    await main.getByRole("button", { name: "Clear selection" }).click();
    await expect(main.getByRole("region", { name: "Selected people" })).toHaveCount(0);

    // Controls stay off paper: the checkbox column, the actions and the bar.
    await page.emulateMedia({ media: "print" });
    await expect(main.getByRole("checkbox", { name: "Select all people on this page" })).toBeHidden();
    await expect(row.getByRole("button", { name: "Exempt…" })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (personId) await api(page, `/api/admin/users/${personId}`, { method: "DELETE" });
  }
});
