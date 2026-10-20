import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.14.0 (F3): the per-person compliance record, /compliance/person/{id}
// and /compliance/person/me. A reader opens their own record and sees their
// rows under a pronoun-free subtitle with a back link to My policies; the
// admin opens a person's record from the People side with the Actions
// section, downloads the CSV (21 columns, audited as ack.record_exported)
// and prints it with the controls off paper and a footer naming who
// generated it; a stranger gets the shell's not-found page and the API's
// 404; a group lead with the Program setting on sees a member's record
// scoped to the spaces they can read, with a count for the rest and no
// private-space title anywhere in the page or the JSON.
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the community
// build, so each test skips itself when the portal answers 402 and runs in
// full on the EE rig (as e2e/compliance-portal.spec.ts does). The lead case
// sets the lead through the training leads API and skips when training is
// not licensed either.

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the record page check. Read it and confirm at the end.";

/** RECORD_CSV_HEADER in src/lib/read-evidence.ts: the 21 columns of a person's record. */
const RECORD_HEADER =
  "policy,set,status,source,assigned_at,removed_at,due_at,acknowledged_at,version,version_id,version_source,content_sha256,signed_name,identity_proof,read_seconds,reached_end,ip,exempt_reason,exempt_by,exempt_until,superseded_by";

/** The subtitle, the same sentence for every person (no pronoun to get wrong). */
const SUBTITLE = "every policy this person must confirm, with the evidence and prior cycles.";

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

/** Switch the requirement on without a notice (the portal's "Require quietly"). */
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
  expect(id, "group id").toBeTruthy();
  for (const userId of memberIds) {
    const added = await api(page, `/api/admin/groups/${id}`, { method: "PATCH", body: { addUserId: userId } });
    expect(added.status, `member ${userId} added to ${name}`).toBe(200);
  }
  return id;
}

/** A private space readable by the named groups only: admins see it, nobody else. */
async function makePrivateSpace(page: Page, name: string, groupIds: number[]): Promise<number> {
  const made = await api(page, "/api/admin/spaces", { method: "POST", body: { name, visibility: "private", groupIds } });
  expect(made.status, "private space created").toBe(201);
  const id = made.body?.space?.id;
  expect(id, "space id").toBeTruthy();
  return id;
}

/** A text download through the page's session cookie (api() parses JSON only). */
async function fetchText(page: Page, path: string): Promise<{ status: number; text: string; disposition: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, text: await res.text(), disposition: res.headers.get("content-disposition") || "" };
  }, path);
}

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

async function auditRows(page: Page, pick: (r: any) => boolean): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(pick);
}

/** The record's table under the heading with this name (each section is labelled by its heading). */
const section = (page: Page, name: RegExp | string) => page.getByRole("region", { name });

