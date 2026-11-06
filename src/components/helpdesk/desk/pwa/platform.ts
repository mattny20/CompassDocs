// What this browser can do about desk notifications and installing the
// desk (1.19.0). Client-only helpers; every read is guarded so a server
// render or an old browser gets "unknown" rather than a throw.

import { describeDevice, type HdPushBrowser, type HdPushOs } from "@/lib/helpdesk/push-shared";

export interface DeskPlatform {
  browser: HdPushBrowser;
  os: HdPushOs;
  /** Running as the installed app (Home Screen, dock, start menu). */
  standalone: boolean;
  /** iPhone or iPad in Safari, not installed: push needs Add to Home Screen first. */
  iosNeedsInstall: boolean;
  /** Service worker, PushManager and Notification all present. */
  pushSupported: boolean;
  secure: boolean;
  /** iPadOS reports itself as a Mac with touch. */
  touchMac: boolean;
}

export const SW_URL = "/desk-sw.js";
export const SW_SCOPE = "/desk";

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  try {
    return window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: window-controls-overlay)").matches || nav.standalone === true;
  } catch {
    return nav.standalone === true;
  }
}

/** Brave hides behind Chrome's user agent; it answers navigator.brave.isBrave(). */
export async function detectBrave(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const b = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
  if (!b || typeof b.isBrave !== "function") return false;
  try {
    return Boolean(await b.isBrave());
  } catch {
    return true;
  }
}

export function readPlatform(brave: boolean): DeskPlatform {
  if (typeof window === "undefined") {
    return { browser: "other", os: "other", standalone: false, iosNeedsInstall: false, pushSupported: false, secure: false, touchMac: false };
  }
  const touchMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  const { browser, os } = describeDevice(navigator.userAgent, { brave, touchMac });
  const standalone = isStandalone();
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const ios = os === "ios" || os === "ipados";
  return {
    browser,
    os,
    standalone,
    iosNeedsInstall: ios && !standalone,
    pushSupported,
    secure: window.isSecureContext,
    touchMac,
  };
}

/** The base64url VAPID key as the bytes PushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** sha-256 of the endpoint, first 32 hex: the server's device fingerprint. */
export async function fingerprintOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** The desk's service worker registration, registering it when needed. */
export async function deskRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const reg = existing ?? (await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }));
  if (reg.active) return reg;
  // Wait for the first install to finish before subscribing.
  await new Promise<void>((resolve) => {
    const worker = reg.installing ?? reg.waiting;
    if (!worker) return resolve();
    const done = () => {
      if (worker.state === "activated" || worker.state === "redundant") {
        worker.removeEventListener("statechange", done);
        resolve();
      }
    };
    worker.addEventListener("statechange", done);
    setTimeout(resolve, 10_000);
  });
  return reg;
}

/**
 * Sign-out: forget this browser's push subscription, server side first
 * (while the session still answers), then in the browser, so a signed-out
 * device stops getting desk notices. Best effort and bounded (3 s): sign-out
 * never waits on it.
 */
export async function forgetPushOnThisDevice(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const work = (async () => {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/helpdesk/push/subscriptions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => null);
    await sub.unsubscribe().catch(() => false);
  })().catch(() => {});
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, 3_000))]);
}
