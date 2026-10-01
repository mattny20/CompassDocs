// Standardized header for every admin settings page: the section's icon,
// label, and one-line description from lib/settings-sections — the same
// identity the nav shows, so pages can't drift. Server-safe.
//
// The section is the page: its label is the h1 (PageHeader). The console
// layout above it shows only a small "Settings" eyebrow.

import { settingsSection } from "@/lib/settings-sections";
import { PageHeader } from "./PageHeader";

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
      {s && <PageHeader icon={Icon && <Icon />} title={s.label} subtitle={s.description} actions={actions} />}
      {children}
    </div>
  );
}
