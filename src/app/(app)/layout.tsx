import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";
import { WidthProvider } from "@/components/PageWidth";
import { SettingsProvider } from "@/components/SettingsProvider";
import { getAppSettings } from "@/lib/settings-store";
import { settingsForUser } from "@/lib/format";
import { countOpenSuggestions, countPendingChangeRequests, countTrashed } from "@/lib/db";
import { roleAtLeast } from "@/lib/types";
import { ToastHost } from "@/components/Toasts";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { navCapabilities } from "@/lib/nav-capabilities";
import { spaceScopeFor } from "@/lib/access";
import { listSpaces } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Force the first-login password change before anything else is usable.
  if (user.must_change_password) redirect("/account/password");

  const isEditor = roleAtLeast(user.role, "editor");
  const [reviewCount, trashCount, caps, paletteSpaces, workspaceSettings] = await Promise.all([
    roleAtLeast(user.role, "approver")
      ? Promise.all([countOpenSuggestions(), countPendingChangeRequests()]).then(
          ([a, b]) => a + b
        )
      : Promise.resolve(0),
    isEditor ? countTrashed() : Promise.resolve(0),
    navCapabilities(user),
    spaceScopeFor(user).then((scope) => listSpaces(scope)),
    getAppSettings(),
  ]);
  // Workspace defaults with this user's own time zone / date format on top.
  const settings = settingsForUser(workspaceSettings, user);

  return (
    <div className="flex h-screen overflow-hidden print:h-auto print:overflow-visible">
      {/* Keyboard users: jump past the sidebar straight to the page content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-compass-600 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <Sidebar user={user} reviewCount={reviewCount} trashCount={trashCount} />
      <main id="main" className="flex-1 overflow-y-auto print:overflow-visible">
        <SettingsProvider value={settings}>
        <WidthProvider initial={user.page_width}>{children}
        <ToastHost /></WidthProvider>
        </SettingsProvider>
      </main>
      <CommandPalette
        userId={user.id}
        caps={caps}
        spaces={paletteSpaces.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          icon: s.icon,
          category: s.description || null,
        }))}
      />
    </div>
  );
}
