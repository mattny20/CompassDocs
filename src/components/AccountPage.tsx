// Standardized header for every account settings page: the section's icon,
// label and description from lib/account-sections — the same identity the
// account rail shows. The section is the page's h1 (PageHeader); the
// account layout above renders only an "Account" eyebrow. Server-safe.

import { accountSection } from "@/lib/account-sections";
import { PageHeader } from "./PageHeader";

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
      {s && <PageHeader icon={Icon && <Icon />} title={s.label} subtitle={description ?? s.description} />}
      {children}
    </div>
  );
}
