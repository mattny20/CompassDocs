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

  const programAssign = await api(page, "/api/training/programs/1", {
    method: "POST",
    body: { everyone: true },
  });
  expect(programAssign.status).toBe(402);

  await page.goto("/training");
  await expect(page.locator("h1")).toContainText("Training");
  await expect(page.locator("code", { hasText: "training" })).toBeVisible();
});
