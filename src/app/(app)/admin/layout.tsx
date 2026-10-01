import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";
import { PageContainer } from "@/components/PageWidth";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Enforcement lives on each page, not here (0.93): the console is no longer
  // all-or-nothing, so a role holding one settings permission gets that section
  // and nothing else. The layout only decides whether there is anything at all
  // to show, and which entries the rail may link to.
  const user = await requireUser();
  const reachable = await reachableSettingsSections(user);
  if (reachable.length === 0) redirect("/");

  return (
    <PageContainer>
      {/* An eyebrow, not a heading: the section (SettingsPage) is the page's
          h1. "Settings — Manage your workspace" on every admin page pushed the
          first control 250px down and gave the console two h1-sized titles. */}
      <p className={`mb-4 flex items-center gap-1.5 ${RAIL_GROUP_TEXT}`}>
        <Settings className="h-3.5 w-3.5" aria-hidden /> Settings
      </p>
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        {/* Sticky and self-scrolling: the 20-entry rail stays put while a long
            page (Workspace, Notifications, Backups) scrolls, and fits a
            900px-tall laptop by scrolling inside its own box. self-start is
            what lets a flex child stick at all. */}
        <div className="shrink-0 sm:sticky sm:top-6 sm:max-h-[calc(100vh-3rem)] sm:self-start sm:overflow-y-auto sm:overscroll-contain">
          <SettingsNav reachable={reachable} />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageContainer>
  );
}
