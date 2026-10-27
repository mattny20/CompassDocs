import { test, expect, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { ADMIN, api, login } from "./helpers";

// 1.16.0: the sign-in shell (STYLEGUIDE §Sign-in surfaces) at the sizes it
// has to hold: a phone, a short dialog-sized window (the size of the Outlook
// add-in's dialog, which shows /login only through its "full sign-in page"
// link; its own /addin/outlook/auth form is not this shell), a laptop and a
// 3440 ultrawide, in both themes. Below 64rem the cover is a band in normal
// flow above the form; from 64rem it is a full-height cover beside the
// column. Nothing may sit on top of the fields or the button (the
// Card/Stage rule), and nothing may scroll sideways. The community build
// has no single sign-on, so /login is the one combined form and never asks
// /api/auth/lookup anything.

const VIEWPORTS = [
  { name: "a phone", width: 375, height: 667, cover: false },
  { name: "a dialog-sized window", width: 420, height: 560, cover: false },
  { name: "a laptop", width: 1440, height: 900, cover: true },
  { name: "an ultrawide", width: 3440, height: 1440, cover: true },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

const TARGETS = {
  identifier: 'input[autocomplete="username"]',
  password: 'input[autocomplete="current-password"]',
  submit: 'button[type="submit"]',
};

/** What the layout looks like once the page is hydrated. */
async function measure(page: Page) {
  return page.evaluate((targets) => {
    const root = document.documentElement;
    const rem = parseFloat(getComputedStyle(root).fontSize);
    const hits: Record<string, string> = {};
    for (const [name, sel] of Object.entries(targets)) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) {
        hits[name] = "missing";
        continue;
      }
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hits[name] = at && (at === el || el.contains(at)) ? "self" : at ? `${at.tagName.toLowerCase()}.${String(at.className).split(" ").slice(0, 3).join(".")}` : "nothing";
    }
    window.scrollTo(0, 0);
    const aside = document.querySelector<HTMLElement>("aside.auth-art");
    const main = document.querySelector<HTMLElement>("main");
    const a = aside?.getBoundingClientRect();
    const m = main?.getBoundingClientRect();
    return {
      theme: root.dataset.theme,
      rem,
      scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
      clientWidth: root.clientWidth,
      hits,
      aside: a ? { top: a.top, bottom: a.bottom, left: a.left, right: a.right, height: a.height } : null,
      main: m ? { top: m.top, left: m.left, right: m.right } : null,
      mainFirst: Boolean(aside && main && main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING),
      side: document.querySelector<HTMLElement>(".auth-shell")?.dataset.side ?? null,
      usernameFields: document.querySelectorAll('input[autocomplete="username"]').length,
      art: aside?.dataset.art ?? null,
    };
  }, TARGETS);
}

async function expectLayout(page: Page, vp: Viewport) {
  const m = await measure(page);
  expect(m.scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(m.clientWidth);
  expect(m.hits, "nothing covers the fields or the button").toEqual({ identifier: "self", password: "self", submit: "self" });
  expect(m.usernameFields).toBe(1);
  expect(m.mainFirst, "the form comes before the cover in the DOM").toBe(true);
  expect(m.aside, "the cover is an aside while it carries the name").not.toBeNull();
  const tall = m.aside!.height > 30 * m.rem;
  expect(tall, `cover ${m.aside!.height}px against 30rem = ${30 * m.rem}px`).toBe(vp.cover);
  if (vp.cover) {
    // Split: the cover at full height on the admin's side (the left by
    // default), the form beside it.
    expect(m.aside!.height).toBeCloseTo(vp.height, 0);
    if (m.side === "end") {
      expect(m.aside!.right).toBeCloseTo(m.clientWidth, 0);
      expect(m.main!.right).toBeLessThanOrEqual(m.aside!.left + 1);
    } else {
      expect(m.aside!.left).toBe(0);
      expect(m.main!.left).toBeGreaterThanOrEqual(m.aside!.right - 1);
    }
  } else {
    // Band: in normal flow above the form, never over it.
    expect(m.aside!.top).toBe(0);
    expect(m.main!.top).toBeGreaterThanOrEqual(m.aside!.bottom - 1);
  }
  return m;
}

async function openLogin(browser: Browser, vp: Viewport, colorScheme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme });
  const page = await ctx.newPage();
  const lookups: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/auth/lookup")) lookups.push(r.url());
  });
  await page.goto("/login");
  // Hydrated (the submit is server-rendered disabled until then), fonts in.
  await expect(page.locator(TARGETS.submit)).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, lookups };
}

