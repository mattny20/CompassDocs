// What to tell an agent whose browser can't, won't or doesn't yet show desk
// notifications (1.19.0): re-enabling after "Block" per browser, the iOS
// Home Screen requirement, and Brave's push setting. Plain sentences;
// server-safe.

import type { DeskPlatform } from "../pwa/platform";

/** How to undo "Block" for this browser, step by step. */
export function deniedSteps(p: DeskPlatform): string[] {
  if (p.os === "ios" || p.os === "ipados") {
    return ["Open the Settings app.", "Tap Notifications, then Desk.", "Turn on Allow Notifications."];
  }
  if (p.os === "android") {
    return p.standalone
      ? ["Open Android Settings → Apps → Desk.", "Tap Notifications and turn them on.", "Come back and reload this page."]
      : [
          "Tap the icon at the left of the address bar.",
          "Tap Permissions → Notifications and choose Allow.",
          "Reload this page.",
        ];
  }
  if (p.browser === "safari") {
    return [
      "In the menu bar, choose Safari → Settings → Websites.",
      "Select Notifications, find this site and choose Allow.",
      "Reload this page.",
    ];
  }
  if (p.browser === "firefox") {
    return [
      "Click the icon at the left of the address bar.",
      "Next to Send notifications, clear Blocked Temporarily or Blocked.",
      "Reload this page and turn notifications on again.",
    ];
  }
  return [
    "Click the icon at the left of the address bar (site information).",
    "Set Notifications to Allow, or open Site settings and allow them there.",
    "Reload this page.",
  ];
}

/** A line about the operating system's own switch, when one can block the browser. */
export function systemHint(p: DeskPlatform): string | null {
  if (p.os === "macos") return "Still nothing? Check System Settings → Notifications and allow your browser.";
  if (p.os === "windows") return "Still nothing? Check Windows Settings → System → Notifications and allow your browser.";
  return null;
}

export const BRAVE_HINT =
  "Brave sends push notifications through Google's push service, which is off by default. Open brave://settings/privacy, turn on Use Google services for push messaging, restart Brave and try again.";

export const IOS_INSTALL_HINT =
  "On iPhone and iPad, the desk can show notifications once it's on your Home Screen (iOS and iPadOS 16.4 or later). Tap Share, then Add to Home Screen, open Desk from there and come back to this page.";
