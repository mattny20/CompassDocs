import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The directory registry (1.2), end to end through the HTTP surface and the
// page: fields with options and order, people links both ways, pins, admin
// defaults, and the server-side export. The provider-sync half (records,
// mappings, adoption) lives in test/directory-registry.test.ts because no
// endpoint seeds a provider's people.

const STAMP = Date.now();
const KEY = `e2e_pos_${STAMP}`;

async function cleanup(page: import("@playwright/test").Page) {
  const fields = await api(page, "/api/admin/directory/fields");
  for (const f of fields.body?.fields ?? []) {
    if (String(f.key).startsWith("e2e_pos_")) await api(page, `/api/admin/directory/fields/${f.id}`, { method: "DELETE" });
  }
  const people = await api(page, "/api/admin/directory/people");
  for (const p of people.body?.people ?? []) {
    if (String(p.name).startsWith("E2E Reg ")) await api(page, `/api/admin/directory/people/${p.id}`, { method: "DELETE" });
  }
}

test("fields carry options in the admin's order; grouped views and exports follow it", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  await cleanup(page);

  try {
    // Built-in rows are there and protected.
    const fields = await api(page, "/api/admin/directory/fields");
    expect(fields.status).toBe(200);
    const assistant = fields.body.fields.find((f: any) => f.key === "assistant");
    expect(assistant?.builtin, "assistant is a built-in people field").toBe(1);
    expect(assistant?.kind).toBe("people");
    const del = await api(page, `/api/admin/directory/fields/${assistant.id}`, { method: "DELETE" });
    expect(del.status, "built-ins cannot be deleted").toBe(400);
    const reserved = await api(page, "/api/admin/directory/fields", { method: "POST", body: { label: "Office", key: "office" } });
    expect(reserved.status, "a custom field cannot take a built-in key").toBe(400);

    // A choice field with ordered options and aliases: Attorney first,
    // Receptionist last — "in order of importance to contact".
    const made = await api(page, "/api/admin/directory/fields", {
      method: "POST",
      body: {
        label: `E2E Position ${STAMP}`,
        key: KEY,
        kind: "choice",
        group_by: true,
        show_in_card: true,
        display: "tag",
        value_format: "label",
        options: [
          { value: "Attorney", matches: ["*Attorney*", "Partner"] },
          { value: "Legal Assistant", matches: ["LA"] },
          { value: "Receptionist" },
        ],
      },
    });
    expect(made.status).toBe(201);
    expect(made.body.field.options.length).toBe(3);

    // People: an attorney with two assistants, a receptionist.
    const mk = (name: string, custom: Record<string, string>) =>
      api(page, "/api/admin/directory/people", { method: "POST", body: { name, custom } });
    const dana = (await mk("E2E Reg Dana", { [KEY]: "LA" })).body.person;
    const sam = (await mk("E2E Reg Sam", { [KEY]: "Legal Assistant" })).body.person;
    const zed = (await mk("E2E Reg Zed", { [KEY]: "Receptionist" })).body.person;
    const amy = (await api(page, "/api/admin/directory/people", {
      method: "POST",
      body: { name: "E2E Reg Amy", title: "Senior Partner", custom: { [KEY]: "Partner" }, links: { assistant: [dana.id, sam.id] } },
    })).body.person;
    expect(amy.links.assistant.map((l: any) => l.name)).toEqual(["E2E Reg Dana", "E2E Reg Sam"]);

    // Both directions are visible, from either end.
    const danaNow = (await api(page, "/api/directory")).body.people.find((p: any) => p.id === dana.id);
    expect(danaNow.linked_by.assistant.map((l: any) => l.name)).toEqual(["E2E Reg Amy"]);
    expect(danaNow.assistant_name, "no assistant of her own").toBeNull();

    // Editing from the assistant's side writes the same relation.
    await api(page, `/api/admin/directory/people/${sam.id}`, { method: "PATCH", body: { linked_by: { assistant: [amy.id, zed.id] } } });
    const zedNow = (await api(page, "/api/directory")).body.people.find((p: any) => p.id === zed.id);
    expect(zedNow.links.assistant.map((l: any) => l.name)).toEqual(["E2E Reg Sam"]);

    // The grouped view orders sections by the options, aliases folded in.
    await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { columns: ["name", "department", "phone", KEY], group_by: KEY } });
    await page.goto("/directory");
    await page.getByRole("button", { name: "Groups" }).click();
    await page.getByLabel("Group by").selectOption(KEY);
    await page.fill('input[aria-label="Search people"]', "E2E Reg");
    // Section headers are keyed by the option, so "Partner" files under
    // Attorney. textContent, not innerText: the header is CSS-uppercased.
    await expect(page.locator("h2", { hasText: /Attorney/ })).toBeVisible();
    const headers = await page.locator("h2").allTextContents();
    const order = headers.map((h) => h.replace(/\s*\(\d+\)\s*$/, "").trim()).filter((h) => ["Attorney", "Legal Assistant", "Receptionist"].includes(h));
    expect(order).toEqual(["Attorney", "Legal Assistant", "Receptionist"]);
    // The attorney tile carries her assistants; "Partner" resolved to Attorney.
    await expect(page.getByText("Assistant: E2E Reg Dana, E2E Reg Sam")).toBeVisible();

    // The list opens on the admin's default columns — no Title — and shows
    // the option label, not the raw alias.
    await page.getByRole("button", { name: "List" }).click();
    const ths = (await page.locator("thead th button").allTextContents()).map((t) => t.replace(/[↑↓]/g, "").trim());
    expect(ths).toEqual(["Name", "Department", "Phone", `E2E Position ${STAMP}`]);
    const danaRow = page.locator("tbody tr", { hasText: "E2E Reg Dana" });
    await expect(danaRow.getByText("Legal Assistant", { exact: true })).toBeVisible();

    // Admin pins put people first; the API keeps their order.
    await api(page, `/api/admin/directory/people/${zed.id}`, { method: "PATCH", body: { pinned: true } });
    await api(page, "/api/admin/directory/pins", { method: "PUT", body: { ids: [zed.id] } });
    // The page loads its people once; pins set through the API show after a reload.
    await page.goto("/directory");
    await page.getByRole("button", { name: "Cards" }).click();
    await page.fill('input[aria-label="Search people"]', "E2E Reg");
    await expect(page.getByRole("heading", { name: /Pinned/ })).toBeVisible();

    // Exports: the default preset as PDF, and "what I see" as CSV with the
    // option label and both assistant columns.
    const pdf = await page.evaluate(async () => {
      const res = await fetch("/api/directory/export?format=pdf");
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get("content-type"), head: String.fromCharCode(...buf.slice(0, 5)), size: buf.length };
    });
    expect(pdf.status).toBe(200);
    expect(pdf.type).toContain("application/pdf");
    expect(pdf.head).toBe("%PDF-");
    expect(pdf.size).toBeGreaterThan(1500);

    const csv = await page.evaluate(
      async ({ ids, key }) => {
        const res = await fetch("/api/directory/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ format: "csv", ids, columns: ["name", key, "assistant", "assists"], group_by: key, sort: key }),
        });
        return { status: res.status, text: await res.text(), disposition: res.headers.get("content-disposition") };
      },
      { ids: [amy.id, dana.id, sam.id, zed.id], key: KEY }
    );
    expect(csv.status).toBe(200);
    expect(csv.disposition).toContain(".csv");
    const lines = csv.text.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe(`Group,Name,E2E Position ${STAMP},Assistant,Assists`);
    expect(lines[1]).toBe(`Attorney,E2E Reg Amy,Attorney,"E2E Reg Dana, E2E Reg Sam",`);
    expect(lines.some((l) => l.startsWith("Legal Assistant,E2E Reg Dana,Legal Assistant,,E2E Reg Amy"))).toBe(true);

    // Export presets: save one with a filter and landscape legal paper; the
    // GET honours it and names the file after it.
    const presets = await api(page, "/api/admin/directory/export-presets");
    expect(presets.status).toBe(200);
    const saved = await api(page, "/api/admin/directory/export-presets", {
      method: "PUT",
      body: {
        presets: [
          ...presets.body.presets,
          { id: `e2e-${STAMP}`, name: "E2E Attorneys", paper: "legal", orientation: "landscape", columns: ["name", KEY], filter: { key: KEY, value: "Attorney" }, filename: "e2e-attorneys" },
        ],
      },
    });
    expect(saved.status).toBe(200);
    const one = await page.evaluate(async (id) => {
      const res = await fetch(`/api/directory/export?preset=${id}&format=csv`);
      return { status: res.status, text: await res.text(), disposition: res.headers.get("content-disposition") };
    }, `e2e-${STAMP}`);
    expect(one.status).toBe(200);
    expect(one.disposition).toContain('filename="e2e-attorneys.csv"');
    const rows = one.text.replace(/^﻿/, "").trim().split(/\r?\n/).slice(1);
    expect(rows.some((r) => r.includes("E2E Reg Amy"))).toBe(true);
    expect(rows.some((r) => r.includes("E2E Reg Zed")), "the filter keeps the receptionist out").toBe(false);

    // The manual layer: null reverts a key.
    await api(page, `/api/admin/directory/people/${zed.id}`, { method: "PATCH", body: { custom: { [KEY]: null } } });
    const zedAfter = (await api(page, "/api/admin/directory/people")).body.people.find((p: any) => p.id === zed.id);
    expect(zedAfter.manual[KEY]).toBeUndefined();
    expect(zedAfter.custom[KEY]).toBeUndefined();
  } finally {
    // Presets: drop the one we added.
    const presets = await api(page, "/api/admin/directory/export-presets");
    if (presets.body?.presets) {
      await api(page, "/api/admin/directory/export-presets", {
        method: "PUT",
        body: { presets: presets.body.presets.filter((p: any) => !String(p.id).startsWith("e2e-")) },
      });
    }
    await api(page, "/api/admin/directory/list-columns", { method: "PUT", body: { columns: ["name", "department", "phone", "email", "office"], group_by: "department" } });
    await cleanup(page);
    await ctx.close();
  }
});

