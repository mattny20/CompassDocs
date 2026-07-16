import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { WidthProvider } from "@/components/PageWidth";
import { countOpenSuggestions, countPendingChangeRequests, countTrashed } from "@/lib/db";
import { roleAtLeast } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Force the first-login password change before anything else is usable.
  if (user.must_change_password) redirect("/account/password");

  const isEditor = roleAtLeast(user.role, "editor");
  const [reviewCount, trashCount] = await Promise.all([
    roleAtLeast(user.role, "approver")
      ? Promise.all([countOpenSuggestions(), countPendingChangeRequests()]).then(
          ([a, b]) => a + b
        )
      : Promise.resolve(0),
    isEditor ? countTrashed() : Promise.resolve(0),
  ]);

  return (
    <div className="flex h-screen overflow-hidden print:h-auto print:overflow-visible">
      <Sidebar user={user} reviewCount={reviewCount} trashCount={trashCount} />
      <main className="flex-1 overflow-y-auto print:overflow-visible">
        <WidthProvider initial={user.page_width}>{children}</WidthProvider>
      </main>
    </div>
  );
}
