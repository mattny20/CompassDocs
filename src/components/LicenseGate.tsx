// The one licence gate: what an Enterprise panel shows in place of itself
// when the build or the licence does not cover it. Server-safe (no hooks) so
// a page can render it directly. `canManage` adds the "Open License" button —
// pass it only when the viewer can actually open Settings → License, so a
// delegated viewer never gets a link they cannot follow.

import Link from "next/link";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { buttonClass } from "./Button";

export function LicenseGate({
  feature,
  entitlement,
  canManage = false,
  className = "",
  children,
}: {
  /** The feature, as a name: "SSO", "SCIM provisioning", "The compliance portal". */
  feature: string;
  /** The licence entitlement key that unlocks it, when the build has it but the licence does not. */
  entitlement?: string;
  /** Whether the viewer can open Settings → License (renders the button). */
  canManage?: boolean;
  className?: string;
  /** An extra sentence under the headline (a pricing link, what the feature does). */
  children?: ReactNode;
}) {
  return (
    <div className={`notice-warn flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${className}`.trim()}>
      <Lock className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <strong>{feature} is an Enterprise feature.</strong>
        {entitlement && (
          <>
            {" "}
            It needs a licence with the <code className="font-mono text-xs">{entitlement}</code> entitlement.
          </>
        )}
      </p>
      {canManage && (
        <Link href="/admin/license" className={buttonClass("secondary", "sm")}>
          Open License
        </Link>
      )}
      {children && <div className="basis-full pl-7">{children}</div>}
    </div>
  );
}
