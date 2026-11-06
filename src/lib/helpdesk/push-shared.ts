// Helpdesk 1.19.0: Web Push shapes and the device description, shared by
// the desk's Notifications page (client) and lib/helpdesk/push (server).
// Pure: no server imports.

export type HdPushBrowser = "chrome" | "edge" | "firefox" | "safari" | "brave" | "opera" | "samsung" | "other";
export type HdPushOs = "ios" | "ipados" | "android" | "macos" | "windows" | "linux" | "chromeos" | "other";

export const HD_BROWSER_LABEL: Record<HdPushBrowser, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  brave: "Brave",
  opera: "Opera",
  samsung: "Samsung Internet",
  other: "Browser",
};

export const HD_OS_LABEL: Record<HdPushOs, string> = {
  ios: "iPhone",
  ipados: "iPad",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  other: "another device",
};

/** One registered device as the owner sees it (no endpoint, no keys). */
export interface HdPushDevice {
  id: number;
  label: string;
  browser: HdPushBrowser;
  os: HdPushOs;
  created_at: string;
  last_used_at: string | null;
  last_error: string;
  /** sha-256 of the endpoint, first 32 hex: the page hashes its own subscription to find "this device". */
  fingerprint: string;
}

/** What the service worker receives (JSON, under 3 KB). */
export interface HdPushPayload {
  v: 1;
  title: string;
  body: string;
  /** Collapses updates about one ticket into one notification. */
  tag: string;
  /** Same-origin path the click opens. */
  url: string;
  ticket: number | null;
  silent: boolean;
  renotify: boolean;
  ts: number;
}

/**
 * Browser and system from a user agent, with the page's own hints (Brave
 * hides in Chrome's user agent; iPadOS reports itself as a Mac).
 */
export function describeDevice(ua: string, hints: { brave?: boolean; touchMac?: boolean } = {}): { browser: HdPushBrowser; os: HdPushOs } {
  const s = ua || "";
  let os: HdPushOs = "other";
  if (/iPhone|iPod/.test(s)) os = "ios";
  else if (/iPad/.test(s) || (/Macintosh/.test(s) && hints.touchMac)) os = "ipados";
  else if (/Android/.test(s)) os = "android";
  else if (/CrOS/.test(s)) os = "chromeos";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macos";
  else if (/Windows/.test(s)) os = "windows";
  else if (/Linux|X11/.test(s)) os = "linux";

  let browser: HdPushBrowser = "other";
  if (hints.brave) browser = "brave";
  else if (/Edg(e|A|iOS)?\//.test(s)) browser = "edge";
  else if (/SamsungBrowser\//.test(s)) browser = "samsung";
  else if (/OPR\/|Opera/.test(s)) browser = "opera";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "firefox";
  else if (/Chrome\/|CriOS\//.test(s) || /Chromium\//.test(s)) browser = "chrome";
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = "safari";
  else if ((os === "ios" || os === "ipados") && /AppleWebKit/.test(s)) browser = "safari";
  return { browser, os };
}

/** "Chrome on Mac", "Safari on iPhone". */
export function deviceLabel(d: { browser: HdPushBrowser; os: HdPushOs }): string {
  return `${HD_BROWSER_LABEL[d.browser]} on ${HD_OS_LABEL[d.os]}`;
}

export const HD_BROWSERS = Object.keys(HD_BROWSER_LABEL) as HdPushBrowser[];
export const HD_OSES = Object.keys(HD_OS_LABEL) as HdPushOs[];
