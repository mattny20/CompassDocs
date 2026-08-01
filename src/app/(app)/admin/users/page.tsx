import { requireRole } from "@/lib/auth";
import { listUsers } from "@/lib/db";
import { UsersClient } from "@/components/UsersClient";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const admin = await requireRole("admin");
  const users = await listUsers();
  return <SettingsPage href="/admin/users"><UsersClient users={users} currentUserId={admin.id} /></SettingsPage>;
}
