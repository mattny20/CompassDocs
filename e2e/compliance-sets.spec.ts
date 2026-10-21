import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.14.0 (D3): policy sets. /compliance/sets lists every set with its
// ordered members, its progress and its actions; New set takes a name, the
// policies in order (a search box that appends, a list that reorders) and
// the auto-assign switch; Assign names people and groups (or everyone,
// behind a question) and says beforehand which members will start
// requiring confirmation; a member not yet switched on is switched on by
// the assignment; the person's My policies groups the set's rows under
// "{name} · n of m done" in the set's order; Deactivate tells with Undo;
// Delete asks and, for a set that auto-assigns, wants the name typed; a
// program_read-only role sees the sets and no control.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the route answers 402 and runs in
// full on the EE rig (as e2e/compliance-portal.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the sets smoke. Read it and confirm at the end.";

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

/** The sets route answers 402 on the community build; anything else must be 200 for the admin. */
async function setsLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/admin/compliance/sets");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the sets").toBe(200);
  return true;
}

async function ackRequired(page: Page, docId: number): Promise<number> {
  const res = await api(page, `/api/documents/${docId}`);
  expect(res.status).toBe(200);
  return Number(res.body?.doc?.ack_required);
}

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", { method: "POST", body: { ...user, role: "viewer", name } });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

/** A custom role with exactly these permissions, assigned to the user (as e2e/compliance-rbac.spec.ts does). */
async function grantRole(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e: policy sets", permissions },
  });
  expect(role.status, `custom role ${name} created`).toBe(201);
  const roleId = role.body?.id;
  expect(roleId).toBeTruthy();
  const assigned = await api(page, "/api/admin/rbac/assignments", { method: "POST", body: { role_id: roleId, user_id: userId } });
  expect(assigned.status, `${name} assigned`).toBe(201);
  return roleId;
}

async function makeGroup(page: Page, name: string, memberIds: number[]): Promise<number> {
  const made = await api(page, "/api/admin/groups", { method: "POST", body: { name } });
  expect(made.status, "group created").toBe(201);
  const id = made.body?.group?.id;
  expect(id, "group id").toBeTruthy();
  for (const userId of memberIds) {
    const added = await api(page, `/api/admin/groups/${id}`, { method: "PATCH", body: { addUserId: userId } });
    expect(added.status, "member added").toBe(200);
  }
  return id;
}

type SetRow = {
  id: number;
  name: string;
  active: number;
  assign_new_members: number;
  docs: { id: number; title: string; position: number; ack_required: number }[];
  progress: { required: number; confirmed: number; overdue: number; pct: number };
};

/** The set by name from the route (the page's own source), or undefined once it is gone. */
async function setNamed(page: Page, name: string): Promise<SetRow | undefined> {
  const res = await api(page, "/api/admin/compliance/sets");
  expect(res.status).toBe(200);
  return (res.body?.rows ?? []).find((r: SetRow) => r.name === name);
}

/** The section's tab row: the one <nav aria-label="Compliance"> under the header. */
const subnav = (page: Page) => page.getByRole("navigation", { name: "Compliance" });

/** A set's card, by the id the route gave it. */
const card = (page: Page, setId: number) => page.locator(`#set-${setId}`);

