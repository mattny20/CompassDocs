"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";

type Pref = "light" | "dark" | "system";

const KEY = "compass-theme";
const ORDER: Pref[] = ["light", "dark", "system"];
const LABEL: Record<Pref, string> = { light: "Light", dark: "Dark", system: "Auto" };

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Compute and apply the effective theme (`data-theme`) for a preference. */
function apply(pref: Pref) {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

/**
 * Compact theme control: one icon button that cycles Light → Dark → Auto.
 * The icon shows the current preference; the tooltip says what's next.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  // Start from a stable value to keep SSR/first-client render identical, then
  // sync to the stored preference after mount (the inline script already set
  // the actual data-theme, so there's no visual flash).
  const [pref, setPref] = useState<Pref>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Pref | null) ?? "system";
    setPref(ORDER.includes(stored) ? stored : "system");
    setMounted(true);
  }, []);

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
