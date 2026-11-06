import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// 1.17.0: the sign-in page's quick links (STYLEGUIDE §Sign-in surfaces, the
// one exception to the Card/Stage rule). An admin puts a link on the sign-in
// page in Settings → Links ("Sign-in page"); only a link everyone can see may
// be there, so a group-restricted link is refused and never appears, and a
// link restricted later loses its place. On /login the links are buttons the
// height of the logo tile in a bar across the top of the cover from 64rem
// (1.18.1), right-aligned and level with the tile, and a strip along the top
// of the band below it, after the form in DOM and tab order, never in print.
// A click before anyone signs in is counted with no user, through the
// same-origin beacon, while the href stays the link's own address.

const STAMP = `e2e-sil-${Date.now()}`;
const TARGET = `https://example.com/${STAMP}`;

let adminPage: Page;
let shownId = 0;
let restrictedId = 0;
let laterId = 0;
let groupId = 0;

async function makeLink(page: Page, title: string, url: string, groupIds: number[] = []): Promise<number> {
  const made = await api(page, "/api/admin/links", { method: "POST", body: { title, url, icon_type: "brand", group_ids: groupIds } });
  expect(made.status, `${title} created`).toBe(200);
  const id = made.body?.link?.id;
  expect(id, `${title} id`).toBeTruthy();
  return id;
}

async function clicksOn(page: Page, id: number): Promise<number> {
  const res = await api(page, "/api/admin/links");
  expect(res.status).toBe(200);
  return res.body.links.find((l: { id: number }) => l.id === id)?.clicks ?? -1;
}

/** A signed-out page at a size, with the link's real address answered locally. */
async function signedOut(browser: Browser, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Elsewhere</title>ok" }));
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  return { ctx, page };
}

test.beforeAll(async ({ browser }) => {
  adminPage = await browser.newPage();
  await login(adminPage, ADMIN);

  // Shown: unrestricted, flagged, and first by position so it is inside the
  // eight whatever else the workspace has on its sign-in page.
  shownId = await makeLink(adminPage, `${STAMP} Help desk`, TARGET);
  const flag = await api(adminPage, `/api/admin/links/${shownId}`, { method: "PATCH", body: { signin: true, position: -1000 } });
  expect(flag.status).toBe(200);
  expect(flag.body.link.signin).toBeTruthy();

  const group = await api(adminPage, "/api/admin/groups", { method: "POST", body: { name: `${STAMP} group` } });
  expect(group.status).toBe(201);
  groupId = group.body.group.id;

  // Restricted from the start: the server refuses the flag.
  restrictedId = await makeLink(adminPage, `${STAMP} Restricted`, `${TARGET}/restricted`, [groupId]);
  const refused = await api(adminPage, `/api/admin/links/${restrictedId}`, { method: "PATCH", body: { signin: true } });
  expect(refused.status).toBe(400);

  // Flagged, then restricted: the same save takes it off the sign-in page.
  laterId = await makeLink(adminPage, `${STAMP} Later restricted`, `${TARGET}/later`);
  expect((await api(adminPage, `/api/admin/links/${laterId}`, { method: "PATCH", body: { signin: true } })).status).toBe(200);
  const restricted = await api(adminPage, `/api/admin/links/${laterId}`, { method: "PATCH", body: { group_ids: [groupId] } });
  expect(restricted.status).toBe(200);
  expect(restricted.body.link.signin).toBeFalsy();
});

test.afterAll(async () => {
  for (const id of [shownId, restrictedId, laterId]) if (id) await api(adminPage, `/api/admin/links/${id}`, { method: "DELETE" });
  if (groupId) await api(adminPage, `/api/admin/groups/${groupId}`, { method: "DELETE" });
  await adminPage.close();
});