test("a person opens their own record, the admin opens it with the Actions section, downloads the audited CSV and prints it, and a stranger is not found", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E record policy ${suffix}`;
  const person = { username: `e2e_record_${suffix}`, password: "E2eRecord!12345" };
  const personName = "E2E Record Person";
  const stranger = { username: `e2e_recstr_${suffix}`, password: "E2eStranger!12345" };
  let docId: number | undefined;
  let personId: number | undefined;
  let strangerId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    personId = await makeUser(page, person, personName);
    strangerId = await makeUser(page, stranger, "E2E Record Stranger");
    // Requested after the accounts exist, so both hold a row in space 1.
    await requireQuietly(page, docId);

    // The person's own record: /me resolves to them; the subtitle is the
    // same sentence for everyone; the back link is My policies; the policy
    // sits under Current requirements as Pending; no Actions for a reader.
    const ctx = await browser.newContext();
    try {
      const ppage = await ctx.newPage();
      await login(ppage, person);
      await ppage.goto("/compliance/person/me");
      await expect(ppage.getByRole("heading", { name: `Compliance record - ${personName}` })).toBeVisible();
      await expect(ppage.getByText(`@${person.username} · ${SUBTITLE}`)).toBeVisible();
      await expect(ppage.getByRole("link", { name: "My policies" })).toHaveAttribute("href", "/compliance");
      const row = section(ppage, "Current requirements").locator("tr", { hasText: title });
      await expect(row).toBeVisible();
      await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/doc/${docId}`);
      await expect(row.getByText("Pending", { exact: true })).toBeVisible();
      await expect(row.getByText(/everyone in .+ space/)).toBeVisible();
      await expect(ppage.getByRole("heading", { name: "Actions" })).toHaveCount(0);
      // The reader's own JSON opens too, as 'self'.
      const mine = await api(ppage, "/api/admin/compliance/people/me");
      expect(mine.status).toBe(200);
      expect(mine.body?.viewer_kind).toBe("self");
      expect(mine.body?.person?.id).toBe(personId);
      expect(mine.body?.hidden).toBe(0);
      expect(mine.body?.current?.some((r: { document_id: number; status: string }) => r.document_id === docId && r.status === "pending")).toBe(true);
      // Another person's record is not theirs to open.
      await ppage.goto(`/compliance/person/${strangerId}`);
      await expect(ppage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      expect((await api(ppage, `/api/admin/compliance/people/${strangerId}`)).status).toBe(404);
    } finally {
      await ctx.close();
    }

    // The admin opens the person's record from the programme side: the
    // People back link, the Actions section with its controls, the CSV.
    await page.goto(`/compliance/person/${personId}`);
    await expect(page.getByRole("heading", { name: `Compliance record - ${personName}` })).toBeVisible();
    await expect(page.getByText(`@${person.username} · ${SUBTITLE}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "People" })).toHaveAttribute("href", "/compliance/people");
    await expect(section(page, "Current requirements").locator("tr", { hasText: title })).toBeVisible();
    const actions = section(page, "Actions");
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("button", { name: "Remind about everything outstanding" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Exempt from…" })).toBeEnabled();
    await expect(actions.getByRole("button", { name: "Extend…" })).toBeEnabled();
    // Nothing is confirmed yet, so there is nothing to re-ask.
    await expect(actions.getByRole("button", { name: "Ask to re-confirm…" })).toBeDisabled();
    // Exempt from… lists the policy; the question names the person and the
    // policy; Cancel changes nothing.
    await actions.getByRole("button", { name: "Exempt from…" }).click();
    const menu = page.getByRole("menu", { name: "Exempt from…" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: new RegExp(`^${title}`) }).click();
    const dialog = page.getByRole("dialog", { name: `Exempt ${personName} from "${title}"` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(section(page, "Current requirements").locator("tr", { hasText: title }).getByText("Pending", { exact: true })).toBeVisible();

    // The CSV: the 21 columns, the policy's line, the attachment name, and
    // the audit row written for the download.
    const csv = await fetchText(page, `/api/admin/compliance/people/${personId}?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.disposition).toContain(`compliance-record-${person.username}.csv`);
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe(RECORD_HEADER);
    const line = lines.slice(1).map(cells).find((c) => c[0] === title);
    expect(line, "the policy's line").toBeTruthy();
    expect(line!.length).toBe(21);
    expect(line![2]).toBe("pending");
    expect(line![3]).toBe("space");
    const exported = await auditRows(
      page,
      (r) => r.action === "ack.record_exported" && Number(r.target_id) === personId
    );
    expect(exported.length).toBeGreaterThanOrEqual(1);
    expect(exported[0].details).toMatchObject({ user_id: personId, viewer_kind: "program", hidden: 0 });
    expect(typeof exported[0].details?.rows).toBe("number");

    // On paper: the controls go, the footer names the generator.
    const footer = page.getByText(new RegExp(`^Generated .+ by .+ · CompassDocs \\d+\\.\\d+\\.\\d+`));
    await expect(footer).toHaveCount(1);
    await expect(footer).toBeHidden();
    await page.emulateMedia({ media: "print" });
    await expect(footer).toBeVisible();
    await expect(actions, "the Actions section stays off paper").toBeHidden();
    await expect(page.getByRole("link", { name: "CSV" })).toBeHidden();
    await expect(section(page, "Current requirements").locator("tr", { hasText: title })).toBeVisible();
    await page.emulateMedia({ media: "screen" });

    // A stranger: a signed-in viewer with no relation to the person is not
    // found, on the page and on the API, the same answer an unknown id gets.
    const sctx = await browser.newContext();
    try {
      const spage = await sctx.newPage();
      await login(spage, stranger);
      await spage.goto(`/compliance/person/${personId}`);
      await expect(spage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      expect((await api(spage, `/api/admin/compliance/people/${personId}`)).status).toBe(404);
      expect((await api(spage, "/api/admin/compliance/people/999999999")).status).toBe(404);
    } finally {
      await sctx.close();
    }
  } finally {
    if (strangerId) await api(page, `/api/admin/users/${strangerId}`, { method: "DELETE" });
    if (personId) await api(page, `/api/admin/users/${personId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("a group lead with the setting on opens a member's record scoped to their own spaces: a count for the rest and no private-space title", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const publicTitle = `E2E record public ${suffix}`;
  const privateTitle = `E2E record private ${suffix}`;
  const member = { username: `e2e_recmem_${suffix}`, password: "E2eMember!12345" };
  const memberName = "E2E Record Member";
  const lead = { username: `e2e_reclead_${suffix}`, password: "E2eLead!12345" };
  let publicId: number | undefined;
  let privateId: number | undefined;
  let memberId: number | undefined;
  let leadId: number | undefined;
  let readersGroup: number | undefined;
  let teamGroup: number | undefined;
  let spaceId: number | undefined;
  let settingBefore: boolean | undefined;
  try {
    publicId = await makePolicy(page, publicTitle);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    memberId = await makeUser(page, member, memberName);
    leadId = await makeUser(page, lead, "E2E Record Lead");

    // Two groups: the readers group opens the private space to the member
    // alone; the team group holds the member and is led by the lead, who is
    // in no group that reads the private space.
    readersGroup = await makeGroup(page, `E2E record readers ${suffix}`, [memberId]);
    teamGroup = await makeGroup(page, `E2E record team ${suffix}`, [memberId]);
    const leads = await api(page, "/api/training/leads", { method: "PUT", body: { group_id: teamGroup, user_ids: [leadId] } });
    test.skip(leads.status === 402, "training is not licensed in this build, so no API names a group lead; the EE rig runs the flow");
    expect(leads.status, "the lead named").toBe(200);

    spaceId = await makePrivateSpace(page, `E2E record space ${suffix}`, [readersGroup]);
    privateId = await makePolicy(page, privateTitle, spaceId);
    await requireQuietly(page, publicId);
    await requireQuietly(page, privateId);

    // The Program setting that lets leads see policy standing; restored below.
    const settings = await api(page, "/api/admin/compliance/settings");
    expect(settings.status).toBe(200);
    settingBefore = Boolean(settings.body?.settings?.ack_defaults?.leads_see_policies);
    const on = await api(page, "/api/admin/compliance/settings", {
      method: "PUT",
      body: { ack_defaults: { leads_see_policies: true } },
    });
    expect(on.status, "leads see policy standing").toBe(200);

    // The admin sees both rows and no hidden count.
    const full = await api(page, `/api/admin/compliance/people/${memberId}`);
    expect(full.status).toBe(200);
    expect(full.body?.viewer_kind).toBe("program");
    expect(full.body?.hidden).toBe(0);
    const titles = (full.body?.current ?? []).map((r: { title: string }) => r.title);
    expect(titles).toContain(publicTitle);
    expect(titles).toContain(privateTitle);

    const ctx = await browser.newContext();
    try {
      const lpage = await ctx.newPage();
      await login(lpage, lead);
      // The JSON first: the private title never leaves the database.
      const scoped = await api(lpage, `/api/admin/compliance/people/${memberId}`);
      expect(scoped.status, "the lead opens the member's record").toBe(200);
      expect(scoped.body?.viewer_kind).toBe("lead");
      expect(scoped.body?.hidden).toBe(1);
      expect(JSON.stringify(scoped.body)).not.toContain(privateTitle);
      expect((scoped.body?.current ?? []).map((r: { title: string }) => r.title)).toContain(publicTitle);

      // The page: the public row, the count line, no private title, the
      // back link to the team view, no Actions (a lead is not a manager).
      await lpage.goto(`/compliance/person/${memberId}`);
      await expect(lpage.getByRole("heading", { name: `Compliance record - ${memberName}` })).toBeVisible();
      await expect(lpage.getByText("1 policy you can't view")).toBeVisible();
      await expect(section(lpage, "Current requirements").locator("tr", { hasText: publicTitle })).toBeVisible();
      await expect(lpage.getByText(privateTitle)).toHaveCount(0);
      await expect(lpage.getByRole("link", { name: "Your team's policies" })).toHaveAttribute("href", "/compliance/team");
      await expect(lpage.getByRole("heading", { name: "Actions" })).toHaveCount(0);

      // The lead's CSV carries the same scope and its own audit row.
      const csv = await fetchText(lpage, `/api/admin/compliance/people/${memberId}?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.text).toContain(publicTitle);
      expect(csv.text).not.toContain(privateTitle);

      // With the setting off, the lead is a stranger again.
      const off = await api(page, "/api/admin/compliance/settings", {
        method: "PUT",
        body: { ack_defaults: { leads_see_policies: false } },
      });
      expect(off.status).toBe(200);
      expect((await api(lpage, `/api/admin/compliance/people/${memberId}`)).status, "the setting off closes the record").toBe(404);
      await lpage.goto(`/compliance/person/${memberId}`);
      await expect(lpage.getByRole("heading", { name: "Page not found" })).toBeVisible();
    } finally {
      await ctx.close();
    }
    const exported = await auditRows(
      page,
      (r) => r.action === "ack.record_exported" && Number(r.target_id) === memberId && r.details?.viewer_kind === "lead"
    );
    expect(exported.length).toBeGreaterThanOrEqual(1);
    expect(exported[0].details).toMatchObject({ user_id: memberId, hidden: 1 });
  } finally {
    if (settingBefore !== undefined) {
      await api(page, "/api/admin/compliance/settings", { method: "PUT", body: { ack_defaults: { leads_see_policies: settingBefore } } });
    }
    if (privateId) await api(page, `/api/documents/${privateId}`, { method: "DELETE" });
    if (publicId) await api(page, `/api/documents/${publicId}`, { method: "DELETE" });
    if (spaceId) await api(page, `/api/admin/spaces/${spaceId}`, { method: "DELETE" });
    if (teamGroup) await api(page, `/api/admin/groups/${teamGroup}`, { method: "DELETE" });
    if (readersGroup) await api(page, `/api/admin/groups/${readersGroup}`, { method: "DELETE" });
    if (leadId) await api(page, `/api/admin/users/${leadId}`, { method: "DELETE" });
    if (memberId) await api(page, `/api/admin/users/${memberId}`, { method: "DELETE" });
  }
});
