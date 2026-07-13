import { requireRole } from "@/lib/auth";
import { listUsers } from "@/lib/db";
import { UsersClient } from "@/components/UsersClient";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const admin = await requireRole("admin");
  const users = await listUsers();
  return <UsersClient users={users} currentUserId={admin.id} />;
}
