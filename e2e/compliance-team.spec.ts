import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.14.0 (F4): the team view for group leads. A lead of a group (the same
// group leads Training uses, named on the compliance Overview's Team leads
// block or under Training) opens /compliance/team when Program settings
// let leads see policy standing: one card per led group with "{n} members
// · {m} confirmed · {k} open", a table of Person (a link to the person's
// compliance record) / Policy / Status / Due / Actions, and a count, never
// a title, for a policy a member owes in a space the lead cannot read
// ("and 1 policy you can't view"). Remind queues one reminder for one
// person and toasts; inside the row's cadence the server's refusal is the
// toast ("{Name} was reminded earlier today."). The setting off hides the
// page (not found), the Team tab and the My policies banner ("You lead a
// team. See your team's policies"). A compliance.team_read holder sees
// every group, setting or not, with the tab and no banner (they lead
// nothing); a plain viewer who leads nothing is not found. The Program
// settings toggle "Group leads see policy standing" round-trips through
// the page's one Save.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the portal answers 402 and runs in
// full on the EE rig (as e2e/compliance-portal.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the team view smoke. Read it and confirm at the end.";

/** The section's tab row: the one <nav aria-label="Compliance"> under the header. */
const subnav = (page: Page) => page.getByRole("navigation", { name: "Compliance" });

async function makePolicy(page: Page, title: string, spaceId = 1): Promise<number> {
  const made = await api(page, "/api/documents", {
    method: "POST",
    body: { space_id: spaceId, title, type: "policy", status: "published", content: BODY, tags: [] },
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

/** Switch the requirement on quietly through the portal's request action. */
async function requireQuietly(page: Page, docId: number): Promise<void> {
  const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
  expect(on.status, "requested quietly").toBe(200);
}

async function makeUser(page: Page, user: { username: string; password: string }, name: string): Promise<number> {
  const created = await api(page, "/api/admin/users", { method: "POST", body: { ...user, role: "viewer", name } });
  expect(created.status, `${name} created`).toBe(201);
  const id = created.body?.user?.id;
  expect(id).toBeTruthy();
  return id;
}

async function makeGroup(page: Page, name: string, memberIds: number[]): Promise<number> {
  const made = await api(page, "/api/admin/groups", { method: "POST", body: { name } });
  expect(made.status, `group ${name} created`).toBe(201);
  const id = made.body?.group?.id;
  expect(id).toBeTruthy();
  for (const userId of memberIds) {
    const added = await api(page, `/api/admin/groups/${id}`, { method: "PATCH", body: { addUserId: userId } });
    expect(added.status, `member ${userId} added to ${name}`).toBe(200);
  }
  return id;
}

/** The leads of one group, through the compliance side of the shared list. */
async function setLeads(page: Page, groupId: number, userIds: number[]): Promise<void> {
  const put = await api(page, "/api/compliance/leads", { method: "PUT", body: { group_id: groupId, user_ids: userIds } });
  expect(put.status, "leads set").toBe(200);
}

/** Program settings → Group leads see policy standing; answers what it was. */
async function leadsSeePolicies(page: Page, on: boolean): Promise<boolean> {
  const before = await api(page, "/api/admin/compliance/settings");
  expect(before.status, "the admin reads the program settings").toBe(200);
  const was = Boolean(before.body?.settings?.ack_defaults?.leads_see_policies);
  const put = await api(page, "/api/admin/compliance/settings", { method: "PUT", body: { ack_defaults: { leads_see_policies: on } } });
  expect(put.status, `leads_see_policies set to ${on}`).toBe(200);
  return was;
}

/** A custom role with exactly these permissions, assigned to the user (as e2e/compliance-rbac.spec.ts does). */
async function grantRole(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", { method: "POST", body: { name, description: "e2e: the team view", permissions } });
  expect(role.status, `custom role ${name} created`).toBe(201);
  const roleId = role.body?.id;
  expect(roleId).toBeTruthy();
  const assigned = await api(page, "/api/admin/rbac/assignments", { method: "POST", body: { role_id: roleId, user_id: userId } });
  expect(assigned.status, `${name} assigned`).toBe(201);
  return roleId;
}

/** The newest audit rows (newest first) for one action on one document. */
async function auditRows(page: Page, action: string, docId: number): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(
    (r: { action: string; target_id: string | number | null }) => r.action === action && Number(r.target_id) === docId
  );
}

type TeamRow = {
  group_id: number;
  user_id: number;
  user_name: string;
  assignment_id: number | null;
  document_id: number | null;
  title: string | null;
  status: string | null;
  reminded_at: string | null;
  hidden_count: number;
  /** Whether POST would let this viewer remind the row (leads one of the member's groups, or compliance.program_manage). */
  may_remind: boolean;
};
type TeamPayload = { groups: { id: number; name: string; members: number; confirmed: number; open: number; overdue: number }[]; rows: TeamRow[] };

test("a lead with the setting on sees their group with a count for a private-space policy, reminds once and is refused inside the cadence; the setting off hides the page, the tab and the banner", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E team policy ${suffix}`;
  const privateTitle = `E2E team private ${suffix}`;
  const lead = { username: `e2e_lead_${suffix}`, password: "E2eLead!12345" };
  const member = { username: `e2e_member_${suffix}`, password: "E2eMember!12345" };
  const memberName = "E2E Team Member";
  const groupName = `E2E Team ${suffix}`;
  let docId: number | undefined;
  let privateId: number | undefined;
  let spaceId: number | undefined;
  let leadId: number | undefined;
  let memberId: number | undefined;
  let groupId: number | undefined;
  let privateGroupId: number | undefined;
  let settingWas: boolean | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // The people: a lead and the one member of the group they lead. A
    // second group grants the member alone a private space, where a second
    // policy asks them; the lead cannot read that space.
    leadId = await makeUser(page, lead, "E2E Team Lead");
    memberId = await makeUser(page, member, memberName);
    groupId = await makeGroup(page, groupName, [memberId]);
    privateGroupId = await makeGroup(page, `E2E Team private ${suffix}`, [memberId]);
    const space = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Team space ${suffix}`, slug: `e2e-team-${suffix}`, description: "", visibility: "private", groupIds: [privateGroupId] },
    });
    spaceId = space.body?.space?.id ?? space.body?.id;
    expect(spaceId, "private space created").toBeTruthy();
    privateId = await makePolicy(page, privateTitle, spaceId);
    await requireQuietly(page, docId);
    await requireQuietly(page, privateId);

    // The setting on, and the lead named through the compliance side of the
    // shared leads list (the Overview's Team leads block reads and writes
    // here; a compliance manager need not hold Training).
    settingWas = await leadsSeePolicies(page, true);
    await setLeads(page, groupId, [leadId]);
    const leads = await api(page, "/api/compliance/leads");
    expect(leads.status).toBe(200);
    expect(leads.body?.leads?.some((l: { group_id: number; user_id: number }) => l.group_id === groupId && l.user_id === leadId), "the lead is listed").toBe(true);
    expect(leads.body?.users?.some((u: { id: number }) => u.id === leadId), "the people to pick from are in the answer").toBe(true);
    expect(leads.body?.leads_see_policies).toBe(true);

    const lctx = await browser.newContext();
    try {
      const lpage = await lctx.newPage();
      await login(lpage, lead);

      // The API: the led group, the member's row for the visible policy with
      // the private one as a count, and nothing of the private title.
      const team = await api(lpage, "/api/compliance/team");
      expect(team.status, "a lead with the setting on reads the team").toBe(200);
      const payload = team.body as TeamPayload;
      const group = payload.groups.find((g) => g.id === groupId);
      expect(group, "the led group").toBeTruthy();
      // One row per member and policy: a policy another spec left asking
      // everyone in a space the lead reads is a row of its own (and counts in
      // the header), so the counts are read against the group's own rows and
      // this policy's row is found by its id.
      const rows = payload.rows.filter((r) => r.group_id === groupId);
      const count = (status: string) => rows.filter((r) => r.assignment_id !== null && r.status === status).length;
      expect(group).toMatchObject({
        name: groupName,
        members: 1,
        confirmed: count("confirmed"),
        open: count("pending") + count("overdue"),
        overdue: count("overdue"),
      });
      expect(rows.every((r) => r.user_id === memberId && r.hidden_count === 1), "every row is the member's, with the private policy as a count").toBe(true);
      expect(rows.some((r) => r.document_id === privateId), "no row for the policy the lead cannot read").toBe(false);
      const ours = rows.filter((r) => r.document_id === docId);
      expect(ours.length, "one row for the policy the lead can read").toBe(1);
      expect(ours[0]).toMatchObject({ user_id: memberId, document_id: docId, title, status: "pending", hidden_count: 1, may_remind: true });
      expect(JSON.stringify(payload), "the private title never leaves the server").not.toContain(privateTitle);
      const assignmentId = ours[0].assignment_id;
      expect(assignmentId).toBeTruthy();

      // The page: the lit Team tab beside My policies (no section grant),
      // the heading, the group's card with its counts, the member's row
      // linking to their record, the policy, the Pending chip, the count of
      // what the lead cannot see, and the private title nowhere.
      await lpage.goto("/compliance/team");
      await expect(lpage.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(subnav(lpage).getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(subnav(lpage).getByRole("link", { name: "Overview", exact: true })).toHaveCount(0);
      await expect(lpage.getByRole("heading", { name: "Your team's policies" })).toBeVisible();
      await expect(lpage.getByText("Where the groups you lead stand. You also get a weekly summary by email.")).toBeVisible();
      const card = lpage.locator("section", { has: lpage.getByRole("heading", { name: groupName }) });
      await expect(card).toBeVisible();
      // The header carries the server's numbers (1 open when this policy is the only one asking).
      await expect(card.getByText(`1 member · ${group!.confirmed} confirmed · ${group!.open} open`)).toBeVisible();
      if (group!.overdue === 0) await expect(card.getByText(/\d+ overdue/)).toHaveCount(0);
      else await expect(card.getByText(`${group!.overdue} overdue`)).toBeVisible();
      // The member has one row per policy: this policy's row is the one with its title.
      const row = card.getByRole("row").filter({ hasText: memberName }).filter({ hasText: title });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole("link", { name: memberName })).toHaveAttribute("href", `/compliance/person/${memberId}`);
      await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/doc/${docId}`);
      await expect(row.getByText("Pending", { exact: true })).toBeVisible();
      // The count of what the lead cannot see, once per member (on their first shown row).
      await expect(card.getByText("and 1 policy you can't view")).toHaveCount(1);
      await expect(lpage.getByText(privateTitle)).toHaveCount(0);

      // Show: Overdue takes this pending row away (and empties the card when
      // nobody is overdue), All brings the row back.
      const show = lpage.getByRole("radiogroup", { name: "Show" });
      await show.getByRole("radio", { name: "Overdue" }).click();
      await expect(row).toHaveCount(0);
      if (group!.overdue === 0) await expect(card.getByText("Nobody is overdue.")).toBeVisible();
      await show.getByRole("radio", { name: "All" }).click();
      await expect(row).toHaveCount(1);

      // Remind: one reminder for one person, the toast, the row's new
      // "last reminded" line, the audit row with the lead as actor; a second
      // Remind inside the cadence is the server's sentence as the toast.
      await row.getByRole("button", { name: "Remind", exact: true }).click();
      await expect(lpage.locator('[role="status"]').getByText(`Reminder queued for ${memberName}.`)).toBeVisible();
      await expect(row.getByText(/^last reminded \S/)).toBeVisible();
      const reminded = (await api(lpage, "/api/compliance/team")).body as TeamPayload;
      expect(reminded.rows.find((r) => r.assignment_id === assignmentId)?.reminded_at, "the row carries the stamp").toBeTruthy();
      await row.getByRole("button", { name: "Remind", exact: true }).click();
      await expect(lpage.locator('[role="alert"]').getByText(`${memberName} was reminded earlier today.`)).toBeVisible();
      const again = await api(lpage, "/api/compliance/team", { method: "POST", body: { assignment_id: assignmentId } });
      expect(again.status, "inside the cadence").toBe(429);
      expect(again.body?.error).toBe(`${memberName} was reminded earlier today.`);
      const sent = await auditRows(page, "ack.reminder_sent", docId);
      expect(sent.some((r) => r.details?.by === "lead" && r.details?.user_id === memberId), "the lead's reminder is on the record").toBe(true);

      // My policies carries the lead's banner, and the API says why.
      expect((await api(lpage, "/api/compliance/mine")).body?.lead_team).toBe(true);
      await lpage.goto("/compliance");
      await expect(lpage.getByText("You lead a team.")).toBeVisible();
      await expect(lpage.getByRole("link", { name: "See your team's policies" })).toHaveAttribute("href", "/compliance/team");

      // The setting off: the route refuses with its sentence, the page is
      // not found, the tab and the banner are gone.
      await leadsSeePolicies(page, false);
      const off = await api(lpage, "/api/compliance/team");
      expect(off.status).toBe(403);
      expect(off.body?.error).toBe("Group leads don't see policy standing in this workspace.");
      await lpage.goto("/compliance/team");
      await expect(lpage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      await lpage.goto("/compliance");
      await expect(subnav(lpage).getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
      await expect(lpage.getByText("You lead a team.")).toHaveCount(0);
      expect((await api(lpage, "/api/compliance/mine")).body?.lead_team).toBe(false);
    } finally {
      await lctx.close();
    }
  } finally {
    if (settingWas !== undefined) await leadsSeePolicies(page, settingWas);
    if (privateId) await api(page, `/api/documents/${privateId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    if (groupId) await api(page, `/api/admin/groups/${groupId}`, { method: "DELETE" });
    if (privateGroupId) await api(page, `/api/admin/groups/${privateGroupId}`, { method: "DELETE" });
    if (leadId) await api(page, `/api/admin/users/${leadId}`, { method: "DELETE" });
    if (memberId) await api(page, `/api/admin/users/${memberId}`, { method: "DELETE" });
  }
});

test("a compliance.team_read holder who leads nothing sees every group; a plain viewer is not found; the admin's Overview carries the Team leads block", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E team holder ${suffix}`;
  const holder = { username: `e2e_teamread_${suffix}`, password: "E2eHold!12345" };
  const member = { username: `e2e_teammem_${suffix}`, password: "E2eMem!12345" };
  const groupName = `E2E Team every ${suffix}`;
  let docId: number | undefined;
  let holderId: number | undefined;
  let memberId: number | undefined;
  let groupId: number | undefined;
  let roleId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    await requireQuietly(page, docId);
    memberId = await makeUser(page, member, "E2E Team Member B");
    groupId = await makeGroup(page, groupName, [memberId]);
    holderId = await makeUser(page, holder, "E2E Team Reader");
    roleId = await grantRole(page, `E2E Team Reader ${suffix}`, ["compliance.team_read"], holderId);

    // The admin's Overview: the shared Team leads block with the policy
    // sentence and a picker per group, against the compliance leads route.
    await page.goto("/compliance/overview");
    await expect(page.getByRole("heading", { name: "Team leads" })).toBeVisible();
    await expect(page.getByText("Leads see a scoped view of their group's policies (and training, if licensed) and get a weekly summary.")).toBeVisible();
    await expect(page.getByRole("combobox", { name: `Leads of ${groupName}` })).toBeVisible();

    // The holder leads nothing and holds no section: every group opens,
    // with the new group's member and policy in it; the Team tab is the
    // one tab beside My policies.
    const hctx = await browser.newContext();
    try {
      const hpage = await hctx.newPage();
      await login(hpage, holder);
      const team = await api(hpage, "/api/compliance/team");
      expect(team.status, "a compliance.team_read holder reads every group").toBe(200);
      const payload = team.body as TeamPayload;
      expect(payload.groups.some((g) => g.id === groupId), "the new group is listed").toBe(true);
      const theirs = payload.rows.find((r) => r.group_id === groupId && r.user_id === memberId && r.document_id === docId);
      expect(theirs, "the member's row").toBeTruthy();
      // The holder leads none of the member's groups and manages no
      // programme: the row says so, and the POST refuses as it always did.
      expect(theirs!.may_remind, "a team_read holder who leads nothing may not remind").toBe(false);
      const refusedRemind = await api(hpage, "/api/compliance/team", { method: "POST", body: { assignment_id: theirs!.assignment_id } });
      expect(refusedRemind.status).toBe(403);
      expect(refusedRemind.body?.error).toBe("You can only remind members of groups you lead.");
      await hpage.goto("/compliance/team");
      await expect(hpage.getByRole("heading", { name: "Your team's policies" })).toBeVisible();
      await expect(subnav(hpage).getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(hpage.getByRole("heading", { name: groupName })).toBeVisible();
      // The page offers no control that would fail: Remind is disabled and
      // its wrapper says why (the Tooltip's note, named by the sentence).
      const holderCard = hpage.locator("section", { has: hpage.getByRole("heading", { name: groupName }) });
      // One row per policy the member owes: this policy's row is the one with its title.
      const holderRow = holderCard.getByRole("row").filter({ hasText: "E2E Team Member B" }).filter({ hasText: title });
      await expect(holderRow.getByRole("button", { name: "Remind", exact: true })).toBeDisabled();
      await expect(holderRow.getByRole("note", { name: "Only the group's lead or a programme manager can remind" })).toBeVisible();
      // The holder leads nothing, so My policies says nothing about a team
      // (the Team tab is their way in); the API agrees.
      expect((await api(hpage, "/api/compliance/mine")).body?.lead_team).toBe(false);
      await hpage.goto("/compliance");
      await expect(subnav(hpage).getByRole("link", { name: "Team", exact: true })).toBeVisible();
      await expect(hpage.getByText("You lead a team.")).toHaveCount(0);
    } finally {
      await hctx.close();
    }

    // The member leads nothing and holds nothing: the route says so, the
    // page is not found, no Team tab, no banner.
    const mctx = await browser.newContext();
    try {
      const mpage = await mctx.newPage();
      await login(mpage, member);
      const refused = await api(mpage, "/api/compliance/team");
      expect(refused.status).toBe(403);
      expect(refused.body?.error).toBe("You don't lead any groups.");
      expect((await api(mpage, "/api/compliance/leads")).status, "the leads list needs the section").toBe(403);
      await mpage.goto("/compliance/team");
      await expect(mpage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      await mpage.goto("/compliance");
      await expect(subnav(mpage).getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
      await expect(mpage.getByText("You lead a team.")).toHaveCount(0);
    } finally {
      await mctx.close();
    }
  } finally {
    if (roleId) await api(page, `/api/admin/rbac/roles/${roleId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
    if (groupId) await api(page, `/api/admin/groups/${groupId}`, { method: "DELETE" });
    if (holderId) await api(page, `/api/admin/users/${holderId}`, { method: "DELETE" });
    if (memberId) await api(page, `/api/admin/users/${memberId}`, { method: "DELETE" });
  }
});

