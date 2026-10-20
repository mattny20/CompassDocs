"use client";

// Compliance › Evidence (F2, 1.14.0): the tamper-evident record of the
// read-confirmation programme. A snapshot is taken automatically every
// month and stores the exact records as canonical JSON text with its
// SHA-256; a manager can take one now; a retire writes one for the policy.
// The audit package streams everything as one ZIP with a hash manifest.
// The page lists the stored snapshots newest first with the hash prefix
// (the full hash copies), Verify (the server recomputes the hash over the
// stored text) and the download (the exact text, with the hash in
// X-Content-SHA256 so sha256sum reproduces it). The page header and the
// sub-navigation are the section layout's; the guard is the server page's
// (compliance.export: the hashes are evidence handles, and every download
// carries personal data). No manifest is stored between packages, so the
// hash printed beside the package button is the latest monthly snapshot's
// (the one the report email anchors), or the latest of any kind until a
// month has passed. On paper the controls hide and the record stays
// (STYLEGUIDE §Print).

import { useCallback, useEffect, useState } from "react";
import { Camera, CircleAlert, Download, Package } from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState } from "@/components/form";
import { LicenseGate } from "@/components/LicenseGate";
import { Pager } from "@/components/Pager";
import { LoadingRow } from "@/components/Spinner";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { useAction } from "@/lib/use-action";
import { pageOf, type PortalPageProps } from "./use-portal";

/** One row of GET /api/admin/compliance/snapshots, as the route answers it. */
export interface SnapshotRow {
  id: number;
  taken_at: string;
  kind: "manual" | "monthly" | "retirement";
  /** 'YYYY-MM' on a monthly snapshot; '' otherwise. */
  period: string;
  /** The retired policy of a retirement snapshot; null otherwise, and once that document is purged. */
  document_id: number | null;
  document_title: string | null;
  /** 'system' when the orchestrator took it. */
  taken_by_name: string;
  sha256: string;
}

/** The server page's props: the portal's, plus whether the viewer may take a snapshot (compliance.program_manage, the POST's own gate). */
export interface EvidencePageProps extends PortalPageProps {
  canManage: boolean;
}

/** The lead sentence (items/F2.md, verbatim). */
export const EVIDENCE_LEAD =
  "A snapshot is taken automatically every month; each stores the exact records with a SHA-256 an auditor can verify. The audit package bundles everything as one ZIP.";

const SNAPSHOT_PAGE = 25;
/** The hash prefix shown and toasted; the copy control carries the whole hash. */
const PREFIX = 12;

const KIND_LABEL: Record<SnapshotRow["kind"], string> = { monthly: "Monthly", manual: "Manual", retirement: "Retirement" };

/** How a row is named in its download control: the period of a monthly snapshot ("2026-09"), the id of any other ("#12"). */
function snapshotHandle(s: SnapshotRow): string {
  return s.kind === "monthly" && s.period ? s.period : `#${s.id}`;
}

