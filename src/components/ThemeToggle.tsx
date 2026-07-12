"use client";

import { useEffect, useState } from "react";

type Pref = "light" | "dark" | "system";

const KEY = "compass-theme";
const OPTIONS: { value: Pref; label: string; icon: string }[] = [
  { value: "light", label: "Light", icon: "☀️" },
  { value: "dark", label: "Dark", icon: "🌙" },
  { value: "system", label: "Auto", icon: "🖥️" },
];

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Compute and apply the effective theme (`data-theme`) for a preference. */
function apply(pref: Pref) {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export function ThemeToggle() {
  // Start from a stable value to keep SSR/first-client render identical, then
  // sync to the stored preference after mount (the inline script already set
  // the actual data-theme, so there's no visual flash).
  const [pref, setPref] = useState<Pref>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Pref | null) ?? "system";
    setPref(stored);
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

  function choose(next: Pref) {
    setPref(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    apply(next);
  }

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-slate-200 bg-surface p-0.5"
      role="group"
      aria-label="Color theme"
    >
      {OPTIONS.map((o) => {
        const active = mounted && pref === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => choose(o.value)}
            aria-pressed={active}
            title={`${o.label} theme`}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
              active
                ? "bg-compass-600 text-white shadow-sm"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            }`}
          >
            <span aria-hidden>{o.icon}</span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
