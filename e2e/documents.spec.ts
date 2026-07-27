import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Create → view → search: the content pipeline end to end.
test("create, read, and find a document", async ({ page }) => {
  await login(page, ADMIN);

  const spaces = await api(page, "/api/admin/spaces");
  const spaceId = spaces.body?.spaces?.[0]?.id ?? spaces.body?.[0]?.id;
  expect(spaceId).toBeTruthy();

  const created = await api(page, "/api/documents", {
    method: "POST",
    body: {
      space_id: spaceId,
      title: "E2E Canary Document",
      type: "knowledge",
      status: "published",
      content: "# Canary\n\nA distinctive xylophone-zebra phrase for search.",
      summary: "E2E canary",
      tags: ["e2e"],
    },
  });
  expect(created.status).toBe(201);
  const docId = created.body?.doc?.id ?? created.body?.document?.id;
  expect(docId).toBeTruthy();

  await page.goto(`/doc/${docId}`);
  await expect(page.locator("h1").first()).toContainText("E2E Canary Document");

  const hits = await api(page, "/api/search?q=xylophone-zebra");
  expect(hits.status).toBe(200);
  expect(JSON.stringify(hits.body)).toContain("E2E Canary Document");

  // Trash it so reruns stay clean.
  const del = await api(page, `/api/documents/${docId}`, { method: "DELETE" });
  expect([200, 204]).toContain(del.status);
});
