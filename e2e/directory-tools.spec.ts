import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Admin tools (1.3.1): directory health on the People page, CSV import in
// three steps, and the sync schedule with its report recipients.

test("directory health names the blanks and links to the fix; CSV import plans before it writes", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const made: number[] = [];
  const noOffice = (await api(page, "/api/admin/directory/people", { method: "POST", body: { name: `E2E Tools Blank ${stamp}`, title: "Clerk", email: `blank${stamp}@e2e.test`, phone: "602-555-0101" } })).body.person;
  made.push(noOffice.id);
  try {
    // Health: the person with no office is a finding, with a link to the
    // filtered People page.
    await page.goto("/admin/directory");
    const health = page.getByRole("button", { name: /Directory health/ });
    await expect(health).toBeVisible();
    const row = page.getByText(/no office/i).first();
    await expect(row).toBeVisible();
    await page.locator('a[href="/admin/directory?missing=office"]').first().click();
    await expect(page.getByText(/with no office/)).toBeVisible();
    await expect(page.getByText(`E2E Tools Blank ${stamp}`)).toBeVisible();

    // Import, step 1: the file's columns come back with suggested targets.
    const csv = [
      "Name,Title,Email,Phone,Office",
      `E2E Tools Blank ${stamp},Senior Clerk,blank${stamp}@e2e.test,602-555-0101,PHX1`,
      `E2E Tools New ${stamp},Paralegal,new${stamp}@e2e.test,602-555-0102,TUC`,
      `,,,,`,
      `E2E Tools Dup ${stamp},Clerk,new${stamp}@e2e.test,,PHX1`,
    ].join("\n");
    const analysis = await api(page, "/api/admin/directory/import", { method: "POST", body: { csv, mode: "analyze" } });
    expect(analysis.status).toBe(200);
    expect(analysis.body.rowCount).toBe(4);
    expect(analysis.body.columns.map((c: any) => c.target)).toEqual(["name", "title", "email", "phone", "office"]);
    const mapping: Record<string, string> = {};
    for (const c of analysis.body.columns) mapping[String(c.index)] = c.target;

    // Step 2: the plan says what every row would do and writes nothing.
    const plan = await api(page, "/api/admin/directory/import", { method: "POST", body: { csv, mode: "plan", mapping } });
    expect(plan.status).toBe(200);
    expect(plan.body.counts).toEqual({ create: 1, update: 1, skip: 0, error: 2 });
    const actions = Object.fromEntries(plan.body.rows.map((r: any) => [r.row, r]));
    expect(actions[2].action).toBe("update");
    expect(actions[2].changes).toEqual(expect.arrayContaining(["title", "office"]));
    expect(actions[3].action).toBe("create");
    expect(actions[4].action).toBe("error");
    expect(actions[5].reason).toMatch(/Duplicate email/);
    const untouched = (await api(page, `/api/admin/directory/people`)).body.people.find((p: any) => p.id === noOffice.id);
    expect(untouched.office).toBe("");

    // Step 3: apply does exactly that.
    const applied = await api(page, "/api/admin/directory/import", { method: "POST", body: { csv, mode: "apply", mapping } });
    expect(applied.status).toBe(200);
    expect(applied.body.counts).toEqual({ create: 1, update: 1, skip: 0, error: 2 });
    const people = (await api(page, `/api/admin/directory/people`)).body.people;
    const updated = people.find((p: any) => p.id === noOffice.id);
    expect(updated.office).toBe("PHX1");
    expect(updated.title).toBe("Senior Clerk");
    const created = people.find((p: any) => p.email === `new${stamp}@e2e.test`);
    expect(created).toBeTruthy();
    made.push(created.id);
    expect(created.source).toBe("manual");

    // The same file again is all "nothing to change".
    const again = await api(page, "/api/admin/directory/import", { method: "POST", body: { csv, mode: "plan", mapping } });
    expect(again.body.counts).toEqual({ create: 0, update: 0, skip: 2, error: 2 });

    // The panel itself: paste, read columns, check, and the plan table.
    await page.goto("/admin/directory");
    await page.getByRole("button", { name: /Import from CSV/ }).click();
    await page.getByPlaceholder(/Jane Smith/).fill(csv);
    await page.getByRole("button", { name: "Read columns" }).click();
    await expect(page.getByText("4 rows.")).toBeVisible();
    await page.getByRole("button", { name: "Check what would happen" }).click();
    await expect(page.getByText(/0 to add · 0 to update · 2 unchanged · 2 problems/)).toBeVisible();
  } finally {
    for (const id of made) await api(page, `/api/admin/directory/people/${id}`, { method: "DELETE" });
  }
});

test("the sync schedule round-trips and cleans its recipients", async ({ page }) => {
  await login(page, ADMIN);
  const before = await api(page, "/api/admin/directory/schedule");
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({ microsoft: expect.any(String), google: expect.any(String), hour: expect.any(Number), report_to: expect.any(Array) });
  try {
    const saved = await api(page, "/api/admin/directory/schedule", {
      method: "PUT",
      body: { microsoft: "daily", google: "off", hour: 4, report_to: "IT@e2e.test, it@e2e.test; ops@e2e.test junk", report_quiet: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.microsoft).toBe("daily");
    expect(saved.body.google).toBe("off");
    expect(saved.body.hour).toBe(4);
    expect(saved.body.report_to).toEqual(["it@e2e.test", "ops@e2e.test"]);
    expect(saved.body.report_quiet).toBe(true);
    // A bad frequency and an out-of-range hour are ignored, not stored.
    const bad = await api(page, "/api/admin/directory/schedule", { method: "PUT", body: { microsoft: "weekly", hour: 99 } });
    expect(bad.body.microsoft).toBe("daily");
    expect(bad.body.hour).toBe(3);
  } finally {
    await api(page, "/api/admin/directory/schedule", { method: "PUT", body: { microsoft: before.body.microsoft, google: before.body.google, hour: before.body.hour, report_to: before.body.report_to.join(","), report_quiet: before.body.report_quiet } });
  }
});
