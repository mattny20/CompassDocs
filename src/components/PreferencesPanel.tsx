"use client";

// Account → Preferences: theme, page width, time zone, and date format.
// Everything saves immediately; time zone and date format override the
// workspace defaults just for this user.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Monitor, Moon, Sun } from "lucide-react";
import { WidthPreference } from "./PageWidth";
import { applyThemePref, storeThemePref, type Pref } from "./ThemeToggle";

const THEMES: { value: Pref; label: string; icon: typeof Sun }[] = [
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
  initialWidth,
  initialTimezone,
  initialDateFormat,
  workspaceTimezone,
}: {
  initialTheme: Pref;
  initialWidth: "normal" | "wide" | "full";
  initialTimezone: string;
  initialDateFormat: Df;
  workspaceTimezone: string;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<Pref>(initialTheme);
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

  const select =
    "w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 focus:border-compass-400 focus:outline-none";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Appearance</h3>
        <p className="mb-3 text-sm text-slate-500">
          Saved to your account, so it follows you to any browser you sign in from.
        </p>
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => {
            const Icon = t.icon;
            const active = theme === t.value;
            return (
              <button
                key={t.value}
                role="radio"
                aria-checked={active}
                onClick={() => pickTheme(t.value)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  active ? "bg-compass-600 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
        </div>
        <div className="mt-4 border-t border-slate-100 pt-4">
          <span className="mb-2 block text-xs font-medium text-slate-500">
            Page width — how wide pages render across the whole app
          </span>
          <WidthPreference initial={initialWidth} />
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
