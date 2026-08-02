import { requireSettingsSection } from "@/lib/auth";
import { listUsers, listGroups } from "@/lib/db";
import { SECTIONS, getSectionGrants } from "@/lib/section-access";
import { SectionAccessPanel } from "@/components/SectionAccessPanel";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function SectionAccessPage() {
  await requireSettingsSection("/admin/access");
  const [users, groups] = await Promise.all([listUsers(), listGroups()]);
  const sections = await Promise.all(
    SECTIONS.map(async (s) => ({ ...s, ...(await getSectionGrants(s.key)) }))
  );
  return (
    <SettingsPage href="/admin/access">
    <SectionAccessPanel
      initial={sections}
      users={users
        .filter((u) => u.status === "active")
        .map((u) => ({ id: u.id, name: u.name || u.username, username: u.username, role: u.role }))}
      groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
    />
    </SettingsPage>
  );
}
