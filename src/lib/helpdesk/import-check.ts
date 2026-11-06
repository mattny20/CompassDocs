// Helpdesk 1.19.2: the import's dry run and the map step's rescan run in
// the background (agent W5, mock e1). Server-only.
//
// 1.19.1 ran both inside the request, so a large export held the page (and
// the request) for minutes. Now the routes queue a check and answer at once:
//
//   queueImportCheck   status → 'checking', check_kind 'dry_run' or
//                      'rescan', check_by the person who asked, the
//                      progress reset, heartbeat_at NULL (unclaimed). A dry
//                      run drops the previous dry run's counts.
//   runImportCheck     claims the job the way the import run does (lib:
//                      import.ts ImportLease): heartbeat_at is the lease
//                      token, set by the claim and moved by every progress
//                      write and by a timer between them, each write
//                      conditional on the token. A runner whose job was
//                      stopped, discarded or taken over (it looked stalled)
//                      writes nothing more. The dry run is import.ts's own
//                      plan (planDryRun), read-only, so the counts are the
//                      ones the import will meet; the rescan is scanExport.
//                      Done: the dry run's counts and status 'ready', or the
//                      new scan and mapping and 'uploaded'; the person who
//                      asked hears in the bell (catalog event
//                      hd_import_ready, bell only). Failed: back to
//                      'uploaded' with check_error, and the bell says so.
//   stopImportCheck    a dry run can be stopped (back to 'uploaded'); a
//                      rescan cannot (the mapping waits on it).
//   importCheckSweep   from import.ts importSweep (lib/periodic "hd_import"):
//                      a queued check nobody claimed, or a claimed one whose
//                      heartbeat stalled (the process died), starts again
//                      from the beginning (a check writes nothing until it
//                      ends, so starting over is safe).
//
// While a check runs, the job takes no mapping, file, start or discard
// (import.ts assertNotChecking). The import itself never overlaps a check:
// it needs status 'ready'. Progress (check_progress): rows checked of the
// rows the scan counted, the dry run's counts so far, and when it started,
// from which the page shows the time left.

import "server-only";
import { audit, type AuditActor } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne } from "./db-core";
import {
  IMPORT_STALL_MS,
  ImportError,
  assertScanCurrent,
  getImportJob,
  planDryRun,
  scanExport,
  type ImportJobRow,
} from "./import";
import type { ImportCheckKind, ImportCheckProgress, ImportCounts } from "./import-shared";

/** How often a running check refreshes its heartbeat between progress writes (well inside IMPORT_STALL_MS). */
export const IMPORT_CHECK_HEARTBEAT_MS = 30_000;
/** Progress is written at most this often. */
const PROGRESS_EVERY_MS = 750;
/** A queued check that no process claimed for this long is started by the sweep. */
const UNCLAIMED_MS = 10_000;

const BEAT_SQL = "date_trunc('milliseconds', clock_timestamp())";

/** The runner lost the job (stopped, discarded, or taken over after a stall). */
class CheckLost extends Error {}

interface Lease {
  jobId: number;
  at: Date;
  lost: boolean;
}

function totalsOf(job: ImportJobRow): { tickets: number; all: number } {
  const s = job.counts.scan;
  const tickets = s?.tickets ?? 0;
  return { tickets, all: tickets + (s?.messages ?? 0) + (s?.comments ?? 0) };
}

/**
 * Queue a background dry run or rescan of an uploaded (or dry-run) job for
 * `by`, and start it in this process. Answers the job as it now is.
 */
export async function queueImportCheck(id: number, kind: ImportCheckKind, by: number | null): Promise<ImportJobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  if (job.status === "checking") throw new ImportError("The export is being checked already.", 409);
  if (!["uploaded", "ready"].includes(job.status)) throw new ImportError("This import has already started.", 409);
  if (kind === "dry_run" && !("columns" in job.mapping)) throw new ImportError("Map the columns first.");
  // 1.19.2 review: never plan on a scan read with other columns or files (a rescan failed).
  if (kind === "dry_run") assertScanCurrent(job);
  const t = totalsOf(job);
  const now = new Date().toISOString();
  const progress: ImportCheckProgress = { kind, phase: "queued", done: 0, total: t.all, tickets_done: 0, tickets_total: t.tickets, started_at: now, updated_at: now };
  const row = await hqOne<ImportJobRow>(
    `UPDATE hd_import_jobs SET status = 'checking', check_kind = $2, check_progress = $3, check_by = $4, check_error = '', heartbeat_at = NULL,
            counts = CASE WHEN $2 = 'dry_run' THEN counts - 'dry_run' ELSE counts END, updated_at = now()
      WHERE id = $1 AND status IN ('uploaded', 'ready') RETURNING *`,
    [id, kind, JSON.stringify(progress), by]
  );
  if (!row) throw new ImportError("This import has already started.", 409);
  runImportCheckInBackground(id);
  return row;
}

/** Fire-and-forget (the sweep picks the check up if this process dies first). */
export function runImportCheckInBackground(id: number): void {
  void runImportCheck(id).catch((e) => logEvent("error", "helpdesk.import.check_background_failed", { job: id, error: e instanceof Error ? e.message : String(e) }));
}

