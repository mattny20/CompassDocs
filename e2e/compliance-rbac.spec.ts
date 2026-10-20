import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.10.1 (F6): the compliance portal enforces the read / manage / export
// split. A custom role holding only compliance.program_read reads the
// programme (200) but cannot request (403), remind, stop or export the
// matrix (403), and the portal shows it no control that would answer 403.
// An unknown action is 400 and switches nothing on. Every CSV writes an
// ack.export audit row, and the per-policy record shows the recorded IP only
// to a caller who also holds compliance.export. The program settings need
// program_manage on both verbs, and the space-scoped document.ack_require
// is checked on the document's own space: a role holding it on one space
// cannot PATCH the requirement of a document in another. 1.12.0 adds the
// scope rule on the new per-document routes (a policy in a space the caller
// cannot see is 404 on ack-settings, retire and un-retire, and its Settings
// tab is not found), the user_agent column beside the IP (blank without
// export, filled for an exporter, on current and former-staff rows alike),
// and the shipped Compliance manager preset saving the Settings tab's
// statement card through the API with program_manage alone.
//
// Roles are created the way e2e/rbac-enforcement.spec.ts creates them, and
// the test cleans up after itself: the suite shares one database. Licensed
// builds only: the portal answers 402 on the community build and the test
// skips itself (as e2e/acknowledgements.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the access-control check. Read it and confirm at the end.";

// The 1.11.0 columns in place, the six attestation and re-confirmation
// columns (1.12.0, C4), the five exemption and deadline columns (1.13.0,
// D2) and the policy's sets (1.14.0, D3) appended: ROSTER_CSV_HEADER in
// src/lib/read-evidence.ts.
const ROSTER_HEADER =
  "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,ip,user_agent,version_published_by,version_approved_by,read_seconds,reached_end_self_reported,statement,signed_name,identity_proof,recert_months,effective_at,next_recert_at,exempt_reason,exempt_by,exempt_until,snoozed_until,due_at,set";

/** The ledger (C4, 1.12.0): every confirmation ever recorded; compliance.export only. */
const LEDGER_HEADER =
  "document,document_id,space,name,username,email,role,acknowledged_at,superseded,version,version_id,content_sha256,version_source,statement,signed_name,identity_proof,read_seconds,reached_end_self_reported,ip,user_agent,account_removed";

/** The address the admin's confirmation arrives from, as a proxy would report it. */
const ADMIN_IP = "203.0.113.9";

