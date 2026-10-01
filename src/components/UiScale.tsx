"use client";

// Interface scale (Account › Preferences): Compact 90% / Default / Large 110%
// / Larger 120%, a multiplier on the fluid root size (globals.css
// --ui-scale), so the sidebar, rails, icons, chips and reading measures all
// follow the same factor. Same plumbing as the theme: localStorage is read by
// the pre-paint stamp in the root layout so there is no flash, and the account
// value wins over a stale browser value on mount.

import { useEffect } from "react";

export type UiScale = "compact" | "default" | "large" | "larger";

const KEY = "compass-ui-scale";
export const UI_SCALES: { value: UiScale; label: string; hint: string }[] = [
  { value: "compact", label: "Compact", hint: "90%" },
  { value: "default", label: "Default", hint: "100%" },
  { value: "large", label: "Large", hint: "110%" },
  { value: "larger", label: "Larger", hint: "120%" },
];

export function applyUiScale(pref: UiScale) {
  if (pref === "default") document.documentElement.removeAttribute("data-ui-scale");
  else document.documentElement.setAttribute("data-ui-scale", pref);
}

export function storeUiScale(pref: UiScale) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
}

function isScale(v: unknown): v is UiScale {
  return v === "compact" || v === "default" || v === "large" || v === "larger";
}

/** Mounted once per shell: applies the account's preference when it differs
 * from what this browser stamped before paint. Renders nothing. */
export function UiScaleSync({ accountPref }: { accountPref: UiScale }) {
  useEffect(() => {
    let local: UiScale = "default";
    try {
      const stored = localStorage.getItem(KEY);
      if (isScale(stored)) local = stored;
    } catch {}
    const effective = isScale(accountPref) ? accountPref : "default";
    if (effective !== local) {
      storeUiScale(effective);
      applyUiScale(effective);
    }
  }, [accountPref]);
  return null;
}
