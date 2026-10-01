// Standardized header for every account settings page: the section's icon,
// label and description from lib/account-sections — the same identity the
// account rail shows. The section is the page's h1 at the page-title size;
// the account layout above renders only an "Account" eyebrow. Server-safe.

import { accountSection } from "@/lib/account-sections";

export function AccountPage({
  href,
  description,
  children,
}: {
  /** The section's /account/... href (the account-sections key). */
  href: string;
  /** Overrides the registry description (the tokens page names the role). */
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const s = accountSection(href);
  const Icon = s?.icon;
  return (
    <div>
      {s && (
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            {Icon && <Icon className="h-6 w-6 text-compass-600" aria-hidden />} {s.label}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{description ?? s.description}</p>
        </div>
      )}
      {children}
    </div>
  );
}
