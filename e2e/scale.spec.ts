import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login } from "./helpers";

// The interface scales with the monitor from one root rule (1.4.1,
// STYLEGUIDE §Scaling): 16px up to a 1280px-wide viewport, 18px from 2400px,
// and back to 16px on paper. Every e2e viewport sits at or near 16px, so the
// rest of the suite proves nothing about large monitors — this file does.

const rootPx = (page: Page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

const overflow = (page: Page) =>
  page.evaluate(() => ({
    body: document.documentElement.scrollWidth - window.innerWidth,
    main: (() => {
      const m = document.querySelector("main");
      return m ? m.scrollWidth - m.clientWidth : 0;
    })(),
  }));

test("the root is 16px on a laptop, 18px on a large monitor, 16px on paper", async ({ browser }) => {
  const small = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await small.newPage();
  await login(page, ADMIN);
  expect(await rootPx(page)).toBeCloseTo(16, 1);
  await small.close();

  const large = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const big = await large.newPage();
  await login(big, ADMIN);
  expect(await rootPx(big)).toBeCloseTo(18, 1);

  // Print resets the scale so certificates and PDFs come out identical.
  await big.emulateMedia({ media: "print" });
  expect(await rootPx(big)).toBeCloseTo(16, 1);
  await big.emulateMedia({ media: "screen" });
  await large.close();
});

test("nothing scrolls sideways at 2560 and 3440 at any width preference", async ({ browser }) => {
  // 36 page loads plus the palette, at two widths: well past the default 30 s.
  test.setTimeout(300000);
  for (const width of [2560, 3440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1440 } });
    const page = await ctx.newPage();
    await login(page, ADMIN);
    for (const pref of ["normal", "wide", "full"]) {
      await page.evaluate(
        (p) =>
          fetch("/api/account/preferences", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page_width: p }),
          }),
        pref
      );
      for (const url of ["/", "/directory?view=list", "/directory", "/admin/users", "/doc/1", "/doc/1/edit"]) {
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        const o = await overflow(page);
        expect(o.body, `${url} at ${width} (${pref}) body`).toBeLessThanOrEqual(0);
        expect(o.main, `${url} at ${width} (${pref}) main`).toBeLessThanOrEqual(0);
      }
      // The palette scales with the root and must still fit.
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await page.keyboard.press("Control+k");
      await expect(page.locator('[role="dialog"][aria-label="Command palette"]')).toBeVisible();
      expect((await overflow(page)).body).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
    // Leave the account on the default.
    await page.evaluate(() =>
      fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page_width: "wide" }),
      })
    );
    await ctx.close();
  }
});

test("the Interface scale preference multiplies the root and is stamped before hydration", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  const patch = (ui_scale: string) =>
    page.evaluate(
      (v) =>
        fetch("/api/account/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ui_scale: v }),
        }).then((r) => r.status),
      ui_scale
    );
  try {
    expect(await patch("huge")).toBe(400);
    expect(await patch("large")).toBe(200);
    // The account value is applied on the next load (sync) …
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await rootPx(page)).toBeCloseTo(17.6, 1);
    // … and from then on the browser stamps it before paint: the attribute
    // is on <html> as soon as the document exists.
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-ui-scale"))).toBe("large");
    expect(await patch("compact")).toBe(200);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await rootPx(page)).toBeCloseTo(14.4, 1);
  } finally {
    expect(await patch("default")).toBe(200);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(await rootPx(page)).toBeCloseTo(16, 1);
    await ctx.close();
  }
});

test("Full is a bounded, centred page on an ultrawide", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 3440, height: 1440 } });
  const page = await ctx.newPage();
  await login(page, ADMIN);
  await page.evaluate(() =>
    fetch("/api/account/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page_width: "full" }),
    })
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => {
    const el = document.querySelector("[data-page-width]") as HTMLElement;
    const r = el.getBoundingClientRect();
    const main = document.querySelector("main")!.getBoundingClientRect();
    return { width: r.width, left: r.left - main.left, right: main.right - r.right, root: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
  // 112rem at the root size, centred (equal margins either side).
  expect(m.width).toBeCloseTo(112 * m.root, 0);
  expect(Math.abs(m.left - m.right)).toBeLessThan(2);
  await page.evaluate(() =>
    fetch("/api/account/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page_width: "wide" }),
    })
  );
  await ctx.close();
});
