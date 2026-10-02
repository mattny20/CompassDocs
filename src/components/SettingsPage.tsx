// Standardized header for every admin settings page: the section's icon,
// label, and one-line description from lib/settings-sections — the same
// identity the nav shows, so pages can't drift. Server-safe.
//
// The section is the page: its label is the h1 (PageHeader). The console
// layout above it shows only a small "Settings" eyebrow. When the registry
// names a docs page for the section, a "Docs" button sits in the actions
// slot ahead of whatever the page passes.

import { BookOpen } from "lucide-react";
import { settingsSection } from "@/lib/settings-sections";
import { buttonClass } from "./Button";
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
  const docs = s?.docs ? (
    <a
      href={s.docs}
      target="_blank"
      rel="noreferrer"
      className={buttonClass("ghost", "sm")}
      data-tt={`${s.label} documentation (opens in a new tab)`}
    >
      <BookOpen className="h-4 w-4" aria-hidden />
      Docs
    </a>
  ) : null;
  const headerActions =
    docs || actions ? (
      <>
        {docs}
        {actions}
      </>
    ) : undefined;
  return (
    <div>
      {s && <PageHeader icon={Icon && <Icon />} title={s.label} subtitle={s.description} actions={headerActions} />}
      {children}
    </div>
  );
}
