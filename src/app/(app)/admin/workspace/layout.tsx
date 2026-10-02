import { requireSettingsSection } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";

export const dynamic = "force-dynamic";

// One section, two pages — Branding (name, logo, accent, date & time) and
// Content (retention, attachments, organisation, comments, session) — each
// with its own Save, so a save on one never resets the other's fields.
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsSection("/admin/workspace");
  return (
    <SettingsPage href="/admin/workspace">
      <SubNav label="Workspace settings" section="/admin/workspace" />
      {children}
    </SettingsPage>
  );
}
