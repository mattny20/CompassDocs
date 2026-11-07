// /desk/settings/appearance: Appearance (desk settings, 1.19.4; mock-up t4).
// The desk's background artwork per mode, its transparency and whether
// agents may choose their own. Opens for a desk role holding
// settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AppearanceSettings } from "@/components/helpdesk/desk/appearance/AppearanceSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appearance" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "appearance"))) return <DeskPageForbidden what="Appearance" />;
  return <AppearanceSettings />;
}