test("Program settings: the Team leads card's toggle round-trips through the page's one Save and is sent with every save", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, ADMIN);
  test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
  const before = await api(page, "/api/admin/compliance/settings");
  expect(before.status, "the admin reads the program settings").toBe(200);
  const was = Boolean(before.body?.settings?.ack_defaults?.leads_see_policies);
  try {
    await page.goto("/compliance/settings");
    await expect(page.getByRole("heading", { name: "Team leads" })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Group leads see policy standing" });
    await expect(toggle).toHaveAttribute("aria-checked", String(was));
    await expect(page.getByText("Leads of a group see where its members stand on policies in spaces they can read, and get the weekly summary.")).toBeVisible();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    // Flip it, save, and the API agrees; flip it back the same way.
    await toggle.click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Program settings saved.")).toBeVisible();
    expect((await api(page, "/api/admin/compliance/settings")).body?.settings?.ack_defaults?.leads_see_policies).toBe(!was);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", String(!was));
    await toggle.click();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Program settings saved.")).toBeVisible();
    expect((await api(page, "/api/admin/compliance/settings")).body?.settings?.ack_defaults?.leads_see_policies).toBe(was);

    // A save that changes something else still carries the key (the stored
    // row would otherwise read as off on an upgraded workspace).
    const audited = await api(page, "/api/admin/audit?limit=50");
    const flips = (audited.body?.rows ?? []).filter(
      (r: { action: string; details?: { key?: string } }) => r.action === "settings.compliance" && r.details?.key === "ack_defaults.leads_see_policies"
    );
    expect(flips.length, "both flips are on the record").toBeGreaterThanOrEqual(2);
  } finally {
    await api(page, "/api/admin/compliance/settings", { method: "PUT", body: { ack_defaults: { leads_see_policies: was } } });
  }
});
