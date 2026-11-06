// The licence gate every /help page shows under its own header when the
// build or the licence does not cover the helpdesk (STYLEGUIDE §Notices:
// the one LicenseGate, with "Open License" only for someone who can open
// it). Server-safe.

import type { ReactNode } from "react";
import { LicenseGate } from "@/components/LicenseGate";
import type { HelpAccess } from "./access";

export function HelpGate({ access, children }: { access: HelpAccess; children: ReactNode }) {
  if (!access.licensed) {
    return <LicenseGate feature="The helpdesk" entitlement="helpdesk" canManage={access.canManageLicense} />;
  }
  return <>{children}</>;
}
