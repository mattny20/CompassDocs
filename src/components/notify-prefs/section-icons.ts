// The lucide icon for each notification section (lib/notify-policy-shared),
// shared by the admin Policies page and Account → Notifications.

import { ClipboardCheck, FileText, GraduationCap, Headset, LifeBuoy, Megaphone, ShieldCheck, Stamp, type LucideIcon } from "lucide-react";
import type { NotifySection } from "@/lib/notify-policy-shared";

export const SECTION_ICON: Record<NotifySection, LucideIcon> = {
  read_confirmations: ClipboardCheck,
  documents: FileText,
  helpdesk: LifeBuoy,
  approvals: Stamp,
  desk: Headset,
  training: GraduationCap,
  newsletter: Megaphone,
  security: ShieldCheck,
};
