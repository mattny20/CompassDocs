import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import JSZip from "jszip";
import { ADMIN, login, api } from "./helpers";

// 1.14.0 (F2): the Evidence page of the Compliance section and the
// compliance report block on Program settings. "Take snapshot now" adds a
// row with its kind, hash prefix, copy control, Verify and download; Verify
// toasts "Hash matches"; the download is the canonical text with the hash
// in X-Content-SHA256, so sha256sum over the file reproduces it; the audit
// package is a streamed ZIP whose manifest lists every file with its hash
// and carries the confirmed version's text hashed as the record says; a
// retire writes a retirement snapshot named for the policy. The report
// block saves through its own route inside the page's one Save and reads
// back. A program_read-only role has no Evidence tab, gets the shell's
// not-found page on /compliance/evidence and 403 from the routes; an
// export holder opens the page without "Take snapshot now".
//
// Read confirmation is entitlement-gated (policy_ack). CI runs the
// community build, so each test skips itself when the portal answers 402
// and runs in full on the EE rig (as e2e/compliance-portal.spec.ts does).

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const BODY = "## Policy\n\nShort policy text for the evidence smoke. Read it and confirm at the end.";

/** The lead sentence of the page (items/F2.md, verbatim). */
const LEAD =
  "A snapshot is taken automatically every month; each stores the exact records with a SHA-256 an auditor can verify. The audit package bundles everything as one ZIP.";

/** The per-policy roster inside the package: the matrix minus its first three columns (handoff-evidence-1.14.md). */
const ROSTER_PACKAGE_HEADER =
  "name,username,email,role,account_status,status,source,assigned_at,cycle_started_at,due_at,snoozed_until,acknowledged_at,version,version_id,content_sha256,version_source,signed_name,identity_proof,statement,read_seconds,reached_end_self_reported,ip,user_agent,exempt_at,exempt_by,exempt_reason,exempt_until,removed_at,removed_reason";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

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

/** A confirmation of the policy's current version through the API, as the card posts it. */
async function confirmThrough(page: Page, docId: number): Promise<void> {
  const summary = await api(page, `/api/documents/${docId}/ack`);
  expect(summary.status).toBe(200);
  const confirmed = await api(page, `/api/documents/${docId}/ack`, {
    method: "POST",
    body: { version_id: summary.body?.latest_version_id },
  });
  expect(confirmed.status, "confirmed").toBe(200);
}

async function auditRows(page: Page, pick: (r: any) => boolean): Promise<{ details: any }[]> {
  const log = await api(page, "/api/admin/audit?limit=100");
  expect(log.status, "audit log readable").toBe(200);
  return (log.body?.rows ?? []).filter(pick);
}

/** A text download through the page's session cookie, with the headers the record relies on. */
async function fetchText(
  page: Page,
  path: string
): Promise<{ status: number; type: string; disposition: string; sha: string; text: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    return {
      status: res.status,
      type: res.headers.get("content-type") || "",
      disposition: res.headers.get("content-disposition") || "",
      sha: res.headers.get("x-content-sha256") || "",
      text: await res.text(),
    };
  }, path);
}

/** A binary download (the ZIP) through the page's session cookie, as base64 for the Node side to unpack. */
async function fetchBinary(
  page: Page,
  path: string
): Promise<{ status: number; type: string; disposition: string; base64: string }> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return {
      status: res.status,
      type: res.headers.get("content-type") || "",
      disposition: res.headers.get("content-disposition") || "",
      base64: btoa(bin),
    };
  }, path);
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

