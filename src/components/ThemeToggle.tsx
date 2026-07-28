"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

export type Pref = "light" | "dark" | "system";

const KEY = "compass-theme";
const ORDER: Pref[] = ["light", "dark", "system"];
const LABEL: Record<Pref, string> = { light: "Light", dark: "Dark", system: "Auto" };

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Compute and apply the effective theme (`data-theme`) for a preference.
 * Exported for the account Preferences page, which sets the theme directly. */
export function applyThemePref(pref: Pref) {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

/** Persist a preference locally (the no-flash boot script reads this key). */
export function storeThemePref(pref: Pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
}
const apply = applyThemePref;

/**
 * Compact theme control: one icon button that cycles Light → Dark → Auto.
 * The icon shows the current preference; the tooltip says what's next.
 * With `accountPref` (signed-in surfaces) the account is the source of truth:
 * it wins over this browser's stored value on mount, and changes write back
 * so the theme follows the user across devices.
 */
export function ThemeToggle({
  className = "",
  accountPref,
}: {
  className?: string;
  accountPref?: Pref;
}) {
  // Start from a stable value to keep SSR/first-client render identical, then
  // sync to the stored preference after mount (the inline script already set
  // the actual data-theme, so there's no visual flash).
  const [pref, setPref] = useState<Pref>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Pref | null) ?? "system";
    const local = ORDER.includes(stored) ? stored : "system";
    const effective = accountPref && ORDER.includes(accountPref) ? accountPref : local;
    setPref(effective);
    if (effective !== local) {
      try {
        localStorage.setItem(KEY, effective);
      } catch {}
      apply(effective);
    }
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountPref]);

  // While on "system", follow live OS theme changes.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    setPref(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    apply(next);
    if (accountPref !== undefined) {
      void fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      }).catch(() => {});
    }
  }

  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={cycle}
      title={mounted ? `Theme: ${LABEL[pref]} — click for ${LABEL[next]}` : "Theme"}
      aria-label={`Color theme (currently ${LABEL[pref]})`}
      className={`rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 ${className}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
