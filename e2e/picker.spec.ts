import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// A5: the searchable picker replaces the checkbox walls. The webhook form's
// "Only for these spaces" list is the canonical case — pick through the
// combobox, drop a chip, and the fetch payload (space_ids) follows the chips.

test("the webhook form's space picker: type, pick, remove a chip, save", async ({ page }) => {
  await login(page, ADMIN);

  // Two spaces with names nothing else matches, so a partial query is unambiguous.
  const stamp = Date.now();
  const spaceIds: number[] = [];
  const names = [`E2E Picker Alpha ${stamp}`, `E2E Picker Bravo ${stamp}`];
  for (const name of names) {
    const res = await api(page, "/api/admin/spaces", {
      method: "POST",
      body: { name, description: "picker test", visibility: "internal" },
    });
    const id = res.body?.space?.id ?? res.body?.id;
    expect(id, `space "${name}" was created (${res.status})`).toBeTruthy();
    spaceIds.push(id);
  }
  const [alphaId, bravoId] = spaceIds;

  let hookId: number | undefined;
  try {
    await page.goto("/admin/notifications");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add webhook" }) });

    const combo = form.getByRole("combobox", { name: "Spaces" });
    await expect(combo).toBeVisible();
    // Enter inside the picker must not submit the form (the URL is still empty,
    // so a stray submit would have surfaced as a toast / an extra webhook).
    await combo.fill(`Picker Alpha ${stamp}`);
    await combo.press("Enter");
    await expect(form.getByRole("button", { name: `Remove ${names[0]}` })).toBeVisible();

    await combo.fill(`Picker Bravo ${stamp}`);
    await page.getByRole("option", { name: new RegExp(`Picker Bravo ${stamp}`) }).click();
    await expect(form.getByRole("button", { name: `Remove ${names[1]}` })).toBeVisible();

    // Drop Alpha; Bravo stays.
    await form.getByRole("button", { name: `Remove ${names[0]}` }).click();
    await expect(form.getByRole("button", { name: `Remove ${names[0]}` })).toHaveCount(0);
    await expect(form.getByRole("button", { name: `Remove ${names[1]}` })).toBeVisible();

    const hookName = `E2E picker hook ${stamp}`;
    await form.getByLabel("Name", { exact: true }).fill(hookName);
    await form.getByLabel(/^Webhook URL/).fill("https://example.invalid/hook");
    await form.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByText("Webhook added.")).toBeVisible();

    const list = await api(page, "/api/admin/webhooks");
    expect(list.status).toBe(200);
    const hook = (list.body?.webhooks as { id: number; name: string; space_ids: number[] }[]).find(
      (h) => h.name === hookName
    );
    expect(hook, "the webhook was created").toBeTruthy();
    hookId = hook!.id;
    expect(hook!.space_ids).toEqual([bravoId]);
    expect(hook!.space_ids).not.toContain(alphaId);
  } finally {
    if (hookId) await api(page, `/api/admin/webhooks/${hookId}`, { method: "DELETE" });
    for (const id of spaceIds) await api(page, `/api/admin/spaces/${id}`, { method: "DELETE" });
  }
});
