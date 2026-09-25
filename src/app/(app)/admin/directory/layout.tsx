import { requireSettingsSection } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { DirectorySubnav } from "@/components/directory-admin/DirectorySubnav";

export const dynamic = "force-dynamic";

// One section, five pages: the header and the tab row are shared; each page
// loads only what its job needs. Every page also enforces the section's
// permission itself (the settings convention), this guard just keeps the
// chrome from rendering for someone who is about to be redirected.
export default async function DirectoryAdminLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsSection("/admin/directory");
  return (
    <SettingsPage href="/admin/directory">
      <DirectorySubnav />
      {children}
    </SettingsPage>
  );
}
