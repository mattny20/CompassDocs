import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The directory settings as pages (1.2.4): each job on its own route under
// one header and tab row, and the Offices page feeding the PDF export.

const STAMP = Date.now();

test("each directory settings job is a page under one header", async ({ page }) => {
  await login(page, ADMIN);
  for (const [path, heading] of [
    ["/admin/directory", "Add a person"],
    ["/admin/directory/fields", "Directory fields"],
    ["/admin/directory/offices", "Offices"],
    ["/admin/directory/export", "Export presets"],
    ["/admin/directory/sync", "Google Workspace sync"],
  ] as const) {
    await page.goto(path);
    // The section header and the tab row are shared; the active tab is the page.
    await expect(page.getByRole("heading", { name: "Directory", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Directory settings" });
    await expect(nav.locator('a[aria-current="page"]')).toHaveAttribute("href", path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
});

test("office profiles round-trip and close the PDF for the offices in it", async ({ page }) => {
  await login(page, ADMIN);
  const before = await api(page, "/api/admin/directory/offices");
  expect(before.status).toBe(200);
  expect(Array.isArray(before.body.fields)).toBe(true);

  const office = `E2E-OFF-${STAMP}`;
  const person = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Office Person ${STAMP}`, office } })).body.person;
  try {
    const saved = await api(page, "/api/admin/directory/offices", {
      method: "PUT",
      body: {
        fields: [...before.body.fields, { label: `Mail stop ${STAMP}` }],
        profiles: [
          ...before.body.profiles,
          { office, name: "E2E Office", values: { address: "1 Test Way\nTestville", main_phone: "555-0100", [`mail_stop_${STAMP}`]: "MS-7" } },
        ],
      },
    });
    expect(saved.status).toBe(200);
    const mine = saved.body.profiles.find((p: any) => p.office === office);
    expect(mine.values.address).toBe("1 Test Way\nTestville");
    expect(mine.values[`mail_stop_${STAMP}`]).toBe("MS-7");

    const size = async (query: string) => {
      const r = await page.evaluate(async (q) => {
        const res = await fetch(`/api/directory/export?format=pdf${q}`, { method: "GET" });
        return { status: res.status, size: (await res.arrayBuffer()).byteLength };
      }, query);
      expect(r.status).toBe(200);
      return r.size;
    };
    // Same people, with and without the office block: the block is bytes.
    const withOffices = await size("");
    const without = await size("&office_info=0");
    expect(withOffices).toBeGreaterThan(without);
    // The two-column layout, a second sort key and unshaded rows all render.
    expect(await size("&page_columns=2&sort=office&sort2=title&sort2_dir=desc&zebra=0")).toBeGreaterThan(1500);
    expect(await size("&page_columns=3&columns=name,phone")).toBeGreaterThan(1500);
    expect(await size("&office_columns=4")).toBeGreaterThan(1500);
    expect(await size("&office_columns=1")).toBeGreaterThan(1500);
  } finally {
    await api(page, `/api/admin/directory/people/${person.id}`, { method: "DELETE" });
    const now = await api(page, "/api/admin/directory/offices");
    await api(page, "/api/admin/directory/offices", {
      method: "PUT",
      body: {
        fields: now.body.fields.filter((f: any) => !String(f.label).includes(String(STAMP))),
        profiles: now.body.profiles.filter((p: any) => p.office !== office),
      },
    });
  }
});

// A 1x1 PNG, enough for the photo pipeline to decode, crop and re-encode.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("reach people: contact card, photo upload, date fields and the month's strip, missing-value filter", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const key = `e2e_pos_start_${stamp}`;
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const thisMonth = iso(new Date(now.getFullYear(), now.getMonth(), Math.min(now.getDate(), 28)));
  const fiveYears = iso(new Date(now.getFullYear() - 5, now.getMonth(), Math.min(now.getDate(), 28)));

  const field = (await api(page, "/api/admin/directory/fields", { method: "POST", body: { label: `E2E Start ${stamp}`, key, kind: "date", date_role: "start" } })).body.field;
  expect(field.kind).toBe("date");
  expect(field.date_role).toBe("start");
  const newHire = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Reg Newhire ${stamp}`, title: "Associate", email: `newhire${stamp}@e2e.test`, phone: "602-555-0100 x218", office: "PHX1", custom: { [key]: thisMonth } } })).body.person;
  const veteran = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Reg Veteran ${stamp}`, custom: { [key]: fiveYears } } })).body.person;
  const blank = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Reg Blank ${stamp}` } })).body.person;
  try {
    // The date reads back formatted on the public API and sorts as a date.
    const dir = await api(page, "/api/directory");
    const hire = dir.body.people.find((p: any) => p.id === newHire.id);
    expect(hire.custom[key]).toBe(thisMonth);

    // Contact card: vCard 3.0 with the phone as typed and CRLF endings.
    const vcf = await page.evaluate(async (id) => {
      const res = await fetch(`/api/directory/${id}/vcard`);
      return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), text: await res.text() };
    }, newHire.id);
    expect(vcf.status).toBe(200);
    expect(vcf.type).toContain("text/vcard");
    expect(vcf.disposition).toContain(".vcf");
    expect(vcf.text).toContain("BEGIN:VCARD\r\nVERSION:3.0");
    expect(vcf.text).toContain("TEL;TYPE=WORK,VOICE:602-555-0100 x218");
    expect(vcf.text).toContain("TITLE:Associate");

    // The sheet as contacts.
    const sheet = await page.evaluate(async (ids) => {
      const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "vcf", ids }) });
      return { status: res.status, text: await res.text(), disposition: res.headers.get("content-disposition") };
    }, [newHire.id, veteran.id]);
    expect(sheet.status).toBe(200);
    expect(sheet.disposition).toContain(".vcf");
    expect(sheet.text.split("BEGIN:VCARD").length - 1).toBe(2);

    // Photo upload: both sizes come back through the photo route.
    const upload = await page.evaluate(async ({ id, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append("photo", new Blob([bytes], { type: "image/png" }), "p.png");
      const res = await fetch(`/api/admin/directory/people/${id}/photo`, { method: "POST", body: form });
      const data = await res.json();
      const thumb = await fetch(`/api/directory/${id}/photo`);
      const large = await fetch(`/api/directory/${id}/photo?size=large`);
      return { status: res.status, photo: String(data.photo ?? "").slice(0, 22), thumb: thumb.status, thumbType: thumb.headers.get("content-type"), large: large.status, largeLen: (await large.arrayBuffer()).byteLength, thumbLen: (await thumb.arrayBuffer()).byteLength };
    }, { id: newHire.id, b64: PNG_1x1.toString("base64") });
    expect(upload.status).toBe(200);
    expect(upload.photo).toBe("data:image/jpeg;base64");
    expect(upload.thumb).toBe(200);
    expect(upload.thumbType).toBe("image/jpeg");
    expect(upload.large).toBe(200);
    expect(upload.largeLen).toBeGreaterThan(upload.thumbLen);
    const cleared = await api(page, `/api/admin/directory/people/${newHire.id}/photo`, { method: "DELETE" });
    expect(cleared.status).toBe(200);

    // The month's strip on the directory, and tenure on the profile.
    await page.goto("/directory");
    await expect(page.getByText("Started this month")).toBeVisible();
    await expect(page.getByText("Work anniversaries")).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Reg Veteran ${stamp}` }).first()).toBeVisible();
    await page.goto(`/directory/${veteran.id}`);
    await expect(page.getByText(/Since .* · 5 years/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Save .* as a contact/ })).toBeVisible();
    await page.getByRole("button", { name: "Show contact QR code" }).click();
    await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

    // The record-property inventory answers even with no records.
    const props = await api(page, "/api/admin/directory/fields/preview?provider=microsoft");
    expect(props.status).toBe(200);
    expect(Array.isArray(props.body.properties)).toBe(true);

    // ?missing= lands the admin on exactly the people without an office.
    await page.goto("/admin/directory?missing=office");
    await expect(page.getByText(/with no office/)).toBeVisible();
    await expect(page.getByText(`E2E Reg Blank ${stamp}`)).toBeVisible();
    await expect(page.getByText(`E2E Reg Newhire ${stamp}`)).toHaveCount(0);
  } finally {
    for (const id of [newHire.id, veteran.id, blank.id]) await api(page, `/api/admin/directory/people/${id}`, { method: "DELETE" });
    await api(page, `/api/admin/directory/fields/${field.id}`, { method: "DELETE" });
  }
});
