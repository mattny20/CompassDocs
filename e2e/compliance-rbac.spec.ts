import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.10.1 (F6): the compliance portal enforces the read / manage / export
// split. A custom role holding only compliance.program_read reads the
// programme (200) but cannot request (403), remind, stop or export the
// matrix (403), and the portal shows it no control that would answer 403.
// An unknown action is 400 and switches nothing on. Every CSV writes an
// ack.export audit row, and the per-policy record shows the recorded IP only
// to a caller who also holds compliance.export.
//
// Roles are created the way e2e/rbac-enforcement.spec.ts creates them, and
// the test cleans up after itself: the suite shares one database. Licensed
// builds only: the portal answers 402 on the community build and the test
// skips itself (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the access-control check. Read it and confirm at the end.";

const ROSTER_HEADER =
  "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,ip,user_agent";

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

async function portalLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/admin/compliance");
  if (res.status === 402) return false;
  expect(res.status, "the admin reads the portal").toBe(200);
  return true;
}

/** A custom role with exactly these permissions, assigned to the user. */
async function grantRole(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e: the compliance split", permissions },
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

async function fetchText(page: Page, path: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, text: await res.text() };
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

test("a program_read-only role reads the portal and nothing more; unknown actions are 400; exports are audited; the IP is for exporters", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E compliance rbac ${suffix}`;
  const reader = { username: `e2e_compread_${suffix}`, password: "E2eRead!12345" };
  const steward = { username: `e2e_compstew_${suffix}`, password: "E2eStew!12345" };
  let docId: number | undefined;
  let readerId: number | undefined;
  let stewardId: number | undefined;
  let readerRole: number | undefined;
  let stewardRole: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // An unknown action is refused before anything happens: the policy stays
    // off, and nobody is mailed. (Before F6 anything but 'remind' meant
    // 'request'.)
    const unknown = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "frob" } });
    expect(unknown.status).toBe(400);
    expect(unknown.body?.error).toBe("Unknown action.");
    expect((await api(page, "/api/admin/compliance", { method: "POST", body: { docId } })).status, "no action is unknown too").toBe(400);
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.ack_required).toBe(0);

    // The admin switches the policy on quietly and confirms it, so the record
    // has one confirmed row to carry an IP column for.
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    expect(typeof on.body?.queued, "the answer carries the queued count").toBe("number");
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    const confirmed = await api(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: summary.body?.latest_version_id },
    });
    expect(confirmed.status).toBe(200);
    // The admin holds everything: the GET says so.
    const adminView = await api(page, "/api/admin/compliance");
    expect(adminView.body?.can).toEqual({ manage: true, export: true });

    // The read-only role: compliance.program_read and nothing else.
    readerId = await makeUser(page, reader, "E2E Compliance Reader");
    readerRole = await grantRole(page, `E2E Compliance Reader ${suffix}`, ["compliance.program_read"], readerId);
    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);

      // The API: read opens, manage and export stay closed.
      const view = await api(rpage, "/api/admin/compliance");
      expect(view.status, "program_read reads the portal").toBe(200);
      expect(view.body?.can, "and is told what it may not do").toEqual({ manage: false, export: false });
      expect(view.body?.docs?.some((d: { id: number }) => d.id === docId), "the policy is listed").toBe(true);
      const preview = await api(rpage, `/api/admin/compliance?preview=${docId}`);
      expect(preview.status, "the audience count is a read").toBe(200);
      expect(typeof preview.body?.eligible).toBe("number");
      for (const action of ["request", "remind", "stop"]) {
        const refused = await api(rpage, "/api/admin/compliance", { method: "POST", body: { docId, action } });
        expect(refused.status, `${action} needs program_manage`).toBe(403);
      }
      expect((await fetchText(rpage, "/api/admin/compliance?format=csv")).status, "the matrix needs export").toBe(403);
      // The roster needs the space-scoped document.ack_roster_read, which
      // this role does not hold either.
      expect((await api(rpage, `/api/documents/${docId}/acknowledgements`)).status).toBe(403);
      // Nothing changed hands.
      expect((await api(page, `/api/documents/${docId}`)).body?.doc?.ack_required).toBe(1);

      // The page: the programme is readable, with no manage or export
      // control anywhere, and the roster expand says why it cannot load
      // instead of spinning.
      await rpage.goto("/compliance");
      const main = rpage.locator("#main");
      await expect(main.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(main.getByText("Policies requiring confirmation")).toBeVisible();
      const row = main.locator("li", { hasText: title });
      await expect(row).toBeVisible();
      await expect(main.getByRole("button", { name: "Request read confirmation" })).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Document" })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Remind" })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Stop requiring" })).toHaveCount(0);
      await expect(main.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
      await expect(main.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
      await expect(main.getByRole("link", { name: "Download this policy's compliance record" })).toHaveCount(0);
      await row.getByRole("button", { name: title }).click();
      await expect(rpage.locator('[role="alert"]').getByText(/permission|roster/)).toBeVisible();
      await expect(rpage.locator('[role="status"]', { hasText: "Loading" })).toHaveCount(0);
      await expect(row.getByRole("button", { name: title })).toHaveAttribute("aria-expanded", "false");
    } finally {
      await rctx.close();
    }

    // A roster reader without export: the per-policy CSV opens (the space
    // permission), carries the ip and user_agent columns at the end, and
    // leaves them blank.
    stewardId = await makeUser(page, steward, "E2E Compliance Steward");
    stewardRole = await grantRole(
      page,
      `E2E Compliance Steward ${suffix}`,
      ["compliance.program_read", "document.ack_roster_read"],
      stewardId
    );
    const sctx = await browser.newContext();
    try {
      const spage = await sctx.newPage();
      await login(spage, steward);
      const csv = await fetchText(spage, `/api/documents/${docId}/acknowledgements?format=csv`);
      expect(csv.status, "a roster reader downloads the record").toBe(200);
      const lines = csv.text.trim().split("\n");
      expect(lines[0]).toBe(ROSTER_HEADER);
      const ipAt = cells(lines[0]).indexOf("ip");
      const adminLine = lines.slice(1).map(cells).find((c) => c[1] === ADMIN.username);
      expect(adminLine, "the admin's confirmed row is in the record").toBeTruthy();
      expect(adminLine![4], "and it is confirmed").toBe("acknowledged");
      expect(adminLine![ipAt], "without export the ip column is blank").toBe("");
      for (const c of lines.slice(1).map(cells)) expect(c[ipAt]).toBe("");
      // The JSON roster carries no ip either.
      const roster = await api(spage, `/api/documents/${docId}/acknowledgements`);
      expect(roster.status).toBe(200);
      expect(roster.body?.can?.export).toBe(false);
      expect(roster.body?.rows?.every((r: Record<string, unknown>) => !("ip" in r))).toBe(true);
      expect((await fetchText(spage, "/api/admin/compliance?format=csv")).status, "the matrix still needs export").toBe(403);
    } finally {
      await sctx.close();
    }
    // That download is on the record, marked as without the IP.
    const stewardExport = await auditRows(
      page,
      (r) => r.action === "ack.export" && Number(r.target_id) === docId && r.actor_name === "E2E Compliance Steward"
    );
    expect(stewardExport.length).toBe(1);
    expect(stewardExport[0].details?.format).toBe("roster");
    expect(stewardExport[0].details?.with_ip).toBe(false);
    expect(stewardExport[0].details?.rows).toBeGreaterThanOrEqual(1);

    // The admin's exports: the same header, the IP column populated from the
    // record for an exporter (blank here only when the rig records none),
    // and one ack.export row per download.
    const adminCsv = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=csv`);
    expect(adminCsv.status).toBe(200);
    expect(adminCsv.text.trim().split("\n")[0]).toBe(ROSTER_HEADER);
    const adminRoster = await auditRows(
      page,
      (r) => r.action === "ack.export" && Number(r.target_id) === docId && r.actor_name !== "E2E Compliance Steward"
    );
    expect(adminRoster.length).toBe(1);
    expect(adminRoster[0].details).toMatchObject({ format: "roster", doc_id: docId, with_ip: true });
    expect(adminRoster[0].details?.rows).toBeGreaterThanOrEqual(1);
    const adminJson = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(adminJson.body?.can?.export).toBe(true);
    expect(adminJson.body?.rows?.every((r: Record<string, unknown>) => "ip" in r), "an exporter's JSON rows carry ip").toBe(true);

    const matrix = await fetchText(page, "/api/admin/compliance?format=csv");
    expect(matrix.status).toBe(200);
    const matrixExport = await auditRows(page, (r) => r.action === "ack.export" && r.details?.format === "matrix");
    expect(matrixExport.length).toBeGreaterThanOrEqual(1);
    expect(matrixExport[0].details).toMatchObject({ format: "matrix", doc_id: "all", with_ip: false });
    expect(typeof matrixExport[0].details?.rows).toBe("number");
  } finally {
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (stewardRole) await api(page, `/api/admin/rbac/roles/${stewardRole}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (stewardId) await api(page, `/api/admin/users/${stewardId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