/** A JSON request with extra headers through the page's session cookie (api() takes none). */
async function apiWithHeaders(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown; headers: Record<string, string> }
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ path, method, body, headers }) => {
      const res = await fetch(path, {
        method: method || "GET",
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: any = null;
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed };
    },
    { path, method: init.method, body: init.body, headers: init.headers }
  );
}

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
  const manager = { username: `e2e_compmgr_${suffix}`, password: "E2eMgr!12345" };
  let docId: number | undefined;
  let hiddenId: number | undefined;
  let readerId: number | undefined;
  let stewardId: number | undefined;
  let requirerId: number | undefined;
  let managerId: number | undefined;
  let readerRole: number | undefined;
  let stewardRole: number | undefined;
  let requirerRole: number | undefined;
  let otherSpaceId: number | undefined;
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
    // A notify that is not a boolean is refused too, as the shield's PATCH
    // refuses it: "false" must not read as "tell everyone".
    const notifyString = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: "false" },
    });
    expect(notifyString.status).toBe(400);
    expect(notifyString.body?.error).toBe("'notify' must be true or false.");
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.ack_required).toBe(0);

    // The admin switches the policy on quietly and confirms it, so the record
    // has one confirmed row to carry an IP column for. The confirmation
    // arrives with a forwarded address, as it would through the proxy, so
    // the exporter's view below can be checked against a real value.
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    expect(typeof on.body?.queued, "the answer carries the queued count").toBe("number");
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    const confirmed = await apiWithHeaders(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: summary.body?.latest_version_id },
      headers: { "x-forwarded-for": ADMIN_IP },
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
      // The ledger (C4, 1.12.0) carries the IP and user agent of every
      // confirmation ever recorded: the section alone does not open it.
      expect((await fetchText(rpage, "/api/admin/compliance?format=ledger")).status, "the ledger needs export").toBe(403);
      // The program settings need program_manage on both verbs.
      expect((await api(rpage, "/api/admin/compliance/settings")).status, "reading the settings").toBe(403);
      const put = await api(rpage, "/api/admin/compliance/settings", {
        method: "PUT",
        body: { ack_defaults: { edit_default: "reset" } },
      });
      expect(put.status, "writing the settings").toBe(403);
      // The roster needs the space-scoped document.ack_roster_read, which
      // this role does not hold either.
      expect((await api(rpage, `/api/documents/${docId}/acknowledgements`)).status).toBe(403);
      // Nothing changed hands.
      expect((await api(page, `/api/documents/${docId}`)).body?.doc?.ack_required).toBe(1);

      // The pages (B4, 1.12.0: /compliance is My policies; the programme
      // is the Overview's tiles and the Policies page's rows): readable,
      // with no manage or export control anywhere and no Settings tab, and
      // the roster expand says why it cannot load instead of spinning.
      await rpage.goto("/compliance/overview");
      const main = rpage.locator("#main");
      await expect(main.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(main.getByText("Policies requiring confirmation")).toBeVisible();
      await expect(main.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
      await rpage.goto("/compliance/policies");
      await expect(main.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      const row = main.locator("li", { hasText: title });
      await expect(row).toBeVisible();
      await expect(main.getByRole("button", { name: "Request read confirmation" })).toHaveCount(0);
      await expect(main.getByRole("combobox", { name: "Document" })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Remind", exact: true })).toHaveCount(0);
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

    // A role holding document.ack_require on another space may read the
    // policy (an internal space) but not switch its requirement, its notice
    // or its edit default: the key is checked on the document's own space.
    const otherSpace = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Other ${suffix}`, slug: `e2e-other-${suffix}`, description: "", visibility: "private" },
    });
    otherSpaceId = otherSpace.body?.space?.id ?? otherSpace.body?.id;
    expect(otherSpaceId, "the other space exists").toBeTruthy();
    // A policy in the private space, required quietly, for the scope rule
    // below: a document outside the caller's scope answers 404 on every
    // per-document route and as a page, before the licence and the
    // permission checks.
    hiddenId = await makePolicy(page, `${title} hidden`, otherSpaceId!);
    const hiddenOn = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId: hiddenId, action: "request", notify: false },
    });
    expect(hiddenOn.status, "the hidden policy is required quietly").toBe(200);
    const requirer = { username: `e2e_compreq_${suffix}`, password: "E2eReq!12345" };
    requirerId = await makeUser(page, requirer, "E2E Compliance Requirer");
    const reqRole = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Requirer ${suffix}`, description: "e2e: ack_require on one space", permissions: ["document.ack_require"] },
    });
    expect(reqRole.status).toBe(201);
    requirerRole = reqRole.body?.id;
    const scoped = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: requirerRole, user_id: requirerId, space_id: otherSpaceId },
    });
    expect(scoped.status, "assigned in the other space only").toBe(201);
    const qctx = await browser.newContext();
    try {
      const qpage = await qctx.newPage();
      await login(qpage, requirer);
      expect((await api(qpage, `/api/documents/${docId}`)).status, "the policy is readable").toBe(200);
      for (const body of [{ required: false }, { required: true, notify: true }, { edit_default: "reset" }]) {
        const patched = await api(qpage, `/api/documents/${docId}/ack`, { method: "PATCH", body });
        expect(patched.status, `PATCH ${JSON.stringify(body)} from another space's holder`).toBe(403);
      }
      const reask = await api(qpage, `/api/documents/${docId}/ack/reconfirm`, {
        method: "POST",
        body: { reason: "Holder of the key on another space" },
      });
      expect(reask.status, "the re-ask is scoped the same way").toBe(403);
    } finally {
      await qctx.close();
    }
    // Nothing changed hands.
    const untouched = await api(page, `/api/documents/${docId}/ack`);
    expect(untouched.body?.required).toBe(true);
    expect(untouched.body?.edit_default).toBe("ask");
    expect((await auditRows(page, (r) => r.action === "document.ack_removed" && Number(r.target_id) === docId)).length).toBe(0);

    // A roster reader without export: the per-policy CSV opens (the space
    // permission), carries ip and user_agent after kept_since_asked (blank
    // without export) and the version's publisher and approver at the end.
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
      const header = cells(lines[0]);
      const ipAt = header.indexOf("ip");
      const adminLine = lines.slice(1).map(cells).find((c) => c[1] === ADMIN.username);
      expect(adminLine, "the admin's confirmed row is in the record").toBeTruthy();
      expect(adminLine![4], "and it is confirmed").toBe("acknowledged");
      expect(adminLine![ipAt], "without export the ip column is blank").toBe("");
      for (const c of lines.slice(1).map(cells)) expect(c[ipAt]).toBe("");
      // The user agent (filled from 1.12.0) follows the same rule.
      const uaAt = header.indexOf("user_agent");
      expect(uaAt, "user_agent follows ip").toBe(ipAt + 1);
      for (const c of lines.slice(1).map(cells)) expect(c[uaAt], "without export the user_agent column is blank").toBe("");
      // The provenance columns are for everyone who may read the roster.
      expect(adminLine![header.indexOf("version_published_by")], "the version's publisher is named").not.toBe("");
      expect(adminLine![header.indexOf("version_approved_by")], "no change request, no approver").toBe("");
      // The reading evidence (1.11.0, C3) closes the row: the admin confirmed
      // through the API without opening the page, so the read time is
      // unknown (blank, not 0) and the self-reported flag reads "no"; a
      // pending row carries neither.
      const readAt = header.indexOf("read_seconds");
      const reachedAt = header.indexOf("reached_end_self_reported");
      expect(readAt, "read_seconds follows the provenance pair").toBe(header.indexOf("version_approved_by") + 1);
      expect(reachedAt, "reached_end_self_reported follows it").toBe(readAt + 1);
      expect(adminLine![readAt], "no view was recorded: unknown, not zero").toBe("");
      expect(adminLine![reachedAt], "confirmed without the card's report").toBe("no");
      // The six 1.12.0 columns close the line (C4): the statement the admin
      // confirmed under (the workspace default: this policy sets none), no
      // signature (the policy does not require one), and the policy's
      // re-confirmation settings (none set here).
      const statementAt = header.indexOf("statement");
      expect(statementAt, "statement follows the evidence pair").toBe(reachedAt + 1);
      expect(header.slice(statementAt), "the six columns in order, then the five of 1.13.0 (D2), last").toEqual([
        "statement",
        "signed_name",
        "identity_proof",
        "recert_months",
        "effective_at",
        "next_recert_at",
        "exempt_reason",
        "exempt_by",
        "exempt_until",
        "snoozed_until",
        "due_at",
      ]);
      expect(adminLine![header.indexOf("exempt_reason")], "the admin is not exempt").toBe("");
      expect(adminLine![header.indexOf("snoozed_until")], "nor snoozed").toBe("");
      expect(adminLine![header.indexOf("signed_name")], "no signature required, none recorded").toBe("");
      expect(adminLine![header.indexOf("recert_months")], "no interval set").toBe("");
      expect(adminLine![header.indexOf("next_recert_at")]).toBe("");
      for (const c of lines.slice(1).map(cells)) {
        if (c[1] !== ADMIN.username) {
          expect(c[readAt], "a pending row has no read time").toBe("");
          expect(c[reachedAt], "and no report").toBe("");
          expect(c[statementAt], "and no statement").toBe("");
        }
      }
      // The JSON roster carries no ip or user agent either, on current and
      // former-staff rows alike.
      const roster = await api(spage, `/api/documents/${docId}/acknowledgements`);
      expect(roster.status).toBe(200);
      expect(roster.body?.can?.export).toBe(false);
      expect(roster.body?.rows?.every((r: Record<string, unknown>) => !("ip" in r))).toBe(true);
      expect(roster.body?.rows?.every((r: Record<string, unknown>) => !("user_agent" in r)), "nor user_agent").toBe(true);
      expect(
        (roster.body?.former_staff ?? []).every((r: Record<string, unknown>) => !("ip" in r) && !("user_agent" in r)),
        "former staff rows carry no personal data without export"
      ).toBe(true);
      // The ledger view is readable with the roster permission, with the two
      // personal-data fields blank; the ledger file needs export.
      const ledgerView = await api(spage, `/api/documents/${docId}/acknowledgements?view=all`);
      expect(ledgerView.status, "the All confirmations view opens with the roster permission").toBe(200);
      expect(ledgerView.body?.can?.export).toBe(false);
      const stewardLedgerRow = (ledgerView.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
      expect(stewardLedgerRow, "the admin's confirmation is in the ledger").toBeTruthy();
      expect(stewardLedgerRow?.ip, "blank without export").toBe("");
      expect(stewardLedgerRow?.user_agent, "blank without export").toBe("");
      expect(stewardLedgerRow?.superseded).toBe(false);
      expect(stewardLedgerRow?.account_removed).toBe(false);
      expect((await fetchText(spage, `/api/documents/${docId}/acknowledgements?format=ledger`)).status, "the per-policy ledger file needs export").toBe(403);
      expect((await fetchText(spage, "/api/admin/compliance?format=csv")).status, "the matrix still needs export").toBe(403);
      expect((await fetchText(spage, "/api/admin/compliance?format=ledger")).status, "and so does the workspace ledger").toBe(403);

      // Scope (1.12.0): the policy in the private space does not exist for
      // the steward on any of the new per-document routes, nor as a page;
      // 404 comes before the licence and the permission checks, so a
      // hidden document is never confirmed to exist by a 402 or a 403.
      expect((await api(spage, `/api/documents/${hiddenId}/ack-settings`)).status, "GET ack-settings out of scope").toBe(404);
      expect(
        (await api(spage, `/api/documents/${hiddenId}/ack-settings`, { method: "PATCH", body: { signature: true } })).status,
        "PATCH ack-settings out of scope"
      ).toBe(404);
      expect(
        (await api(spage, `/api/documents/${hiddenId}/ack/retire`, { method: "POST", body: { reason: "Superseded by the new expense policy" } }))
          .status,
        "retire out of scope"
      ).toBe(404);
      expect(
        (await api(spage, `/api/documents/${hiddenId}/ack/unretire`, { method: "POST", body: {} })).status,
        "un-retire out of scope"
      ).toBe(404);
      await spage.goto(`/doc/${hiddenId}/acknowledgements/settings`);
      await expect(spage.getByRole("heading", { name: "Page not found" })).toBeVisible();
    } finally {
      await sctx.close();
    }
    // The hidden policy is untouched by the refusals.
    const hiddenDoc = (await api(page, `/api/documents/${hiddenId}`)).body?.doc;
    expect(hiddenDoc?.ack_required).toBe(1);
    expect(hiddenDoc?.ack_retired_at).toBeNull();
    expect(hiddenDoc?.ack_signature ?? 0).toBe(0);
    // That download is on the record, marked as without the IP.
    const stewardExport = await auditRows(
      page,
      (r) => r.action === "ack.export" && Number(r.target_id) === docId && r.actor_name === "E2E Compliance Steward"
    );
    expect(stewardExport.length, "one download on the record; the refused ledger file wrote nothing").toBe(1);
    expect(stewardExport[0].details?.format).toBe("roster");
    expect(stewardExport[0].details?.with_ip).toBe(false);
    expect(stewardExport[0].details?.rows).toBeGreaterThanOrEqual(1);

    // The shipped Compliance manager preset (program_manage, program_read,
    // export and ack_roster_read; no document.ack_require): the Settings
    // tab admits program_manage alone, so its API does too — the statement
    // card saves with 200 (1.12.0).
    const rolesList = await api(page, "/api/admin/rbac/roles");
    expect(rolesList.status).toBe(200);
    const preset = (rolesList.body?.roles ?? []).find((r: { key: string }) => r.key === "compliance-manager");
    expect(preset, "the shipped Compliance manager preset exists").toBeTruthy();
    managerId = await makeUser(page, manager, "E2E Compliance Manager");
    const presetAssigned = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: preset.id, user_id: managerId },
    });
    expect(presetAssigned.status, "the preset assigned").toBe(201);
    const mctx = await browser.newContext();
    try {
      const mpage = await mctx.newPage();
      await login(mpage, manager);
      const settingsView = await api(mpage, `/api/documents/${docId}/ack-settings`);
      expect(settingsView.status, "a Compliance manager reads the settings").toBe(200);
      expect(settingsView.body?.statement).toBeNull();
      const statement = `I have read this policy and will follow it (${suffix}).`;
      const saved = await api(mpage, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { statement } });
      expect(saved.status, "and saves the statement card").toBe(200);
      expect(saved.body?.statement).toBe(statement);
      const back = await api(mpage, `/api/documents/${docId}/ack-settings`, { method: "PATCH", body: { statement: null } });
      expect(back.status, "and clears it again").toBe(200);
      expect(back.body?.statement).toBeNull();
    } finally {
      await mctx.close();
    }
    expect(
      (await auditRows(page, (r) => r.action === "ack.settings_changed" && Number(r.target_id) === docId && r.actor_name === "E2E Compliance Manager")).length,
      "both saves are on the record"
    ).toBe(2);

    // The admin's exports: the same header, the IP column populated from the
    // record for an exporter (the forwarded address the confirmation
    // arrived with, matched to the row by person and time), and one
    // ack.export row per download.
    const adminCsv = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=csv`);
    expect(adminCsv.status).toBe(200);
    const adminLines = adminCsv.text.trim().split("\n");
    expect(adminLines[0]).toBe(ROSTER_HEADER);
    const adminIpAt = cells(adminLines[0]).indexOf("ip");
    const adminOwnLine = adminLines.slice(1).map(cells).find((c) => c[1] === ADMIN.username);
    expect(adminOwnLine, "the admin's confirmed row is in the record").toBeTruthy();
    expect(adminOwnLine![adminIpAt], "an exporter sees the recorded address").toBe(ADMIN_IP);
    expect(adminOwnLine![cells(adminLines[0]).indexOf("user_agent")], "an exporter sees the recorded user agent").not.toBe("");
    for (const c of adminLines.slice(1).map(cells)) {
      if (c[1] !== ADMIN.username) expect(c[adminIpAt], "a pending row has no address").toBe("");
    }
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
    const adminJsonRow = (adminJson.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(adminJsonRow?.ip, "and the admin's JSON row carries the same address").toBe(ADMIN_IP);
    expect(typeof adminJsonRow?.user_agent, "and the recorded user agent").toBe("string");
    expect(adminJsonRow?.user_agent).not.toBe("");
    // The JSON rows carry the evidence under the record's own names (C3).
    expect(adminJsonRow?.read_seconds, "an API confirmation without a view: unknown read time").toBeNull();
    expect(adminJsonRow?.reached_end, "and no self-reported flag").toBe(false);

    const matrix = await fetchText(page, "/api/admin/compliance?format=csv");
    expect(matrix.status).toBe(200);
    const matrixExport = await auditRows(page, (r) => r.action === "ack.export" && r.details?.format === "matrix");
    expect(matrixExport.length).toBeGreaterThanOrEqual(1);
    expect(matrixExport[0].details).toMatchObject({ format: "matrix", doc_id: "all", with_ip: false });
    expect(typeof matrixExport[0].details?.rows).toBe("number");
    // The matrix carries the same six columns (C4, 1.12.0) and, after them,
    // the same five exemption and deadline columns (D2, 1.13.0) at the end:
    // MATRIX_CSV_HEADER in src/lib/read-evidence.ts.
    const matrixHeader = cells(matrix.text.trim().split("\n")[0]);
    expect(matrixHeader.slice(-11)).toEqual([
      "statement",
      "signed_name",
      "identity_proof",
      "recert_months",
      "effective_at",
      "next_recert_at",
      "exempt_reason",
      "exempt_by",
      "exempt_until",
      "snoozed_until",
      "due_at",
    ]);

    // The ledgers (C4, 1.12.0): the workspace file from the portal route and
    // the per-policy file from the record route, both for an exporter, both
    // with the documented header, the recorded address on the admin's row,
    // and one ack.export row each marked with_ip.
    const ledger = await fetchText(page, "/api/admin/compliance?format=ledger");
    expect(ledger.status, "an exporter downloads the workspace ledger").toBe(200);
    const ledgerLines = ledger.text.trim().split("\n");
    expect(ledgerLines[0]).toBe(LEDGER_HEADER);
    const ledgerHeader = cells(ledgerLines[0]);
    const adminLedgerLine = ledgerLines
      .slice(1)
      .map(cells)
      .find((c) => Number(c[ledgerHeader.indexOf("document_id")]) === docId && c[ledgerHeader.indexOf("username")] === ADMIN.username);
    expect(adminLedgerLine, "the admin's confirmation of this policy is in the ledger").toBeTruthy();
    expect(adminLedgerLine![ledgerHeader.indexOf("ip")], "with the recorded address").toBe(ADMIN_IP);
    expect(adminLedgerLine![ledgerHeader.indexOf("superseded")], "the newest confirmation is not superseded").toBe("no");
    expect(adminLedgerLine![ledgerHeader.indexOf("account_removed")]).toBe("no");
    expect(adminLedgerLine![ledgerHeader.indexOf("document")]).toBe(title);
    const ledgerExport = await auditRows(page, (r) => r.action === "ack.export" && r.details?.format === "ledger" && r.details?.doc_id === "all");
    expect(ledgerExport.length).toBeGreaterThanOrEqual(1);
    expect(ledgerExport[0].details).toMatchObject({ format: "ledger", doc_id: "all", with_ip: true });
    expect(typeof ledgerExport[0].details?.rows).toBe("number");

    const docLedger = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=ledger`);
    expect(docLedger.status, "an exporter downloads the per-policy ledger").toBe(200);
    const docLedgerLines = docLedger.text.trim().split("\n");
    expect(docLedgerLines[0]).toBe(LEDGER_HEADER);
    expect(docLedgerLines.slice(1).map(cells).every((c) => Number(c[ledgerHeader.indexOf("document_id")]) === docId), "this policy's rows only").toBe(true);
    const docLedgerExport = await auditRows(
      page,
      (r) => r.action === "ack.export" && Number(r.target_id) === docId && r.details?.format === "ledger"
    );
    expect(docLedgerExport.length).toBe(1);
    expect(docLedgerExport[0].details).toMatchObject({ format: "ledger", doc_id: docId, with_ip: true });
    // The exporter's ledger view carries the address and the user agent.
    const adminLedgerView = await api(page, `/api/documents/${docId}/acknowledgements?view=all`);
    expect(adminLedgerView.status).toBe(200);
    const adminLedgerRow = (adminLedgerView.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(adminLedgerRow?.ip).toBe(ADMIN_IP);
    expect(typeof adminLedgerRow?.user_agent).toBe("string");
  } finally {
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (stewardRole) await api(page, `/api/admin/rbac/roles/${stewardRole}`, { method: "DELETE" });
    if (requirerRole) await api(page, `/api/admin/rbac/roles/${requirerRole}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (stewardId) await api(page, `/api/admin/users/${stewardId}`, { method: "DELETE" });
    if (requirerId) await api(page, `/api/admin/users/${requirerId}`, { method: "DELETE" });
    if (managerId) await api(page, `/api/admin/users/${managerId}`, { method: "DELETE" });
    if (hiddenId) await api(page, `/api/documents/${hiddenId}`, { method: "DELETE" });
    if (otherSpaceId) await api(page, `/api/admin/spaces/${otherSpaceId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.12.0 (G3): retiring a policy is for holders of document.ack_require on
// the document's space or compliance.program_manage. A program_read-only
// role is 403 on both verbs; a holder of ack_require on the space retires
// it with a reason (a short one is 400), the second retire is 409, PATCH
// /ack { required: true } on the retired policy is 409, the document page
// shows the neutral "Retired {date}" row and no confirmation card, the
// portal lists it as retired and off the request picker, and un-retire
// restores the requirement and the card. Both actions are audited.
test("retire and un-retire: program_read only is 403; a holder of document.ack_require retires it, readers see the retired row, un-retire restores the card", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E retire ${suffix}`;
  const reader = { username: `e2e_retread_${suffix}`, password: "E2eRead!12345" };
  const retirer = { username: `e2e_retirer_${suffix}`, password: "E2eRet!12345" };
  const REASON = "Superseded by the new expense policy";
  let docId: number | undefined;
  let readerId: number | undefined;
  let retirerId: number | undefined;
  let readerRole: number | undefined;
  let retirerRole: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // The admin switches the policy on quietly and confirms it, so the
    // retirement has one confirmation to freeze.
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    const summary = await api(page, `/api/documents/${docId}/ack`);
    expect(summary.status).toBe(200);
    const confirmed = await api(page, `/api/documents/${docId}/ack`, {
      method: "POST",
      body: { version_id: summary.body?.latest_version_id },
    });
    expect(confirmed.status).toBe(200);

    // The read-only role: 403 on both verbs, and nothing changed hands.
    readerId = await makeUser(page, reader, "E2E Retire Reader");
    readerRole = await grantRole(page, `E2E Retire Reader ${suffix}`, ["compliance.program_read"], readerId);
    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);
      const refused = await api(rpage, `/api/documents/${docId}/ack/retire`, { method: "POST", body: { reason: REASON } });
      expect(refused.status, "retire needs ack_require on the space or program_manage").toBe(403);
      const resumed = await api(rpage, `/api/documents/${docId}/ack/unretire`, { method: "POST", body: {} });
      expect(resumed.status, "and so does un-retire").toBe(403);
    } finally {
      await rctx.close();
    }
    expect((await api(page, `/api/documents/${docId}`)).body?.doc?.ack_required).toBe(1);

    // A viewer holding document.ack_require on the policy's own space (the
    // sample space the policy was made in) retires it.
    retirerId = await makeUser(page, retirer, "E2E Retirer");
    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Retirer ${suffix}`, description: "e2e: ack_require on the policy's space", permissions: ["document.ack_require"] },
    });
    expect(role.status).toBe(201);
    retirerRole = role.body?.id;
    const scoped = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: retirerRole, user_id: retirerId, space_id: 1 },
    });
    expect(scoped.status, "assigned on the policy's space").toBe(201);
    const qctx = await browser.newContext();
    try {
      const qpage = await qctx.newPage();
      await login(qpage, retirer);
      const short = await api(qpage, `/api/documents/${docId}/ack/retire`, { method: "POST", body: { reason: "short" } });
      expect(short.status, "a reason of ten characters").toBe(400);
      expect(short.body?.error).toBe("A reason of at least 10 characters is required.");
      const notRetired = await api(qpage, `/api/documents/${docId}/ack/unretire`, { method: "POST", body: {} });
      expect(notRetired.status, "nothing to resume yet").toBe(409);
      expect(notRetired.body?.error).toBe("This policy is not retired.");

      const retired = await api(qpage, `/api/documents/${docId}/ack/retire`, { method: "POST", body: { reason: REASON } });
      expect(retired.status, "retired").toBe(200);
      expect(retired.body?.ok).toBe(true);
      expect(retired.body?.acked, "the admin's confirmation was current").toBe(1);
      expect(retired.body?.required).toBeGreaterThanOrEqual(1);
      expect(retired.body?.rev, "the version people had been asked to confirm").toBe(1);

      const again = await api(qpage, `/api/documents/${docId}/ack/retire`, { method: "POST", body: { reason: REASON } });
      expect(again.status).toBe(409);
      expect(again.body?.error).toBe("This policy is already retired.");
      const reRequire = await api(qpage, `/api/documents/${docId}/ack`, { method: "PATCH", body: { required: true } });
      expect(reRequire.status, "the shield cannot switch a retired policy back on").toBe(409);
      expect(reRequire.body?.error).toBe("This policy is retired. Un-retire it first.");

      // The reader-facing surface: one neutral row, no card, no sticky control.
      await qpage.goto(`/doc/${docId}`);
      await expect(qpage.locator("h1")).toContainText(title);
      await expect(qpage.getByText(/^Retired \S/).first()).toBeVisible();
      await expect(qpage.locator("#confirm-reading")).toHaveCount(0);
      await expect(qpage.getByRole("link", { name: "Jump to confirmation" })).toHaveCount(0);
    } finally {
      await qctx.close();
    }

    // The document: requirement off, the retirement on the row. The
    // portal: listed as retired with the reason, out of the request picker
    // and out of the tiles.
    const doc = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(doc?.ack_required).toBe(0);
    expect(doc?.ack_retired_at).toBeTruthy();
    expect(doc?.ack_retired_reason).toBe(REASON);
    const view = await api(page, "/api/admin/compliance");
    expect(view.status).toBe(200);
    const row = (view.body?.docs ?? []).find((d: { id: number }) => d.id === docId);
    expect(row, "a retired policy stays listed").toBeTruthy();
    expect(row?.ack_retired_at).toBeTruthy();
    expect(row?.ack_retired_by_name).toBe("E2E Retirer");
    expect(row?.ack_retired_reason).toBe(REASON);
    expect(row?.acked, "the frozen count").toBe(1);
    expect(row?.retired_rev).toBe(1);
    expect((view.body?.candidates ?? []).some((c: { id: number }) => c.id === docId), "not a request candidate").toBe(false);
    const retiredAudit = await auditRows(page, (r) => r.action === "ack.retired" && Number(r.target_id) === docId);
    expect(retiredAudit.length).toBe(1);
    expect(retiredAudit[0].details).toMatchObject({ reason: REASON, acked: 1, superseded_by: null, version: 1 });

    // Un-retire (the admin holds program_manage): the requirement and the
    // card come back, the admin's confirmation still counts, the second
    // call is 409.
    const resumed = await api(page, `/api/documents/${docId}/ack/unretire`, { method: "POST", body: {} });
    expect(resumed.status, "resumed").toBe(200);
    expect(resumed.body?.ok).toBe(true);
    expect(resumed.body?.current, "the prior confirmation is current again").toBe(1);
    expect(resumed.body?.eligible).toBeGreaterThanOrEqual(1);
    expect((await api(page, `/api/documents/${docId}/ack/unretire`, { method: "POST", body: {} })).status).toBe(409);
    const after = (await api(page, `/api/documents/${docId}`)).body?.doc;
    expect(after?.ack_required).toBe(1);
    expect(after?.ack_retired_at).toBeNull();
    expect(after?.ack_retired_reason).toBe("");
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("#confirm-reading")).toHaveCount(1);
    await expect(page.getByText(/^Retired \S/)).toHaveCount(0);
    const unretiredAudit = await auditRows(page, (r) => r.action === "ack.unretired" && Number(r.target_id) === docId);
    expect(unretiredAudit.length).toBe(1);
    expect(unretiredAudit[0].details).toMatchObject({ current: 1 });
    const portalAfter = await api(page, "/api/admin/compliance");
    const liveRow = (portalAfter.body?.docs ?? []).find((d: { id: number }) => d.id === docId);
    expect(liveRow?.ack_retired_at).toBeNull();
  } finally {
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (retirerRole) await api(page, `/api/admin/rbac/roles/${retirerRole}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (retirerId) await api(page, `/api/admin/users/${retirerId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

// 1.13.0 (D2): the roster's actions are bound to their document and never
// to a person's own row. The space-scoped twin
// POST /api/documents/[id]/acknowledgements/actions admits a steward holding
// document.ack_require on that space without the Compliance section, and
// every write runs WHERE document_id = that document: assignment ids of a
// policy in another space come back as `skipped` and that policy's rows are
// untouched (the other policy itself is 404 to the steward). A snooze pauses
// reminders and nothing else: the Overview's numbers, the policy row's
// counts and the CSV's status cell read the same before and after, with
// only snoozed_until filled. Exempting your own row is 400 with the one
// sentence, on both routes, and writes nothing.
//
// The rows here are pending, not overdue: a deadline reaches the past only
// by waiting (a rule's days are 1 or more and a fixed date in the past
// falls back to the rule), so the invariant is proved on a pending row,
// which the server treats exactly as an overdue one (status, counts and
// CSV all read from due_at and the confirmation, never from the snooze).
test("assignment actions: a steward of one space cannot reach another space's rows through the twin, a snooze leaves the numbers and the CSV status alone, and exempting yourself is 400", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  const suffix = stamp();
  const title = `E2E assignment actions ${suffix}`;
  const steward = { username: `e2e_asgstew_${suffix}`, password: "E2eStew!12345" };
  const person = { username: `e2e_asgperson_${suffix}`, password: "E2ePerson!12345" };
  const SELF = "Ask another compliance manager to record your exemption.";
  let docId: number | undefined;
  let otherId: number | undefined;
  let otherSpaceId: number | undefined;
  let stewardId: number | undefined;
  let stewardRole: number | undefined;
  let personId: number | undefined;
  try {
    // A person in the sample space (enrolled when the policy is switched
    // on), the policy in space 1, and a second policy in a private space the
    // steward cannot see; both required quietly.
    personId = await makeUser(page, person, "E2E Assignment Person");
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
    const on = await api(page, "/api/admin/compliance", { method: "POST", body: { docId, action: "request", notify: false } });
    expect(on.status, "requested quietly").toBe(200);
    const otherSpace = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name: `E2E Other B ${suffix}`, slug: `e2e-other-b-${suffix}`, description: "", visibility: "private" },
    });
    otherSpaceId = otherSpace.body?.space?.id ?? otherSpace.body?.id;
    expect(otherSpaceId, "the other space exists").toBeTruthy();
    otherId = await makePolicy(page, `${title} B`, otherSpaceId!);
    const otherOn = await api(page, "/api/admin/compliance", { method: "POST", body: { docId: otherId, action: "request", notify: false } });
    expect(otherOn.status, "the other policy is required quietly").toBe(200);

    // The rows, by the admin: the person's row on A, and every row on B.
    const rosterA = await api(page, `/api/documents/${docId}/acknowledgements`);
    expect(rosterA.status).toBe(200);
    const personRow = (rosterA.body?.rows ?? []).find((r: { username: string }) => r.username === person.username);
    expect(personRow?.assignment_id, "the person is enrolled on A with an assignment id").toBeTruthy();
    const adminRow = (rosterA.body?.rows ?? []).find((r: { username: string }) => r.username === ADMIN.username);
    expect(adminRow?.assignment_id, "and so is the admin").toBeTruthy();
    const rosterB = await api(page, `/api/documents/${otherId}/acknowledgements`);
    expect(rosterB.status).toBe(200);
    const rowsB: { assignment_id: number; due_at: string | null; username: string }[] = rosterB.body?.rows ?? [];
    expect(rowsB.length, "B has rows (the admin at least)").toBeGreaterThanOrEqual(1);
    const idsB = rowsB.map((r) => r.assignment_id);
    const dueB = new Map(rowsB.map((r) => [r.assignment_id, r.due_at]));

    // The steward: document.ack_require on space 1 only, no Compliance section.
    stewardId = await makeUser(page, steward, "E2E Assignment Steward");
    const role = await api(page, "/api/admin/rbac/roles", {
      method: "POST",
      body: { name: `E2E Assignment Steward ${suffix}`, description: "e2e: ack_require on one space", permissions: ["document.ack_require", "document.ack_roster_read"] },
    });
    expect(role.status).toBe(201);
    stewardRole = role.body?.id;
    const scoped = await api(page, "/api/admin/rbac/assignments", {
      method: "POST",
      body: { role_id: stewardRole, user_id: stewardId, space_id: 1 },
    });
    expect(scoped.status, "assigned on space 1").toBe(201);
    const sctx = await browser.newContext();
    try {
      const spage = await sctx.newPage();
      await login(spage, steward);
      // Without the section, the admin route is closed; the twin is open
      // for the steward's own space.
      expect(
        (await api(spage, "/api/admin/compliance/assignments", { method: "POST", body: { action: "extend", assignment_ids: [personRow.assignment_id], days: 7 } })).status,
        "the admin route needs program_manage"
      ).toBe(403);
      // B's ids through A's twin: 200, nothing changed, every id skipped.
      const crossed = await api(spage, `/api/documents/${docId}/acknowledgements/actions`, {
        method: "POST",
        body: { action: "extend", assignment_ids: idsB, days: 7, reason: "Reaching across spaces, for the test" },
      });
      expect(crossed.status, "the twin answers, bound to its document").toBe(200);
      expect(crossed.body?.changed).toEqual([]);
      expect([...(crossed.body?.skipped ?? [])].sort((a, b) => a - b)).toEqual([...idsB].sort((a, b) => a - b));
      // B itself does not exist for the steward.
      expect(
        (await api(spage, `/api/documents/${otherId}/acknowledgements/actions`, { method: "POST", body: { action: "extend", assignment_ids: idsB, days: 7 } })).status,
        "the other space's policy is 404"
      ).toBe(404);
      // A's own row through the twin: the steward may act.
      const extended = await api(spage, `/api/documents/${docId}/acknowledgements/actions`, {
        method: "POST",
        body: { action: "extend", assignment_ids: [personRow.assignment_id], days: 7, reason: "Audit week" },
      });
      expect(extended.status, "a steward extends a row of their own space").toBe(200);
      expect(extended.body?.changed).toEqual([personRow.assignment_id]);
      const undone = await api(spage, `/api/documents/${docId}/acknowledgements/actions`, {
        method: "POST",
        body: { action: "undo_extend", assignment_ids: [personRow.assignment_id] },
      });
      expect(undone.status).toBe(200);
      expect(undone.body?.changed).toEqual([personRow.assignment_id]);
    } finally {
      await sctx.close();
    }
    // B's rows are exactly as they were.
    const rosterBAfter = await api(page, `/api/documents/${otherId}/acknowledgements`);
    for (const r of rosterBAfter.body?.rows ?? []) {
      expect(r.due_at, `B's row ${r.username} keeps its deadline`).toBe(dueB.get(r.assignment_id));
      expect(r.exempt).toBe(false);
      expect(r.snoozed_until).toBeNull();
    }
    const dueA = (await api(page, `/api/documents/${docId}/acknowledgements`)).body?.rows?.find(
      (r: { username: string }) => r.username === person.username
    )?.due_at;
    expect(dueA, "the extension was undone").toBe(personRow.due_at);

    // The snooze invariant: the Overview's numbers, the policy row and the
    // CSV status cell before and after, with only snoozed_until filled.
    const before = await api(page, "/api/admin/compliance");
    expect(before.status).toBe(200);
    const rowBefore = (before.body?.docs ?? []).find((d: { id: number }) => d.id === docId);
    expect(rowBefore).toBeTruthy();
    const csvBefore = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=csv`);
    expect(csvBefore.status).toBe(200);
    const headerCells = cells(csvBefore.text.trim().split("\n")[0]);
    const statusAt = headerCells.indexOf("status");
    const snoozedAt = headerCells.indexOf("snoozed_until");
    const lineOf = (text: string) => text.trim().split("\n").slice(1).map(cells).find((c) => c[1] === person.username);
    const personBefore = lineOf(csvBefore.text);
    expect(personBefore?.[statusAt]).toBe("pending");
    expect(personBefore?.[snoozedAt]).toBe("");
    const snoozed = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "snooze", assignment_ids: [personRow.assignment_id] },
    });
    expect(snoozed.status, "snoozed through the admin route").toBe(200);
    expect(snoozed.body?.changed).toEqual([personRow.assignment_id]);
    expect(snoozed.body?.until, "the answer says when reminders resume").toBeTruthy();
    const after = await api(page, "/api/admin/compliance");
    expect(after.body?.kpis, "the Overview's numbers do not move").toEqual(before.body?.kpis);
    const rowAfter = (after.body?.docs ?? []).find((d: { id: number }) => d.id === docId);
    expect({ required: rowAfter?.required, acked: rowAfter?.acked }).toEqual({ required: rowBefore?.required, acked: rowBefore?.acked });
    const csvAfter = await fetchText(page, `/api/documents/${docId}/acknowledgements?format=csv`);
    const personAfter = lineOf(csvAfter.text);
    expect(personAfter?.[statusAt], "the CSV status is the same").toBe("pending");
    expect(personAfter?.[snoozedAt], "only the snooze is on the row").not.toBe("");
    const snoozedRow = (await api(page, `/api/documents/${docId}/acknowledgements`)).body?.rows?.find(
      (r: { username: string }) => r.username === person.username
    );
    expect(snoozedRow?.snoozed_until).toBeTruthy();
    expect(snoozedRow?.acknowledged_at).toBeNull();
    expect(snoozedRow?.exempt).toBe(false);
    const unsnoozed = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "unsnooze", assignment_ids: [personRow.assignment_id] },
    });
    expect(unsnoozed.status).toBe(200);
    expect(unsnoozed.body?.changed).toEqual([personRow.assignment_id]);

    // Exempting yourself: 400 with the sentence on both routes, nothing written.
    for (const path of ["/api/admin/compliance/assignments", `/api/documents/${docId}/acknowledgements/actions`]) {
      const self = await api(page, path, {
        method: "POST",
        body: { action: "exempt", assignment_ids: [adminRow.assignment_id, personRow.assignment_id], reason: "Author of the policy" },
      });
      expect(self.status, `${path}: your own row is refused`).toBe(400);
      expect(self.body?.error).toBe(SELF);
    }
    const untouched = (await api(page, `/api/documents/${docId}/acknowledgements`)).body?.rows ?? [];
    expect(untouched.every((r: { exempt: boolean }) => r.exempt === false), "the whole request was refused: nobody was exempted").toBe(true);
    expect((await auditRows(page, (r) => r.action === "ack.exempted" && Number(r.target_id) === docId)).length).toBe(0);
    // Someone else's row goes through, and is on the record.
    const other = await api(page, "/api/admin/compliance/assignments", {
      method: "POST",
      body: { action: "exempt", assignment_ids: [personRow.assignment_id], reason: "Signed on paper" },
    });
    expect(other.status).toBe(200);
    expect(other.body?.changed).toEqual([personRow.assignment_id]);
    const exempted = await auditRows(page, (r) => r.action === "ack.exempted" && Number(r.target_id) === docId);
    expect(exempted.length).toBe(1);
    expect(exempted[0].details).toMatchObject({ assignment_id: personRow.assignment_id, user_id: personId });
  } finally {
    if (stewardRole) await api(page, `/api/admin/rbac/roles/${stewardRole}`, { method: "DELETE" });
    if (stewardId) await api(page, `/api/admin/users/${stewardId}`, { method: "DELETE" });
    if (personId) await api(page, `/api/admin/users/${personId}`, { method: "DELETE" });
    if (otherId) await api(page, `/api/documents/${otherId}`, { method: "DELETE" });
    if (otherSpaceId) await api(page, `/api/admin/spaces/${otherSpaceId}`, { method: "DELETE" });
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});