test("a flagged link is on /login, opens in a new tab at its own address, and restricted links never are", async ({ browser }) => {
  const { ctx, page } = await signedOut(browser, 1440, 900);
  const nav = page.getByRole("navigation", { name: "Quick links" });
  await expect(nav).toBeVisible();
  const link = nav.getByRole("link", { name: new RegExp(`${STAMP} Help desk`) });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", TARGET);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByText(`${STAMP} Restricted`)).toHaveCount(0);
  await expect(page.getByText(`${STAMP} Later restricted`)).toHaveCount(0);
  expect(await nav.getByRole("link").count()).toBeLessThanOrEqual(8);

  // The form stays first: <main> precedes the bar in the DOM, and the bar
  // lives in the cover.
  const order = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const bar = document.querySelector('nav[aria-label="Quick links"]')!;
    return {
      after: Boolean(main.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING),
      inCover: Boolean(bar.closest(".auth-art")),
    };
  });
  expect(order).toEqual({ after: true, inCover: true });
  await ctx.close();
});

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** The cover, the lockup, the bar and each link, and what is under each link's middle. */
async function measureLinks(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Quick links"]')!;
    const navBox = box(nav)!;
    const links = [...nav.querySelectorAll<HTMLElement>("a")].map((a) => {
      const r = box(a)!;
      // Only a link wholly inside the scroller's view can be hit-tested.
      const inView = r.left >= navBox.left - 0.5 && r.right <= navBox.right + 0.5;
      const at = inView ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return { ...r, inView, hit: inView ? Boolean(at && a.contains(at)) : null, under: at && !a.contains(at) ? `${at.tagName}.${at.className}` : "" };
    });
    const tile = document.querySelector(".auth-art-tile");
    const tileBox = box(tile);
    const tileAt = tileBox ? document.elementFromPoint(tileBox.left + tileBox.width / 2, tileBox.top + tileBox.height / 2) : null;
    return {
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      art: box(document.querySelector(".auth-art"))!,
      tile: tileBox,
      tileClear: Boolean(tile && tileAt && tile.contains(tileAt)),
      top: box(document.querySelector(".auth-art-top")),
      foot: box(document.querySelector(".auth-art-foot")),
      main: box(document.querySelector("main"))!,
      field: box(document.querySelector('input[autocomplete="username"]'))!,
      nav: navBox,
      navOverflowX: getComputedStyle(nav).overflowX,
      navScrolls: nav.scrollWidth > nav.clientWidth + 1,
      links,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

/** Two boxes share some area. */
function overlaps(a: Box, b: Box) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** The checks every wide cover holds, whatever the links' number and length. */
function expectTopBar(m: Awaited<ReturnType<typeof measureLinks>>) {
  const { art, tile, top, foot, main, nav, links } = m;
  expect(tile, "the cover carries the logo tile").not.toBeNull();
  // In the cover, never over the column.
  expect(nav.left).toBeGreaterThanOrEqual(art.left - 1);
  expect(nav.right).toBeLessThanOrEqual(art.right + 1);
  expect(nav.right <= main.left + 1 || nav.left >= main.right - 1).toBe(true);
  // At the top, level with the tile, and the buttons are the tile's height.
  expect(nav.top).toBeLessThan(art.top + art.height * 0.2);
  for (const l of links) {
    expect(Math.abs(l.height - tile!.height), `a button is ${l.height}px against the ${tile!.height}px tile`).toBeLessThanOrEqual(1);
    expect(Math.abs(l.top - tile!.top), "one row, level with the tile").toBeLessThanOrEqual(1);
    // Never over the lockup or the words.
    expect(overlaps(l, top!), "a link over the lockup").toBe(false);
    if (foot && foot.height) expect(l.bottom).toBeLessThanOrEqual(foot.top);
    // Nothing takes its clicks.
    if (l.inView) expect(l.hit, `a link is under ${l.under}`).toBe(true);
  }
  // The scroller starts right of the lockup, and the tile is never covered.
  expect(nav.left).toBeGreaterThanOrEqual(top!.right - 1);
  expect(m.tileClear, "nothing over the logo tile").toBe(true);
  expect(links.filter((l) => l.inView).length).toBeGreaterThan(0);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
}

test("from 64rem the links are buttons in a bar across the top of the cover, level with the logo and right-aligned", async ({ browser }) => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [1024, 600],
  ]) {
    const { ctx, page } = await signedOut(browser, width, height);
    await expect(page.getByRole("navigation", { name: "Quick links" })).toBeVisible();
    const m = await measureLinks(page);
    expectTopBar(m);
    // Right-aligned, inset by the cover's padding (the tile's own inset),
    // when the row fits; a longer row scrolls instead.
    const pad = m.tile!.left - m.art.left;
    if (!m.navScrolls) {
      const last = m.links[m.links.length - 1];
      expect(Math.abs(m.art.right - pad - last.right), `the row ends ${pad}px in from the edge`).toBeLessThanOrEqual(1);
    }
    // The middle of the cover is clear: the bar ends well above it.
    expect(m.nav.bottom).toBeLessThan(m.art.top + m.art.height / 2);
    // No caption on screen; the nav carries the name.
    await expect(page.locator(".auth-links-label")).toHaveCount(0);
    await ctx.close();
  }
});

