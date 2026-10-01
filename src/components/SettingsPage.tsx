// Standardized header for every admin settings page: the section's icon,
// label, and one-line description from lib/settings-sections — the same
// identity the nav shows, so pages can't drift. Server-safe.
//
// The section is the page: its label is the h1 at the guide's page-title
// size. The console layout above it shows only a small "Settings" eyebrow,
// so the first control no longer sits under three stacked headings.

import { settingsSection } from "@/lib/settings-sections";

export function SettingsPage({
  href,
  children,
  actions,
}: {
  /** The section's /admin/... href (the settings-sections key). */
  href: string;
  children: React.ReactNode;
  /** Optional right-aligned header controls (e.g. an export button). */
  actions?: React.ReactNode;
}) {
  const s = settingsSection(href);
  const Icon = s?.icon;
  return (
    <div>
      {s && (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
              {Icon && <Icon className="h-6 w-6 text-compass-600" aria-hidden />} {s.label}
            </h1>
            <p className="mt-1 text-sm text-slate-500">{s.description}</p>
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
