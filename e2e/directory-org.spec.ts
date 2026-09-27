import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// The org chart (1.3.3): the built-in Reports to field, one manager per
// person, the tree view, the team block on a profile, the team page, and
// the loop finding on the People page.

test("Reports to is built in and single-valued; the org chart, profile team block and team page follow it", async ({ page }) => {
  await login(page, ADMIN);
  const stamp = Date.now();
  const fields = (await api(page, "/api/admin/directory/fields")).body.fields as any[];
  const manager = fields.find((f) => f.key === "manager");
  expect(manager).toBeTruthy();
  expect(manager.builtin).toBe(1);
  expect(manager.kind).toBe("people");
  expect(manager.multi).toBe(0);
  expect(manager.inverse_label).toBe("Direct reports");
  expect(manager.mappings.microsoft).toEqual({ kind: "path", path: "manager.mail" });
  expect(manager.mappings.google).toEqual({ kind: "path", path: "relations[manager].value" });

  const mk = async (name: string, title: string, links?: Record<string, number[]>) =>
    (await api(page, "/api/admin/directory/people", { method: "POST", body: { name, title, links } })).body.person;
  const head = await mk(`E2E Org Head ${stamp}`, "Managing Partner");
  const vp = await mk(`E2E Org Vp ${stamp}`, "Partner", { manager: [head.id] });
  const lead = await mk(`E2E Org Lead ${stamp}`, "Associate", { manager: [vp.id, head.id] }); // second target dropped
  const ic1 = await mk(`E2E Org Alpha ${stamp}`, "Paralegal", { manager: [lead.id] });
  const ic2 = await mk(`E2E Org Beta ${stamp}`, "Paralegal", { manager: [lead.id] });
  const ids = [head.id, vp.id, lead.id, ic1.id, ic2.id];
  try {
    const got = (await api(page, `/api/admin/directory/people`)).body.people as any[];
    expect(got.find((p) => p.id === lead.id).links.manager.map((l: any) => l.id)).toEqual([vp.id]);
    expect(got.find((p) => p.id === vp.id).linked_by.manager.map((l: any) => l.id)).toEqual([lead.id]);

    // The org chart view: the head at the top, the tree folded three deep,
    // the leaf reachable by expanding, and a search that keeps the line above.
    await page.goto("/directory?view=org");
    await expect(page.getByRole("button", { name: "Org chart" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: `E2E Org Head ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Lead ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Alpha ${stamp}`, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `Expand E2E Org Lead ${stamp}'s team` }).click();
    await expect(page.getByRole("link", { name: `E2E Org Alpha ${stamp}`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Collapse all" }).click();
    await expect(page.getByRole("link", { name: `E2E Org Lead ${stamp}`, exact: true })).toHaveCount(0);
    await page.getByLabel("Search people").fill(`E2E Org Beta ${stamp}`);
    await expect(page.getByRole("link", { name: `E2E Org Beta ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Head ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Alpha ${stamp}`, exact: true })).toHaveCount(0);

    // Focus from a profile lands on the person with the path open.
    await page.goto(`/directory?view=org&focus=${ic1.id}`);
    await expect(page.getByRole("link", { name: `E2E Org Alpha ${stamp}`, exact: true })).toBeVisible();

    // The profile: the chain above, the peers, the direct reports, the links.
    await page.goto(`/directory/${lead.id}`);
    await expect(page.getByText("Reports to:")).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Head ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `E2E Org Vp ${stamp}`, exact: true })).toBeVisible();
    await expect(page.getByText("Direct reports")).toBeVisible();
    await expect(page.getByRole("link", { name: /E2E Org Alpha/ })).toBeVisible();
    await page.getByRole("link", { name: /Whole team/ }).click();
    await expect(page).toHaveURL(new RegExp(`/directory/${lead.id}/team$`));
    await expect(page.getByRole("heading", { name: /team/ })).toBeVisible();
    await expect(page.getByText("2 people across 1 level")).toBeVisible();
    await expect(page.getByRole("link", { name: /E2E Org Beta/ })).toBeVisible();

    // The team page from the top counts every level.
    await page.goto(`/directory/${head.id}/team`);
    await expect(page.getByText("4 people across 3 levels")).toBeVisible();
    await expect(page.getByText("Their reports")).toBeVisible();

    // A loop is a health finding and is broken in the chart, not followed.
    await api(page, `/api/admin/directory/people/${head.id}`, { method: "PATCH", body: { links: { manager: [ic2.id] } } });
    await page.goto("/admin/directory");
    await expect(page.getByText(/reporting line loops/)).toBeVisible();
    // The loop breaks at its lowest id — the head — so the tree below is unchanged.
    await page.goto(`/directory/${head.id}/team`);
    await expect(page.getByText("4 people across 3 levels")).toBeVisible();
    await page.goto("/directory?view=org");
    await expect(page.getByText("1 loop broken")).toBeVisible();
  } finally {
    for (const id of ids) await api(page, `/api/admin/directory/people/${id}`, { method: "DELETE" });
  }
});
