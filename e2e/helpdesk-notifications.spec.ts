import { test, expect, type Page } from "@playwright/test";
import { createECDH, randomBytes } from "node:crypto";
import { ADMIN, api, login } from "./helpers";

// The desk as a web app and its notifications (Helpdesk 1.19.0, agent F).
//
// Unlicensed builds still serve the desk's manifest, icons, service worker
// and offline page (they are static); everything behind the desk itself
// answers 402 there, so the licensed tests skip themselves and the EE rig
// runs them. The browser's push service is not reachable from CI, so the
// round-trip replaces PushManager.subscribe with a subscription carrying
// real P-256 keys on an FCM-shaped endpoint: the page, the API and the
// database are the real ones.

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/push/vapid");
  if (res.status === 402) return false;
  expect(res.status, "the admin is a helpdesk agent").toBe(200);
  return true;
}

test.describe("desk web app", () => {
  test("the manifest, icons, service worker and offline page are served", async ({ request }) => {
    const manifest = await request.get("/desk.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const m = await manifest.json();
    expect(m).toMatchObject({ name: "CompassDocs Desk", short_name: "Desk", scope: "/desk", display: "standalone" });
    expect(m.start_url.startsWith("/desk")).toBeTruthy();
    const purposes = m.icons.map((i: { purpose?: string }) => i.purpose);
    expect(purposes).toContain("maskable");
    for (const icon of [...m.icons.map((i: { src: string }) => i.src), "/desk-apple-touch-icon.png", "/desk-badge-96.png"]) {
      const res = await request.get(icon);
      expect(res.ok(), icon).toBeTruthy();
      expect(res.headers()["content-type"]).toContain("image/png");
    }
    const sw = await request.get("/desk-sw.js");
    expect(sw.ok()).toBeTruthy();
    expect(sw.headers()["content-type"]).toMatch(/javascript/);
    const body = await sw.text();
    expect(body).toContain('addEventListener("push"');
    expect(body).toContain('addEventListener("notificationclick"');
    expect((await request.get("/desk-offline.html")).ok()).toBeTruthy();
  });
});

test.describe("desk notifications", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test("the settings page renders and a switch persists", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await page.goto("/desk/settings/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What reaches you where" })).toBeVisible();

    const box = page.getByRole("checkbox", { name: "Reopened by email" });
    const was = await box.isChecked();
    const saved = page.waitForResponse((r) => r.url().includes("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT");
    await box.click();
    expect((await saved).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Reopened by email" })).toBeChecked({ checked: !was });

    // Quiet hours and preview persist too.
    const quiet = page.getByRole("switch", { name: "Use quiet hours" });
    const quietWas = (await quiet.getAttribute("aria-checked")) === "true";
    // Each change is its own PUT: wait for both before reloading (a reload cancels one still in flight).
    const put = (part: string) =>
      page.waitForResponse((r) => r.url().includes("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT" && (r.request().postData() ?? "").includes(part));
    const quietSaved = put('"quiet"');
    await quiet.click();
    await quietSaved;
    const previewSaved = put('"preview"');
    await page.getByRole("radio", { name: "Private" }).click();
    await previewSaved;
    await page.reload();
    await expect(page.getByRole("switch", { name: "Use quiet hours" })).toHaveAttribute("aria-checked", String(!quietWas));
    await expect(page.getByRole("radio", { name: "Private" })).toHaveAttribute("aria-checked", "true");

    // Put everything back.
    const restore = await api(page, "/api/helpdesk/me/notification-prefs", {
      method: "PUT",
      body: { matrix: { reopened: { email: was } }, quiet: { enabled: quietWas }, preview: "full" },
    });
    expect(restore.status).toBe(200);
  });

  test("the service worker registers for the desk", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await page.goto("/desk/settings/notifications");
    const scope = await page.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const reg = await navigator.serviceWorker.getRegistration("/desk");
        if (reg) return reg.scope;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    });
    expect(scope).toBe(new URL("/desk", page.url()).href);
  });

  test("turning notifications on registers this device; turning it off removes it", async ({ page, context }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await context.grantPermissions(["notifications"]);
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const fake = {
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${randomBytes(8).toString("hex")}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    };
    await page.addInitScript((sub) => {
      const w = window as unknown as { __sub: unknown };
      const make = () => ({
        endpoint: sub.endpoint,
        expirationTime: null,
        options: { applicationServerKey: null, userVisibleOnly: true },
        toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
        unsubscribe: async () => {
          w.__sub = null;
          return true;
        },
      });
      PushManager.prototype.subscribe = async function () {
        w.__sub = make();
        return w.__sub as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () {
        return (w.__sub as PushSubscription) ?? null;
      };
    }, fake);

    await page.goto("/desk/settings/notifications");
    await page.getByRole("button", { name: "Turn on notifications on this device" }).click();
    // A fresh browser installs the desk's service worker first (up to 10 s, lib pwa/platform).
    await expect(page.getByText("This device gets desk notifications.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("This device", { exact: true })).toBeVisible();

    const devices = await api(page, "/api/helpdesk/push/devices");
    expect(devices.status).toBe(200);
    const mine = devices.body.devices.find((d: { browser: string }) => d.browser === "chrome");
    expect(mine, "a Chrome device is listed").toBeTruthy();
    expect(JSON.stringify(devices.body)).not.toContain(fake.endpoint);

    await page.getByRole("button", { name: "Turn off on this device" }).click();
    await expect(page.getByRole("button", { name: "Turn on notifications on this device" })).toBeVisible();
    const after = await api(page, "/api/helpdesk/push/devices");
    expect(after.body.devices.some((d: { id: number }) => d.id === mine.id)).toBeFalsy();
  });

  test("the prefs and push routes refuse what they should", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const bad = await api(page, "/api/helpdesk/push/subscriptions", {
      method: "POST",
      body: { subscription: { endpoint: "https://10.0.0.5/push", keys: { p256dh: "x", auth: "y" } } },
    });
    expect(bad.status).toBe(400);
    const prefs = await api(page, "/api/helpdesk/me/notification-prefs", { method: "PUT", body: { quiet: { start: "late" } } });
    expect(prefs.status).toBe(400);
  });
});
