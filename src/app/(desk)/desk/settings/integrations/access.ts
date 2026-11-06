// Who opens Settings → Integrations (agent P): the email channel's
// capability, channels.manage, or settings.manage (which covers every
// settings page), as the API's intakeAdminGate checks.

import "server-only";
import type { SessionUser } from "@/lib/types";
import { deskRoleCaps } from "../../../desk-access";

export async function canOpenIntegrations(user: SessionUser): Promise<boolean> {
  const r = await deskRoleCaps(user);
  return r.can("channels.manage") || r.can("settings.manage");
}