for (const theme of ["light", "dark"] as const) {
  for (const vp of VIEWPORTS) {
    test(`sign-in at ${vp.width}×${vp.height} (${vp.name}), ${theme}: nothing over the form, no sideways scroll`, async ({ browser }) => {
      const { ctx, page, lookups } = await openLogin(browser, vp, theme);
      try {
        await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
        await expect(page.getByText(/^to continue to /)).toBeVisible();
        const m = await expectLayout(page, vp);
        expect(m.theme).toBe(theme);
        // The default art on a fresh database; the checks above hold over a photo too.
        expect(["default", "photo"]).toContain(m.art);
        // The community build: the combined form, no identifier lookup.
        await expect(page.locator('button[type="submit"]')).toHaveText("Sign in");
        expect(lookups).toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }
}

test("print leaves the cover out and the column carries the workspace name", async ({ browser }) => {
  const { ctx, page } = await openLogin(browser, VIEWPORTS[2]);
  try {
    const cover = page.locator("aside.auth-art");
    const company = ((await cover.getAttribute("aria-label")) ?? "").replace(/^About /, "");
    expect(company).not.toBe("");
    // The subtitle reads "to continue to …", so only the lockup is the name alone.
    const lockup = page.locator("main").getByText(company, { exact: true });
    await expect(lockup, "on screen the cover carries the name").toBeHidden();
    await page.emulateMedia({ media: "print" });
    await expect(cover).toBeHidden();
    await expect(lockup).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("an uploaded photo is served by srcset at 1440 and 375, and the form stays on top", async ({ browser }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await login(adminPage, ADMIN);
  // The removal in finally cannot put back artwork that was already set, so
  // a workspace that has some (a shared database, not CI's) is left alone.
  const existing = (await adminPage.request.get("/api/brand/artwork?w=960")).status();
  if (existing !== 404) await admin.close();
  test.skip(existing !== 404, "sign-in artwork is already set here; this test would delete it");
  // A white picture: the worst case for white text, which only the scrim keeps readable.
  const png = await sharp({ create: { width: 2600, height: 1600, channels: 3, background: "#ffffff" } }).png().toBuffer();
  try {
    const res = await adminPage.request.post("/api/admin/branding/artwork", {
      multipart: { file: { name: "white.png", mimeType: "image/png", buffer: png } },
    });
    expect(res.status(), await res.text()).toBe(200);
    const uploaded = (await res.json()) as { version: string; width: number; height: number };
    expect(uploaded).toMatchObject({ width: 2600, height: 1600 });
    expect(uploaded.version).toMatch(/^[a-f0-9]{12}$/);

    for (const vp of [VIEWPORTS[2], VIEWPORTS[0]]) {
      const { ctx, page } = await openLogin(browser, vp);
      try {
        const img = page.locator('img[srcset*="/api/brand/artwork"]');
        await expect(img).toHaveCount(1);
        await expect(img).toHaveAttribute("srcset", new RegExp(`w=2560&v=${uploaded.version} 2560w`));
        await expect(img).toHaveAttribute("alt", "");
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
        const m = await expectLayout(page, vp);
        expect(m.art).toBe("photo");
        // Text over a photo sits on its own scrim.
        const scrim = await page.locator(".auth-art-top").evaluate((el) => getComputedStyle(el, "::before").content);
        expect(scrim).not.toBe("none");
      } finally {
        await ctx.close();
      }
    }
  } finally {
    const removed = await adminPage.request.delete("/api/admin/branding/artwork");
    expect(removed.status()).toBe(200);
    await admin.close();
  }

  // Removed: the default art again, and the files are gone.
  const { ctx, page } = await openLogin(browser, VIEWPORTS[2]);
  try {
    await expect(page.locator('img[srcset*="/api/brand/artwork"]')).toHaveCount(0);
    await expect(page.locator("aside.auth-art")).toHaveAttribute("data-art", "default");
    expect((await page.request.get("/api/brand/artwork?w=1600")).status()).toBe(404);
  } finally {
    await ctx.close();
  }
});

test("Sign-in page settings: the preview stays beside the fields at Wide, and nothing scrolls sideways on a phone", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await login(page, ADMIN);
    // Wide is the default page width; other specs put it back after changing it.
    await api(page, "/api/account/preferences", { method: "PATCH", body: { page_width: "wide" } });
    await page.goto("/admin/workspace/sign-in");
    const frame = page.locator('iframe[src*="/login/preview"]');
    const headline = page.getByLabel("Headline (optional)");
    await expect(frame).toBeVisible();

    // While the headline is typed, the live preview is in view beside it.
    await headline.scrollIntoViewIfNeeded();
    await expect(headline).toBeInViewport();
    await expect(frame).toBeInViewport();
    const [f, h] = await Promise.all([frame.boundingBox(), headline.boundingBox()]);
    expect(f!.x, "the preview sits beside the fields, not above them").toBeGreaterThan(h!.x + h!.width);
    // Sticky: still in view at the last field of the page.
    const helpLink = page.getByLabel("Help link (optional)");
    await helpLink.scrollIntoViewIfNeeded();
    await expect(helpLink).toBeInViewport();
    await expect(frame).toBeInViewport();

    // A phone: one column, the Preview size options wrap inside their card.
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      await expect(frame).toBeVisible();
      const m = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const group = document.querySelector('[role="radiogroup"][aria-label="Preview size"]')!;
        const card = group.closest("section")!;
        return {
          scrollWidth: main.scrollWidth,
          clientWidth: main.clientWidth,
          group: group.getBoundingClientRect().right,
          card: card.getBoundingClientRect().right,
        };
      });
      expect(m.scrollWidth, `no sideways scroll at ${width}`).toBeLessThanOrEqual(m.clientWidth);
      expect(m.group, `Preview size stays inside its card at ${width}`).toBeLessThanOrEqual(m.card);
    }
  } finally {
    await ctx.close();
  }
});
