import { Chip, chipClass } from "@/components/Chip";
import { ackFormerStaffRows } from "@/lib/db";
import type { AckStatusRow, AckFormerStaffRow } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime, settingsForUser } from "@/lib/format";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
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

const INFERRED_TT =
  "Version inferred from the confirmation time; confirmations before 1.10.0 did not record it";

/** "v12", with the inferred tooltip on rows from before 1.10.0. */
function VersionCell({ row }: { row: Pick<AckStatusRow, "rev" | "version_source"> }) {
  if (!row.rev) return <>—</>;
  if (row.version_source === "inferred") {
    return (
      <span data-tt={INFERRED_TT} data-tt-wrap="" className="inline-flex items-center gap-1.5">
        v{row.rev}
        <span className="text-xs text-slate-500">(inferred)</span>
      </span>
    );
  }
  return <>v{row.rev}</>;
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

  return (
    <>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-compass-500"
          style={{ width: `${rows.length ? Math.round((acked.length / rows.length) * 100) : 0}%` }}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
        <Table>
          <thead className={TABLE_HEAD_ROW}>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th fit>Status</Th>
              <Th fit>Confirmed</Th>
              <Th fit>Version</Th>
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
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      {former.length > 0 && <FormerStaff rows={former} fmt={fmt} />}
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
}: {
  rows: AckFormerStaffRow[];
  fmt: Parameters<typeof formatDateTime>[1];
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
      <Table className="mt-2">
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            <Th>Person</Th>
            <Th fit>Account</Th>
            <Th fit>Confirmed</Th>
            <Th fit>Version</Th>
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
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}