test("New set takes two policies in order, Assign to a group switches them on and the member's My policies groups them under the set", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const name = `E2E onboarding set ${suffix}`;
  const titleA = `E2E set policy A ${suffix}`;
  const titleB = `E2E set policy B ${suffix}`;
  const member = { username: `e2e_setmember_${suffix}`, password: "E2eSet!12345" };
  let docA: number | undefined;
  let docB: number | undefined;
  let memberId: number | undefined;
  let groupId: number | undefined;
  let setId: number | undefined;
  try {
    docA = await makePolicy(page, titleA);
    docB = await makePolicy(page, titleB);
    test.skip(!(await setsLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    memberId = await makeUser(page, member, "E2E Set Member");
    groupId = await makeGroup(page, `E2E set group ${suffix}`, [memberId]);
    // Neither policy requires confirmation yet: the assignment switches them on.
    expect(await ackRequired(page, docA)).toBe(0);
    expect(await ackRequired(page, docB)).toBe(0);

    // The page under the section's header, with its tab lit and the intro sentence.
    await page.goto("/compliance/sets");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    await expect(subnav(page).getByRole("link", { name: "Sets", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Group policies into a set, assigned to every new joiner automatically or to people and groups as one unit.")).toBeVisible();

    // New set: the form opens above the list and the button hides while it is open.
    const newSet = page.getByRole("button", { name: "New set" });
    await newSet.click();
    await expect(newSet).toHaveCount(0);
    const form = page.locator("#new-set");
    await expect(form.getByRole("heading", { name: "New set", exact: true })).toBeVisible();
    await form.getByLabel("Set name").fill(name);
    // B first, then A: the list numbers them in the order they were added…
    const picker = form.getByRole("combobox", { name: "Add policies" });
    await picker.fill(titleB);
    await page.getByRole("option", { name: new RegExp(titleB) }).click();
    await picker.fill(titleA);
    await page.getByRole("option", { name: new RegExp(titleA) }).click();
    await expect(form.getByText(`1. ${titleB}`)).toBeVisible();
    await expect(form.getByText(`2. ${titleA}`)).toBeVisible();
    // … and Move up puts A first.
    await form.getByRole("button", { name: `Move 2. ${titleA} up` }).click();
    await expect(form.getByText(`1. ${titleA}`)).toBeVisible();
    await expect(form.getByText(`2. ${titleB}`)).toBeVisible();
    // Auto-assign is on by default; the policies are not yet required, and the list says so.
    await expect(form.getByRole("switch", { name: "Auto-assign to new joiners" })).toBeChecked();
    await expect(form.getByText("not yet required").first()).toBeVisible();
    await form.getByRole("button", { name: "Create set" }).click();
    await expect(page.locator('[role="status"]').getByText("Set created: 2 policies · auto-assigned to new joiners")).toBeVisible();
    await expect(form).toHaveCount(0);

    // The route agrees: the members in that order, auto-assign on, nobody asked yet.
    const made = await setNamed(page, name);
    expect(made, "the set is listed").toBeTruthy();
    setId = made!.id;
    expect(made!.docs.map((d) => d.id)).toEqual([docA, docB]);
    expect(made!.docs.map((d) => d.position)).toEqual([0, 1]);
    expect(made!.assign_new_members).toBe(1);
    expect(made!.progress.required).toBe(0);

    // The card: the name, the Auto-assign chip, the ordered chips, the standing.
    const row = card(page, setId);
    await expect(row.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(row.getByText("Auto-assign", { exact: true })).toBeVisible();
    await expect(row.getByText(`1. ${titleA}`)).toBeVisible();
    await expect(row.getByText(`2. ${titleB}`)).toBeVisible();
    await expect(row.getByText("Nobody asked yet")).toBeVisible();

    // Assign: the modal names the set, lists the two members that will
    // start requiring confirmation, and takes the group.
    await row.getByRole("button", { name: "Assign", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Assign “${name}”` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/^These 2 documents will start requiring confirmation: /)).toBeVisible();
    const assign = dialog.getByRole("button", { name: "Assign set" });
    await expect(assign, "nothing named yet").toBeDisabled();
    const groups = dialog.getByRole("combobox", { name: "Add groups" });
    await groups.fill(`E2E set group ${suffix}`);
    await page.getByRole("option", { name: new RegExp(`E2E set group ${suffix}`) }).click();
    await expect(assign).toBeEnabled();
    await assign.click();
    await expect(page.locator('[role="status"]').getByText(/^Set assigned: 2 policies, \d+ (person|people) · 2 switched on$/)).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // Both policies now require confirmation, and the set's progress counts the member.
    expect(await ackRequired(page, docA), "A switched on").toBe(1);
    expect(await ackRequired(page, docB), "B switched on").toBe(1);
    const assigned = await setNamed(page, name);
    expect(assigned!.docs.every((d) => d.ack_required === 1)).toBe(true);
    expect(assigned!.progress.required).toBeGreaterThanOrEqual(2);
    // The standing line reads a percentage now ("0%": nobody has confirmed yet).
    await expect(row.getByText(/\b\d+%/)).toBeVisible();
    await expect(row.getByText("Nobody asked yet")).toHaveCount(0);

    // The member: My policies groups the two rows under the set's label, in
    // the set's order, and the rows carry the set in the API.
    const ctx = await browser.newContext();
    try {
      const mpage = await ctx.newPage();
      await login(mpage, member);
      const mine = await api(mpage, "/api/compliance/mine");
      expect(mine.status).toBe(200);
      const rowA = (mine.body?.rows ?? []).find((r: { id: number }) => r.id === docA);
      const rowB = (mine.body?.rows ?? []).find((r: { id: number }) => r.id === docB);
      expect(rowA?.set_names, "A names the set").toEqual([name]);
      expect(rowA?.set_position).toBe(0);
      expect(rowB?.set_position).toBe(1);
      await mpage.goto("/compliance");
      const toConfirm = mpage.getByRole("region", { name: "To confirm" });
      await expect(toConfirm.getByRole("heading", { name: `${name} · 0 of 2 done` })).toBeVisible();
      const group = toConfirm.getByRole("region", { name: `${name} · 0 of 2 done` });
      const rows = group.locator("li");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).getByRole("link", { name: titleA })).toHaveAttribute("href", `/doc/${docA}#confirm-reading`);
      await expect(rows.nth(1).getByRole("link", { name: titleB })).toHaveAttribute("href", `/doc/${docB}#confirm-reading`);
    } finally {
      await ctx.close();
    }
  } finally {
    if (setId) await api(page, `/api/admin/compliance/sets/${setId}`, { method: "DELETE" });
    if (groupId) await api(page, `/api/admin/groups/${groupId}`, { method: "DELETE" });
    if (memberId) await api(page, `/api/admin/users/${memberId}`, { method: "DELETE" });
    if (docA) await api(page, `/api/documents/${docA}`, { method: "DELETE" });
    if (docB) await api(page, `/api/documents/${docB}`, { method: "DELETE" });
  }
});

test("Edit renames a set, Deactivate tells with Undo, and Delete asks for the name of a set that auto-assigns", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const name = `E2E annual set ${suffix}`;
  const renamed = `${name} renamed`;
  const title = `E2E set policy ${suffix}`;
  let docId: number | undefined;
  let setId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await setsLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const made = await api(page, "/api/admin/compliance/sets", {
      method: "POST",
      body: { name, doc_ids: [docId], assign_new_members: true },
    });
    expect(made.status, "set created").toBe(201);
    setId = made.body?.set?.id;
    expect(setId).toBeTruthy();

    await page.goto("/compliance/sets");
    const row = card(page, setId!);
    await expect(row.getByRole("heading", { name, exact: true })).toBeVisible();

    // Edit: the form under the row, the name changed, saved, the card renamed.
    await row.getByRole("button", { name: "Edit" }).click();
    const field = row.getByLabel("Set name");
    await expect(field).toHaveValue(name);
    await field.fill(renamed);
    await row.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator('[role="status"]').getByText("Set updated.")).toBeVisible();
    await expect(row.getByRole("heading", { name: renamed, exact: true })).toBeVisible();
    expect((await setNamed(page, renamed))?.id).toBe(setId);

    // Deactivate: no question (it is reversible), the toast with Undo, the
    // Inactive chip, Assign gone, the route's active flag off.
    await row.getByRole("button", { name: "Deactivate" }).click();
    const toast = page.locator('[role="status"]', { hasText: "Set deactivated" });
    await expect(toast).toBeVisible();
    await expect(row.getByText("Inactive", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Assign", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Activate" })).toBeVisible();
    expect((await setNamed(page, renamed))?.active).toBe(0);
    // A deactivated set cannot be assigned through the API either.
    const refused = await api(page, `/api/admin/compliance/sets/${setId}`, { method: "POST", body: { everyone: true } });
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toBe("This set is deactivated. Reactivate it to assign it.");

    // Undo re-activates: the toast, the chip gone, Assign back.
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator('[role="status"]').getByText("Set active again.")).toBeVisible();
    await expect(row.getByText("Inactive", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
    expect((await setNamed(page, renamed))?.active).toBe(1);

    // Delete: the danger question with the documented body; the set
    // auto-assigns, so the button waits for its name; Cancel keeps it.
    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog", { name: `Delete "${renamed}"?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Policies and confirmations stay; only the set is removed. This cannot be undone.")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete set" });
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByText(/type .* to confirm/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await setNamed(page, renamed))?.id, "Cancel keeps the set").toBe(setId);
    // The name typed: the set goes, the policy stays required, the route answers 404.
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox").fill(renamed);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.locator('[role="status"]').getByText("Set deleted.")).toBeVisible();
    await expect(row).toHaveCount(0);
    expect(await setNamed(page, renamed)).toBeUndefined();
    expect((await api(page, `/api/admin/compliance/sets/${setId}`, { method: "PATCH", body: { active: false } })).status).toBe(404);
    setId = undefined;
    // Focus never falls to <body>: the New set button takes it.
    await expect(page.getByRole("button", { name: "New set" })).toBeFocused();
  } finally {
    if (setId) await api(page, `/api/admin/compliance/sets/${setId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a program_read-only role sees the sets with the tab lit and no control; the writes answer 403", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const name = `E2E read-only set ${suffix}`;
  const title = `E2E set policy ro ${suffix}`;
  const reader = { username: `e2e_setread_${suffix}`, password: "E2eRead!12345" };
  let docId: number | undefined;
  let setId: number | undefined;
  let readerId: number | undefined;
  let readerRole: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await setsLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const made = await api(page, "/api/admin/compliance/sets", { method: "POST", body: { name, doc_ids: [docId] } });
    expect(made.status, "set created").toBe(201);
    setId = made.body?.set?.id;
    readerId = await makeUser(page, reader, "E2E Set Reader");
    readerRole = await grantRole(page, `E2E Set Reader ${suffix}`, ["compliance.program_read"], readerId);

    const ctx = await browser.newContext();
    try {
      const rpage = await ctx.newPage();
      await login(rpage, reader);
      // The API: the list opens; every write is refused.
      expect((await api(rpage, "/api/admin/compliance/sets")).status, "program_read reads the sets").toBe(200);
      expect((await api(rpage, "/api/admin/compliance/sets", { method: "POST", body: { name: `${name} x`, doc_ids: [docId] } })).status).toBe(403);
      expect((await api(rpage, `/api/admin/compliance/sets/${setId}`, { method: "PATCH", body: { active: false } })).status).toBe(403);
      expect((await api(rpage, `/api/admin/compliance/sets/${setId}`, { method: "POST", body: { everyone: true } })).status).toBe(403);
      expect((await api(rpage, `/api/admin/compliance/sets/${setId}`, { method: "DELETE" })).status).toBe(403);

      // The page: the tab, the set with its member, and no control that would answer 403.
      await rpage.goto("/compliance/sets");
      const main = rpage.locator("#main");
      await expect(main.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(subnav(rpage).getByRole("link", { name: "Sets", exact: true })).toHaveAttribute("aria-current", "page");
      const row = card(rpage, setId!);
      await expect(row.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(row.getByText(`1. ${title}`)).toBeVisible();
      await expect(main.getByRole("button", { name: "New set" })).toHaveCount(0);
      for (const label of ["Assign", "Edit", "Deactivate", "Activate", "Delete"]) {
        await expect(row.getByRole("button", { name: label, exact: true }), `no ${label} for a reader`).toHaveCount(0);
      }
      // Nothing changed hands.
      expect((await setNamed(page, name))?.active).toBe(1);
    } finally {
      await ctx.close();
    }
  } finally {
    if (setId) await api(page, `/api/admin/compliance/sets/${setId}`, { method: "DELETE" });
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
