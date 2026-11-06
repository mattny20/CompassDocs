// What the desk shows instead of itself (1.19.0): the house licence gate
// when the build or licence does not cover the helpdesk, and a "not for
// you" page for someone without a desk permission, which points them to
// Get help. Both sit in a bare top bar (the Desk mark and the way back to
// CompassDocs): there is no rail to offer. Server-safe.

import Link from "next/link";
import { ExternalLink, LifeBuoy, ShieldOff } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { LicenseGate } from "@/components/LicenseGate";
import { EmptyState } from "@/components/form";

function Bare({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-slate-200 bg-surface px-4">
        <span className="flex items-center gap-2 text-base font-bold text-slate-900">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-compass-600 text-white">
            <LifeBuoy className="h-4.5 w-4.5" aria-hidden />
          </span>
          Desk
        </span>
        <Link href="/" className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-800">
          CompassDocs
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <PageContainer>{children}</PageContainer>
      </main>
    </div>
  );
}

export function DeskLicenceGate({ canManage }: { canManage: boolean }) {
  return (
    <Bare>
      <PageHeader icon={<LifeBuoy />} title="Desk" subtitle="Where your IT, HR and Facilities teams work requests." />
      <LicenseGate feature="The helpdesk" entitlement="helpdesk" canManage={canManage} />
    </Bare>
  );
}

export function DeskForbidden() {
  return (
    <Bare>
      <PageHeader icon={<LifeBuoy />} title="Desk" subtitle="Where your IT, HR and Facilities teams work requests." />
      <EmptyState
        icon={<ShieldOff />}
        title="The desk is for helpdesk agents"
        body="Your account doesn't work helpdesk tickets. To ask for help or follow your own requests, use Get help."
        action={{ href: "/help", label: "Go to Get help", icon: <LifeBuoy /> }}
      />
    </Bare>
  );
}

/** A page inside the desk the viewer's role does not reach (an agent opening Workflows). */
export function DeskPageForbidden({ what }: { what: string }) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <EmptyState
          icon={<ShieldOff />}
          title={`${what} is for helpdesk managers`}
          body="Ask a helpdesk manager or an administrator if you need to change how the helpdesk works."
          action={{ href: "/desk", label: "Back to tickets" }}
        />
      </PageContainer>
    </div>
  );
}
