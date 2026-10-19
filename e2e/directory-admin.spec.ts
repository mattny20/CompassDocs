import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The directory settings as pages (1.2.4): each job on its own route under
// one header and tab row, and the Offices page feeding the PDF export. Since
// 1.11.2 the Directory page defaults have a page of their own (Display) and
// the Export page is a preset list beside the selected preset's editor.

const STAMP = Date.now();

/** The five cards the preset editor groups its controls into, in order. */
const PRESET_CARDS = ["Document", "Page", "Columns", "Order and filter", "Schedule"] as const;

test("each directory settings job is a page under one header", async ({ page }) => {
  await login(page, ADMIN);
  for (const [path, heading] of [
    ["/admin/directory", "Add a person"],
    ["/admin/directory/display", "Directory page defaults"],
    ["/admin/directory/fields", "Directory fields"],
    ["/admin/directory/offices", "Offices"],
    ["/admin/directory/export", "Presets"],
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

// 1.11.1: per-column wrapping, assistant details, custom margins and sorting
// by first or last name, in the preset editor and on the Directory page.
test("a preset keeps column limits, assistant details, custom margins and a first-name sort; the directory sorts names by part", async ({ page, browser }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  // Two people whose full-name order and last-name order disagree: Amy Zebra
  // leads by full and first name, Zed Aardvark by last name. Zed assists Amy.
  const zed = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `Zed Aardvark${stamp}`, phone: "602-555-0101" } })).body.person;
  const amy = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `Amy Zebra${stamp}`, title: "Partner", links: { assistant: [zed.id] } } })).body.person;
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  const defaults = (await api(page, "/api/admin/directory/list-columns")).body;
  const id = `e2e-wrap-${stamp}`;
  try {
    // The preset round-trips through PUT and GET, sanitized: an unknown column
    // drops out of the limits, 500 clamps to 120, the assistant fields keep
    // only real non-link keys once, and the name sorts are accepted as sorts.
    const saved = await api(page, "/api/admin/directory/export-presets", {
      method: "PUT",
      body: {
        presets: [
          ...presets,
          {
            id,
            name: `E2E Wrap ${stamp}`,
            columns: ["name", "assistant", "phone"],
            column_limits: { name: 12, bogus: 50, phone: 500 },
            assistant_fields: ["phone", "phone", "name", "assists"],
            margins: "custom",
            margin_custom: { top: 0.7, right: 0.6, bottom: 0.8, left: 0.6 },
            sort: "name:first",
            sort2: "name:last",
            filename: id,
          },
        ],
      },
    });
    expect(saved.status).toBe(200);
    const mine = saved.body.presets.find((p: any) => p.id === id);
    expect(mine.column_limits).toEqual({ name: 12, phone: 120 });
    expect(mine.assistant_fields).toEqual(["phone"]);
    expect(mine.margins).toBe("custom");
    expect(mine.margin_custom).toEqual({ top: 0.7, right: 0.6, bottom: 0.8, left: 0.6 });
    expect(mine.sort).toBe("name:first");
    expect(mine.sort2).toBe("name:last");
    const back = (await api(page, "/api/admin/directory/export-presets")).body.presets.find((p: any) => p.id === id);
    expect(back).toMatchObject({ column_limits: { name: 12, phone: 120 }, assistant_fields: ["phone"], margins: "custom", margin_custom: { top: 0.7 }, sort: "name:first", sort2: "name:last" });

    // The PDF renders with a wrapped column and custom margins.
    const pdf = await page.evaluate(async (id) => {
      const res = await fetch(`/api/directory/export?preset=${id}&format=pdf`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get("content-type"), head: String.fromCharCode(...buf.slice(0, 5)), size: buf.length };
    }, id);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain("application/pdf");
    expect(pdf.head).toBe("%PDF-");
    expect(pdf.size).toBeGreaterThan(1500);

    // The CSV's assistant cell carries the chosen field after the name. Only
    // Amy is exported (a "what I see" export of one row): Zed's details come
    // from everyone the viewer may see, not from the rows in the file.
    const csv = await page.evaluate(
      async ({ id, ids }) => {
        const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: id, format: "csv", ids }) });
        return { status: res.status, text: await res.text() };
      },
      { id, ids: [amy.id] }
    );
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`Zed Aardvark${stamp} · 602-555-0101`);

    // The editor shows what was saved: the name sort, the per-column limit,
    // the margins and their inches, the assistant's ticked field. The preset
    // is a row in the list; its editor is the five group cards.
    await page.goto("/admin/directory/export");
    await page.getByRole("button", { name: `E2E Wrap ${stamp}` }).click();
    await expect(page.getByRole("heading", { name: `E2E Wrap ${stamp}` })).toBeVisible();
    for (const card of PRESET_CARDS) await expect(page.getByRole("heading", { name: card, exact: true })).toBeVisible();
    // "Sort by" / "Then by" wrap a direction select too, so their names are not exact.
    await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("name:first");
    await expect(page.getByRole("combobox", { name: "Then by" })).toHaveValue("name:last");
    await expect(page.getByRole("spinbutton", { name: "Wrap Name after" })).toHaveValue("12");
    await expect(page.getByRole("spinbutton", { name: "Wrap Phone after" })).toHaveValue("120");
    await expect(page.getByRole("combobox", { name: "Margins", exact: true })).toHaveValue("custom");
    await expect(page.getByRole("spinbutton", { name: "Top", exact: true })).toHaveValue("0.7");
    await expect(page.getByRole("spinbutton", { name: "Bottom", exact: true })).toHaveValue("0.8");
    await expect(page.getByRole("checkbox", { name: "Phone", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Title", exact: true })).not.toBeChecked();
    // Out of range is refused inline, not clamped by the server after a
    // "saved": Save waits the moment the value is typed; the message waits
    // until the input is left, so a "1" on the way to "12" is not shouted at.
    const wrapName = page.getByRole("spinbutton", { name: "Wrap Name after" });
    const wrapError = page.getByText("Wrap after for Name: must be between 8 and 120.");
    const save = page.getByRole("button", { name: "Save presets" });
    await wrapName.fill("4");
    await expect(save).toBeDisabled();
    await expect(wrapError).toHaveCount(0);
    await wrapName.blur();
    await expect(wrapError).toBeVisible();
    await wrapName.fill("12");
    await expect(wrapError).toHaveCount(0);
    await expect(save).toBeEnabled();
    // A custom margin takes one decimal place, the rule the server keeps, so
    // 0.75 is refused here rather than saved as 0.8 behind a "saved".
    const top = page.getByRole("spinbutton", { name: "Top", exact: true });
    await top.fill("0.75");
    await expect(page.getByText("Use one decimal place.")).toBeVisible();
    await expect(save).toBeDisabled();
    await top.fill("0.7");
    await expect(page.getByText("Use one decimal place.")).toHaveCount(0);
    await expect(save).toBeEnabled();
    // Save, so the leave guard has nothing to hold the next navigation for;
    // afterwards the inputs show what was saved.
    await save.click();
    await expect(page.getByText("Export presets saved.")).toBeVisible();
    await expect(top).toHaveValue("0.7");
    await expect(wrapName).toHaveValue("12");

    // The admin default for "Sort names by" saves through the Directory page
    // defaults card's route and comes back to it, on the Display page; the
    // Export page no longer carries it.
    const put = await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { name_sort: "last" } });
    expect(put.status).toBe(200);
    await page.goto("/admin/directory/display");
    await expect(page.getByRole("combobox", { name: "Sort names by" })).toHaveValue("last");
    await page.goto("/admin/directory/export");
    await expect(page.getByRole("combobox", { name: "Sort names by" })).toHaveCount(0);

    // A fresh browser opens the list by last name (the admin's default), the
    // control switches it, and this browser's choice survives a reload.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    try {
      await login(fresh, ADMIN);
      await fresh.goto("/directory?view=list");
      await fresh.getByRole("textbox", { name: "Search people" }).fill(String(stamp));
      // The visible list only: the print table is in the DOM too, hidden.
      const rows = fresh.getByRole("table").locator("tbody tr");
      await expect(rows).toHaveCount(2);
      const control = fresh.getByRole("combobox", { name: "Sort names by" });
      await expect(control).toHaveValue("last");
      await expect(rows.first()).toContainText(`Zed Aardvark${stamp}`);
      await control.selectOption("full");
      await expect(rows.first()).toContainText(`Amy Zebra${stamp}`);
      await control.selectOption("last");
      await expect(rows.first()).toContainText(`Zed Aardvark${stamp}`);
      await control.selectOption("first");
      await expect(rows.first()).toContainText(`Amy Zebra${stamp}`);
      // "What I see" sends the effective sort key, not the column name.
      const [req] = await Promise.all([
        fresh.waitForRequest((r) => r.url().includes("/api/directory/export") && r.method() === "POST"),
        (async () => {
          await fresh.getByRole("button", { name: /Export/ }).click();
          await fresh.getByRole("menuitem", { name: /What I see/ }).first().click();
        })(),
      ]);
      expect(req.postDataJSON().sort).toBe("name:first");
      await fresh.reload();
      await fresh.getByRole("textbox", { name: "Search people" }).fill(String(stamp));
      await expect(fresh.getByRole("combobox", { name: "Sort names by" })).toHaveValue("first");
      await expect(fresh.getByRole("table").locator("tbody tr").first()).toContainText(`Amy Zebra${stamp}`);
    } finally {
      await ctx.close();
    }
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
    await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { name_sort: defaults?.name_sort ?? "full" } });
    for (const p of [amy, zed]) await api(page, `/api/admin/directory/people/${p.id}`, { method: "DELETE" });
  }
});

