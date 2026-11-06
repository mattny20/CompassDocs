// /desk/settings/assets: Assets (desk settings, 1.19.3; mock-up i3). Where
// devices come from: the Snipe-IT address and API key, Test connection and
// Sync now, what solving offers, and who sees assets. Opens for a desk role
// holding settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssetSettings } from "@/components/helpdesk/desk/assets/AssetSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "assets"))) return <DeskPageForbidden what="Assets" />;
  return <AssetSettings />;
}
