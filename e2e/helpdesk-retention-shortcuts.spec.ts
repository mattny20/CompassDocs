import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// 1.19.1 Helpdesk, Desk settings → Shortcuts and → Retention and privacy
// (agent V5, mock-ups #7 and #6). Licensed builds only: the API answers 402
// on the community build and the specs skip.
//
// Global state: both settings are read first and put back exactly as they
// were, in a finally. The retention rules are never saved on (the rig's
// nightly sweep would act on everyone's tickets).

async function licensed(page: Page, path: string): Promise<boolean> {
  const res = await api(page, path);
  if (res.status === 402) return false;
  expect(res.status, `the admin reads ${path}`).toBe(200);
  return true;
}

/** Network-bound expectations: the shared dev server compiles routes on first use. */
const SLOW = { timeout: 45_000 };

async function noSidewaysScroll(page: Page) {
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(ok, "no sideways page scroll").toBe(true);
}

test.describe("Helpdesk shortcuts and retention settings", () => {
  test.describe.configure({ timeout: 240_000 });
  test("Shortcuts: choose what each one opens, or Hidden", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page, "/api/helpdesk/admin/shortcuts")), "community build: the helpdesk answers 402");
    const before = (await api(page, "/api/helpdesk/admin/shortcuts")).body.shortcuts;
    try {
      await page.goto("/desk/settings/shortcuts");
      await expect(page.locator("h1")).toHaveText("Shortcuts", SLOW);
      await expect(page.getByRole("link", { name: "Shortcuts" })).toHaveAttribute("aria-current", "page");
      const rows = page.getByRole("list", { name: "Shortcuts" }).getByRole("listitem");
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toContainText("Report a problem with this page");
      await expect(rows.nth(2)).toContainText("A space's address you can't open");

      // Whatever it is now, change it (Hidden, or back to Automatic when it is Hidden).
      const target = before.link === "hidden" ? "auto" : "hidden";
      const link = page.getByRole("combobox", { name: "Report a broken link opens" });
      await link.selectOption(target);
      // Request access offers only access types (and Automatic, Hidden).
      const access = page.getByRole("combobox", { name: "Request access opens" });
      const labels = await access.locator("option").allTextContents();
      expect(labels.every((l) => l.startsWith("Automatic") || l === "Hidden" || l.includes("approved by its owner"))).toBe(true);

      await page.getByRole("button", { name: "Save shortcuts" }).click();
      await expect(page.getByText("Shortcuts saved.")).toBeVisible(SLOW);
      expect((await api(page, "/api/helpdesk/admin/shortcuts")).body.shortcuts.link).toBe(target === "auto" ? null : "hidden");
      await page.reload();
      await expect(page.getByRole("combobox", { name: "Report a broken link opens" })).toHaveValue(target, SLOW);

      // A type that can't carry a space is refused for Request access.
      const types = (await api(page, "/api/helpdesk/admin/shortcuts")).body.types as { id: number; access: boolean; active: boolean }[];
      const plain = types.find((t) => t.active && !t.access);
      if (plain) expect((await api(page, "/api/helpdesk/admin/shortcuts", { method: "PUT", body: { space_access: plain.id } })).status).toBe(400);

      await page.setViewportSize({ width: 390, height: 844 });
      await noSidewaysScroll(page);
    } finally {
      const put = await api(page, "/api/helpdesk/admin/shortcuts", { method: "PUT", body: before });
      expect(put.status).toBe(200);
    }
  });

  test("Retention and privacy: preview the next run, see the list, save", async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page, "/api/helpdesk/admin/retention")), "community build: the helpdesk answers 402");
    const before = (await api(page, "/api/helpdesk/admin/retention")).body.settings;
    try {
      await page.goto("/desk/settings/retention");
      await expect(page.locator("h1")).toHaveText("Retention and privacy", SLOW);
      const preview = page.getByTestId("retention-preview");
      const closeSwitch = page.getByRole("switch", { name: /Close solved tickets automatically/ });
      const purgeSwitch = page.getByRole("switch", { name: /Anonymise or delete old closed tickets/ });
      // Owner decision (1.19.1): both rules default to off. On the shared rig
      // they are only ever switched on unsaved; every save below has them off.
      if (!before.auto_close_enabled && !before.retention_enabled) {
        await expect(preview).toContainText("Both rules are off", SLOW);
        await expect(closeSwitch).toHaveAttribute("aria-checked", "false");
        await expect(purgeSwitch).toHaveAttribute("aria-checked", "false");
        await expect(page.getByRole("textbox", { name: "After" })).toHaveCount(0);
      }
      if (!before.auto_close_enabled) await closeSwitch.click();
      if (!before.retention_enabled) await purgeSwitch.click();
      await expect(preview).toContainText("Tonight:", SLOW);

      // The preview follows unsaved choices: the request carries them.
      const days = page.getByRole("textbox", { name: "After" });
      const previewReq = page.waitForRequest((r) => r.url().endsWith("/api/helpdesk/admin/retention/preview") && (r.postData() ?? "").includes('"auto_close_days":12'));
      await days.fill("12");
      await previewReq;
      await page.getByRole("radiogroup", { name: "Months or years" }).getByRole("radio", { name: "months" }).click();
      await expect(page.getByRole("textbox", { name: "Keep closed tickets for" })).toHaveValue(String(Math.min(240, before.keep_amount)));

      await page.getByRole("button", { name: "See the list" }).click();
      const dialog = page.getByRole("dialog", { name: "The next run" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toBeHidden();

      // Delete asks first; Cancel saves nothing.
      await page.getByRole("radiogroup", { name: "Then" }).getByRole("radio", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Delete old tickets for good?" })).toBeVisible(SLOW);
      await page.getByRole("button", { name: "Cancel" }).click();
      expect((await api(page, "/api/helpdesk/admin/retention")).body.settings.action).toBe(before.action);
      await page.getByRole("radiogroup", { name: "Then" }).getByRole("radio", { name: "Anonymise" }).click();

      // Switch both rules off again: their values are kept and saved, the rules stay off.
      await closeSwitch.click();
      await purgeSwitch.click();
      await expect(closeSwitch).toHaveAttribute("aria-checked", "false");
      await expect(preview).toContainText("Both rules are off", SLOW);
      await page.getByRole("switch", { name: /Include tickets in a person's data export/ }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Retention settings saved.")).toBeVisible(SLOW);
      const after = (await api(page, "/api/helpdesk/admin/retention")).body.settings;
      expect(after.auto_close_enabled).toBe(false);
      expect(after.retention_enabled).toBe(false);
      expect(after.auto_close_days).toBe(12);
      expect(after.keep_unit).toBe("months");
      expect(after.include_in_export).toBe(!before.include_in_export);

      // Out of range is refused by the API.
      expect((await api(page, "/api/helpdesk/admin/retention", { method: "PUT", body: { auto_close_days: 0 } })).status).toBe(400);

      await page.setViewportSize({ width: 390, height: 844 });
      await noSidewaysScroll(page);
    } finally {
      const put = await api(page, "/api/helpdesk/admin/retention", { method: "PUT", body: before });
      expect(put.status).toBe(200);
    }
  });
});
