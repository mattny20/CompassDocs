import type { ReactNode } from "react";
import { ClipboardCheck, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { buttonClass } from "@/components/Button";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { getAckVersionInfo, lastAckDecision } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate, settingsForUser } from "@/lib/format";
import { userHolds } from "@/lib/access";
import { AckSubnav } from "./AckSubnav";
import { confirmationSentence } from "./ack-sentence";
import { ackPageContext, cachedAckRows } from "./data";

export const dynamic = "force-dynamic";

// The per-document Read confirmation pages (1.10.0): one header, one
// sub-navigation row (Record · History) and the one subtitle sentence C1
// owns, shared by every page under this folder. Each page enforces the
// guards itself; this layout checks them too so the chrome never renders
// for someone who is about to be redirected.
export default async function AcknowledgementsLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));
  // The newest reset is the ask behind the current marker
  // (resetAcknowledgements is the only code that moves it); kept edits on
  // top of it change the History tab, not this sentence.
  const [rows, version, asked, settings, mayRequire, mayManage] = await Promise.all([
    cachedAckRows(doc.id),
    getAckVersionInfo(doc.id),
    lastAckDecision(doc.id, { outcome: "reset" }),
    getAppSettings(),
    // The re-ask's own gate (A7): the reconfirm route takes the same OR.
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
  ]);
  const fmt = settingsForUser(settings, user);
  const current = rows.filter((r) => r.acknowledged_at).length;
  // Only a published document that requires confirmation can be re-asked;
  // the record page itself is readable either way.
  const canReask = doc.status === "published" && doc.ack_required === 1 && (mayRequire || mayManage);
  const subtitle = confirmationSentence({
    current,
    eligible: rows.length,
    rev: version.rev,
    author: version.author,
    asked,
    resetAt: doc.ack_revision_at,
    formatDate: (iso) => formatDate(iso, fmt),
  });

  return (
    <PageContainer>
      <PageHeader
        back={{ href: `/doc/${doc.id}`, label: doc.title }}
        icon={<ClipboardCheck />}
        title="Read confirmation"
        subtitle={subtitle}
        actions={
          // The record is printed as evidence: controls stay off paper
          // (STYLEGUIDE §Print), as does the Record · History row below.
          <>
            {canReask && (
              <ReconfirmButton
                docId={doc.id}
                title={doc.title}
                summary={{ current, eligible: rows.length, rev: version.rev }}
                size="md"
                className="print:hidden"
              />
            )}
            <a
              href={`/api/documents/${doc.id}/acknowledgements?format=csv`}
              data-tt="Download the record as CSV"
              className={buttonClass("secondary", "md", "print:hidden")}
            >
              <Download className="h-4 w-4" /> Export CSV
            </a>
          </>
        }
        className="mb-4"
      />
      <AckSubnav docId={doc.id} />
      {children}
    </PageContainer>
  );
}
