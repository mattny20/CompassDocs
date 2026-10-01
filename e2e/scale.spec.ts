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