/** A custom role with exactly these permissions, assigned to the user. */
async function grantRole(page: Page, name: string, permissions: string[], userId: number): Promise<number> {
  const role = await api(page, "/api/admin/rbac/roles", {
    method: "POST",
    body: { name, description: "e2e: the evidence split", permissions },
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

/** The section's tab row: the one <nav aria-label="Compliance"> under the header. */
const subnav = (page: Page) => page.getByRole("navigation", { name: "Compliance" });

test("Take snapshot now adds a row, Verify confirms the hash, the download carries X-Content-SHA256, the package's manifest lists its files, and a retire writes a retirement snapshot", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page, ADMIN);
  const title = `E2E evidence ${stamp()}`;
  let docId: number | undefined;
  try {
    docId = await makePolicy(page, title);
    test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");

    // One live policy with one confirmation, so the snapshot and the package
    // have a row and a version to carry.
    const on = await api(page, "/api/admin/compliance", {
      method: "POST",
      body: { docId, action: "request", notify: false },
    });
    expect(on.status, "requested quietly").toBe(200);
    await confirmThrough(page, docId);

    const before = await api(page, "/api/admin/compliance/snapshots");
    expect(before.status, "the admin lists the snapshots").toBe(200);
    const known = new Set<number>((before.body?.rows ?? []).map((r: { id: number }) => r.id));

    // The page: under the section header, the tab lit, the lead sentence
    // and the primary package link.
    await page.goto("/compliance/evidence");
    await expect(page.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
    await expect(subnav(page).getByRole("link", { name: "Evidence", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(LEAD)).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit package (ZIP)" })).toHaveAttribute("href", "/api/admin/compliance/audit-package");

    // Take snapshot now: the toast carries the new hash's prefix; the list
    // gains the row, newest first, with the Manual chip, the same prefix,
    // the copy control and the download named by its id; the audit row
    // carries the hash.
    await page.getByRole("button", { name: "Take snapshot now" }).click();
    const stored = page.locator('[role="status"]').getByText(/^Snapshot stored · sha256 [0-9a-f]{12}$/);
    await expect(stored).toBeVisible();
    const prefix = (await stored.textContent())!.match(/[0-9a-f]{12}$/)![0];
    const after = await api(page, "/api/admin/compliance/snapshots");
    const fresh = (after.body?.rows ?? []).find((r: { id: number }) => !known.has(r.id));
    expect(fresh, "the new snapshot is listed").toBeTruthy();
    expect(fresh.kind).toBe("manual");
    expect(fresh.sha256.startsWith(prefix), "the toast's prefix is the stored hash's").toBe(true);
    expect(after.body.rows[0].id, "newest first").toBe(fresh.id);
    const snapshotAudit = await auditRows(page, (r) => r.action === "ack.snapshot" && Number(r.details?.snapshot_id) === fresh.id);
    expect(snapshotAudit.length).toBe(1);
    expect(snapshotAudit[0].details).toMatchObject({ kind: "manual", sha256: fresh.sha256 });

    const row = page.locator("tbody tr").first();
    await expect(row.getByText("Manual", { exact: true })).toBeVisible();
    await expect(row.locator("code")).toHaveText(prefix);
    await expect(row.getByRole("button", { name: "Copy SHA-256" })).toBeVisible();
    const download = row.getByRole("link", { name: `Download snapshot #${fresh.id}` });
    await expect(download).toHaveAttribute("href", `/api/admin/compliance/snapshots/${fresh.id}`);
    await expect(download).toHaveAttribute("data-tt", `Download snapshot #${fresh.id}`);
    // The hash printed beside the package button: the latest monthly
    // snapshot's, or the latest of any kind until the rig has one.
    await expect(page.getByText(/^(Monthly snapshot \d{4}-\d{2}|Latest snapshot) · sha256 [0-9a-f]{12}$/)).toBeVisible();

    // Verify: the server recomputes the hash over the stored text.
    await row.getByRole("button", { name: "Verify" }).click();
    await expect(page.locator('[role="status"]').getByText("Hash matches")).toBeVisible();
    const verify = await api(page, `/api/admin/compliance/snapshots/${fresh.id}?verify=1`);
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ ok: true, stored: fresh.sha256, computed: fresh.sha256 });

    // The download: the canonical text verbatim, the hash in
    // X-Content-SHA256, sha256sum over the file reproducing it, and the
    // policy with its confirmation inside.
    const dl = await fetchText(page, `/api/admin/compliance/snapshots/${fresh.id}`);
    expect(dl.status).toBe(200);
    expect(dl.type).toContain("application/json");
    expect(dl.disposition).toContain(`compliance-snapshot-manual-${fresh.id}.json`);
    expect(dl.sha, "X-Content-SHA256").toBe(fresh.sha256);
    expect(sha256(dl.text), "sha256sum over the file reproduces the header").toBe(fresh.sha256);
    const snapshot = JSON.parse(dl.text);
    expect(snapshot.format).toBe("compassdocs-compliance-snapshot/1");
    expect(snapshot.policies.some((p: { id: number }) => p.id === docId), "the policy is in the snapshot").toBe(true);
    const ack = snapshot.current_acks.find((a: { policy_id: number }) => a.policy_id === docId);
    expect(ack, "its confirmation is in the snapshot").toBeTruthy();

    // The audit package: a streamed ZIP whose manifest (last, and not
    // listing itself) names every file with a hash that the file bears;
    // the policy's folder with its roster; the confirmed version's text
    // hashed exactly as the confirmation records it; the snapshot just
    // taken, byte for byte the download; and the export audited once the
    // stream has closed.
    const pkg = await fetchBinary(page, "/api/admin/compliance/audit-package");
    expect(pkg.status).toBe(200);
    expect(pkg.type).toContain("application/zip");
    expect(pkg.disposition).toMatch(/compliance-audit-package-\d{4}-\d{2}-\d{2}\.zip/);
    const zip = await JSZip.loadAsync(Buffer.from(pkg.base64, "base64"));
    const manifestFile = zip.file("manifest.json");
    expect(manifestFile, "manifest.json").toBeTruthy();
    const manifest = JSON.parse(await manifestFile!.async("string"));
    expect(manifest.generated_at, "generated_at").toBeTruthy();
    expect(manifest.app_version, "app_version").toBeTruthy();
    const names: string[] = manifest.files.map((f: { name: string }) => f.name);
    for (const name of [
      "summary.json",
      "matrix.csv",
      "acknowledgements.csv",
      "decisions.csv",
      "waivers.csv",
      "notices.csv",
      "audit-extract.csv",
      `policies/${docId}/policy.json`,
      `policies/${docId}/roster.csv`,
      `policies/${docId}/history.csv`,
      `policies/${docId}/versions/v${ack.version}.md`,
      `snapshots/manual-${fresh.id}.json`,
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names, "the manifest does not list itself").not.toContain("manifest.json");
    for (const f of manifest.files as { name: string; sha256: string }[]) {
      const entry = zip.file(f.name);
      expect(entry, f.name).toBeTruthy();
      expect(sha256(await entry!.async("nodebuffer")), `${f.name} hashes as the manifest says`).toBe(f.sha256);
    }
    const version = manifest.files.find((f: { name: string }) => f.name === `policies/${docId}/versions/v${ack.version}.md`);
    expect(version?.sha256, "the version's text is hashed as the confirmation records it").toBe(ack.content_sha256);
    expect(await zip.file(`snapshots/manual-${fresh.id}.json`)!.async("string"), "the stored snapshot rides along verbatim").toBe(dl.text);
    const roster = await zip.file(`policies/${docId}/roster.csv`)!.async("string");
    const rosterLines = roster.trim().split("\n");
    expect(rosterLines[0]).toBe(ROSTER_PACKAGE_HEADER);
    expect(rosterLines.slice(1).some((l) => l.includes(ADMIN.username)), "the admin's row is in the policy's roster").toBe(true);
    await expect
      .poll(
        async () =>
          (await auditRows(page, (r) => r.action === "ack.audit_export" && r.details?.format === "package" && r.details?.scope === "all")).length,
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    // A retire writes a retirement snapshot for the policy: the row names
    // the policy beside its Retirement chip and downloads like any other.
    const retired = await api(page, `/api/documents/${docId}/ack/retire`, {
      method: "POST",
      body: { reason: "Superseded by the new evidence policy" },
    });
    expect(retired.status, "retired").toBe(200);
    const listed = await api(page, "/api/admin/compliance/snapshots");
    const retirement = (listed.body?.rows ?? []).find(
      (r: { kind: string; document_id: number | null }) => r.kind === "retirement" && r.document_id === docId
    );
    expect(retirement, "the retirement snapshot is listed").toBeTruthy();
    expect(retirement.document_title).toBe(title);
    await page.reload();
    const retirementRow = page.locator("tbody tr", { hasText: "Retirement" }).filter({ hasText: title }).first();
    await expect(retirementRow).toBeVisible();
    await expect(retirementRow.getByRole("link", { name: `Download snapshot #${retirement.id}` })).toHaveAttribute(
      "href",
      `/api/admin/compliance/snapshots/${retirement.id}`
    );
  } finally {
    if (docId) await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  }
});

test("Program settings: the compliance report block saves through its own route with the page's one Save and reads back", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN);
  test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
  const before = await api(page, "/api/admin/compliance/report");
  expect(before.status, "the admin reads the report settings").toBe(200);
  const original = before.body?.settings as { enabled: boolean; cadence: string; recipients: number[] } | undefined;
  expect(original, "the settings shape").toBeTruthy();
  // The admin's own account, from the list the picker reads.
  const people = await api(page, "/api/users/mentionable");
  const me = (people.body?.users ?? []).find((u: { username: string }) => u.username === ADMIN.username);
  expect(me, "the admin is an active account").toBeTruthy();
  try {
    // A known starting point, through the route the block saves with.
    const reset = await api(page, "/api/admin/compliance/report", {
      method: "PUT",
      body: { enabled: false, cadence: "weekly", recipients: [] },
    });
    expect(reset.status).toBe(200);

    await page.goto("/compliance/settings");
    await expect(page.getByRole("heading", { name: "Compliance report" })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Send the compliance report" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const cadence = page.getByRole("radiogroup", { name: "Cadence" });
    await expect(cadence.getByRole("radio", { name: "Weekly (Monday)" })).toHaveAttribute("aria-checked", "true");
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    // On with nobody to send to: the block says so inline and Save stays off.
    await toggle.click();
    const needsRecipient = page.getByText("Choose at least one recipient, or turn the report off.");
    await expect(needsRecipient).toBeVisible();
    await expect(save).toBeDisabled();

    // Monthly, to the admin: the page's one Save, the page's one toast.
    await cadence.getByRole("radio", { name: "Monthly (with the snapshot)" }).click();
    const picker = page.getByRole("combobox", { name: "Recipients" });
    await picker.fill(ADMIN.username);
    await page.getByRole("option", { name: new RegExp(ADMIN.username) }).click();
    await expect(needsRecipient).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('[role="status"]').getByText("Program settings saved.")).toBeVisible();

    const saved = await api(page, "/api/admin/compliance/report");
    expect(saved.body?.settings).toEqual({ enabled: true, cadence: "monthly", recipients: [me.id] });
    expect((saved.body?.recipients ?? []).map((r: { username: string }) => r.username)).toEqual([ADMIN.username]);
    // Each changed key is audited as ack.report_settings.
    const audited = await auditRows(page, (r) => r.action === "ack.report_settings");
    for (const key of ["ack_report.enabled", "ack_report.cadence", "ack_report.recipients"]) {
      expect(audited.some((r) => r.details?.key === key), key).toBe(true);
    }

    // It reads back after a reload, with the page clean.
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(cadence.getByRole("radio", { name: "Monthly (with the snapshot)" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: `Remove ${me.name || me.username}` })).toBeVisible();
    await expect(save).toBeDisabled();

    // The route refuses a recipient that is not an active account with its sentence.
    const bad = await api(page, "/api/admin/compliance/report", { method: "PUT", body: { recipients: [2147483647] } });
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toBe("Every recipient must be an active account.");
  } finally {
    if (original) {
      await api(page, "/api/admin/compliance/report", {
        method: "PUT",
        body: { enabled: original.enabled, cadence: original.cadence, recipients: original.recipients },
      });
    }
  }
});

test("a program_read-only role has no Evidence tab, gets the not-found page on /compliance/evidence and 403 from the routes; an export holder opens the page without Take snapshot now", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN);
  test.skip(!(await portalLicensed(page)), "policy_ack is not licensed in this build; the EE rig runs the flow");
  const suffix = stamp();
  const reader = { username: `e2e_evread_${suffix}`, password: "E2eRead!12345" };
  const exporter = { username: `e2e_evexp_${suffix}`, password: "E2eExp!12345" };
  let readerId: number | undefined;
  let exporterId: number | undefined;
  let readerRole: number | undefined;
  let exporterRole: number | undefined;
  try {
    readerId = await makeUser(page, reader, "E2E Evidence Reader");
    readerRole = await grantRole(page, `E2E Evidence Reader ${suffix}`, ["compliance.program_read"], readerId);
    exporterId = await makeUser(page, exporter, "E2E Evidence Exporter");
    exporterRole = await grantRole(page, `E2E Evidence Exporter ${suffix}`, ["compliance.program_read", "compliance.export"], exporterId);

    // The admin's tab row lists Evidence after People and before Settings.
    await page.goto("/compliance/overview");
    const adminTabs = await subnav(page).getByRole("link").allTextContents();
    expect(adminTabs.indexOf("Evidence"), "Evidence after People").toBeGreaterThan(adminTabs.indexOf("People"));
    expect(adminTabs.indexOf("Evidence"), "Evidence before Settings").toBeLessThan(adminTabs.indexOf("Settings"));

    // program_read alone: the portal opens, the Evidence tab is absent, the
    // page is the shell's not-found page, and every evidence route refuses.
    const rctx = await browser.newContext();
    try {
      const rpage = await rctx.newPage();
      await login(rpage, reader);
      await rpage.goto("/compliance/overview");
      await expect(rpage.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(subnav(rpage).getByRole("link", { name: "Overview", exact: true })).toBeVisible();
      await expect(subnav(rpage).getByRole("link", { name: "Evidence", exact: true })).toHaveCount(0);
      await rpage.goto("/compliance/evidence");
      await expect(rpage.getByRole("heading", { name: "Page not found" })).toBeVisible();
      expect((await api(rpage, "/api/admin/compliance/snapshots")).status, "listing needs export").toBe(403);
      expect((await api(rpage, "/api/admin/compliance/snapshots", { method: "POST" })).status, "taking one needs program_manage").toBe(403);
      expect((await fetchText(rpage, "/api/admin/compliance/audit-package")).status, "the package needs export").toBe(403);
      expect((await api(rpage, "/api/admin/compliance/report")).status, "the report settings need export").toBe(403);
      expect(
        (await api(rpage, "/api/admin/compliance/report", { method: "PUT", body: { enabled: false } })).status,
        "writing them needs program_manage"
      ).toBe(403);
    } finally {
      await rctx.close();
    }

    // program_read + export: the tab and the page, the package link, the
    // list (or its empty state), and no "Take snapshot now" (the POST is
    // program_manage's, and the page says so by leaving the control out).
    const ectx = await browser.newContext();
    try {
      const epage = await ectx.newPage();
      await login(epage, exporter);
      await epage.goto("/compliance/evidence");
      await expect(epage.getByRole("heading", { name: /^Compliance/ })).toBeVisible();
      await expect(subnav(epage).getByRole("link", { name: "Evidence", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(epage.getByText(LEAD)).toBeVisible();
      await expect(epage.getByRole("link", { name: "Audit package (ZIP)" })).toBeVisible();
      await expect(epage.getByRole("button", { name: "Take snapshot now" })).toHaveCount(0);
      expect((await api(epage, "/api/admin/compliance/snapshots")).status, "export lists the snapshots").toBe(200);
      expect((await api(epage, "/api/admin/compliance/snapshots", { method: "POST" })).status, "but cannot take one").toBe(403);
      expect((await api(epage, "/api/admin/compliance/report")).status, "export reads the report settings").toBe(200);
    } finally {
      await ectx.close();
    }
  } finally {
    if (readerRole) await api(page, `/api/admin/rbac/roles/${readerRole}`, { method: "DELETE" });
    if (exporterRole) await api(page, `/api/admin/rbac/roles/${exporterRole}`, { method: "DELETE" });
    if (readerId) await api(page, `/api/admin/users/${readerId}`, { method: "DELETE" });
    if (exporterId) await api(page, `/api/admin/users/${exporterId}`, { method: "DELETE" });
  }
});
