import { requireSettingsSection } from "@/lib/auth";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";

export const dynamic = "force-dynamic";

export default async function RolesLayout({ children }: { children: React.ReactNode }) {
  await requireSettingsSection("/admin/roles");
  return (
    <SettingsPage href="/admin/roles">
      <SubNav label="Roles settings" section="/admin/roles" />
      {children}
    </SettingsPage>
  );
}