test("on a phone the links are a strip along the top of the band, over the lockup and above the form", async ({ browser }) => {
  for (const [width, height] of [
    [390, 844],
    [375, 667],
    [768, 1024],
  ]) {
    const { ctx, page } = await signedOut(browser, width, height);
    await expect(page.getByRole("navigation", { name: "Quick links" })).toBeVisible();
    const m = await measureLinks(page);
    expect(Math.abs(m.nav.top - m.art.top)).toBeLessThanOrEqual(1);
    expect(Math.round(m.nav.width)).toBe(Math.round(m.art.width));
    // The lockup sits under the strip, inside the band.
    expect(m.top!.top).toBeGreaterThanOrEqual(m.nav.bottom - 1);
    expect(m.top!.bottom).toBeLessThanOrEqual(m.art.bottom + 1);
    expect(m.field.top).toBeGreaterThanOrEqual(m.art.bottom);
    expect(m.navOverflowX).toBe("auto");
    for (const l of m.links) {
      expect(Math.abs(l.height - 2.25 * m.rem)).toBeLessThanOrEqual(1);
      if (l.inView) expect(l.hit, `a link is under ${l.under}`).toBe(true);
    }
    // The strip scrolls itself; the page never scrolls sideways.
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    await ctx.close();
  }
});

test("no sideways page scroll at 375, 768, 1024 and 1440", async ({ browser }) => {
  for (const [width, height] of [
    [375, 667],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ]) {
    const { ctx, page } = await signedOut(browser, width, height);
    await expect(page.getByRole("navigation", { name: "Quick links" })).toBeVisible();
    const m = await measureLinks(page);
    expect(m.scrollWidth, `no sideways scroll at ${width}`).toBeLessThanOrEqual(m.clientWidth);
    await ctx.close();
  }
});

test("eight links with long titles stay in one row that scrolls, clear of the logo", async ({ browser }) => {
  const extra: number[] = [];
  try {
    for (let i = 0; i < 7; i++) {
      const id = await makeLink(adminPage, `${STAMP} A rather long link title for the employee portal ${i + 1}`, `${TARGET}/long-${i}`);
      const flag = await api(adminPage, `/api/admin/links/${id}`, { method: "PATCH", body: { signin: true, position: -999 + i } });
      expect(flag.status).toBe(200);
      extra.push(id);
    }
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      const { ctx, page } = await signedOut(browser, width, height);
      const nav = page.getByRole("navigation", { name: "Quick links" });
      await expect(nav.getByRole("link")).toHaveCount(8);
      const m = await measureLinks(page);
      if (width >= 1024) expectTopBar(m);
      // One row that scrolls sideways, inside the cover.
      expect(m.navScrolls).toBe(true);
      expect(new Set(m.links.map((l) => Math.round(l.top))).size).toBe(1);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
      // The last link is reachable, and clickable once scrolled to.
      const last = nav.getByRole("link").last();
      await last.scrollIntoViewIfNeeded();
      const hit = await last.evaluate((a) => {
        const r = a.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(at && a.contains(at));
      });
      expect(hit, `the last link is clickable at ${width}`).toBe(true);
      if (width >= 1024) expect((await measureLinks(page)).tileClear).toBe(true);
      await ctx.close();
    }
  } finally {
    for (const id of extra) await api(adminPage, `/api/admin/links/${id}`, { method: "DELETE" });
  }
});

test("nothing of the bar prints", async ({ browser }) => {
  const { ctx, page } = await signedOut(browser, 1440, 900);
  await expect(page.getByRole("navigation", { name: "Quick links" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".auth-links")).toBeHidden();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  await ctx.close();
});

// The admin API exposes the count only, not who clicked: that the click is
// stored with no user is test/quick-links.test.ts's ("without a session,
// only a sign-in page link is recorded (with no user)").
test("a click before sign-in goes through the beacon and is counted", async ({ browser }) => {
  const before = await clicksOn(adminPage, shownId);
  expect(before).toBe(0);

  const { ctx, page } = await signedOut(browser, 1440, 900);
  const beacon = page.waitForResponse((r) => r.url().endsWith(`/api/links/${shownId}/click`) && r.request().method() === "POST");
  const popup = page.waitForEvent("popup");
  await page.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: new RegExp(`${STAMP} Help desk`) }).click();
  expect((await beacon).status()).toBe(204);
  const opened = await popup;
  expect(opened.url()).toBe(TARGET);
  await ctx.close();

  // The one click, from a page with no session, is on the admin's count.
  await expect.poll(() => clicksOn(adminPage, shownId)).toBe(1);
});

test("a click on a link that is not on the sign-in page is refused before sign-in", async ({ browser }) => {
  const { ctx, page } = await signedOut(browser, 1440, 900);
  const status = await page.evaluate(async (id) => (await fetch(`/api/links/${id}/click`, { method: "POST" })).status, laterId);
  expect(status).toBe(401);
  await ctx.close();
  expect(await clicksOn(adminPage, laterId)).toBe(0);
});