async function writeProgress(lease: Lease, progress: ImportCheckProgress | null): Promise<void> {
  if (lease.lost) throw new CheckLost();
  const r = await hqOne<{ heartbeat_at: string | Date }>(
    `UPDATE hd_import_jobs SET heartbeat_at = ${BEAT_SQL}${progress ? ", check_progress = $3" : ""}
      WHERE id = $1 AND status = 'checking' AND heartbeat_at = $2 RETURNING heartbeat_at`,
    progress ? [lease.jobId, lease.at, JSON.stringify(progress)] : [lease.jobId, lease.at]
  );
  if (!r) {
    lease.lost = true;
    throw new CheckLost();
  }
  lease.at = new Date(r.heartbeat_at);
}

/** One write at a time per run: a progress write and the heartbeat timer never interleave (each moves the token). */
function serialiser(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
}

function shortCounts(c: ImportCounts): NonNullable<ImportCheckProgress["counts"]> {
  return { tickets_create: c.tickets_create, tickets_update: c.tickets_update, contacts_matched: c.contacts_matched, skipped: c.skipped };
}

/**
 * Claim and run one queued (or stalled) check to its end, a stop or a
 * failure. Never throws. Answers the job afterwards.
 */
export async function runImportCheck(id: number, opts: { heartbeatMs?: number } = {}): Promise<ImportJobRow | undefined> {
  const claimed = await hqOne<ImportJobRow>(
    `UPDATE hd_import_jobs SET heartbeat_at = ${BEAT_SQL}, updated_at = now()
      WHERE id = $1 AND status = 'checking' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))
      RETURNING *`,
    [id, IMPORT_STALL_MS / 1000]
  ).catch(() => undefined);
  if (!claimed?.heartbeat_at) return getImportJob(id);
  const lease: Lease = { jobId: id, at: new Date(claimed.heartbeat_at), lost: false };
  const kind: ImportCheckKind = claimed.check_kind === "rescan" ? "rescan" : "dry_run";
  const by = claimed.check_by ?? null;
  const exclusive = serialiser();
  const timer = setInterval(() => {
    void exclusive(() => writeProgress(lease, null)).catch(() => {});
  }, opts.heartbeatMs ?? IMPORT_CHECK_HEARTBEAT_MS);
  timer.unref?.();
  const t = totalsOf(claimed);
  const progress: ImportCheckProgress = {
    ...(claimed.check_progress ?? {}),
    kind,
    phase: "reading",
    done: 0,
    total: t.all,
    tickets_done: 0,
    tickets_total: t.tickets,
    // A restart after a stall starts the clock again (the time left is worked out from it).
    started_at: new Date().toISOString(),
    counting_at: undefined,
    counting_from: 0,
  };
  let last = 0;
  const report = async (patch: Partial<ImportCheckProgress>, force = false) => {
    Object.assign(progress, patch);
    if (!force && Date.now() - last < PROGRESS_EVERY_MS) {
      if (lease.lost) throw new CheckLost();
      return;
    }
    last = Date.now();
    progress.updated_at = new Date().toISOString();
    await exclusive(() => writeProgress(lease, { ...progress }));
  };
  try {
    await report({}, true);
    if (kind === "dry_run") {
      assertScanCurrent(claimed);
      const counts = await planDryRun(claimed, async (p) => {
        const done = p.phase === "messages" ? t.tickets + p.done : p.done;
        // The pace is measured from the first counted batch (the reading pass before it is a different speed).
        const start = p.phase !== "reading" && !progress.counting_at ? { counting_at: new Date().toISOString(), counting_from: done } : {};
        await report({ ...start, phase: p.phase, done, tickets_done: p.phase === "messages" ? t.tickets : p.done, counts: shortCounts(p.counts) });
      });
      const row = await exclusive(() =>
        hqOne<ImportJobRow>(
          `UPDATE hd_import_jobs SET counts = counts || jsonb_build_object('dry_run', $3::jsonb), status = 'ready', check_error = '',
                  check_progress = $4, updated_at = now()
            WHERE id = $1 AND status = 'checking' AND heartbeat_at = $2 RETURNING *`,
          [id, lease.at, JSON.stringify(counts), JSON.stringify({ ...progress, phase: "done", done: t.all, tickets_done: t.tickets, counts: shortCounts(counts), updated_at: new Date().toISOString() })]
        )
      );
      if (!row) throw new CheckLost();
      await tell(by, row, "ready", counts);
    } else {
      const { mapping, scan } = await scanExport(claimed, async (p) => {
        const start = !progress.counting_at ? { counting_at: progress.started_at, counting_from: 0 } : {};
        await report({ ...start, phase: "tickets", done: p.rows, total: Math.max(t.all, p.rows), tickets_done: p.tickets });
      });
      const row = await exclusive(() =>
        hqOne<ImportJobRow>(
          `UPDATE hd_import_jobs SET mapping = $3, counts = jsonb_build_object('scan', $4::jsonb), status = 'uploaded', check_error = '',
                  check_progress = $5, updated_at = now()
            WHERE id = $1 AND status = 'checking' AND heartbeat_at = $2 RETURNING *`,
          [
            id,
            lease.at,
            JSON.stringify(mapping),
            JSON.stringify(scan),
            JSON.stringify({ ...progress, phase: "done", done: scan.tickets + scan.messages + scan.comments, total: scan.tickets + scan.messages + scan.comments, updated_at: new Date().toISOString() }),
          ]
        )
      );
      if (!row) throw new CheckLost();
      await tell(by, row, "ready");
    }
  } catch (e) {
    if (e instanceof CheckLost || lease.lost) {
      logEvent("info", "helpdesk.import.check_stopped", { job: id, kind });
    } else {
      const message =
        e instanceof ImportError ? e.message : kind === "dry_run" ? "The dry run stopped on an unexpected error. Run it again." : "The export couldn't be read again. Save the columns again to retry.";
      logEvent("error", "helpdesk.import.check_failed", { job: id, kind, error: e instanceof Error ? e.message : String(e) });
      const row = await exclusive(() =>
        hqOne<ImportJobRow>(
          `UPDATE hd_import_jobs SET status = 'uploaded', check_error = $3, counts = counts - 'dry_run', updated_at = now()
            WHERE id = $1 AND status = 'checking' AND heartbeat_at = $2 RETURNING *`,
          [id, lease.at, message]
        )
      ).catch(() => undefined);
      if (row) await tell(by, row, "failed");
    }
  } finally {
    clearInterval(timer);
  }
  return getImportJob(id);
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The bell notice for the person who asked (catalog event hd_import_ready, bell only). */
async function tell(by: number | null, job: ImportJobRow, outcome: "ready" | "failed", counts?: ImportCounts): Promise<void> {
  if (!by) return;
  const dry = job.check_kind !== "rescan";
  const title =
    outcome === "failed"
      ? `${dry ? "Dry run" : "Reading the export"} stopped: ${job.filename}`
      : dry
        ? `Dry run ready: ${job.filename}`
        : `Export read with your columns: ${job.filename}`;
  const body =
    outcome === "failed"
      ? job.check_error
      : counts
        ? `${fmt(counts.tickets_create)} to create, ${fmt(counts.tickets_update)} to update${counts.skipped ? `, ${fmt(counts.skipped)} skipped` : ""}.`
        : "Check the values the new columns brought in, then run the dry run.";
  try {
    const { notify } = await import("../notifications");
    await notify([by], { kind: "hd_ticket", event: "hd_import_ready", title, body, link: `/desk/settings/import?job=${job.id}` });
  } catch (e) {
    logEvent("warn", "helpdesk.import.check_notice_failed", { job: job.id, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Stop a running dry run (a rescan can't be stopped: the mapping waits on it). */
export async function stopImportCheck(id: number, actor: AuditActor, ip: string | null = null): Promise<ImportJobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  if (job.status !== "checking") throw new ImportError("Nothing is being checked.", 409);
  if (job.check_kind === "rescan") throw new ImportError("Reading the export with new columns can't be stopped. It finishes on its own; you can leave the page.", 409);
  const row = await hqOne<ImportJobRow>(
    `UPDATE hd_import_jobs SET status = 'uploaded', heartbeat_at = NULL, counts = counts - 'dry_run', check_error = '', updated_at = now()
      WHERE id = $1 AND status = 'checking' AND check_kind = 'dry_run' RETURNING *`,
    [id]
  );
  if (!row) throw new ImportError("Nothing is being checked.", 409);
  const p = job.check_progress ?? {};
  await audit({
    actor,
    action: "helpdesk.import.check_stopped",
    targetType: "helpdesk_import",
    targetId: String(id),
    targetLabel: job.filename,
    details: { kind: "dry_run", done: p.done ?? 0, total: p.total ?? 0 },
    ip,
  });
  return row;
}

/** Audit the start of a background check (the routes call it after queueImportCheck). */
export async function auditCheckStarted(job: ImportJobRow, kind: ImportCheckKind, actor: AuditActor, ip: string | null = null): Promise<void> {
  await audit({
    actor,
    action: "helpdesk.import.check_started",
    targetType: "helpdesk_import",
    targetId: String(job.id),
    targetLabel: job.filename,
    details: { kind, source: job.source },
    ip,
  });
}

/**
 * From importSweep: start checks nobody is running (queued and never
 * claimed for a few seconds, or claimed with a stalled heartbeat). One or
 * two at a time; each claim is atomic, so a race with another instance or
 * with the route's own start is harmless.
 */
export async function importCheckSweep(): Promise<number> {
  const due = await hq<{ id: number }>(
    `SELECT id FROM hd_import_jobs
      WHERE status = 'checking'
        AND ((heartbeat_at IS NULL AND updated_at < now() - make_interval(secs => $1))
          OR heartbeat_at < now() - make_interval(secs => $2))
      ORDER BY id LIMIT 2`,
    [UNCLAIMED_MS / 1000, IMPORT_STALL_MS / 1000]
  );
  for (const j of due) runImportCheckInBackground(j.id);
  return due.length;
}
