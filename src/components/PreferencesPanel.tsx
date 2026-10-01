"use client";

// Account → Preferences: theme, page width, time zone, and date format.
// Everything saves immediately; time zone and date format override the
// workspace defaults just for this user.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Monitor, Moon, Sun } from "lucide-react";
import { WidthPreference } from "./PageWidth";
import { Segmented, type SegmentedOption } from "./Segmented";
import { applyThemePref, storeThemePref, type Pref } from "./ThemeToggle";
import { UI_SCALES, applyUiScale, storeUiScale, type UiScale } from "./UiScale";

const THEMES: SegmentedOption<Pref>[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Auto", icon: Monitor },
];

type Df = "auto" | "medium" | "long" | "iso" | "us" | "eu";
const DATE_FORMATS: Df[] = ["auto", "medium", "long", "iso", "us", "eu"];
const SAMPLE = new Date("2026-03-31T17:30:00Z");

function dfExample(df: Df): string {
  const opts: Record<Exclude<Df, "auto">, [string, Intl.DateTimeFormatOptions]> = {
    medium: ["en-US", { year: "numeric", month: "short", day: "numeric" }],
    long: ["en-US", { year: "numeric", month: "long", day: "numeric" }],
    iso: ["en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }],
    us: ["en-US", { year: "numeric", month: "2-digit", day: "2-digit" }],
    eu: ["en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }],
  };
  if (df === "auto") return "";
  const [locale, o] = opts[df];
  return new Intl.DateTimeFormat(locale, { ...o, timeZone: "UTC" }).format(SAMPLE);
}

export function PreferencesPanel({
  initialTheme,
  initialScale = "default",
  initialTimezone,
  initialDateFormat,
  workspaceTimezone,
}: {
  initialTheme: Pref;
  initialScale?: UiScale;
  initialTimezone: string;
  initialDateFormat: Df;
  workspaceTimezone: string;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<Pref>(initialTheme);
  const [scale, setScale] = useState<UiScale>(initialScale);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [dateFormat, setDateFormat] = useState<Df>(initialDateFormat);
  const [error, setError] = useState("");

  const zones = useMemo<string[]>(() => {
    try {
      return (Intl as any).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  async function patch(body: object): Promise<boolean> {
    setError("");
    const res = await fetch("/api/account/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      router.refresh();
      return true;
    }
    setError((await res.json().catch(() => null))?.error || "Couldn't save.");
    return false;
  }

  async function pickTheme(next: Pref) {
    setTheme(next);
    applyThemePref(next);
    storeThemePref(next);
    await patch({ theme: next });
  }

  async function pickScale(next: UiScale) {
    setScale(next);
    applyUiScale(next);
    storeUiScale(next);
    await patch({ ui_scale: next });
  }

  const select =
    "w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 focus:border-compass-400 focus:outline-none";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Appearance</h3>
        <p className="mb-3 text-sm text-slate-500">
          Saved to your account, so it follows you to any browser you sign in from.
        </p>
        <Segmented options={THEMES} value={theme} onChange={pickTheme} label="Theme" />
        <div className="mt-4 border-t border-slate-100 pt-4">
          <span className="mb-2 block text-xs font-medium text-slate-500">
            Page width — how wide pages render across the whole app
          </span>
          {/* Inside the app shell the width context is live: picking a width
              re-flows this page at once, which is the preview. */}
          <WidthPreference />
        </div>
        <div className="mt-4 border-t border-slate-100 pt-4">
          <span className="mb-2 block text-xs font-medium text-slate-500">
            Interface scale — the size of everything, text and controls alike
          </span>
          <Segmented options={UI_SCALES} value={scale} onChange={pickScale} label="Interface scale" />
          <p className="mt-2 text-xs text-slate-500">
            Default already grows with your monitor. Pick Large or Larger on a 32-inch or ultrawide
            screen, Compact to fit more on a laptop. Browser zoom still works on top.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Dates &amp; times</h3>
        <p className="mb-3 text-sm text-slate-500">
          Timestamps on documents, history, and the dashboard render in this zone and style.
          The weekly digest arrives Monday morning in your zone.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Time zone</span>
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                void patch({ timezone: e.target.value });
              }}
              className={select}
            >
              <option value="">Workspace default ({workspaceTimezone || "UTC"})</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Date format</span>
            <select
              value={dateFormat}
              onChange={(e) => {
                const df = e.target.value as Df;
                setDateFormat(df);
                void patch({ date_format: df });
              }}
              className={select}
            >
              {DATE_FORMATS.map((df) => (
                <option key={df} value={df}>
                  {df === "auto" ? "Workspace default" : dfExample(df)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
