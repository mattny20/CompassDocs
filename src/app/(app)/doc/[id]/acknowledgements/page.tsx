import { Check } from "lucide-react";
import { Chip, chipClass } from "@/components/Chip";
import { SectionEmpty } from "@/components/form";
import { ackFormerStaffRows } from "@/lib/db";
import type { AckStatusRow, AckFormerStaffRow } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { documentWordCount, isShortRead, readTimeLabel, SHORT_READ_TOOLTIP } from "@/lib/read-evidence";
import { ackPageContext, cachedAckRows } from "./data";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

// The Record tab of the Read confirmation pages: the roster. The header,
// the subtitle sentence and the Record · History row live in layout.tsx.

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `Read confirmation · ${doc.title}` : "Read confirmation" };
}

/** "v12", marked "(inferred)" on rows from before 1.10.0. The explanation is
 *  a footnote under the table, not a tooltip: the table scrolls sideways
 *  inside its card, and a tooltip bubble is clipped by that container. */
function VersionCell({ row }: { row: Pick<AckStatusRow, "rev" | "version_source"> }) {
  if (!row.rev) return <>—</>;
  if (row.version_source === "inferred") {
    return (
      <span className="inline-flex items-center gap-1.5">
        v{row.rev}
        <span className="text-xs text-slate-500">(inferred)</span>
      </span>
    );
  }
  return <>v{row.rev}</>;
}

const INFERRED_NOTE =
  "Confirmations before 1.10.0 did not record the version; where a version is marked (inferred) it is the one that was current at the time of the confirmation.";

/** The footnote the two evidence columns need (the table scrolls sideways
 *  inside its card, so the warn tone's tooltip may clip; the rule is
 *  spelled out here too). */
const EVIDENCE_NOTE =
  "Read time is how long the document was open on screen for that person since everyone was last asked, summed from view tracking when they confirmed; it is not proof of comprehension. A time in amber is shorter than a quarter of a typical read of this document at 200 words per minute. Reached end is what the reader's own browser reported. Confirmations before 1.11.0 recorded neither.";

/**
 * "6 min", "under 1 min", blank when the record holds no read time. The
 * warn tone (ink, not a chip: this is a measurement, not a status) applies
 * only below a quarter of a typical read of the document, with the tooltip
 * on a focusable span as the style guide asks of non-interactive elements.
 */
function ReadTimeCell({ seconds, words }: { seconds: number | null; words: number }) {
  const label = readTimeLabel(seconds);
  if (!label) return null;
  if (isShortRead(seconds, words)) {
    return (
      <span className="ink-warn" data-tt={SHORT_READ_TOOLTIP} data-tt-wrap tabIndex={0}>
        {label}
      </span>
    );
  }
  return <>{label}</>;
}

/** A check mark when the reader's browser reported the end on screen; nothing otherwise. */
function ReachedEndCell({ reached }: { reached: boolean | null }) {
  if (!reached) return null;
  return (
    <>
      <Check className="h-4 w-4 ink-ok" aria-hidden="true" />
      <span className="sr-only">Yes</span>
    </>
  );
}

export default async function AcknowledgementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));

  const [rows, former, settings] = await Promise.all([
    cachedAckRows(doc.id),
    ackFormerStaffRows(doc.id),
    getAppSettings(),
  ]);
  const fmt = settingsForUser(settings, user);
  const acked = rows.filter((r) => r.acknowledged_at);
  const pending = rows.filter((r) => !r.acknowledged_at);
  const anyInferred = [...rows, ...former].some((r) => r.rev && r.version_source === "inferred");
  // The threshold rule measures each read time against the live text: the
  // document people are asked to read today.
  const words = documentWordCount(doc.content ?? "");
  const anyConfirmed = acked.length > 0 || former.length > 0;

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

      {/* overflow-hidden keeps the rounded corners; the Table's own scroll
          wrapper carries the sideways scroll on a phone (seven columns, five
          of them nowrap, outgrow 375px). On paper the Table drops its minimum
          width and the wrapper its scroll, so the two evidence columns are
          not clipped by this card on a portrait page. */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
        {rows.length === 0 ? (
          <SectionEmpty className="px-4 py-6">
            No one is asked to confirm this document yet. Everyone who can see it is listed here once it
            is published.
          </SectionEmpty>
        ) : (
          <Table scroll minWidth="54rem">
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th fit>Status</Th>
                <Th fit>Confirmed</Th>
                <Th fit>Version</Th>
                <Th fit>Read time</Th>
                <Th fit>Reached end (self-reported)</Th>
              </tr>
            </thead>
            <tbody>
              {[...pending, ...acked].map((r) => (
                <tr key={r.id} className={TR}>
                  <Td>
                    <span className="font-medium text-slate-800">{r.name || r.username}</span>
                    {r.email && <span className="ml-2 text-xs text-slate-500">{r.email}</span>}
                  </Td>
                  <Td className="text-slate-500">{r.role}</Td>
                  <Td fit>
                    {r.acknowledged_at ? (
                      <span className={chipClass("ok")}>Confirmed</span>
                    ) : (
                      <span className={chipClass("warn")}>Pending</span>
                    )}
                  </Td>
                  <Td fit className="text-slate-500">
                    {r.acknowledged_at ? formatDateTime(r.acknowledged_at, fmt) : "—"}
                  </Td>
                  <Td fit className="text-slate-500">
                    <VersionCell row={r} />
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
        )}
      </div>

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
  rows: AckFormerStaffRow[];
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
      <Table scroll minWidth="50rem" className="mt-2">
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            <Th>Person</Th>
            <Th fit>Account</Th>
            <Th fit>Confirmed</Th>
            <Th fit>Version</Th>
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
