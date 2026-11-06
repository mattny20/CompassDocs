// /desk/settings/notifications (1.19.0): the agent's own notification
// settings: push on this device and their devices, events × channels,
// teams, quiet hours, preview and sound, pause, Install Desk. Agent F's
// route inside the desk (the (desk) layout gates the licence first; the
// /desk/settings layout draws the settings rail and scrolls the page).

import { BellRing } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/form";
import { notifyView } from "@/lib/helpdesk/notify-prefs";
import { listPushDevices } from "@/lib/helpdesk/push";
import { NotificationSettings } from "@/components/helpdesk/desk/notifications/NotificationSettings";
import { deskAccess } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

export default async function DeskNotificationsPage() {
  const user = await requireUser();
  const access = await deskAccess(user);
  if (!access.licensed) return null; // the layout shows the licence gate
  if (!access.agent) {
    return (
      <PageContainer>
        <PageHeader icon={<BellRing />} title="Notifications" subtitle="Choose what reaches you about tickets, and where." />
        <EmptyState
          icon={<BellRing />}
          title="Notifications here are for agents"
          body="You don't work helpdesk tickets, so the desk has nothing to tell you. Approvals reach you through the bell and email."
          action={{ href: "/account/notifications", label: "Open your notification settings" }}
        />
      </PageContainer>
    );
  }
  const [view, devices] = await Promise.all([notifyView(user.id), listPushDevices(user.id)]);
  // The settings layout (agent D) owns the scroll container and the rail.
  return (
    <PageContainer>
      <NotificationSettings initial={view} devices={devices} />
    </PageContainer>
  );
}
