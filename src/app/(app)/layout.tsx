import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { countOpenSuggestions, countPendingChangeRequests } from "@/lib/db";
import { roleAtLeast } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Force the first-login password change before anything else is usable.
  if (user.must_change_password) redirect("/account/password");

  const reviewCount = roleAtLeast(user.role, "approver")
    ? (await countOpenSuggestions()) + (await countPendingChangeRequests())
    : 0;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar user={user} reviewCount={reviewCount} />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
