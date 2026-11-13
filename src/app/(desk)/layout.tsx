// The desk (1.19.0, /desk): the helpdesk agents' full-screen workspace, in
// its own route group beside (app) so it carries no CompassDocs sidebar or
// palette (STYLEGUIDE §Page skeleton, "A page that must not have the app
// shell at all"). It repeats what (app)/layout.tsx does first (sign-in,
// the forced password change, the interface scale, the date settings, one
// ToastHost and one DialogHost) and then gates on the licence and on the
// desk permissions: unlicensed is the house licence gate, no desk
// permission is a page pointing to Get help.

import { redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import { requireUser, currentPagePath } from "@/lib/auth";
import { safeReturnPath } from "@/lib/return-to";
import { getAppSettings } from "@/lib/settings-store";
import { settingsForUser } from "@/lib/format";
import { unreadNotificationCount } from "@/lib/db";
import { SettingsProvider } from "@/components/SettingsProvider";
import { WidthProvider } from "@/components/PageWidth";
import { ToastHost } from "@/components/Toasts";
import { DialogHost } from "@/components/Dialog";
import { UiScaleSync } from "@/components/UiScale";
import { DeskShell } from "@/components/helpdesk/desk/DeskShell";
import { DuoDeskPrompt } from "@/components/helpdesk/desk/DuoDeskPrompt";
import { DeskForbidden, DeskLicenceGate } from "@/components/helpdesk/desk/DeskGate";
import { DeskKeysProvider } from "@/components/helpdesk/desk/DeskKeysProvider";
import { PwaHead } from "@/components/helpdesk/desk/pwa/PwaHead";
import { InstallDeskMenuItem } from "@/components/helpdesk/desk/pwa/InstallDesk";
import { deskPwaMetadata, deskPwaViewport } from "@/components/helpdesk/desk/pwa/metadata";
import { firstSettingsHref } from "@/components/helpdesk/desk/settings/settings-nav";
import { agentAvailability, deskAccess, deskRoleCaps } from "./desk-access";
import { deskLookFor } from "@/lib/helpdesk/appearance";
import { claudeDeskClientProps } from "@/lib/helpdesk/claude/desk-props";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Desk", template: "%s · Desk" },
  robots: { index: false, follow: false },
  // The desk installs as an app of its own (agent F's manifest and icons).
  ...deskPwaMetadata,
};

export const viewport: Viewport = deskPwaViewport;

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  // "desk" (1.20.5): the Duo desk rule is asked here whatever path the request claims to be for.
  const user = await requireUser("desk");
  if (user.must_change_password) {
    const back = safeReturnPath(await currentPagePath());
    redirect(back === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(back)}`);
  }

  const [access, workspaceSettings] = await Promise.all([deskAccess(user), getAppSettings()]);
  const settings = settingsForUser(workspaceSettings, user);

  let body: React.ReactNode;
  if (!access.licensed) {
    body = <DeskLicenceGate canManage={access.manageLicense} />;
  } else if (!access.any) {
    body = <DeskForbidden />;
  } else {
    const [unread, availability, role, look, claude] = await Promise.all([
      unreadNotificationCount(user.id),
      agentAvailability(user.id),
      deskRoleCaps(user),
      // The desk background artwork (1.19.4 C5, lib/helpdesk/appearance).
      deskLookFor(user.id),
      // Claude in the desk (1.20.0): null unless it is on for this agent.
      claudeDeskClientProps(user),
    ]);
    const reports = access.reports || role.can("reports.own") || role.can("reports.team") || role.can("reports.all");
    body = (
      <DeskShell
        user={{ id: user.id, name: user.name || user.username }}
        caps={{
          agent: access.agent,
          admin: access.admin,
          reports,
          workflows: role.can("workflows.manage"),
          settingsHref: firstSettingsHref(role.caps),
        }}
        role={role.role}
        roleCaps={role.caps}
        claude={claude}
        unread={unread}
        availability={availability}
        installSlot={<InstallDeskMenuItem />}
        look={look.look}
        lookMenu={look.menu}
      >
        {children}
      </DeskShell>
    );
  }

  return (
    <SettingsProvider value={settings}>
      <WidthProvider initial={user.page_width}>
        <DeskKeysProvider singleKey={user.single_key_shortcuts}>
          <UiScaleSync accountPref={user.ui_scale} />
          {body}
          {access.licensed && access.any && <PwaHead />}
          <ToastHost />
          <DialogHost />
          {/* 1.20.5: shown only when a desk request is refused for want of a Duo approval. */}
          <DuoDeskPrompt />
        </DeskKeysProvider>
      </WidthProvider>
    </SettingsProvider>
  );
}