export function Evidence({ licensed, canManageLicense = false, canManage }: EvidencePageProps) {
  const fmt = useFormatDate();
  const { run, isBusy } = useAction();
  const [rows, setRows] = useState<SnapshotRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/compliance/snapshots");
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || "Couldn't load the snapshots.");
      setRows((d?.rows ?? []) as SnapshotRow[]);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load the snapshots.");
    }
  }, []);
  useEffect(() => {
    if (licensed) void load();
  }, [licensed, load]);

  // One POST through useAction (STYLEGUIDE §Feedback): the server's error
  // or the fallback is toasted; the new hash's prefix is the success line,
  // and the list reloads so the row is on screen, newest first.
  async function takeSnapshot() {
    const box: { sha256?: string } = {};
    const ok = await run(
      "take",
      async () => {
        const res = await fetch("/api/admin/compliance/snapshots", { method: "POST" });
        if (res.ok) box.sha256 = ((await res.clone().json().catch(() => ({}))) as { sha256?: string }).sha256;
        return res;
      },
      { fallback: "Couldn't take the snapshot.", refresh: false }
    );
    if (!ok) return;
    toast("ok", `Snapshot stored · sha256 ${(box.sha256 ?? "").slice(0, PREFIX)}`);
    setPage(0);
    await load();
  }

  // Verify asks the server to recompute the hash over the stored text; a
  // mismatch is an error toast, because it means the record changed.
  function verify(s: SnapshotRow) {
    return run(
      `verify-${s.id}`,
      async () => {
        const res = await fetch(`/api/admin/compliance/snapshots/${s.id}?verify=1`);
        if (res.ok) {
          const d = (await res.clone().json().catch(() => ({}))) as { ok?: boolean };
          if (d.ok) toast("ok", "Hash matches");
          else toast("error", "Hash does not match the stored record");
        }
        return res;
      },
      { fallback: "Couldn't verify the snapshot.", refresh: false }
    );
  }

  if (!licensed) return <LicenseGate feature="Evidence" entitlement="policy_ack" canManage={canManageLicense} />;
  if (loadError && !rows) {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't load the snapshots"
        body={loadError}
        action={{ onClick: () => void load(), label: "Try again" }}
      />
    );
  }
  if (!rows) return <LoadingRow className="py-10" />;

  // The hash an auditor is told to look for: the latest monthly snapshot's
  // (the report email carries the same), or the latest of any kind until a
  // month has passed. Printed, not a control, so it survives paper.
  const anchor = rows.find((s) => s.kind === "monthly") ?? rows[0] ?? null;
  const pager =
    rows.length > SNAPSHOT_PAGE ? <Pager page={page} limit={SNAPSHOT_PAGE} total={rows.length} onPage={setPage} /> : null;

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{EVIDENCE_LEAD}</p>

      <div className="flex flex-wrap items-center gap-3">
        {canManage && (
          <Button
            variant="secondary"
            icon={<Camera />}
            busy={isBusy("take")}
            onClick={() => void takeSnapshot()}
            className="print:hidden"
          >
            Take snapshot now
          </Button>
        )}
        {/* A plain anchor: a Link would prefetch the download, and every
            package is built on request and audited. */}
        <a href="/api/admin/compliance/audit-package" className={buttonClass("primary", "md", "print:hidden")}>
          <Package className="h-4 w-4" aria-hidden /> Audit package (ZIP)
        </a>
        {anchor && (
          <p className="text-xs text-slate-500">
            {anchor.kind === "monthly" ? `Monthly snapshot ${anchor.period}` : "Latest snapshot"} · sha256{" "}
            <code className="font-mono text-slate-700">{anchor.sha256.slice(0, PREFIX)}</code>
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Camera />}
          title="No snapshots yet"
          body="Monthly snapshots start automatically; take one now for a point-in-time record."
        />
      ) : (
        <Card title="Snapshots" icon={<Camera />} padding="none">
          {pager && <div className="border-b border-slate-100 px-4 py-2">{pager}</div>}
          <Table scroll>
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th fit>Taken</Th>
                <Th>Kind</Th>
                <Th>SHA-256</Th>
                <Th fit align="right" className="print:hidden">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {pageOf(rows, page, SNAPSHOT_PAGE).map((s) => {
                const handle = snapshotHandle(s);
                return (
                  <tr key={s.id} className={TR}>
                    <Td fit>
                      <span className="block text-slate-700">{fmt.date(s.taken_at)}</span>
                      <span className="block text-xs text-slate-500">
                        {!s.taken_by_name || s.taken_by_name === "system" ? "automatic" : `by ${s.taken_by_name}`}
                      </span>
                    </Td>
                    <Td>
                      <span className={chipClass("neutral", "sm")}>{KIND_LABEL[s.kind]}</span>
                      {s.kind === "monthly" && s.period && <span className="ml-2 text-xs text-slate-500">{s.period}</span>}
                      {s.kind === "retirement" && (
                        <span className="ml-2 text-xs text-slate-500">
                          {s.document_title ?? (s.document_id ? `Policy #${s.document_id}` : "a purged policy")}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1">
                        <code className="font-mono text-xs text-slate-700">{s.sha256.slice(0, PREFIX)}</code>
                        <CopyButton text={s.sha256} label="Copy SHA-256" iconOnly className="print:hidden" />
                      </span>
                    </Td>
                    <Td fit align="right" className="print:hidden">
                      <span className="inline-flex items-center gap-1">
                        <Button variant="secondary" size="sm" busy={isBusy(`verify-${s.id}`)} onClick={() => void verify(s)}>
                          Verify
                        </Button>
                        <a
                          href={`/api/admin/compliance/snapshots/${s.id}`}
                          className={iconButtonClass("quiet")}
                          data-tt={`Download snapshot ${handle}`}
                          aria-label={`Download snapshot ${handle}`}
                        >
                          <Download aria-hidden />
                        </a>
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Verify recomputes the hash over the stored record. A download is that record byte for byte, with the hash in
            its X-Content-SHA256 header, so sha256sum on the file reproduces it.
          </p>
          {pager && <div className="border-t border-slate-100 px-4 py-2">{pager}</div>}
        </Card>
      )}
    </div>
  );
}
