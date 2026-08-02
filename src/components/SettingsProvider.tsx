"use client";

// Workspace date/time settings, resolved once per shell and read by every
// component that renders a timestamp.
//
// Why a provider: ~25 client components across nine routes render an absolute
// date. They already had the right helpers available (`lib/format`) but no way
// to reach the settings those helpers need, so they fell back to
// `toLocaleString()` — which uses the *browser's* locale and zone and silently
// ignores both the workspace setting and the user's own preference. Threading
// `settings` through nine page components and their intermediate props is a
// much larger and more fragile diff than one context read, so the settings ride
// the same route the page-width preference already takes (`PageWidth.tsx`).
//
// The value is resolved server-side (`settingsForUser(workspace, user)`) and
// passed down, so SSR and the client hydrate from the same object. Because
// `lib/format` always passes an explicit locale AND time zone to Intl, both
// renders produce identical strings — which also removes the hydration-mismatch
// risk the raw `toLocaleString()` calls carried.

import { createContext, useContext, useMemo } from "react";
import { SETTINGS_DEFAULTS, type AppSettings } from "@/lib/settings";
import { formatDate, formatDateTime, formatDayShort } from "@/lib/format";

const SettingsContext = createContext<AppSettings>(SETTINGS_DEFAULTS);

export function SettingsProvider({
  value,
  children,
}: {
  value: AppSettings;
  children: React.ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** The resolved workspace settings (with this user's time zone / date format
 * preference already applied). Use when you need to hand `settings` to a
 * `lib/format` helper directly, or need `timezone` itself. */
export function useAppSettings(): AppSettings {
  return useContext(SettingsContext);
}

/**
 * Date/time formatters bound to the resolved settings.
 *
 *   const fmt = useFormatDate();
 *   fmt.date(iso)      → "2026-08-02"            (date only)
 *   fmt.dateTime(iso)  → "2026-08-02, 01:08"     (date + time)
 *   fmt.dayShort(ymd)  → "08-02"                 (calendar bucket, no year)
 *
 * All three accept null/undefined and return "" — call sites keep their own
 * "never" / "—" fallbacks.
 */
export function useFormatDate() {
  const settings = useContext(SettingsContext);
  return useMemo(
    () => ({
      settings,
      date: (iso: string | null | undefined) => formatDate(iso, settings),
      dateTime: (iso: string | null | undefined) => formatDateTime(iso, settings),
      dayShort: (ymd: string | null | undefined) => formatDayShort(ymd, settings),
    }),
    [settings]
  );
}

/** Render a formatted date from a *server* component inside a shell that mounts
 * the provider — the hook is client-only, so server pages drop these in instead
 * of threading `settings` through every intermediate component. */
export function DateText({ iso }: { iso: string | null | undefined }) {
  return <>{formatDate(iso, useContext(SettingsContext))}</>;
}

/** Server-component counterpart of `fmt.dateTime` — see `DateText`. */
export function DateTimeText({ iso }: { iso: string | null | undefined }) {
  return <>{formatDateTime(iso, useContext(SettingsContext))}</>;
}