// 1.11.2: export markers (a symbol in front of a name for people who match a
// field value, the key in the PDF's footer) and name formats, through the
// markers route, a preset and the files it makes.
test("markers round-trip and refuse an unprintable symbol; a preset prints them and writes names in a format", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const title = `E2E Notary ${stamp}`;
  const before = (await api(page, "/api/admin/directory/markers")).body.markers as any[];
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  // Zed is a notary by title and assists Jane, who is not one.
  const zed = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `Zed Aardvark${stamp}`, title, phone: "602-555-0101" } })).body.person;
  const jane = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: "Smith, Jane A.", links: { assistant: [zed.id] } } })).body.person;
  const id = `e2e-mark-${stamp}`;
  try {
    // A symbol the PDF's Helvetica cannot print is refused by name, never
    // saved to come out as a box on paper; the stored set is untouched.
    const refused = await api(page, "/api/admin/directory/markers", {
      method: "PUT",
      body: { markers: [...before, { label: "Public notary", symbol: "★", key: "title", value: title }] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Marker "Public notary": the symbol "★" cannot be printed.');
    expect((await api(page, "/api/admin/directory/markers")).body.markers).toEqual(before);
    // A printable one round-trips through PUT and GET with a slug id.
    const saved = await api(page, "/api/admin/directory/markers", {
      method: "PUT",
      body: { markers: [...before, { label: "Public notary", symbol: "*", key: "title", value: title }] },
    });
    expect(saved.status).toBe(200);
    const mine = saved.body.markers.find((m: any) => m.value === title);
    expect(mine).toMatchObject({ label: "Public notary", symbol: "*", key: "title", value: title });
    expect(mine.id).toMatch(/^public-notary/);
    expect((await api(page, "/api/admin/directory/markers")).body.markers).toContainEqual(mine);

    // A preset that prints the marker and writes names "Last, First initial";
    // an id the workspace does not have drops out of the preset.
    const put = await api(page, "/api/admin/directory/export-presets", {
      method: "PUT",
      body: {
        presets: [
          ...presets,
          { id, name: `E2E Mark ${stamp}`, columns: ["name", "assistant", "phone"], assistant_fields: ["phone"], markers: [mine.id, "bogus"], name_format: "last_first_initial", filename: id },
        ],
      },
    });
    expect(put.status).toBe(200);
    const preset = put.body.presets.find((p: any) => p.id === id);
    expect(preset.markers).toEqual([mine.id]);
    expect(preset.name_format).toBe("last_first_initial");

    // The CSV: the notary's name cell starts with the symbol and the Markers
    // column lists the label; Jane's name reads "Smith, J."; her assistant
    // cell carries Zed's own prefix and format.
    const csv = await page.evaluate(
      async ({ id, ids }) => {
        const res = await fetch("/api/directory/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: id, format: "csv", ids }) });
        return { status: res.status, text: await res.text() };
      },
      { id, ids: [jane.id, zed.id] }
    );
    expect(csv.status).toBe(200);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Name,Assistant,Phone,Markers");
    expect(lines).toHaveLength(3);
    expect(lines).toContain(`"* Aardvark${stamp}, Z.",,602-555-0101,Public notary`);
    expect(lines).toContain(`"Smith, J.","* Aardvark${stamp}, Z. · 602-555-0101",,`);

    // The PDF renders with the key line in its footer.
    const pdf = await page.evaluate(async (id) => {
      const res = await fetch(`/api/directory/export?preset=${id}&format=pdf`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, head: String.fromCharCode(...buf.slice(0, 5)), size: buf.length };
    }, id);
    expect(pdf.status).toBe(200);
    expect(pdf.head).toBe("%PDF-");
    expect(pdf.size).toBeGreaterThan(1500);

    // The page: the Markers card lists the marker; the preset's Document card
    // shows the format and its Columns card ticks the marker.
    await page.goto("/admin/directory/export");
    await expect(page.getByRole("heading", { name: "Markers", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name of Public notary" }).last()).toHaveValue("Public notary");
    await page.getByRole("button", { name: `E2E Mark ${stamp}` }).click();
    await expect(page.getByRole("combobox", { name: "Name format" })).toHaveValue("last_first_initial");
    await expect(page.getByRole("checkbox", { name: "* Public notary" }).last()).toBeChecked();
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
    await api(page, "/api/admin/directory/markers", { method: "PUT", body: { markers: before } });
    for (const p of [jane, zed]) await api(page, `/api/admin/directory/people/${p.id}`, { method: "DELETE" });
  }
});

// 1.11.2: the Directory page defaults (list columns, the Groups view's field,
// Sort names by) are the Display page, one card with one Save.
test("the Display page holds the Directory page defaults and saves them", async ({ page }) => {
  await login(page, ADMIN);
  const defaults = (await api(page, "/api/admin/directory/list-columns")).body;
  const want = defaults?.name_sort === "first" ? "last" : "first";
  try {
    await page.goto("/admin/directory/display");
    await expect(page.getByRole("heading", { name: "Directory page defaults" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Groups view opens on" })).toBeVisible();
    // The columns list is the shared ordered list; Name is always a row in it.
    await expect(page.getByRole("button", { name: "Remove Name" })).toBeVisible();
    const save = page.getByRole("button", { name: "Save defaults" });
    await expect(save).toBeDisabled();
    await page.getByRole("combobox", { name: "Sort names by" }).selectOption(want);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Directory defaults saved.")).toBeVisible();
    expect((await api(page, "/api/admin/directory/list-columns")).body.name_sort).toBe(want);
  } finally {
    await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { name_sort: defaults?.name_sort ?? "full" } });
  }
});

// 1.11.2, at the tightest common phone width: the preset list stacks over the
// editor, nothing pushes the page sideways (the Wrap after rows and the
// custom margins wrap instead), and the Save row stays reachable.
test("at 375px the Export page stacks the preset list over the editor and Save is reachable", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const stamp = Date.now();
  const id = `e2e-phone-${stamp}`;
  const presets = (await api(page, "/api/admin/directory/export-presets")).body.presets as any[];
  try {
    const saved = await api(page, "/api/admin/directory/export-presets", {
      method: "PUT",
      body: {
        presets: [
          ...presets,
          { id, name: `E2E Phone ${stamp}`, split_by: "office", margins: "custom", schedule: { frequency: "weekly", day: 1, hour: 6, recipients: "reception@e2e.test", format: "pdf" } },
        ],
      },
    });
    expect(saved.status).toBe(200);

    await page.goto("/admin/directory/export");
    const row = page.getByRole("button", { name: `E2E Phone ${stamp}` });
    await expect(row).toContainText("ZIP");
    await expect(row).toContainText("Scheduled");
    await row.click();
    await expect(page.getByRole("heading", { name: `E2E Phone ${stamp}` })).toBeVisible();
    for (const card of PRESET_CARDS) await expect(page.getByRole("heading", { name: card, exact: true })).toBeVisible();

    // The list sits above the editor.
    const list = await page.getByRole("heading", { name: "Presets" }).boundingBox();
    const first = await page.getByRole("heading", { name: "Document", exact: true }).boundingBox();
    expect(list!.y, "the preset list stacks above the editor").toBeLessThan(first!.y);
    // Nothing scrolls sideways: not the page, and not a card.
    const overflow = await page.locator("#main").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the page does not scroll sideways").toBeLessThanOrEqual(0);
    for (const card of ["Presets", ...PRESET_CARDS]) {
      const section = page.locator("section", { has: page.getByRole("heading", { name: card, exact: true }) }).last();
      const spill = await section.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill, `the ${card} card does not overflow`).toBeLessThanOrEqual(0);
    }

    // A change pins the Save row to the bottom of the viewport; it saves.
    await page.getByRole("textbox", { name: "Subtitle" }).fill("Phone pass");
    const save = page.getByRole("button", { name: "Save presets" });
    await expect(save).toBeEnabled();
    await expect(save).toBeInViewport();
    await save.click();
    await expect(page.getByText("Export presets saved.")).toBeVisible();
  } finally {
    await api(page, "/api/admin/directory/export-presets", { method: "PUT", body: { presets } });
    await ctx.close();
  }
});
