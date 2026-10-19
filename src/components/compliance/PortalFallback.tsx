"use client";

// What a routed portal page shows before its payload is on screen (B4):
// the licence gate, the load failure with Try again, or the loading row,
// exactly as the one-page portal showed them. The page header and the
// sub-navigation are the layout's, so none of these carries a title.

import { CircleAlert } from "lucide-react";
import { LoadingRow } from "@/components/Spinner";
import { LicenseGate } from "@/components/LicenseGate";
import { EmptyState } from "@/components/form";
import type { Portal, PortalPageProps } from "./use-portal";

export function PortalFallback({
  licensed,
  canManageLicense = false,
  portal,
}: PortalPageProps & { portal: Pick<Portal, "data" | "loadError" | "load"> }) {
  if (!licensed) {
    return <LicenseGate feature="The compliance portal" entitlement="policy_ack" canManage={canManageLicense} />;
  }
  if (portal.loadError && !portal.data) {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't load the compliance portal"
        body={portal.loadError}
        action={{ onClick: () => void portal.load(), label: "Try again" }}
      />
    );
  }
  return <LoadingRow className="py-10" />;
}
