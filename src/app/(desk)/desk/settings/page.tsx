// /desk/settings: the first page this person's desk role reaches.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { firstSettingsHref } from "@/components/helpdesk/desk/settings/settings-nav";
import { deskRoleCaps } from "../../desk-access";

export default async function DeskSettingsIndex() {
  const user = await requireUser();
  redirect(firstSettingsHref((await deskRoleCaps(user)).caps));
}
