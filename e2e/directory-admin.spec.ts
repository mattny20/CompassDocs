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
