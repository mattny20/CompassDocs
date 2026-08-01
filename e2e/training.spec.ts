import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Training is entitlement-gated. CI runs the community build (no @ee, no
// license), so what CI can assert is the gate itself: every training API
// answers 402 and the page shows the licensing notice instead of leaking
// functionality. The full licensed flow is exercised on the EE rig.

test("training: entitlement gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);

  const decks = await api(page, "/api/training/decks");
  expect(decks.status).toBe(402);
  expect(String(decks.body?.error || "")).toContain("license");

  const mine = await api(page, "/api/training/my");
  expect(mine.status).toBe(402);

  const create = await api(page, "/api/training/decks", {
    method: "POST",
    body: { document_id: 1 },
  });
  expect(create.status).toBe(402);

  const act = await api(page, "/api/training/assignments/1", {
    method: "POST",
    body: { action: "confirm" },
  });
  expect(act.status).toBe(402);

  const programs = await api(page, "/api/training/programs");
  expect(programs.status).toBe(402);

  const overview = await api(page, "/api/training/overview");
  expect(overview.status).toBe(402);

  const person = await api(page, "/api/training/people/1");
  expect(person.status).toBe(402);

  const matrix = await api(page, "/api/training/matrix");
  expect(matrix.status).toBe(402);

  const snapshots = await api(page, "/api/training/snapshots");
  expect(snapshots.status).toBe(402);

  const auditPackage = await api(page, "/api/training/audit-package");
  expect(auditPackage.status).toBe(402);

  const report = await api(page, "/api/training/report");
  expect(report.status).toBe(402);

  const leads = await api(page, "/api/training/leads");
  expect(leads.status).toBe(402);

  const team = await api(page, "/api/training/team");
  expect(team.status).toBe(402);

  const programAssign = await api(page, "/api/training/programs/1", {
    method: "POST",
    body: { everyone: true },
  });
  expect(programAssign.status).toBe(402);

  await page.goto("/training");
  await expect(page.locator("h1")).toContainText("Training");
  await expect(page.locator("code", { hasText: "training" })).toBeVisible();
});
