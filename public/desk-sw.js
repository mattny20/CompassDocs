/* CompassDocs Desk service worker (Helpdesk 1.19.0).
 *
 * Registered by the desk (components/helpdesk/desk/pwa) with scope "/desk".
 * Three jobs:
 *   push               show the notification the server sent (one per
 *                      ticket: the tag collapses updates about it);
 *   notificationclick  focus an open desk window and take it to the ticket,
 *                      else open a new one;
 *   fetch              navigations only: network first, and a small offline
 *                      page when the network is gone. Nothing else is
 *                      cached, never an API response (they hold personal
 *                      data).
 */

const VERSION = "desk-sw-v1";
const OFFLINE_URL = "/desk-offline.html";
const PRECACHE = [OFFLINE_URL, "/desk-192.png", "/desk-badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("desk-sw-") && k !== VERSION).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {
          /* not supported here */
        }
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(VERSION);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }
    })()
  );
});

/** A same-origin path from the payload, else the desk. */
function safeUrl(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/desk";
  return raw;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "CompassDocs Desk", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "CompassDocs Desk";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : "hd-desk";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/desk-192.png",
    badge: "/desk-badge-96.png",
    tag,
    renotify: data.renotify !== false,
    silent: data.silent === true,
    timestamp: typeof data.ts === "number" ? data.ts : Date.now(),
    data: { url: safeUrl(data.url), ticket: typeof data.ticket === "number" ? data.ticket : null },
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // The app badge on an installed desk (where supported): a dot, not a count we cannot keep true.
      if (self.navigator && "setAppBadge" in self.navigator) {
        try {
          await self.navigator.setAppBadge();
        } catch (e) {
          /* ignore */
        }
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safeUrl(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      if (self.navigator && "clearAppBadge" in self.navigator) {
        try {
          await self.navigator.clearAppBadge();
        } catch (e) {
          /* ignore */
        }
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = windows.filter((c) => new URL(c.url).origin === self.location.origin);
      // Prefer a desk window (the installed app or a desk tab), else any window of the site.
      const desk = sameOrigin.find((c) => new URL(c.url).pathname.startsWith("/desk")) || null;
      const client = desk || null;
      if (client) {
        try {
          await client.focus();
        } catch (e) {
          /* focus may be refused; still try to navigate */
        }
        if ("navigate" in client && client.url !== target) {
          try {
            await client.navigate(target);
            return;
          } catch (e) {
            // Not controlled by this worker: ask the page to go there itself.
          }
        }
        client.postMessage({ type: "desk:navigate", url: path });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});

// The browser rotated the subscription (rare; Firefox does it): register the
// new one with the server and drop the old one, with the agent's session.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription || null;
      let sub = event.newSubscription || null;
      if (!sub) {
        const key = old && old.options ? old.options.applicationServerKey : null;
        if (!key) return;
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const send = (method, body) =>
        fetch("/api/helpdesk/push/subscriptions", {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      await send("POST", { subscription: sub.toJSON() });
      if (old && old.endpoint !== sub.endpoint) await send("DELETE", { endpoint: old.endpoint });
    })()
  );
});