// 1.13.0: an option's heads. Saved through the field route and read back in
// order; refused by name when an id is not a whole number, there are more
// than five, or someone is not in the directory; pruned on read once the
// person is hidden; picked on the Fields page with their own value shown.
test("an option saved with heads round-trips, a bad head is refused, a hidden head drops out on read, and the Fields page picks them", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  // Its own key prefix and names: the first test's cleanup must not reach these rows.
  const key = `e2e_heads_${stamp}`;
  const fieldsOf = async () => (await api(page, "/api/admin/directory/fields")).body.fields.find((f: any) => f.key === key);
  const made: { id: number }[] = [];
  let fieldId: number | undefined;
  try {
    const field = (await api(page, "/api/admin/directory/fields", {
      method: "POST",
      body: { label: `E2E Dept ${stamp}`, key, kind: "choice", group_by: true, value_format: "label", options: [{ value: "ENG", label: "Engineering" }, { value: "EXEC", label: "Executive" }] },
    })).body.field as { id: number };
    fieldId = field.id;
    const mk = async (name: string, value: string) => {
      const p = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name, custom: { [key]: value } } })).body.person;
      made.push(p);
      return p;
    };
    const jane = await mk(`E2E Heads Jane ${stamp}`, "EXEC");
    const bob = await mk(`E2E Heads Bob ${stamp}`, "ENG");

    // Saved in the order given, once each; an option without heads carries no key.
    const saved = await api(page, `/api/admin/directory/fields/${field.id}`, {
      method: "PATCH",
      body: { options: [{ value: "ENG", label: "Engineering", heads: [bob.id, jane.id, bob.id] }, { value: "EXEC", label: "Executive" }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.field.options[0].heads).toEqual([bob.id, jane.id]);
    expect(saved.body.field.options[1].heads).toBeUndefined();
    expect((await fieldsOf()).options[0].heads).toEqual([bob.id, jane.id]);

    // Refused, and nothing changes: a non-integer id, more than five, someone not in the directory.
    const refusals: [unknown[], RegExp][] = [
      [["x"], /not a person's id/],
      [[1, 2, 3, 4, 5, 6], /up to 5 heads/],
      [[jane.id, 99999999], /person in the directory/],
    ];
    for (const [heads, re] of refusals) {
      const r = await api(page, `/api/admin/directory/fields/${field.id}`, { method: "PATCH", body: { options: [{ value: "ENG", label: "Engineering", heads }, { value: "EXEC" }] } });
      expect(r.status, `refuses ${JSON.stringify(heads)}`).toBe(400);
      expect(r.body.error).toMatch(re);
    }
    expect((await fieldsOf()).options[0].heads).toEqual([bob.id, jane.id]);

    // A hidden head drops out on read; shown again, they are back.
    await api(page, `/api/admin/directory/people/${bob.id}`, { method: "PATCH", body: { hidden: true } });
    expect((await fieldsOf()).options[0].heads).toEqual([jane.id]);
    await api(page, `/api/admin/directory/people/${bob.id}`, { method: "PATCH", body: { hidden: false } });
    expect((await fieldsOf()).options[0].heads).toEqual([bob.id, jane.id]);

    // The Fields page: the Heads list under the options, one picker per
    // option naming the row, the saved heads as chips, the help once; pick
    // Jane as Executive's head (her own value shows beside her name) and
    // Save options.
    await page.goto("/admin/directory/fields");
    // The row's label is an input's value; its key is text.
    const row = page.locator("tr", { hasText: key });
    await row.getByRole("button", { name: "2 options" }).click();
    const heads = page.getByRole("group", { name: "Heads" });
    await expect(heads).toBeVisible();
    await expect(heads.getByText("The people who head this section. They print at the top of its section on exports and in the Groups view, even when their own value is another section.")).toBeVisible();
    await expect(heads.getByRole("button", { name: `Remove ${bob.name}` })).toBeVisible();
    await expect(heads.getByRole("button", { name: `Remove ${jane.name}` })).toBeVisible();
    const execPicker = heads.getByRole("combobox", { name: "Heads of Executive" });
    await execPicker.fill(jane.name);
    const choice = page.getByRole("option", { name: new RegExp(jane.name) });
    await expect(choice).toContainText("Executive");
    await choice.click();
    await expect(heads.getByRole("button", { name: `Remove ${jane.name}` })).toHaveCount(2);
    await page.getByRole("button", { name: "Save options" }).click();
    await expect(page.getByText("Options saved.")).toBeVisible();
    const after = await fieldsOf();
    expect(after.options[0].heads).toEqual([bob.id, jane.id]);
    expect(after.options[1].heads).toEqual([jane.id]);
  } finally {
    for (const p of made) await api(page, `/api/admin/directory/people/${p.id}`, { method: "DELETE" });
    if (fieldId !== undefined) await api(page, `/api/admin/directory/fields/${fieldId}`, { method: "DELETE" });
  }
});

test("the mapping preview runs without records and rejects a broken mapping", async ({ page }) => {
  await login(page, ADMIN);
  const bad = await api(page, "/api/admin/directory/fields/preview", {
    method: "POST",
    body: { provider: "microsoft", mapping: { kind: "extract", path: "businessPhones", pattern: "(" } },
  });
  expect(bad.status).toBe(400);
  const ok = await api(page, "/api/admin/directory/fields/preview", {
    method: "POST",
    body: { provider: "microsoft", mapping: { kind: "compose", template: "{officeLocation} – {city}" } },
  });
  expect(ok.status).toBe(200);
  expect(ok.body.preview.total).toBe(0);
  expect(ok.body.preview.filled).toBe(0);

  // Reverting to "Not mapped" is a save without the provider, and it sticks:
  // the field reads back unmapped, legacy column included (1.2.2).
  const made = await api(page, "/api/admin/directory/fields", {
    method: "POST",
    body: { label: `E2E Revert ${STAMP}`, key: `e2e_pos_revert_${STAMP}`, mappings: { microsoft: { kind: "path", path: "officeLocation" } } },
  });
  expect(made.status).toBe(201);
  expect(made.body.field.graph_path).toBe("officeLocation");
  const cleared = await api(page, `/api/admin/directory/fields/${made.body.field.id}`, { method: "PATCH", body: { mappings: {} } });
  expect(cleared.status).toBe(200);
  expect(cleared.body.field.mappings).toEqual({});
  expect(cleared.body.field.graph_path).toBe("");
  const reread = (await api(page, "/api/admin/directory/fields")).body.fields.find((f: any) => f.id === made.body.field.id);
  expect(reread.mappings).toEqual({});
  await api(page, `/api/admin/directory/fields/${made.body.field.id}`, { method: "DELETE" });
});
