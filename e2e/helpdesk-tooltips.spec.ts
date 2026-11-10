import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// data-tt tooltips stay on screen (1.20.2, components/TooltipPlacer): the
// buttons at the top of the ticket pane (Status, Follow, Solve, More) sit
// right under the pane's top edge, where a bubble above them was cut off.
// A bubble with no room above opens below, and one near a side edge slides
// back inside. Checked on the ticket pane, the queue's header, the desk's
// top bar, a settings page header and two of the main app's pages.

/** Where the control's bubble is, and the box it can be seen in (the viewport cut down by every clipping ancestor). */
async function bubble(el: Locator) {
  return el.evaluate((node) => {
    const e = node as HTMLElement;
    const cs = getComputedStyle(e, "::after");
    const r = e.getBoundingClientRect();
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    const m = new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform);
    const left = r.left + parseFloat(cs.left) + m.e;
    const top = r.top + parseFloat(cs.top) + m.f;
    const box = { top: 0, left: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) continue;
      const q = p.getBoundingClientRect();
      box.top = Math.max(box.top, q.top);
      box.left = Math.max(box.left, q.left);
      box.right = Math.min(box.right, q.right);
      box.bottom = Math.min(box.bottom, q.bottom);
    }
    return { label: e.getAttribute("data-tt") ?? "", shown: cs.visibility === "visible", top, bottom: top + h, left, right: left + w, box, pos: e.getAttribute("data-tt-pos"), auto: e.getAttribute("data-tt-auto") };
  });
}

/** Hover every tooltip control near the top of `scope` and expect its bubble wholly inside what can be seen. */
async function expectTopTooltipsInside(page: Page, scope: Locator, where: string, maxY = 170): Promise<string[]> {
  const seen: string[] = [];
  const all = scope.locator("[data-tt]:not([data-tt-pos='right'])");
  const n = Math.min(await all.count(), 60);
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const r = await el.boundingBox().catch(() => null);
    if (!r || r.width === 0 || r.y > maxY || r.y < 0) continue;
    if ((await el.getAttribute("aria-expanded")) === "true") continue;
    await el.hover({ timeout: 5_000 }).catch(() => null);
    await page.waitForTimeout(500);
    const b = await bubble(el);
    if (!b.shown || !b.label) continue;
    seen.push(b.label);
    const msg = `${where}: "${b.label}" ${JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), box: b.box })}`;
    expect(b.top, msg).toBeGreaterThanOrEqual(b.box.top - 0.5);
    expect(b.bottom, msg).toBeLessThanOrEqual(b.box.bottom + 0.5);
    expect(b.left, msg).toBeGreaterThanOrEqual(b.box.left - 0.5);
    expect(b.right, msg).toBeLessThanOrEqual(b.box.right + 0.5);
  }
  await page.mouse.move(0, 0);
  return seen;
}

test.describe("tooltips stay on screen", () => {
  let number = 0;

  test("the ticket pane's Status, Follow, Solve and More, the queue header and the top bar", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    const lic = await api(page, "/api/helpdesk/admin/settings");
    test.skip(lic.status === 402, "helpdesk is not licensed in this build; the EE rig runs the flow");
    const made = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `E2E tooltips ${Date.now()}`, body: "Where do the tooltips go?", team_id: null } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    number = made.body.ticket.number;
    try {
      await page.goto(`/desk/tickets/${number}?view=open`);
      const pane = page.locator("article").first();
      await expect(pane.getByRole("button", { name: /^Solve/ })).toBeVisible({ timeout: 120_000 });
      // The row with Status, Follow, Solve and More: every tooltip in it is whole, inside the pane.
      const seen = await expectTopTooltipsInside(page, pane, "ticket pane");
      expect(seen).toEqual(expect.arrayContaining(["Status", "More"]));
      // They opened below: there is no room above them under the pane's top edge.
      const more = pane.locator('[data-tt="More"]').first();
      await more.hover();
      await page.waitForTimeout(500);
      const b = await bubble(more);
      expect(b.auto).toBe("bottom");
      expect(b.top).toBeGreaterThan((await more.boundingBox())!.y);
      // An explicit position still wins over the automatic one.
      await more.evaluate((e) => e.setAttribute("data-tt-pos", "bottom"));
      await page.mouse.move(0, 0);
      await more.hover();
      await page.waitForTimeout(400);
      expect((await bubble(more)).top).toBeGreaterThan((await more.boundingBox())!.y);
      await more.evaluate((e) => e.removeAttribute("data-tt-pos"));

      // The queue's header (filter, sort, new) and the desk's top bar.
      await expectTopTooltipsInside(page, page.locator("body"), "desk queue and top bar", 110);
      // A phone: nothing crosses the right edge.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/desk/tickets/${number}`);
      await expect(page.locator("article").first().getByRole("button", { name: /^Solve/ })).toBeVisible({ timeout: 120_000 });
      await expectTopTooltipsInside(page, page.locator("body"), "ticket at 390", 260);
      await page.setViewportSize({ width: 1440, height: 900 });
    } finally {
      await api(page, `/api/helpdesk/tickets/${number}`, { method: "DELETE" });
    }
  });

  test("settings page headers and the main app's page headers", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    for (const path of ["/", "/admin/users", "/admin/spaces"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 120_000 });
      await expectTopTooltipsInside(page, page.locator("body"), path, 200);
    }
    const lic = await api(page, "/api/helpdesk/admin/settings");
    if (lic.status === 402) return;
    for (const path of ["/desk/settings/email", "/desk/settings/integrations"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 120_000 });
      await expectTopTooltipsInside(page, page.locator("body"), path, 200);
    }
  });
});
