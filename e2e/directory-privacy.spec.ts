import { test, expect } from "@playwright/test";
import { ADMIN, EDITOR, ensureUser, login, api } from "./helpers";

// Privacy & exports (1.3.4): admin-only fields and contact columns never
// reach a viewer — not the directory, the API, the profile, the export or
// the contact card; a preset can zip one file per office, lay people out
// as photo cards, and carry an email schedule.

test("an admin-only field and a restricted contact column are stripped for everyone but admins, everywhere", async ({ browser }) => {
  const admin = await browser.newContext();
  const page = await admin.newPage();
  await login(page, ADMIN);
  await ensureUser(page, EDITOR, "editor", "E2E Editor");
  const stamp = Date.now();
  const key = `e2e_home_${stamp}`;
  const field = (await api(page, "/api/admin/directory/fields", { method: "POST", body: { label: `E2E Home ${stamp}`, key, kind: "text", visibility: "admins" } })).body.field;
  expect(field.visibility).toBe("admins");
  const person = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Private Person ${stamp}`, title: "Clerk", email: `private${stamp}@e2e.test`, phone: "602-555-0111", mobile: "602-555-0999", custom: { [key]: "Tucson" } } })).body.person;
  const before = await api(page, "/api/admin/directory/list-columns");
  try {
    // Mobile for admins only.
    const set = await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { column_visibility: { mobile: "admins", email: "everyone" } } });
    expect(set.body.column_visibility).toEqual({ mobile: "admins" });

    // The admin still sees everything.
    const mine = (await api(page, "/api/directory")).body;
    const meP = mine.people.find((p: any) => p.id === person.id);
    expect(meP.mobile).toBe("602-555-0999");
    expect(meP.custom[key]).toBe("Tucson");
    expect(mine.fields.some((f: any) => f.key === key)).toBe(true);

    // A viewer does not: API, directory page, profile, contact card, export.
    const viewer = await browser.newContext();
    const vp = await viewer.newPage();
    await login(vp, EDITOR);
    const theirs = (await api(vp, "/api/directory")).body;
    const p = theirs.people.find((x: any) => x.id === person.id);
    expect(p.mobile).toBe("");
    expect(p.phone).toBe("602-555-0111");
    expect(p.custom[key]).toBeUndefined();
    expect(theirs.fields.some((f: any) => f.key === key)).toBe(false);

    await vp.goto(`/directory/${person.id}`);
    await expect(vp.getByText("602-555-0111")).toBeVisible();
    await expect(vp.getByText("602-555-0999")).toHaveCount(0);
    await expect(vp.getByText("Tucson")).toHaveCount(0);

    const vcf = await vp.evaluate(async (id) => (await fetch(`/api/directory/${id}/vcard`)).text(), person.id);
    expect(vcf).toContain("602-555-0111");
    expect(vcf).not.toContain("602-555-0999");
    expect(vcf).not.toContain("Tucson");

    const csv = await vp.evaluate(async ({ id, cols }) => {
      const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "csv", ids: [id], columns: cols }) });
      return res.text();
    }, { id: person.id, cols: ["name", "phone", "mobile", key] });
    expect(csv).toContain("602-555-0111");
    expect(csv).not.toContain("602-555-0999");
    expect(csv).not.toContain("Tucson");
    expect(csv.split("\r\n")[0]).not.toMatch(/Mobile/);

    // The list's Columns menu does not offer the hidden column either.
    await vp.goto("/directory");
    await vp.getByRole("button", { name: "List" }).click();
    await vp.getByRole("button", { name: /Columns/ }).click();
    await expect(vp.getByRole("checkbox", { name: /^Mobile\b/ })).toHaveCount(0);
    await expect(vp.getByRole("checkbox", { name: /^Phone\b/ })).toHaveCount(1);
    await viewer.close();
  } finally {
    await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { column_visibility: before.body.column_visibility ?? {} } });
    await api(page, `/api/admin/directory/people/${person.id}`, { method: "DELETE" });
    await api(page, `/api/admin/directory/fields/${field.id}`, { method: "DELETE" });
    await admin.close();
  }
});

test("a preset can zip one file per office, lay people out as photo cards, and carry a stamped email schedule", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const a = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Zip Alpha ${stamp}`, title: "Partner", office: `ZIPA${stamp}`, phone: "1" } })).body.person;
  const b = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Zip Beta ${stamp}`, title: "Associate", office: `ZIPB${stamp}`, phone: "2" } })).body.person;
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  try {
    // One zip, one PDF per office, each titled with the office.
    const zip = await page.evaluate(async (ids) => {
      const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "pdf", ids, split: "office", title: "Zip test" }) });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), head: String.fromCharCode(...buf.slice(0, 2)), size: buf.length, text: new TextDecoder("latin1").decode(buf) };
    }, [a.id, b.id]);
    expect(zip.status).toBe(200);
    expect(zip.type).toBe("application/zip");
    expect(zip.disposition).toContain("-by-office.zip");
    expect(zip.head).toBe("PK");
    expect(zip.text).toContain(`zipa${stamp}.pdf`);
    expect(zip.text).toContain(`zipb${stamp}.pdf`);

    // Photo cards: still a PDF, still the people.
    const cards = await page.evaluate(async (ids) => {
      const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "pdf", ids, layout: "cards", cards_per_row: 3, photos: true }) });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get("content-type"), head: String.fromCharCode(...buf.slice(0, 5)), size: buf.length };
    }, [a.id, b.id]);
    expect(cards.status).toBe(200);
    expect(cards.type).toBe("application/pdf");
    expect(cards.head).toBe("%PDF-");
    expect(cards.size).toBeGreaterThan(1500);

    // A saved preset keeps layout, split and schedule; the schedule is stamped on save.
    const saved = await api(page, "/api/admin/directory/export-presets", {
      method: "PUT",
      body: { presets: [...presets, { id: `e2e-whoswho-${stamp}`, name: `E2E Who's who ${stamp}`, layout: "cards", cards_per_row: 5, split_by: "office", schedule: { frequency: "weekly", day: 5, hour: 7, recipients: "reception@e2e.test, bad", format: "pdf" } }] },
    });
    expect(saved.status).toBe(200);
    const mine = saved.body.presets.find((p: any) => p.id === `e2e-whoswho-${stamp}`);
    expect(mine.layout).toBe("cards");
    expect(mine.cards_per_row).toBe(5);
    expect(mine.split_by).toBe("office");
    expect(mine.schedule).toMatchObject({ frequency: "weekly", day: 5, hour: 7, recipients: ["reception@e2e.test"], format: "pdf" });
    expect(typeof mine.schedule.since).toBe("string");

    // The Export page shows it, and the Directory's Export menu marks the zip.
    await page.goto("/admin/directory/export");
    await page.getByRole("combobox", { name: "Preset" }).selectOption({ label: `E2E Who's who ${stamp}` });
    await expect(page.getByText("Every Friday at 07:00 UTC")).toBeVisible();
    await page.goto("/directory");
    await page.getByRole("button", { name: /Export/ }).click();
    await expect(page.getByRole("menuitem", { name: new RegExp(`E2E Who's who ${stamp}`) })).toContainText("ZIP");
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
    for (const id of [a.id, b.id]) await api(page, `/api/admin/directory/people/${id}`, { method: "DELETE" });
  }
});
