import type { ReactNode } from "react";
import { ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { ReconfirmButton } from "@/components/ReconfirmButton";
import { AckExportMenu } from "@/components/AckRoster";
import { getAckVersionInfo, lastAckDecision, listAckDecisions } from "@/lib/db";
import type { AckDecision } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate, settingsForUser } from "@/lib/format";
import { userHolds } from "@/lib/access";
import { recertCycleSubtitle } from "@/lib/ack-recert";
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
  const [rows, version, asked, settings, mayRequire, mayManage, canExport, decisions] = await Promise.all([
    cachedAckRows(doc.id),
    getAckVersionInfo(doc.id),
    lastAckDecision(doc.id, { outcome: "reset" }),
    getAppSettings(),
    // The re-ask's own gate (A7): the reconfirm route takes the same OR.
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    // The ledger export carries the IP and user agent of every confirmation:
    // the Export menu offers it to compliance.export holders only (C4).
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
    // The cycle count for the subtitle (G1): only read when the policy has
    // an interval; the History tab reads the same rows.
    doc.ack_recert_months != null ? listAckDecisions(doc.id) : Promise.resolve([] as AckDecision[]),
  ]);
  const fmt = settingsForUser(settings, user);
  const current = rows.filter((r) => r.acknowledged_at).length;
  // Only a published document that requires confirmation can be re-asked;
  // the record page itself is readable either way.
  const canReask = doc.status === "published" && doc.ack_required === 1 && (mayRequire || mayManage);
  const sentence = confirmationSentence({
    current,
    eligible: rows.length,
    rev: version.rev,
    author: version.author,
    asked,
    resetAt: doc.ack_revision_at,
    formatDate: (iso) => formatDate(iso, fmt),
  });
  // "… · Cycle 4 · annual" (G1, 1.12.0): the first ask is cycle 1 and each
  // sweep (a ledger row from source 'recurrence') starts the next; a policy
  // without an interval keeps the C1 sentence alone.
  const subtitle =
    doc.ack_recert_months != null
      ? `${sentence} · ${recertCycleSubtitle(1 + decisions.filter((x) => x.source === "recurrence").length, doc.ack_recert_months)}`
      : sentence;

  return (
    <PageContainer>
      {/* The record is printed as evidence (STYLEGUIDE §Print): the paper
          copy opens with what it is, which policy, and when it was taken. */}
      <p className="mb-2 hidden text-sm font-semibold text-slate-800 print:block">
        Read confirmations · {doc.title} · as of {formatDate(new Date().toISOString(), fmt)}
      </p>
      <PageHeader
        back={{ href: `/doc/${doc.id}`, label: doc.title }}
        icon={<ClipboardCheck />}
        title="Read confirmation"
        subtitle={subtitle}
        actions={
          // Controls stay off paper (STYLEGUIDE §Print), as does the
          // Record · History row below.
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
            <AckExportMenu docId={doc.id} canExport={canExport} />
          </>
        }
        className="mb-4"
      />
      <AckSubnav docId={doc.id} showSettings={mayRequire || mayManage} />
      {children}
    </PageContainer>
  );
}
