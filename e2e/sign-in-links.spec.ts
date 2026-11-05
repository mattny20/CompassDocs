import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// 1.17.0: the sign-in page's quick links (STYLEGUIDE §Sign-in surfaces, the
// one exception to the Card/Stage rule). An admin puts a link on the sign-in
// page in Settings → Links ("Sign-in page"); only a link everyone can see may
// be there, so a group-restricted link is refused and never appears, and a
// link restricted later loses its place. On /login the links are a bar across
// the middle of the cover from 64rem and a strip along the bottom of the band
// below it, after the form in DOM and tab order, never in print. A click
// before anyone signs in is counted with no user, through the same-origin
// beacon, while the href stays the link's own address.

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

test("from 64rem the bar crosses the middle of the cover, clear of the lockup and the words", async ({ browser }) => {
  for (const [width, height] of [
    [1440, 900],
    [1024, 600],
  ]) {
    const { ctx, page } = await signedOut(browser, width, height);
    const box = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
      return {
        art: r(".auth-art"),
        bar: r('nav[aria-label="Quick links"]'),
        top: r(".auth-art-top"),
        foot: r(".auth-art-foot"),
        main: r("main"),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    const { art, bar, top, foot, main } = box;
    expect(art && bar && main).toBeTruthy();
    // Inside the cover, never over the column.
    expect(bar!.left).toBeGreaterThanOrEqual(art!.left);
    expect(bar!.right).toBeLessThanOrEqual(art!.right);
    expect(bar!.right <= main!.left || bar!.left >= main!.right).toBe(true);
    // Never over the lockup or the headline block.
    if (top && top.height) expect(bar!.top).toBeGreaterThanOrEqual(top.bottom);
    if (foot && foot.height) expect(bar!.bottom).toBeLessThanOrEqual(foot.top);
    // In the middle when there is room (the laptop).
    if (height >= 900) {
      const mid = (bar!.top + bar!.bottom) / 2;
      expect(Math.abs(mid - (art!.top + art!.bottom) / 2)).toBeLessThan(art!.height * 0.1);
    }
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(page.locator(".auth-links-label")).toHaveText(/quick links/i);
    await ctx.close();
  }
});

test("on a phone the links are a strip along the bottom of the band, above the form", async ({ browser }) => {
  const { ctx, page } = await signedOut(browser, 390, 844);
  const nav = page.getByRole("navigation", { name: "Quick links" });
  await expect(nav).toBeVisible();
  const box = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const bar = document.querySelector<HTMLElement>('nav[aria-label="Quick links"]')!;
    return {
      art: r(".auth-art"),
      bar: r('nav[aria-label="Quick links"]'),
      top: r(".auth-art-top"),
      field: r('input[autocomplete="username"]'),
      overflowX: getComputedStyle(bar).overflowX,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  expect(Math.abs(box.bar.bottom - box.art.bottom)).toBeLessThanOrEqual(1);
  expect(Math.round(box.bar.width)).toBe(Math.round(box.art.width));
  expect(box.bar.top).toBeGreaterThanOrEqual(box.top.bottom);
  expect(box.field.top).toBeGreaterThanOrEqual(box.art.bottom);
  expect(box.overflowX).toBe("auto");
  // The strip scrolls itself; the page never scrolls sideways.
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  await expect(page.locator(".auth-links-label")).toBeHidden();
  await ctx.close();
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
