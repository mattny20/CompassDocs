import { Chip } from "@/components/Chip";
import { ackFormerStaffRows, listAckLedger } from "@/lib/db";
import type { AckFormerStaffRow } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { userHolds } from "@/lib/access";
import { resolvePolicyDefaults } from "@/lib/compliance";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { AckRoster, VersionCell, ReadTimeCell, ReachedEndCell, SignedCell } from "@/components/AckRoster";
import type { AckLedgerViewRow } from "@/components/AckRoster";
import { documentWordCount } from "@/lib/read-evidence";
import { ackPageContext, cachedAckRows } from "./data";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

// The Record tab of the Read confirmation pages: the roster (C4, 1.12.0:
// AckRoster with its Show filter, the people filter, the pager and the
// Current version / All confirmations switch), the collapsed former-staff
// section and the two footnotes. The header, the subtitle sentence, the
// Export menu and the Record · History row live in layout.tsx.
//
// 1.13.0 (D2, D4, E1): the roster's row and bulk actions (Extend…, Exempt…,
// Remove exemption, Snooze / Unsnooze, Ask to re-confirm…) for a viewer who
// may act on this policy: a steward (document.ack_require on the space)
// posts to the space-scoped twin /api/documents/{id}/acknowledgements/actions,
// a program manager (compliance.program_manage) to the admin route; both
// take the same body and answer. The policy's resolved grace decides the
// Overdue chip. A retired or stopped policy (ack_required = 0) keeps its
// record readable and its rows still.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `Read confirmation · ${doc.title}` : "Read confirmation" };
}

const INFERRED_NOTE =
  "Confirmations before 1.10.0 did not record the version; where a version is marked (inferred) it is the one that was current at the time of the confirmation.";

/** The footnote the two evidence columns need (the table scrolls sideways
 *  inside its card, so the warn tone's tooltip may clip; the rule is
 *  spelled out here too). */
const EVIDENCE_NOTE =
  "Read time is how long the document was open on screen for that person since everyone was last asked, summed from view tracking when they confirmed; it is not proof of comprehension. A time in amber is shorter than a quarter of a typical read of this document at 200 words per minute. Reached end is what the reader's own browser reported. Confirmations before 1.11.0 recorded neither.";

export default async function AcknowledgementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));

  const [rows, former, ledger, settings, canSeeIp, mayRequire, mayManage, defaults] = await Promise.all([
    cachedAckRows(doc.id),
    ackFormerStaffRows(doc.id),
    listAckLedger(doc.id),
    getAppSettings(),
    // The IP column of the All confirmations view is for exporters only, as
    // the ip column of the CSV is (F6).
    userHolds(user, "compliance.export", { legacyMin: "admin" }),
    // The actions' own gate (D2): the two routes take the same OR.
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    resolvePolicyDefaults(doc.id),
  ]);
  const fmt = settingsForUser(settings, user);
  // A steward acts through the document-bound twin; a program manager
  // without the space key through the admin route. Nothing to act on once
  // the policy is retired or stopped.
  const endpoint =
    doc.ack_required !== 1
      ? undefined
      : mayRequire
        ? `/api/documents/${doc.id}/acknowledgements/actions`
        : mayManage
          ? "/api/admin/compliance/assignments"
          : undefined;
  const acked = rows.filter((r) => r.acknowledged_at);
  const anyInferred = [...rows, ...former, ...ledger].some((r) => r.rev && r.version_source === "inferred");
  // The threshold rule measures each read time against the live text: the
  // document people are asked to read today.
  const words = documentWordCount(doc.content ?? "");
  const anyConfirmed = acked.length > 0 || former.length > 0 || ledger.length > 0;
  // Only what the view shows crosses to the client: the IP for an exporter,
  // never the user agent or the statement text (the CSV carries those).
  const ledgerRows: AckLedgerViewRow[] = ledger.map((r) => ({
    id: r.id,
    name: r.name,
    username: r.username,
    email: r.email,
    account_removed: r.account_removed,
    acknowledged_at: r.acknowledged_at,
    superseded: r.superseded,
    rev: r.rev,
    version_source: r.version_source,
    signed_name: r.signed_name,
    read_seconds: r.read_seconds,
    reached_end: r.reached_end,
    ip: canSeeIp ? r.ip : "",
  }));

  return (
    <>
      {/* The progress bar and the table need people to be asked; a freshly
          required document in a space with no readers yet gets the
          section-level empty state instead of a 0% bar over an empty body. */}
      {rows.length > 0 && (
        <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-compass-500"
            style={{ width: `${Math.round((acked.length / rows.length) * 100)}%` }}
          />
        </div>
      )}

      <AckRoster
        docId={doc.id}
        title={doc.title}
        rows={rows}
        ledger={ledgerRows}
        canSeeIp={canSeeIp}
        fmt={fmt}
        words={words}
        endpoint={endpoint}
        can={{ act: Boolean(endpoint) }}
        grace={defaults.values.overdue_grace_days}
        // The person's record (F3, 1.14.0): a roster reader opens it for the
        // spaces they read, so every person on this roster has a page.
        recordLinks
      />

      {former.length > 0 && <FormerStaff rows={former} fmt={fmt} words={words} />}

      {anyConfirmed && <p className="mt-3 text-xs text-slate-500">{EVIDENCE_NOTE}</p>}
      {anyInferred && <p className="mt-3 text-xs text-slate-500">{INFERRED_NOTE}</p>}
    </>
  );
}

/**
 * Confirmations by people who are no longer asked: deleted accounts (shown
 * from the name snapshot) and disabled ones. Kept for the record, collapsed
 * by default, never part of the count above.
 */
function FormerStaff({
  rows,
  fmt,
  words,
}: {
  /** signed_name is the C2 field on the row (optional here so the section compiles before and after it lands). */
  rows: (AckFormerStaffRow & { signed_name?: string | null })[];
  fmt: Parameters<typeof formatDateTime>[1];
  /** The live document's word count, for the Read time threshold. */
  words: number;
}) {
  return (
    <details className="mt-6 rounded-xl border border-slate-200 bg-surface shadow-xs [&[open]>summary]:border-b [&[open]>summary]:border-slate-100">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:text-compass-700 marker:text-compass-500">
        Former staff and disabled accounts ({rows.length})
      </summary>
      <p className="px-4 pt-3 text-sm text-slate-500">
        People who confirmed this document but are no longer asked. Their records are kept and are not
        counted above.
      </p>
      <Table scroll minWidth="54rem" className="mt-2">
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            <Th>Person</Th>
            <Th fit>Account</Th>
            <Th fit>Confirmed</Th>
            <Th fit>Version</Th>
            <Th fit>Signed</Th>
            <Th fit>Read time</Th>
            <Th fit>Reached end (self-reported)</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={TR}>
              <Td>
                <span className="font-medium text-slate-800">{r.name || r.username || "Former staff"}</span>
                {r.email && <span className="ml-2 text-xs text-slate-500">{r.email}</span>}
              </Td>
              <Td fit>
                <Chip tone="neutral">{r.reason === "left" ? "Left" : "Disabled"}</Chip>
              </Td>
              <Td fit className="text-slate-500">
                {formatDateTime(r.acknowledged_at, fmt)}
              </Td>
              <Td fit className="text-slate-500">
                <VersionCell row={r} />
              </Td>
              <Td fit className="text-slate-700">
                <SignedCell name={r.signed_name} />
              </Td>
              <Td fit className="text-slate-500">
                <ReadTimeCell seconds={r.read_seconds} words={words} />
              </Td>
              <Td fit>
                <ReachedEndCell reached={r.reached_end} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}
