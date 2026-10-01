import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// Keyboard focus is one global :focus-visible outline (1.4.4, STYLEGUIDE
// §Focus). Before it, 83 controls hid the outline and inputs drew a 1.3:1
// ring nobody could see. This proves the ring exists on a link, a button and
// an input in both themes, and that the two documented opt-outs stay bare.

async function outlineOf(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    el.focus({ focusVisible: true } as FocusOptions);
    const cs = getComputedStyle(el);
    return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, focused: document.activeElement === el };
  }, selector);
}

for (const theme of ["light", "dark"] as const) {
  test(`keyboard focus is visible in ${theme} mode`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    await login(page, ADMIN);
    await page.evaluate((t) => localStorage.setItem("compass-theme", t), theme);
    await page.goto("/admin/users");
    await page.waitForLoadState("networkidle");

    // Playwright's focus() does not always count as keyboard focus; use Tab
    // from a known starting point so :focus-visible applies.
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
    });
    expect(ring.style, `${ring.tag} after Tab`).toBe("solid");
    expect(ring.width).toBe("2px");
    // compass-600 in light, compass-300 in dark (default accent).
    expect(ring.color).toBe(theme === "light" ? "rgb(46, 117, 189)" : "rgb(130, 180, 224)");

    // Inputs: outline (offset 0) and a tinted border, no decorative ring.
    const search = page.getByPlaceholder(/Search by name/);
    await search.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const input = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    expect(input.tag).toBe("INPUT");
    expect(input.style).toBe("solid");
    expect(input.width).toBe("2px");
    expect(input.offset).toBe("0px");

    // The palette input is the documented opt-out: the panel is the frame.
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    await expect(page.locator('[role="dialog"][aria-label="Command palette"]')).toBeVisible();
    const palette = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { cls: el.className, style: getComputedStyle(el).outlineStyle };
    });
    expect(palette.cls).toContain("cmd-input");
    expect(palette.style).toBe("none");
    await ctx.close();
  });
}
