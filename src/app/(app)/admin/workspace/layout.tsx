import { requireSettingsSection } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";

export const dynamic = "force-dynamic";

// One section, three pages — Branding (name, logo, accent, date & time),
// Content (retention, attachments, organisation, comments, session) and the
// Sign-in page (artwork and text, 1.16.0) — each with its own Save, so a
// save on one never resets the other's fields.
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsSection("/admin/workspace");
  return (
    <SettingsPage href="/admin/workspace">
      <SubNav label="Workspace settings" section="/admin/workspace" />
      {children}
    </SettingsPage>
  );
}
