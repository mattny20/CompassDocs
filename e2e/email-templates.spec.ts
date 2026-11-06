import { test, expect } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Composable email templates (1.19.0): Settings → Notifications → Email
// templates. An admin makes a header in the Headers library, builds the
// "Content review due" email from it in the composer (the live preview
// follows the pickers), saves, and finds the template marked Customized.
// The header then cannot be deleted while the template uses it: the
// button is disabled with the reason beside it and the route refuses with
// the list. By default (no choice made) the email carries the Standard
// header and footer.

const EVENT = "review_due";

test("an admin composes an email from parts and a part in use cannot be deleted", async ({ page }) => {
  await login(page, ADMIN);
  const name = `E2E header ${Date.now()}`;
  let partId = 0;
  try {
    // 1. A new header, from the Headers tab.
    await page.goto("/admin/notifications/templates/headers");
    const libs = page.getByRole("navigation", { name: "Email template libraries" });
    await expect(libs.getByRole("link", { name: "Headers" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "New header" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill(name);
    const content = page.getByRole("textbox", { name: "Content" });
    await content.fill("**E2E banner** for ");
    await page.getByRole("combobox", { name: "Insert tag" }).selectOption("org_name");
    await expect(content).toHaveValue("**E2E banner** for {{org_name}}");
    await page.getByRole("button", { name: "Create header" }).click();
    await expect(page.getByText("Header created.")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/headers\?part=\d+/);
    partId = Number(new URL(page.url()).searchParams.get("part"));
    expect(partId).toBeGreaterThan(0);
    // The draft preview already shows it inside an email.
    const libPreview = page.frameLocator(`iframe[title="Preview of ${name}"]`);
    await expect(libPreview.locator("body")).toContainText("E2E banner", { timeout: 20_000 });

    // 2. The composer: choose it, watch the preview, save.
    await page.goto(`/admin/notifications/templates/event/${EVENT}`);
    await expect(page.getByRole("heading", { level: 2, name: "Content review due" })).toBeVisible();
    const preview = page.frameLocator('iframe[title="Preview of Content review due"]');
    // Every email is branded by default: the Standard footer's manage link is there.
    await expect(preview.locator("body")).toContainText("Manage your notifications", { timeout: 20_000 });
    await expect(page.getByRole("combobox", { name: "Header" })).toHaveValue("");
    await expect(page.getByRole("combobox", { name: "Header" }).locator("option").first()).toHaveText("Use workspace default");
    await expect(page.getByText("Workspace default: Standard header")).toBeVisible();
    await expect(preview.locator("body")).not.toContainText("E2E banner");
    await expect(page.getByTestId("email-preview-subject")).not.toHaveText("…");
    const header = page.getByRole("combobox", { name: "Header" });
    await header.selectOption({ label: name });
    await expect(preview.locator("body")).toContainText("E2E banner", { timeout: 20_000 });
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("Template saved.")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Header" })).toHaveValue(String(partId));

    // 3. The Templates tab shows the parts and the Customized marker.
    await page.goto("/admin/notifications/templates");
    const row = page.getByTestId(`template-row-${EVENT}`);
    await expect(row).toContainText(name);
    await expect(row).toContainText("Customized");

    // 4. In use: Delete is disabled with the reason, and the route refuses.
    await page.goto(`/admin/notifications/templates/headers?part=${partId}`);
    const used = page.getByRole("button", { name: "Used by 1 template", exact: true });
    await used.click();
    await expect(page.getByRole("dialog", { name: `Templates that use ${name}` }).getByRole("link", { name: "Content review due" })).toHaveAttribute(
      "href",
      `/admin/notifications/templates/event/${EVENT}`
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await expect(page.getByTestId("delete-reason")).toHaveText(/Used by 1 template\. Choose another header/);
    const refused = await api(page, `/api/admin/email-templates/parts/${partId}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(refused.body.used_by.map((u: { event_key: string }) => u.event_key)).toContain(EVENT);
  } finally {
    // Leave the shared database as it was: the email follows the default again, the header goes.
    await api(page, `/api/admin/email-templates/compositions/${EVENT}`, {
      method: "PUT",
      body: { scope: "all", header_id: null },
    });
    if (partId) {
      const gone = await api(page, `/api/admin/email-templates/parts/${partId}`, { method: "DELETE" });
      expect(gone.status).toBe(200);
    }
  }
});
