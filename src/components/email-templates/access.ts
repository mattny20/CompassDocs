// Who may open the email template screens, and what they may do there
// (1.19.0). The routes decide for themselves (lib/email-parts-access); the
// pages ask the same questions so they never show a control the route
// would refuse. Server-only.
//
//   manage    integration.email_template_manage: everything
//   read      integration.email_template_read: look, preview
//   helpdesk  helpdesk.admin, or a desk role with templates.manage
//             (lib/helpdesk/roles hdCan), on a licensed helpdesk: compose
//             the hd_* emails (for all teams or one team); the libraries are
//             read-only for them, because a part is shared by every email.
//             The same test as lib/email-parts-access's route gate.

import "server-only";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import type { SessionUser } from "@/lib/types";

export interface TemplatesAccess {
  manage: boolean;
  read: boolean;
  helpdesk: boolean;
}

export async function templatesAccess(user: SessionUser): Promise<TemplatesAccess> {
  const [manage, read, licensed] = await Promise.all([
    userHolds(user, "integration.email_template_manage", { legacyMin: "admin" }),
    userHolds(user, "integration.email_template_read", { legacyMin: "admin" }),
    featureEnabled("helpdesk"),
  ]);
  const helpdesk =
    licensed &&
    ((await userHolds(user, "helpdesk.admin", { legacyMin: "admin" })) ||
      (await (await import("@/lib/helpdesk/roles")).hdCan(user, "templates.manage")));
  return { manage, read: read || manage, helpdesk };
}
