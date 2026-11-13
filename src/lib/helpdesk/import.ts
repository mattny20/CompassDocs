// Helpdesk 1.19.1: import tickets from a Zoho Desk export (a zip of CSVs)
// or a generic CSV (one row per ticket, optional messages CSV), in four
// steps the wizard at /desk/settings/import walks: upload → map → dry run
// → import. Server-only.
//
//   upload    the file streams to the uploads volume (capped by the
//             "Largest upload" setting, default 200 MB) and is scanned:
//             headers, recognised files, the departments, statuses,
//             priorities, agents and contacts in it, and a first mapping.
//   map       the admin adjusts columns and values; saved on the job.
//   dry run   the whole export is planned with the same code the import
//             runs, writing nothing: counts to create and update, contacts
//             matched or kept, attachments, and every skipped row with its
//             reason (the download).
//   import    a background job (startImport → runImportJob) in batches of
//             one transaction each, with the cursor saved in the same
//             transaction, so a cancel stops between batches and a resume
//             (or a restart: the periodic sweep picks up a stalled job)
//             carries on from the last committed row.
//
// What an import never does: it writes rows directly and calls none of
// lib/helpdesk/events (afterTicketCreated / afterMessageAdded /
// afterTicketUpdated / afterTicketSolved), createTicket, addMessage or
// updateTicket. So no notification, email, push, auto-assignment, rule,
// workflow or newbie review runs for an imported ticket or message.
// test/helpdesk-import.test.ts checks both the effects and this file's
// imports.
//
// Idempotent: each ticket keeps the source's id (hd_tickets.import_source
// + import_ref, unique) and each message its own (hd_messages.import_ref,
// unique per ticket); a re-run updates them in place. import_source is the
// source KEY (import-shared importSourceKey): "zoho", or "csv:<name>" for a
// CSV source the admin names (default: the file's name), so two systems'
// ids never meet; CSV jobs from before names keep "csv". A ticket
// anonymised since (lib/helpdesk/retention) is never written again: its
// rows are skipped with the reason, so erased data does not come back. New tickets take the
// next numbers from the ticket sequence; the source number is kept as
// source_ref.import_label ("Zoho #1234") and shown on the ticket.
//
// Timestamps: a ticket keeps its created time, and solved/closed time; a
// message its author and time; first_replied_at is the first agent public
// message. SLA: a solved or closed ticket gets no clocks. An open one gets
// its reply and resolution dues computed FROM THE IMPORT TIME on its team's
// calendar and targets (as if it had just arrived), never from its old
// created time, which would breach everything at once; a ticket the source
// already answered has its first reply stamped, so only resolution runs.
// Waiting and on-hold tickets start paused.

import "server-only";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import type { PoolClient } from "pg";
import { hq, hqOne, withTx } from "./db-core";
import { uploadDir, saveUpload, deleteUpload } from "../uploads";
import { getSetting, setSetting } from "../db";
import { audit } from "../audit";
import { logEvent } from "../log";
import { csvRows, csvLine } from "./import-csv";
import { isZipFile, openZipEntry, readZipDirectory, readZipEntry, ZipError, type ZipEntry } from "./import-zip";
import { importBodyToMarkdown } from "./import-body";
import { textToSafeMarkdown } from "./inbound-parse";
import { AttachmentRejectedError, ATTACHMENT_LIMITS, classifyUpload, cleanFilename } from "./attachments";
import { assignable, newTicketReplyToken, helpdeskTimezone } from "./tickets";
import { computeDues } from "./sla";
import { hoursForTeam, slaPolicyForTeam } from "./calendars";
import { createTeam } from "./teams";
import {
  AGENT_ALIASES,
  CONTACT_ALIASES,
  DEPARTMENT_ALIASES,
  IMPORT_REF_PREFIX,
  IMPORT_SKIPPED_KEEP,
  REQUIRED_MESSAGE_FIELDS,
  classifyCsvName,
  cleanEmail,
  cleanName,
  cleanSourceName,
  defaultPriorityFor,
  defaultSourceName,
  defaultStatusFor,
  detectDateOrder,
  emptyCounts,
  guessMessageColumns,
  guessTicketColumns,
  importSourceKey,
  isHdPriority,
  isHdStatus,
  naturalCompare,
  normKey,
  normTag,
  parseSourceDate,
  pickHeader,
  splitList,
  truthy,
} from "./import-shared";
import type {
  DepartmentTarget,
  ImportCheckProgress,
  ImportCounts,
  ImportFileKind,
  ImportJobStatus,
  ImportJobView,
  ImportMapping,
  ImportProgress,
  ImportScan,
  ImportScanAgent,
  ImportSkippedRow,
  ImportSource,
  MessageField,
  StatusTarget,
  TicketField,
} from "./import-shared";
import type { HdMessageVia, HdPriority, HdSource, HdStatus } from "./types";

export class ImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// --- Settings ------------------------------------------------------------------------

export const IMPORT_SETTINGS_KEY = "helpdesk_import";
export const IMPORT_DEFAULT_MAX_MB = 200;
export const IMPORT_MAX_MB_CEILING = 2048;
/** Batches: tickets and messages per transaction. */
export const IMPORT_BATCH = { tickets: 100, messages: 200 } as const;
/** Upload files are kept this long when a job never finishes. */
export const IMPORT_FILE_TTL_MS = 7 * 24 * 3_600_000;
/** A running job with no heartbeat for this long is resumed by the sweep. */
export const IMPORT_STALL_MS = 3 * 60_000;

export interface ImportSettings {
  max_upload_mb: number;
}

export async function getImportSettings(): Promise<ImportSettings> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse((await getSetting(IMPORT_SETTINGS_KEY)) ?? "{}") ?? {};
  } catch {
    raw = {};
  }
  const n = Number(raw.max_upload_mb);
  return { max_upload_mb: Number.isInteger(n) && n >= 1 && n <= IMPORT_MAX_MB_CEILING ? n : IMPORT_DEFAULT_MAX_MB };
}

export async function saveImportSettings(input: Partial<ImportSettings>): Promise<ImportSettings> {
  const n = Number(input.max_upload_mb);
  if (!Number.isInteger(n) || n < 1 || n > IMPORT_MAX_MB_CEILING) throw new ImportError(`The largest upload must be a whole number of MB from 1 to ${IMPORT_MAX_MB_CEILING}.`);
  await setSetting(IMPORT_SETTINGS_KEY, JSON.stringify({ max_upload_mb: n }));
  return { max_upload_mb: n };
}

// --- Files ---------------------------------------------------------------------------

const STORED_RE = /^[a-f0-9]{32}\.(zip|csv)$/;

function importDir(): string {
  return join(uploadDir(), "hd-import");
}

function storedPath(name: string): string {
  if (!STORED_RE.test(name)) throw new ImportError("That upload is not available.", 404);
  return join(importDir(), name);
}

export interface ImportFiles {
  /** The main upload (a zip, or the tickets CSV). */
  main: string;
  main_kind: "zip" | "csv";
  /** A generic import's messages CSV, uploaded second. */
  messages?: string;
  messages_filename?: string;
  size: number;
}

/**
 * Stream a request body to the import folder, refusing it past `maxBytes`
 * (the partial file is removed). Returns the stored name and size.
 */
export async function saveImportUpload(body: ReadableStream<Uint8Array> | null, maxBytes: number, ext: "zip" | "csv" | "bin"): Promise<{ name: string; size: number }> {
  if (!body) throw new ImportError("Choose a file to upload.");
  await mkdir(importDir(), { recursive: true });
  const name = `${randomBytes(16).toString("hex")}.${ext === "bin" ? "csv" : ext}`;
  const path = join(importDir(), name);
  const out = createWriteStream(path);
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ImportError(`That file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 413);
      }
      if (!out.write(value)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (e) {
    out.destroy();
    await unlink(path).catch(() => {});
    throw e;
  }
  if (size === 0) {
    await unlink(path).catch(() => {});
    throw new ImportError("The file is empty.");
  }
  return { name, size };
}

async function removeStored(name: string | undefined): Promise<void> {
  if (!name || !STORED_RE.test(name)) return;
  await unlink(join(importDir(), name)).catch(() => {});
}

async function removeJobFiles(files: ImportFiles | Record<string, never>): Promise<void> {
  const f = files as Partial<ImportFiles>;
  await removeStored(f.main);
  await removeStored(f.messages);
}

// --- Jobs --------------------------------------------------------------------------------

interface JobRow {
  id: number;
  created_by: number | null;
  created_by_name: string;
  source: ImportSource;
  status: ImportJobStatus;
  filename: string;
  files: ImportFiles | Record<string, never>;
  counts: {
    scan?: ImportScan;
    dry_run?: ImportCounts;
    result?: ImportCounts;
    teams?: Record<string, number>;
  };
  mapping: ImportMapping | Record<string, never>;
  progress: ImportProgress;
  error: string;
  created_at: string;
  updated_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
  // 1.19.2 (agent W5, lib/helpdesk/import-check): the background dry run / rescan.
  check_kind?: string;
  check_progress?: ImportCheckProgress;
  check_by?: number | null;
  check_error?: string;
}

export type ImportJobRow = JobRow;

export async function getImportJob(id: number): Promise<JobRow | undefined> {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return hqOne<JobRow>("SELECT * FROM hd_import_jobs WHERE id = $1", [id]);
}

async function nextTicketNumber(): Promise<number | null> {
  const r = await hqOne<{ last_value: string; is_called: boolean }>("SELECT last_value, is_called FROM hd_ticket_number_seq").catch(() => undefined);
  if (!r) return null;
  return Number(r.last_value) + (r.is_called ? 1 : 0);
}

function stripSkipped(c: ImportCounts | undefined): Omit<ImportCounts, "skipped_rows"> | null {
  if (!c) return null;
  const { skipped_rows: _drop, ...rest } = c;
  return rest;
}

export async function jobView(row: JobRow): Promise<ImportJobView> {
  const files = row.files as Partial<ImportFiles>;
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    filename: row.filename,
    size: files.size ?? 0,
    has_messages_file: !!files.messages,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    finished_at: row.finished_at,
    error: row.error,
    mapping: "columns" in row.mapping ? (row.mapping as ImportMapping) : null,
    scan: row.counts.scan ?? null,
    dry_run: stripSkipped(row.counts.dry_run),
    result: stripSkipped(row.counts.result),
    progress: row.progress ?? {},
    check: {
      kind: row.check_kind === "dry_run" || row.check_kind === "rescan" ? row.check_kind : null,
      progress: row.check_progress ?? {},
      error: row.check_error ?? "",
    },
    next_number: await nextTicketNumber(),
  };
}

export async function listImportJobs(limit = 10): Promise<JobRow[]> {
  return hq<JobRow>("SELECT * FROM hd_import_jobs WHERE status <> 'discarded' ORDER BY id DESC LIMIT $1", [limit]);
}

/** Create a job for a stored upload; checks it is the kind of file the source needs, then scans it. */
export async function createImportJob(input: {
  source: ImportSource;
  filename: string;
  stored: { name: string; size: number };
  actor: { id: number; name: string };
}): Promise<JobRow> {
  const path = storedPath(input.stored.name);
  const zip = await isZipFile(path);
  if (input.source === "zoho" && !zip) {
    await removeStored(input.stored.name);
    throw new ImportError("A Zoho Desk export is a .zip file. Download the export again, or choose CSV.");
  }
  let mainName = input.stored.name;
  // The stored name's extension follows what the file is, not what it was called.
  const wantExt = zip ? "zip" : "csv";
  if (!mainName.endsWith(`.${wantExt}`)) {
    const renamed = mainName.replace(/\.(zip|csv)$/, `.${wantExt}`);
    const { rename } = await import("node:fs/promises");
    await rename(path, storedPath(renamed));
    mainName = renamed;
  }
  const files: ImportFiles = { main: mainName, main_kind: zip ? "zip" : "csv", size: input.stored.size };
  const row = await hqOne<JobRow>(
    `INSERT INTO hd_import_jobs (created_by, created_by_name, source, status, filename, files)
     VALUES ($1, $2, $3, 'uploaded', $4, $5) RETURNING *`,
    [input.actor.id, input.actor.name, input.source, cleanFilename(input.filename).slice(0, 200), JSON.stringify(files)]
  );
  try {
    return await rescanJob(row!.id);
  } catch (e) {
    await discardImportJob(row!.id);
    throw e;
  }
}

/** Attach (or replace) a generic import's messages CSV, then rescan. */
export async function attachMessagesFile(
  id: number,
  stored: { name: string; size: number },
  filename: string,
  /** 1.19.2: read the export again in the background (lib/helpdesk/import-check), for this person. */
  opts: { background?: { by: number | null } } = {}
): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  assertNotChecking(job);
  if (!["uploaded", "ready"].includes(job.status)) throw new ImportError("This import has already started.", 409);
  if (job.source !== "csv") throw new ImportError("Only a CSV import takes a separate messages file.");
  if (await isZipFile(storedPath(stored.name))) {
    await removeStored(stored.name);
    throw new ImportError("The messages file must be a CSV file.");
  }
  const files = job.files as ImportFiles;
  const next: ImportFiles = { ...files, messages: stored.name, messages_filename: cleanFilename(filename), size: files.size + stored.size };
  // 1.19.2 review: only while the job still takes a file (a check or an
  // import that began since the read is never overwritten), and the old file
  // goes only once the new one is recorded.
  const written = await hqOne<JobRow>(
    "UPDATE hd_import_jobs SET files = $2, updated_at = now() WHERE id = $1 AND status IN ('uploaded', 'ready') RETURNING *",
    [id, JSON.stringify(next)]
  );
  if (!written) {
    await removeStored(stored.name);
    throw await changedUnderneath(id);
  }
  await removeStored(files.messages);
  if (opts.background) return (await import("./import-check")).queueImportCheck(id, "rescan", opts.background.by);
  return rescanJob(id);
}

/** A background check holds the job (1.19.2, lib/helpdesk/import-check): nothing else changes it meanwhile. */
function assertNotChecking(job: JobRow): void {
  if (job.status === "checking") throw new ImportError("The export is being checked. Wait for it to finish, or stop the check.", 409);
}

/** The refusal when a conditional write found the job moved on since it was read (a check or an import began). */
async function changedUnderneath(id: number): Promise<ImportError> {
  const now = await getImportJob(id);
  if (now?.status === "checking") return new ImportError("The export is being checked. Wait for it to finish, or stop the check.", 409);
  if (!now || now.status === "discarded") return new ImportError("That import was not found.", 404);
  return new ImportError("This import has already started.", 409);
}

/**
 * What a scan was made from (1.19.2 review): the column choices and the
 * files. A scan whose basis no longer matches the job (new columns or a new
 * messages file saved, and the rescan failed or hasn't run) is stale: the
 * next save reads the export again, and the dry run refuses to plan on it.
 */
export function scanBasis(columns: ImportMapping["columns"] | undefined, files: Partial<ImportFiles> | Record<string, never>): string {
  const flat = (["tickets", "messages", "comments"] as const)
    .flatMap((kind) => Object.entries((columns?.[kind] ?? {}) as Record<string, string>).filter(([, h]) => h).map(([f, h]) => `${kind}.${f}=${h}`))
    .sort();
  const f = files as Partial<ImportFiles>;
  return [...flat, `files=${f.main ?? ""}|${f.messages ?? ""}`].join("\n");
}

/** The job's scan was made from its current columns and files (a scan from before 1.19.2 has no basis and counts as current). */
export function scanIsCurrent(job: Pick<JobRow, "counts" | "mapping" | "files">): boolean {
  const basis = job.counts.scan?.basis;
  if (!basis) return true;
  return basis === scanBasis("columns" in job.mapping ? (job.mapping as ImportMapping).columns : undefined, job.files);
}

/** The dry run's refusal on a stale scan. */
export function assertScanCurrent(job: Pick<JobRow, "counts" | "mapping" | "files">): void {
  if (!scanIsCurrent(job)) {
    throw new ImportError("The export hasn't been read with these columns and files yet. Save the mapping to read it again, then run the dry run.", 409);
  }
}

export async function discardImportJob(id: number): Promise<JobRow | undefined> {
  const job = await getImportJob(id);
  if (!job) return undefined;
  if (job.status === "running" || job.status === "queued" || job.status === "cancelling") throw new ImportError("Stop the import before discarding it.", 409);
  assertNotChecking(job);
  await removeJobFiles(job.files);
  return hqOne<JobRow>("UPDATE hd_import_jobs SET status = 'discarded', files = '{}', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE id = $1 RETURNING *", [id]);
}

// --- Reading an export -------------------------------------------------------------------

interface Layout {
  source: ImportSource;
  path: string;
  kind: "zip" | "csv";
  messagesPath?: string;
  /** Per kind, the CSV entries (zip) in order. */
  entries: Partial<Record<ImportFileKind, ZipEntry[]>>;
  /** Non-CSV entries by lower-cased base name. */
  attachments: Map<string, ZipEntry[]>;
  attachmentCount: number;
  ignored: string[];
  /** Per-entry inflate cap. */
  entryMax: number;
}

const baseName = (p: string) => (p.split("/").pop() ?? p).toLowerCase();

async function openLayout(job: JobRow): Promise<Layout> {
  const files = job.files as Partial<ImportFiles>;
  if (!files.main) throw new ImportError("This import's file is no longer available. Upload it again.", 410);
  const path = storedPath(files.main);
  try {
    await stat(path);
  } catch {
    throw new ImportError("This import's file is no longer available. Upload it again.", 410);
  }
  const { max_upload_mb } = await getImportSettings();
  const layout: Layout = {
    source: job.source,
    path,
    kind: files.main_kind ?? "csv",
    messagesPath: files.messages ? storedPath(files.messages) : undefined,
    entries: {},
    attachments: new Map(),
    attachmentCount: 0,
    ignored: [],
    entryMax: Math.min(max_upload_mb * 1024 * 1024 * 20, 8 * 1024 * 1024 * 1024),
  };
  if (layout.kind !== "zip") return layout;
  let entries: ZipEntry[];
  try {
    entries = await readZipDirectory(path);
  } catch (e) {
    throw new ImportError(e instanceof ZipError ? e.message : "The zip can't be read.");
  }
  const unknownCsv: ZipEntry[] = [];
  for (const e of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
    if (e.directory || /(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
    const kind = classifyCsvName(e.name);
    if (kind) (layout.entries[kind] ??= []).push(e);
    else if (e.name.toLowerCase().endsWith(".csv")) unknownCsv.push(e);
    else {
      const k = baseName(e.name);
      const list = layout.attachments.get(k) ?? [];
      list.push(e);
      layout.attachments.set(k, list);
      layout.attachmentCount++;
    }
  }
  // A generic zip whose CSVs have other names: the first is the tickets, a second the messages.
  if (!layout.entries.tickets && unknownCsv.length) layout.entries.tickets = [unknownCsv.shift()!];
  if (job.source === "csv" && !layout.entries.threads && unknownCsv.length) layout.entries.threads = [unknownCsv.shift()!];
  layout.ignored = unknownCsv.map((e) => e.name);
  return layout;
}

interface SourceRow {
  file: string;
  line: number;
  values: Record<string, string>;
}

/** Every row of one kind of file, in order (split files one after another). */
async function* rowsOf(layout: Layout, kind: ImportFileKind, onHeaders?: (h: string[]) => void): AsyncGenerator<SourceRow> {
  if (layout.kind === "csv") {
    const path = kind === "tickets" ? layout.path : kind === "threads" ? layout.messagesPath : undefined;
    if (!path) return;
    const file = kind === "tickets" ? "tickets.csv" : "messages.csv";
    for await (const r of csvRows(createReadStream(path), onHeaders)) yield { file, line: r.line, values: r.values };
    return;
  }
  let first = true;
  for (const e of layout.entries[kind] ?? []) {
    const stream = await openZipEntry(layout.path, e, layout.entryMax);
    const file = e.name;
    try {
      for await (const r of csvRows(stream, (h) => {
        if (first) onHeaders?.(h);
        first = false;
      })) {
        yield { file, line: r.line, values: r.values };
      }
    } catch (err) {
      if (err instanceof ZipError) throw new ImportError(err.message);
      throw err;
    } finally {
      stream.destroy();
    }
  }
}

async function headersOf(layout: Layout, kind: ImportFileKind): Promise<string[]> {
  let headers: string[] = [];
  const it = rowsOf(layout, kind, (h) => {
    headers = h;
  });
  try {
    await it.next();
  } finally {
    await it.return?.(undefined);
  }
  return headers;
}

// --- Side tables (Zoho) ------------------------------------------------------------------

interface Person {
  name: string;
  email: string;
}

interface Lookups {
  departments: Map<string, string>;
  agents: Map<string, Person>;
  contacts: Map<string, Person>;
  /** Emails the export says are agents (the agents file and ticket owners). */
  agentEmails: Set<string>;
}

function personFrom(values: Record<string, string>, headers: string[], aliases: typeof CONTACT_ALIASES): { id: string; person: Person } {
  const get = (keys: string[]) => {
    const h = pickHeader(headers, keys);
    return h ? (values[h] ?? "").trim() : "";
  };
  const name = get(aliases.name) || [get(aliases.first), get(aliases.last)].filter(Boolean).join(" ");
  return { id: get(aliases.id), person: { name: cleanName(name), email: cleanEmail(get(aliases.email)) } };
}

async function loadLookups(layout: Layout): Promise<Lookups> {
  const lk: Lookups = { departments: new Map(), agents: new Map(), contacts: new Map(), agentEmails: new Set() };
  let headers: string[] = [];
  for await (const r of rowsOf(layout, "departments", (h) => (headers = h))) {
    const id = (r.values[pickHeader(headers, DEPARTMENT_ALIASES.id)] ?? "").trim();
    const name = (r.values[pickHeader(headers, DEPARTMENT_ALIASES.name)] ?? "").trim();
    if (id && name) lk.departments.set(id, name);
  }
  headers = [];
  for await (const r of rowsOf(layout, "agents", (h) => (headers = h))) {
    const { id, person } = personFrom(r.values, headers, AGENT_ALIASES);
    if (id) lk.agents.set(id, person);
    if (person.email) lk.agentEmails.add(person.email);
  }
  headers = [];
  for await (const r of rowsOf(layout, "contacts", (h) => (headers = h))) {
    const { id, person } = personFrom(r.values, headers, CONTACT_ALIASES);
    if (id) lk.contacts.set(id, person);
  }
  return lk;
}

// --- Users -------------------------------------------------------------------------------

interface UserHit {
  id: number;
  name: string;
}

/** Accounts by lower-cased email (an active account wins over a disabled one). */
async function usersByEmail(emails: Iterable<string>): Promise<Map<string, UserHit>> {
  const all = [...new Set([...emails].filter(Boolean))];
  const out = new Map<string, UserHit>();
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await hq<{ id: number; name: string; username: string; email: string }>(
      `SELECT DISTINCT ON (lower(email)) id, name, username, lower(email) AS email FROM users
        WHERE lower(email) = ANY($1::text[]) AND email <> ''
        ORDER BY lower(email), (status = 'active') DESC, id`,
      [all.slice(i, i + 1000)]
    );
    for (const r of rows) out.set(r.email, { id: r.id, name: r.name || r.username });
  }
  return out;
}

// --- Tickets: extraction and planning --------------------------------------------------

interface RawTicket {
  ref: string;
  number: string;
  subject: string;
  body: string;
  status: string;
  priority: string;
  department: string;
  agent: Person;
  contact: Person;
  created: string;
  closed: string;
  tags: string[];
  category: string;
  channel: string;
  escalated: boolean;
}

function cell(values: Record<string, string>, header: string | undefined): string {
  return header ? (values[header] ?? "").trim() : "";
}

function extractTicket(values: Record<string, string>, cols: Partial<Record<TicketField, string>>, lk: Lookups): RawTicket {
  const c = (f: TicketField) => cell(values, cols[f]);
  let department = c("department");
  if (!department && c("department_id")) department = lk.departments.get(c("department_id")) ?? "";
  if (/^\d{6,}$/.test(department) && lk.departments.has(department)) department = lk.departments.get(department)!;
  const agentById = c("agent_id") ? lk.agents.get(c("agent_id")) : undefined;
  const agent: Person = {
    name: cleanName(c("agent_name")) || agentById?.name || "",
    email: cleanEmail(c("agent_email")) || agentById?.email || "",
  };
  const contactById = c("contact_id") ? lk.contacts.get(c("contact_id")) : undefined;
  const rawEmail = c("contact_email");
  const contact: Person = {
    name: cleanName(c("contact_name")) || contactById?.name || (rawEmail.includes("<") ? cleanName(rawEmail) : ""),
    email: cleanEmail(rawEmail) || contactById?.email || "",
  };
  return {
    ref: c("ref"),
    number: c("number").replace(/^#/, ""),
    subject: c("subject"),
    body: values[cols.body ?? ""] ?? "",
    status: c("status"),
    priority: c("priority"),
    department,
    agent,
    contact,
    created: c("created_at"),
    closed: c("closed_at"),
    tags: splitList(c("tags")),
    category: c("category"),
    channel: c("channel"),
    escalated: truthy(c("escalated")),
  };
}

export function agentKey(p: Person): string {
  return p.email || (p.name ? `name:${p.name.toLowerCase()}` : "");
}

function contactKey(p: Person): string {
  return p.email || (p.name ? `name:${p.name.toLowerCase()}` : "");
}

function sourceFor(channel: string): HdSource {
  const k = normKey(channel);
  if (k.includes("mail")) return "email";
  if (/^(web|webform|form|portal|helpcenter|selfservice|customerportal)$/.test(k)) return "portal";
  return "desk";
}

interface PlannedTicket {
  /** Where the row is (a skipped row's line in the download). */
  file: string;
  line: number;
  ref: string;
  label: string;
  subject: string;
  body: string;
  status: HdStatus;
  priority: HdPriority;
  tags: string[];
  department: string;
  team: DepartmentTarget;
  agent: Person;
  agentUserId: number | null;
  requester: { id: number | null; name: string; email: string };
  requesterKey: string;
  requesterMatched: boolean;
  created: number;
  solved: number | null;
  closed: number | null;
  category: string;
  source: HdSource;
}

interface PlanCtx {
  source: ImportSource;
  /** The idempotency key the tickets carry (importSourceKey). */
  key: string;
  /** Refs of existing tickets anonymised since: their rows are skipped. */
  anonymised: Set<string>;
  mapping: ImportMapping;
  lk: Lookups;
  users: Map<string, UserHit>;
  /** Accounts the admin mapped agents to, by id. */
  byId: Map<number, UserHit>;
  /** Ticket refs seen in this pass → the line that kept it. */
  seen: Map<string, number>;
  contactsMatched: Set<string>;
  contactsKept: Set<string>;
}

function deptTarget(mapping: ImportMapping, name: string): DepartmentTarget {
  if (!name) return { action: "none" };
  return mapping.departments[name] ?? { action: "none" };
}

function statusTarget(mapping: ImportMapping, raw: string): StatusTarget {
  const t = mapping.statuses[raw];
  return t && isHdStatus(t.status) ? t : defaultStatusFor(raw);
}

function priorityTarget(mapping: ImportMapping, raw: string): HdPriority {
  const p = mapping.priorities[raw];
  return isHdPriority(p) ? p : defaultPriorityFor(raw);
}

/** The account an agent maps to: the admin's choice, else the email match. */
function agentUser(ctx: PlanCtx, p: Person): UserHit | null {
  const key = agentKey(p);
  if (!key) return null;
  if (key in ctx.mapping.agents) {
    const id = ctx.mapping.agents[key];
    if (id === null) return null;
    return ctx.byId.get(id) ?? { id, name: p.name || p.email };
  }
  return p.email ? ctx.users.get(p.email) ?? null : null;
}

function skip(file: string, line: number, ref: string, reason: string): ImportSkippedRow {
  return { file, line, ref, reason };
}

function planTicket(raw: RawTicket, row: SourceRow, ctx: PlanCtx): PlannedTicket | ImportSkippedRow {
  const ref = (raw.ref || raw.number).slice(0, 200);
  if (!ref) return skip(row.file, row.line, "", "No ticket id or number");
  const earlier = ctx.seen.get(ref);
  if (earlier !== undefined) return skip(row.file, row.line, ref, `The same ticket id is on line ${earlier}; that row was used`);
  const bodyMd = importBodyToMarkdown(raw.body);
  let subject = raw.subject.replace(/\s+/g, " ").trim();
  if (!subject && !bodyMd) return skip(row.file, row.line, ref, "No subject or description");
  if (!subject) {
    const firstLine = raw.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    subject = firstLine.slice(0, 80) || "(no subject)";
  }
  const zone = ctx.mapping.timezone;
  const order = ctx.mapping.date_order;
  const created = parseSourceDate(raw.created, { zone, order });
  if (created === null) return skip(row.file, row.line, ref, raw.created ? `Created date "${raw.created.slice(0, 40)}" can't be read` : "No created date");
  ctx.seen.set(ref, row.line);
  const st = statusTarget(ctx.mapping, raw.status);
  const tags: string[] = [];
  for (const t of [...raw.tags.map(normTag), st.tag ? normTag(st.tag) : "", raw.escalated ? "escalated" : ""]) {
    if (t && !tags.includes(t) && tags.length < 20) tags.push(t);
  }
  const closedAt = parseSourceDate(raw.closed, { zone, order });
  const done = st.status === "solved" || st.status === "closed";
  const solved = done ? Math.max(closedAt ?? created, created) : null;
  const user = raw.contact.email ? ctx.users.get(raw.contact.email) : undefined;
  const requesterKey = contactKey(raw.contact);
  const agent = agentUser(ctx, raw.agent);
  const number = raw.number || raw.ref;
  return {
    file: row.file,
    line: row.line,
    ref,
    label: `${IMPORT_REF_PREFIX[ctx.source]} #${number.slice(0, 60)}`,
    subject: subject.slice(0, 200),
    body: bodyMd,
    status: st.status,
    priority: priorityTarget(ctx.mapping, raw.priority),
    tags,
    department: raw.department,
    team: deptTarget(ctx.mapping, raw.department),
    agent: raw.agent,
    agentUserId: agent?.id ?? null,
    requester: {
      id: user?.id ?? null,
      name: (raw.contact.name || user?.name || raw.contact.email || "Unknown requester").slice(0, 200),
      email: raw.contact.email.slice(0, 320),
    },
    requesterKey,
    requesterMatched: !!user,
    created,
    solved,
    closed: st.status === "closed" ? solved : null,
    category: raw.category.slice(0, 60),
    source: sourceFor(raw.channel),
  };
}

function countContact(ctx: PlanCtx, t: PlannedTicket, counts: ImportCounts | null): void {
  const key = t.requesterKey || `ticket:${t.ref}`;
  if (t.requesterMatched) {
    if (!ctx.contactsMatched.has(key)) {
      ctx.contactsMatched.add(key);
      if (counts) counts.contacts_matched++;
    }
  } else if (!ctx.contactsKept.has(key)) {
    ctx.contactsKept.add(key);
    if (counts) counts.contacts_kept++;
  }
}

function addSkipped(counts: ImportCounts, s: ImportSkippedRow): void {
  counts.skipped++;
  if (counts.skipped_rows.length < IMPORT_SKIPPED_KEEP) counts.skipped_rows.push(s);
}

// --- Messages: extraction and planning --------------------------------------------------

interface PlannedMessage {
  ticketRef: string;
  ref: string;
  body: string;
  kind: "public" | "internal";
  via: HdMessageVia;
  author: { id: number | null; name: string; email: string };
  agent: boolean;
  created: number;
  attachments: string[];
}

function isPrivate(header: string | undefined, value: string, fallback: boolean): boolean {
  if (!header || !value.trim()) return fallback;
  const h = normKey(header);
  const v = normKey(value);
  if (h.startsWith("ispublic") || h === "public") return !truthy(value);
  if (h.startsWith("isprivate") || h === "private" || h === "internal") return truthy(value);
  if (/^(private|internal|note|notes|comment|agentsonly|restricted)$/.test(v)) return true;
  if (/^(public|external|everyone|customer)$/.test(v)) return false;
  return fallback;
}

function authorIsAgent(type: string, direction: string, email: string, ctx: PlanCtx, fallback: boolean): boolean {
  const t = normKey(type);
  if (/enduser|customer|contact|requester|client|visitor/.test(t)) return false;
  if (/agent|staff|operator|support|admin|system|bot/.test(t)) return true;
  const d = normKey(direction);
  if (d.startsWith("out")) return true;
  if (d.startsWith("in")) return false;
  if (email && ctx.lk.agentEmails.has(email)) return true;
  if (email) {
    const mapped = ctx.mapping.agents[email];
    if (mapped !== undefined) return true;
  }
  return fallback;
}

function planMessage(
  row: SourceRow,
  cols: Partial<Record<MessageField, string>>,
  kind: "threads" | "comments",
  ctx: PlanCtx,
  ticket: { requester_id: number | null; requester_name: string; requester_email: string; created: number } | undefined
): PlannedMessage | ImportSkippedRow {
  const c = (f: MessageField) => cell(row.values, cols[f]);
  const ticketRef = c("ticket_ref").replace(/^#/, "");
  if (!ticketRef) return skip(row.file, row.line, "", "No ticket id on this message");
  if (!ticket) return skip(row.file, row.line, ticketRef, "Its ticket isn't in the import (missing or skipped)");
  const rawBody = row.values[cols.body ?? ""] ?? "";
  const attachments = splitList(c("attachments").replace(/\r?\n/g, ";"));
  const body = importBodyToMarkdown(rawBody);
  if (!body && !attachments.length) return skip(row.file, row.line, ticketRef, "Empty message");
  const created = parseSourceDate(c("created_at"), { zone: ctx.mapping.timezone, order: ctx.mapping.date_order });
  if (created === null) return skip(row.file, row.line, ticketRef, c("created_at") ? `Date "${c("created_at").slice(0, 40)}" can't be read` : "No date on this message");
  const rawEmail = c("author_email");
  const name = cleanName(c("author_name")) || (rawEmail.includes("<") ? cleanName(rawEmail) : "");
  // No email on the row: an agent named in the agents file lends theirs.
  let email = cleanEmail(rawEmail);
  if (!email && name) {
    const lower = name.toLowerCase();
    for (const p of ctx.lk.agents.values()) {
      if (p.email && p.name.toLowerCase() === lower) {
        email = p.email;
        break;
      }
    }
  }
  const agent = authorIsAgent(c("author_type"), c("direction"), email, ctx, kind === "comments");
  const internal = isPrivate(cols.visibility, c("visibility"), kind === "comments");
  let author: PlannedMessage["author"];
  if (agent) {
    const u = agentUser(ctx, { name, email });
    author = u ? { id: u.id, name: u.name, email } : { id: null, name: `Former agent ${name || email || "(unknown)"}`.slice(0, 200), email };
  } else if (!email && !name) {
    author = { id: ticket.requester_id, name: ticket.requester_name, email: ticket.requester_email };
  } else {
    const u = email ? ctx.users.get(email) : undefined;
    const isRequester = email && email === ticket.requester_email.toLowerCase();
    author = { id: u?.id ?? (isRequester ? ticket.requester_id : null), name: (name || u?.name || email).slice(0, 200), email };
  }
  const id = c("ref");
  const prefix = kind === "comments" ? "c" : "t";
  const ref = id
    ? `${prefix}:${id.slice(0, 180)}`
    : `${prefix}h:${createHash("sha1").update(`${ticketRef}\u0000${c("created_at")}\u0000${email}\u0000${name}\u0000${rawBody}`).digest("hex").slice(0, 24)}`;
  const via: HdMessageVia = normKey(c("channel")).includes("mail") ? "email" : agent ? "desk" : "portal";
  return { ticketRef, ref, body, kind: internal ? "internal" : "public", via, author, agent, created, attachments };
}

// --- Attachments -------------------------------------------------------------------------

type AttachmentVerdict = { ok: true; entry: ZipEntry; buf: Buffer; name: string } | { ok: false; reason: "missing" | "refused"; name: string; why: string };

/**
 * The zip entry of a message's file, or null (noted as not imported). Only
 * this ticket's or this message's own file (1.19.1 review): a bare name
 * must sit in a folder named exactly for the ticket's id or the message's
 * id (a path segment, never a substring: "12" is not "1203"); a path given
 * in the row must be that entry's path. Never another ticket's file of the
 * same name (image001.png is on almost every mailed ticket).
 */
async function findAttachment(layout: Layout, name: string, ticketRef: string, msgRef: string): Promise<ZipEntry | null> {
  const want = name.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  const list = layout.attachments.get(baseName(want));
  if (!list?.length) return null;
  if (want.includes("/")) return list.find((e) => e.name.toLowerCase() === want || e.name.toLowerCase().endsWith(`/${want}`)) ?? null;
  const ticket = ticketRef.trim().toLowerCase();
  const id = msgRef.includes(":") && !/^[a-z]+h:/.test(msgRef) ? msgRef.replace(/^[a-z]+:/, "").trim().toLowerCase() : "";
  const folders = (e: ZipEntry) => e.name.toLowerCase().split("/").slice(0, -1);
  return (id ? list.find((e) => folders(e).includes(id)) : undefined) ?? (ticket ? list.find((e) => folders(e).includes(ticket)) : undefined) ?? null;
}

async function checkAttachment(layout: Layout, name: string, ticketRef: string, msgRef: string, nth: number): Promise<AttachmentVerdict> {
  const clean = cleanFilename(name);
  if (layout.kind !== "zip") return { ok: false, reason: "missing", name: clean, why: "not in the export" };
  if (nth >= ATTACHMENT_LIMITS.perMessage) return { ok: false, reason: "refused", name: clean, why: `more than ${ATTACHMENT_LIMITS.perMessage} files on one message` };
  const entry = await findAttachment(layout, name, ticketRef, msgRef);
  if (!entry) return { ok: false, reason: "missing", name: clean, why: "not in the export" };
  if (entry.size > ATTACHMENT_LIMITS.maxBytes) return { ok: false, reason: "refused", name: clean, why: "too large" };
  let buf: Buffer;
  try {
    buf = await readZipEntry(layout.path, entry, ATTACHMENT_LIMITS.maxBytes);
    classifyUpload(buf, clean);
  } catch (e) {
    if (e instanceof AttachmentRejectedError || e instanceof ZipError) return { ok: false, reason: "refused", name: clean, why: e.message.replace(/\.$/, "").toLowerCase() };
    throw e;
  }
  return { ok: true, entry, buf, name: clean };
}

function attachmentNote(problems: { name: string; why: string }[]): string {
  if (!problems.length) return "";
  return "\n\n" + problems.map((p) => textToSafeMarkdown(`(Attachment not imported: ${p.name}, ${p.why}.)`)).join("  \n");
}

// --- Scan ----------------------------------------------------------------------------------

async function teamsByName(): Promise<Map<string, number>> {
  const rows = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams");
  return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

function bump(map: Map<string, number>, k: string): void {
  map.set(k, (map.get(k) ?? 0) + 1);
}

/** Read the export again: headers, values, people; refresh the mapping (keeping the admin's choices). */
export async function rescanJob(id: number): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job) throw new ImportError("That import was not found.", 404);
  const { mapping, scan } = await scanExport(job);
  const row = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET mapping = $2, counts = jsonb_build_object('scan', $3::jsonb), status = 'uploaded', check_error = '', updated_at = now()
      WHERE id = $1 AND status IN ('uploaded', 'ready') RETURNING *`,
    [id, JSON.stringify(mapping), JSON.stringify(scan)]
  );
  if (!row) throw await changedUnderneath(id);
  return row;
}

/** What one pass of a scan has read (1.19.2: the background rescan's progress). */
export type ScanObserver = (p: { rows: number; tickets: number }) => Promise<void>;

/**
 * Read the export: files, headers, values to map, agents and contacts, and
 * the mapping kept from before (rescanJob writes it; the background rescan,
 * lib/helpdesk/import-check, writes it under its lease). `observe` is told
 * every 500 rows read.
 */
export async function scanExport(job: JobRow, observe?: ScanObserver): Promise<{ mapping: ImportMapping; scan: ImportScan }> {
  const layout = await openLayout(job);
  let seenRows = 0;
  const tick = async (tickets: number) => {
    seenRows++;
    if (observe && seenRows % 500 === 0) await observe({ rows: seenRows, tickets });
  };
  const existing = "columns" in job.mapping ? (job.mapping as ImportMapping) : null;
  const warnings: string[] = [];
  if (!layout.entries.tickets && layout.kind === "zip") warnings.push("No tickets file was found in the zip (a CSV named like Tickets.csv or Cases.csv).");
  const ticketHeaders = await headersOf(layout, "tickets");
  const messageHeaders = await headersOf(layout, "threads");
  const commentHeaders = await headersOf(layout, "comments");
  const cols = {
    tickets: { ...guessTicketColumns(ticketHeaders), ...pickValid(existing?.columns.tickets, ticketHeaders) },
    messages: { ...guessMessageColumns(messageHeaders), ...pickValid(existing?.columns.messages, messageHeaders) },
    comments: { ...guessMessageColumns(commentHeaders), ...pickValid(existing?.columns.comments, commentHeaders) },
  };
  if (ticketHeaders.length) {
    if (!cols.tickets.ref && !cols.tickets.number) warnings.push("No ticket id column was recognised. Choose one under Columns.");
    if (!cols.tickets.subject) warnings.push("No subject column was recognised. Choose one under Columns.");
    if (!cols.tickets.created_at) warnings.push("No created date column was recognised. Choose one under Columns.");
  }
  for (const [kind, headers, c] of [["messages", messageHeaders, cols.messages], ["comments", commentHeaders, cols.comments]] as const) {
    if (!headers.length) continue;
    const missing = REQUIRED_MESSAGE_FIELDS.filter((f) => !c[f]);
    if (missing.length) warnings.push(`The ${kind} file has no ${missing.map((f) => (f === "ticket_ref" ? "ticket id" : "text")).join(" or ")} column. Choose one under Columns.`);
  }

  const lk = await loadLookups(layout);
  const departments = new Map<string, number>();
  const statuses = new Map<string, number>();
  const priorities = new Map<string, number>();
  const agents = new Map<string, ImportScanAgent>();
  const contactEmails = new Set<string>();
  const contactKeys = new Set<string>();
  const dateSamples: string[] = [];
  const fileRows = new Map<string, number>();
  let tickets = 0;
  for await (const r of rowsOf(layout, "tickets")) {
    tickets++;
    await tick(tickets);
    bump(fileRows, r.file);
    const t = extractTicket(r.values, cols.tickets, lk);
    if (t.department) bump(departments, t.department);
    bump(statuses, t.status);
    bump(priorities, t.priority);
    const ak = agentKey(t.agent);
    if (ak) {
      const a = agents.get(ak) ?? { key: ak, name: t.agent.name, email: t.agent.email, tickets: 0, matched_user_id: null, matched_user_name: "" };
      a.tickets++;
      agents.set(ak, a);
      if (t.agent.email) lk.agentEmails.add(t.agent.email);
    }
    const ck = contactKey(t.contact);
    if (ck) contactKeys.add(ck);
    if (t.contact.email) contactEmails.add(t.contact.email);
    if (dateSamples.length < 300 && t.created) dateSamples.push(t.created);
  }
  let messages = 0;
  for await (const r of rowsOf(layout, "threads")) {
    messages++;
    await tick(tickets);
    bump(fileRows, r.file);
  }
  let comments = 0;
  for await (const r of rowsOf(layout, "comments")) {
    comments++;
    await tick(tickets);
    bump(fileRows, r.file);
  }
  const users = await usersByEmail([...contactEmails, ...[...agents.values()].map((a) => a.email)]);
  for (const a of agents.values()) {
    const u = a.email ? users.get(a.email) : undefined;
    if (u) {
      a.matched_user_id = u.id;
      a.matched_user_name = u.name;
    }
  }
  let matched = 0;
  for (const k of contactKeys) if (users.has(k)) matched++;

  const files: ImportScan["files"] = [];
  if (layout.kind === "zip") {
    for (const [kind, list] of Object.entries(layout.entries) as [ImportFileKind, ZipEntry[]][]) {
      for (const e of list) files.push({ name: e.name, kind, rows: fileRows.get(e.name) ?? (kind === "tickets" || kind === "threads" || kind === "comments" ? 0 : -1) });
    }
    for (const n of layout.ignored) files.push({ name: n, kind: "ignored", rows: -1 });
  } else {
    files.push({ name: job.filename, kind: "tickets", rows: tickets });
    const f = job.files as ImportFiles;
    if (f.messages) files.push({ name: f.messages_filename || "messages.csv", kind: "threads", rows: messages });
  }

  const scan: ImportScan = {
    files,
    headers: { tickets: ticketHeaders, messages: messageHeaders, comments: commentHeaders },
    tickets,
    messages,
    comments,
    contacts: lk.contacts.size,
    attachments_in_zip: layout.attachmentCount,
    departments: sortValues(departments),
    statuses: sortValues(statuses),
    priorities: sortValues(priorities),
    agents: [...agents.values()].sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name)),
    contacts_matched: matched,
    contacts_kept: contactKeys.size - matched,
    warnings,
  };

  const teams = await teamsByName();
  const mapping: ImportMapping = {
    columns: cols,
    departments: {},
    statuses: {},
    priorities: {},
    agents: {},
    date_order: existing?.date_order ?? detectDateOrder(dateSamples),
    timezone: existing?.timezone || (await helpdeskTimezone()),
  };
  // A CSV source's name: kept from the mapping; a new job's is its file's name.
  // (A job mapped before names existed keeps none, so its key stays "csv".)
  if (job.source === "csv") {
    const name = existing ? cleanSourceName(existing.source_name) : defaultSourceName(job.filename);
    if (name) mapping.source_name = name;
  }
  for (const d of scan.departments) {
    const prev = existing?.departments[d.name];
    if (prev && (prev.action !== "team" || [...teams.values()].includes(prev.team_id))) mapping.departments[d.name] = prev;
    else {
      const tid = teams.get(d.name.toLowerCase());
      mapping.departments[d.name] = tid ? { action: "team", team_id: tid } : { action: "create", name: d.name.slice(0, 80) };
    }
  }
  for (const s of scan.statuses) mapping.statuses[s.name] = existing?.statuses[s.name] ?? defaultStatusFor(s.name);
  for (const p of scan.priorities) mapping.priorities[p.name] = existing?.priorities[p.name] ?? defaultPriorityFor(p.name);
  for (const a of scan.agents) mapping.agents[a.key] = existing && a.key in existing.agents ? existing.agents[a.key] : a.matched_user_id;
  // What this scan was read with (1.19.2 review): a later column or file change makes it stale.
  scan.basis = scanBasis(mapping.columns, job.files);
  return { mapping, scan };
}

function pickValid<T extends string>(cols: Partial<Record<T, string>> | undefined, headers: string[]): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  if (!cols) return out;
  for (const [k, v] of Object.entries(cols) as [T, string][]) if (v === "" || headers.includes(v)) out[k] = v;
  return out;
}

function sortValues(m: Map<string, number>): { name: string; tickets: number }[] {
  return [...m].map(([name, tickets]) => ({ name, tickets })).sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name));
}

// --- Mapping -------------------------------------------------------------------------------

/** Validate and save the admin's mapping; the dry run must run again after. */
export async function saveMapping(
  id: number,
  raw: unknown,
  /** 1.19.2: when the columns change, read the export again in the background (lib/helpdesk/import-check), for this person. */
  opts: { background?: { by: number | null } } = {}
): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  assertNotChecking(job);
  if (!["uploaded", "ready"].includes(job.status)) throw new ImportError("This import has already started.", 409);
  const prev = job.mapping as ImportMapping;
  if (!raw || typeof raw !== "object") throw new ImportError("Send the mapping as JSON.");
  const m = raw as Partial<ImportMapping>;
  const scan = job.counts.scan;
  const headers = scan?.headers ?? { tickets: [], messages: [], comments: [] };
  const teamIds = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams")).map((r) => r.id));
  const userIds = new Set<number>();
  const agentIds = Object.values(m.agents ?? {}).filter((v): v is number => typeof v === "number");
  if (agentIds.length) for (const r of await hq<{ id: number }>("SELECT id FROM users WHERE id = ANY($1::int[])", [agentIds])) userIds.add(r.id);

  const columns = (kind: "tickets" | "messages" | "comments", allowed: readonly string[]) => {
    const src = (m.columns as ImportMapping["columns"] | undefined)?.[kind] ?? prev.columns[kind];
    const out: Record<string, string> = {};
    for (const [f, h] of Object.entries(src ?? {})) {
      if (!allowed.includes(f) || typeof h !== "string") continue;
      if (h && !headers[kind].includes(h)) throw new ImportError(`"${h}" is not a column in the ${kind} file.`);
      // 1.19.2: a blank choice ("Not in the file") is kept, so a rescan's guess doesn't put the column back.
      out[f] = h;
    }
    return out;
  };
  const { TICKET_FIELDS, MESSAGE_FIELDS } = await import("./import-shared");
  const next: ImportMapping = {
    columns: {
      tickets: columns("tickets", TICKET_FIELDS),
      messages: columns("messages", MESSAGE_FIELDS),
      comments: columns("comments", MESSAGE_FIELDS),
    },
    departments: {},
    statuses: {},
    priorities: {},
    agents: {},
    date_order: m.date_order === "dmy" ? "dmy" : m.date_order === "mdy" ? "mdy" : prev.date_order,
    timezone: typeof m.timezone === "string" && validZone(m.timezone) ? m.timezone : prev.timezone,
  };
  if (job.source === "csv") {
    const given = m.source_name === undefined ? cleanSourceName(prev.source_name) : cleanSourceName(m.source_name);
    if (given) next.source_name = given;
    else if (prev.source_name) throw new ImportError("Name the system this file comes from.");
  }
  for (const [name, t] of Object.entries({ ...prev.departments, ...(m.departments ?? {}) })) {
    const v = t as DepartmentTarget;
    if (v?.action === "team" && teamIds.has(Number(v.team_id))) next.departments[name] = { action: "team", team_id: Number(v.team_id) };
    else if (v?.action === "create") {
      const n = String(v.name ?? name).trim().slice(0, 80);
      if (!n) throw new ImportError(`Name the team for ${name}.`);
      next.departments[name] = { action: "create", name: n };
    } else if (v?.action === "none") next.departments[name] = { action: "none" };
    else throw new ImportError(`Choose a team for ${name}.`);
  }
  for (const [name, t] of Object.entries({ ...prev.statuses, ...(m.statuses ?? {}) })) {
    const v = t as StatusTarget;
    if (!v || !isHdStatus(v.status)) throw new ImportError(`Choose a status for ${name || "(blank)"}.`);
    next.statuses[name] = { status: v.status, tag: normTag(String(v.tag ?? "")) };
  }
  for (const [name, p] of Object.entries({ ...prev.priorities, ...(m.priorities ?? {}) })) {
    if (!isHdPriority(p)) throw new ImportError(`Choose a priority for ${name || "(blank)"}.`);
    next.priorities[name] = p;
  }
  for (const [key, v] of Object.entries({ ...prev.agents, ...(m.agents ?? {}) })) {
    if (v === null) next.agents[key] = null;
    else if (typeof v === "number" && (userIds.has(v) || prev.agents[key] === v)) next.agents[key] = v;
    else throw new ImportError("One of the agents maps to an account that doesn't exist.");
  }
  // 1.19.2: compared field by field. The stored mapping comes back from jsonb
  // with its keys reordered, so comparing JSON text called every save a column
  // change and read the whole export again before each dry run.
  const columnsChanged = !sameColumns(next.columns, prev.columns);
  // 1.19.2 review: only while the job still takes a mapping; never over a check or an import that began since the read.
  const row = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET mapping = $2, status = 'uploaded', counts = counts - 'dry_run', updated_at = now()
      WHERE id = $1 AND status IN ('uploaded', 'ready') RETURNING *`,
    [id, JSON.stringify(next)]
  );
  if (!row) throw await changedUnderneath(id);
  // New columns can mean new values to map: read the export again (keeping
  // these choices). So does a scan that is stale (a rescan failed earlier),
  // even when the columns didn't change this time.
  const rescan = columnsChanged || !scanIsCurrent(row);
  if (rescan && opts.background) return (await import("./import-check")).queueImportCheck(id, "rescan", opts.background.by);
  return rescan ? rescanJob(id) : row;
}

/** The same column choices, whatever the key order (a blank choice is no choice). */
export function sameColumns(a: ImportMapping["columns"] | undefined, b: ImportMapping["columns"] | undefined): boolean {
  const flat = (c: ImportMapping["columns"] | undefined) =>
    (["tickets", "messages", "comments"] as const)
      .flatMap((kind) => Object.entries((c?.[kind] ?? {}) as Record<string, string>).filter(([, h]) => h).map(([f, h]) => `${kind}.${f}=${h}`))
      .sort()
      .join("\n");
  return flat(a) === flat(b);
}

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

// --- The plan (dry run and import share it) ---------------------------------------------

interface PassHandlers {
  /** A batch of planned tickets (in source order). Return false to stop (cancelled). */
  tickets(batch: { planned: PlannedTicket; index: number }[], counts: ImportCounts): Promise<boolean>;
  /** A batch of message rows with their ticket refs. */
  messages(batch: { row: SourceRow; kind: "threads" | "comments"; index: number }[], counts: ImportCounts): Promise<boolean>;
}

async function planContext(job: JobRow, layout: Layout): Promise<PlanCtx> {
  const mapping = job.mapping as ImportMapping;
  const lk = await loadLookups(layout);
  const scan = job.counts.scan;
  const emails = new Set<string>();
  for (const a of scan?.agents ?? []) {
    if (a.email) {
      emails.add(a.email);
      lk.agentEmails.add(a.email);
    }
  }
  // Requester and author emails come from the rows; collect them in one cheap pass.
  for await (const r of rowsOf(layout, "tickets")) {
    const t = extractTicket(r.values, mapping.columns.tickets, lk);
    if (t.contact.email) emails.add(t.contact.email);
  }
  for (const kind of ["threads", "comments"] as const) {
    const cols = kind === "threads" ? mapping.columns.messages : mapping.columns.comments;
    if (!cols.author_email) continue;
    for await (const r of rowsOf(layout, kind)) {
      const e = cleanEmail(r.values[cols.author_email] ?? "");
      if (e) emails.add(e);
    }
  }
  for (const p of lk.agents.values()) if (p.email) emails.add(p.email);
  const ids = Object.values(mapping.agents).filter((v): v is number => typeof v === "number");
  const byId = new Map<number, UserHit>();
  if (ids.length) {
    for (const r of await hq<{ id: number; name: string; username: string }>("SELECT id, name, username FROM users WHERE id = ANY($1::int[])", [ids])) {
      byId.set(r.id, { id: r.id, name: r.name || r.username });
    }
  }
  return {
    source: job.source,
    key: importSourceKey(job.source, mapping),
    anonymised: new Set(),
    mapping,
    lk,
    byId,
    users: await usersByEmail(emails),
    seen: new Map(),
    contactsMatched: new Set(),
    contactsKept: new Set(),
  };
}

/** Which refs already exist (from an earlier import of the same source key). */
async function existingRefs(key: string, refs: string[], client?: PoolClient): Promise<Map<string, ExistingTicket>> {
  const rows = await hq<ExistingTicket>(
    `SELECT id, import_ref, status, first_reply_due, resolve_due, sla_paused_at, requester_id, requester_name, requester_email, created_at,
            (anonymised_at IS NOT NULL) AS anonymised
       FROM hd_tickets WHERE import_source = $1 AND import_ref = ANY($2::text[])`,
    [key, refs],
    client
  );
  return new Map(rows.map((r) => [r.import_ref, r]));
}

interface ExistingTicket {
  id: number;
  import_ref: string;
  status: HdStatus;
  first_reply_due: string | null;
  resolve_due: string | null;
  sla_paused_at: string | null;
  requester_id: number | null;
  requester_name: string;
  requester_email: string;
  created_at: string;
  /** Anonymised since it was imported (lib/helpdesk/retention): never written again. */
  anonymised: boolean;
}

const ANONYMISED_TICKET = "This ticket was anonymised in CompassDocs, so it isn't imported again";
const ANONYMISED_MESSAGE = "Its ticket was anonymised in CompassDocs, so it isn't imported again";

// --- Dry run ----------------------------------------------------------------------------------

/** Plan the whole export and write nothing but the counts on the job. */
export async function dryRunJob(id: number): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  assertNotChecking(job);
  assertScanCurrent(job);
  if (!["uploaded", "ready"].includes(job.status)) throw new ImportError("This import has already started.", 409);
  if (!("columns" in job.mapping)) throw new ImportError("Map the columns first.");
  const counts = await planAll(job, null);
  const row = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET counts = counts || jsonb_build_object('dry_run', $2::jsonb), status = 'ready', updated_at = now() WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(counts)]
  );
  return row!;
}

/** Teams the import will create: create-mapped departments that have tickets and no team of that name yet. */
async function teamsToCreate(job: JobRow): Promise<string[]> {
  const mapping = job.mapping as ImportMapping;
  const teams = await teamsByName();
  const out: string[] = [];
  for (const d of job.counts.scan?.departments ?? []) {
    const t = mapping.departments[d.name];
    if (t?.action === "create" && d.tickets > 0 && !teams.has(t.name.toLowerCase()) && !out.some((n) => n.toLowerCase() === t.name.toLowerCase())) out.push(t.name);
  }
  return out;
}

/**
 * Walk the export with the plan. `run` null = dry run (read-only: existing
 * refs and assignability are read, nothing is written); otherwise each
 * batch is handed to the run's writer. Returns the counts.
 */
/** How far a dry run has got (1.19.2: the background dry run's progress, lib/helpdesk/import-check). */
export type PlanObserver = (p: { phase: "reading" | "tickets" | "messages"; done: number; counts: ImportCounts }) => Promise<void>;

/** The dry run's plan and counts, writing nothing (the background dry run writes them under its lease). */
export function planDryRun(job: JobRow, observe?: PlanObserver): Promise<ImportCounts> {
  return planAll(job, null, observe);
}

async function planAll(job: JobRow, run: RunState | null, observe?: PlanObserver): Promise<ImportCounts> {
  const layout = await openLayout(job);
  if (observe) await observe({ phase: "reading", done: 0, counts: run?.counts ?? emptyCounts() });
  const ctx = await planContext(job, layout);
  const mapping = ctx.mapping;
  const counts: ImportCounts = run?.counts ?? emptyCounts();
  const resumeAt = run?.progress ?? {};
  if (!run) counts.teams_create = (await teamsToCreate(job)).length;

  // Phase: tickets.
  const plannedRefs = new Map<string, { requester_id: number | null; requester_name: string; requester_email: string; created: number }>();
  const ticketCursor = resumeAt.phase === "tickets" ? resumeAt.done ?? 0 : resumeAt.phase === "messages" || resumeAt.phase === "finalize" || resumeAt.phase === "done" ? Infinity : 0;
  let index = 0;
  let batch: { planned: PlannedTicket; index: number }[] = [];
  const assignCache = new Map<string, boolean>();
  const teamIdFor = (t: DepartmentTarget): number | null =>
    t.action === "team" ? t.team_id : t.action === "create" ? run?.teams[t.name.toLowerCase()] ?? null : null;
  const flushTickets = async (): Promise<boolean> => {
    if (!batch.length) return true;
    // Assignee only when the account may work the team's tickets (read-only check, both modes).
    for (const b of batch) {
      const p = b.planned;
      if (p.agentUserId === null) continue;
      const teamId = teamIdFor(p.team);
      const key = `${p.agentUserId}:${teamId ?? (p.team.action === "create" ? `new:${p.team.name}` : "none")}`;
      if (!assignCache.has(key)) assignCache.set(key, p.team.action === "create" && !run ? false : await assignable(p.agentUserId, teamId));
      if (!assignCache.get(key)) p.agentUserId = null;
    }
    const ok = run ? await run.writeTickets(batch, counts, teamIdFor, ctx) : await countTickets(ctx, batch, counts);
    batch = [];
    if (observe) await observe({ phase: "tickets", done: index, counts });
    return ok;
  };
  for await (const row of rowsOf(layout, "tickets")) {
    index++;
    const raw = extractTicket(row.values, mapping.columns.tickets, ctx.lk);
    const planned = planTicket(raw, row, ctx);
    const replay = index <= ticketCursor;
    if ("reason" in planned) {
      if (!replay) addSkipped(counts, planned);
      continue;
    }
    countContact(ctx, planned, replay ? null : counts);
    plannedRefs.set(planned.ref, { requester_id: planned.requester.id, requester_name: planned.requester.name, requester_email: planned.requester.email, created: planned.created });
    if (replay) continue;
    batch.push({ planned, index });
    if (batch.length >= IMPORT_BATCH.tickets && !(await flushTickets())) return counts;
  }
  if (!(await flushTickets())) return counts;
  if (run && ticketCursor !== Infinity) await run.phase("messages", 0, counts);

  // Phase: messages (conversations, then comments), one cursor across both.
  const msgCursor = resumeAt.phase === "messages" ? resumeAt.done ?? 0 : resumeAt.phase === "finalize" || resumeAt.phase === "done" ? Infinity : 0;
  let mIndex = 0;
  let mBatch: { row: SourceRow; kind: "threads" | "comments"; index: number }[] = [];
  const flushMessages = async (): Promise<boolean> => {
    if (!mBatch.length) return true;
    const ok = run ? await run.writeMessages(mBatch, counts, ctx, layout) : await countMessages(mBatch, counts, ctx, layout, plannedRefs);
    mBatch = [];
    if (observe) await observe({ phase: "messages", done: mIndex, counts });
    return ok;
  };
  if (msgCursor !== Infinity) {
    for (const kind of ["threads", "comments"] as const) {
      for await (const row of rowsOf(layout, kind)) {
        mIndex++;
        if (mIndex <= msgCursor) continue;
        mBatch.push({ row, kind, index: mIndex });
        if (mBatch.length >= IMPORT_BATCH.messages && !(await flushMessages())) return counts;
      }
    }
    if (!(await flushMessages())) return counts;
  }
  if (run) await run.finalize(counts);
  return counts;
}

async function countTickets(ctx: PlanCtx, batch: { planned: PlannedTicket }[], counts: ImportCounts): Promise<boolean> {
  const existing = await existingRefs(ctx.key, batch.map((b) => b.planned.ref));
  for (const b of batch) {
    const prev = existing.get(b.planned.ref);
    if (prev?.anonymised) {
      ctx.anonymised.add(b.planned.ref);
      addSkipped(counts, skip(b.planned.file, b.planned.line, b.planned.ref, ANONYMISED_TICKET));
    } else if (prev) counts.tickets_update++;
    else counts.tickets_create++;
  }
  return true;
}

async function countMessages(
  batch: { row: SourceRow; kind: "threads" | "comments" }[],
  counts: ImportCounts,
  ctx: PlanCtx,
  layout: Layout,
  planned: Map<string, { requester_id: number | null; requester_name: string; requester_email: string; created: number }>
): Promise<boolean> {
  for (const b of batch) {
    const cols = b.kind === "threads" ? ctx.mapping.columns.messages : ctx.mapping.columns.comments;
    const ticketRef = cell(b.row.values, cols.ticket_ref).replace(/^#/, "");
    if (ctx.anonymised.has(ticketRef)) {
      addSkipped(counts, skip(b.row.file, b.row.line, ticketRef, ANONYMISED_MESSAGE));
      continue;
    }
    const m = planMessage(b.row, cols, b.kind, ctx, planned.get(ticketRef));
    if ("reason" in m) {
      addSkipped(counts, m);
      continue;
    }
    if (m.kind === "internal") counts.notes++;
    else counts.messages++;
    let nth = 0;
    for (const name of m.attachments) {
      const v = await checkAttachment(layout, name, m.ticketRef, m.ref, nth);
      if (v.ok) {
        counts.attachments_import++;
        nth++;
      } else if (v.reason === "missing") counts.attachments_missing++;
      else counts.attachments_refused++;
    }
  }
  return true;
}

// --- The import run ----------------------------------------------------------------------------

interface RunState {
  jobId: number;
  source: ImportSource;
  counts: ImportCounts;
  progress: ImportProgress;
  teams: Record<string, number>;
  now: Date;
  lease: ImportLease;
  /** This run marked the job completed (only then are its files removed and the completion audited). */
  completed: boolean;
  writeTickets(batch: { planned: PlannedTicket; index: number }[], counts: ImportCounts, teamIdFor: (t: DepartmentTarget) => number | null, ctx: PlanCtx): Promise<boolean>;
  writeMessages(batch: { row: SourceRow; kind: "threads" | "comments"; index: number }[], counts: ImportCounts, ctx: PlanCtx, layout: Layout): Promise<boolean>;
  phase(phase: ImportProgress["phase"], done: number, counts: ImportCounts): Promise<void>;
  finalize(counts: ImportCounts): Promise<void>;
}

class Cancelled extends Error {}
/** Another runner took the job over (this one looked stalled): stop, and leave the job to it. */
class LeaseLost extends Cancelled {}

/**
 * A runner's hold on its job (1.19.1 review). heartbeat_at doubles as the
 * fencing token: the runner that claimed the job knows the exact value it
 * last wrote (milliseconds, from the database's clock). Every batch checks
 * it under the job row's lock before writing, and every write of the
 * heartbeat is conditional on it, so a runner whose job was taken over
 * after a stall writes nothing more and changes no status. A timer
 * refreshes the heartbeat while the run plans or replays between batches
 * (a batch itself holds the row lock, which any takeover waits on).
 */
export interface ImportLease {
  jobId: number;
  at: Date;
  lost: boolean;
}

/** How often a running import refreshes its heartbeat (well inside IMPORT_STALL_MS). */
export const IMPORT_HEARTBEAT_MS = 30_000;

const BEAT_SQL = "date_trunc('milliseconds', clock_timestamp())";

/** Inside a batch's transaction: stop if the job was asked to stop, or is no longer this run's. */
async function claimBatch(client: PoolClient, lease: ImportLease): Promise<void> {
  const r = await client.query<{ status: string; heartbeat_at: string | Date | null }>("SELECT status, heartbeat_at FROM hd_import_jobs WHERE id = $1 FOR UPDATE", [lease.jobId]);
  const row = r.rows[0];
  if (!row?.heartbeat_at || new Date(row.heartbeat_at).getTime() !== lease.at.getTime()) {
    lease.lost = true;
    throw new LeaseLost();
  }
  if (row.status !== "running") throw new Cancelled();
}

async function saveCursor(client: PoolClient, lease: ImportLease, progress: ImportProgress, counts: ImportCounts): Promise<void> {
  const r = await client.query<{ heartbeat_at: string | Date }>(
    `UPDATE hd_import_jobs SET progress = $2, counts = counts || jsonb_build_object('result', $3::jsonb), heartbeat_at = ${BEAT_SQL}, updated_at = now()
      WHERE id = $1 AND heartbeat_at = $4 RETURNING heartbeat_at`,
    [lease.jobId, JSON.stringify(progress), JSON.stringify(counts), lease.at]
  );
  if (!r.rows[0]) {
    lease.lost = true;
    throw new LeaseLost();
  }
  lease.at = new Date(r.rows[0].heartbeat_at);
}

/** Refresh the heartbeat outside a batch; marks the lease lost when the job is no longer this run's. */
async function beat(lease: ImportLease): Promise<void> {
  if (lease.lost) return;
  const r = await hqOne<{ heartbeat_at: string | Date }>(
    `UPDATE hd_import_jobs SET heartbeat_at = ${BEAT_SQL} WHERE id = $1 AND heartbeat_at = $2 AND status IN ('running', 'cancelling') RETURNING heartbeat_at`,
    [lease.jobId, lease.at]
  );
  if (r) lease.at = new Date(r.heartbeat_at);
  else lease.lost = true;
}

/** One at a time per run: a batch's transaction and the heartbeat timer never interleave (each changes the token). */
function serialiser(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
}

function makeRun(job: JobRow, now: Date, lease: ImportLease, exclusive: <T>(fn: () => Promise<T>) => Promise<T>, onBatch?: (p: ImportProgress) => Promise<void>): RunState {
  const key = importSourceKey(job.source, job.mapping);
  const counts: ImportCounts = job.counts.result ? { ...emptyCounts(), ...job.counts.result } : emptyCounts();
  const progress: ImportProgress = { ...(job.progress ?? {}) };
  const teams = { ...(job.counts.teams ?? {}) };
  const duesCache = new Map<string, { first_reply_due: Date; resolve_due: Date; policy_id: number | null } | null>();
  const duesFor = async (client: PoolClient, priority: HdPriority, teamId: number | null) => {
    const key = `${priority}:${teamId}`;
    if (!duesCache.has(key)) {
      const policy = await slaPolicyForTeam(priority, teamId, client);
      const hours = await hoursForTeam(teamId, client);
      duesCache.set(key, policy ? { ...computeDues(now.getTime(), policy, hours), policy_id: policy.policy_id ?? null } : null);
    }
    return duesCache.get(key)!;
  };

  const run: RunState = {
    jobId: job.id,
    source: job.source,
    counts,
    progress,
    teams,
    now,
    lease,
    completed: false,
    async writeTickets(batch, c, teamIdFor, ctx) {
      try {
        await exclusive(() => withTx(async (client) => {
          await claimBatch(client, lease);
          const existing = await existingRefs(key, batch.map((b) => b.planned.ref), client);
          for (const { planned: p } of batch) {
            const teamId = teamIdFor(p.team);
            const prev = existing.get(p.ref);
            // Anonymised since it was imported: never written again (the erased data stays erased).
            if (prev?.anonymised) {
              ctx.anonymised.add(p.ref);
              addSkipped(c, skip(p.file, p.line, p.ref, ANONYMISED_TICKET));
              continue;
            }
            const open = p.status !== "solved" && p.status !== "closed";
            const paused = p.status === "pending" || p.status === "on_hold";
            // SLA: open tickets get dues from the import time on their team's calendar; closed ones none.
            let dues: { first_reply_due: Date | string | null; resolve_due: Date | string | null; policy_id: number | null } = { first_reply_due: null, resolve_due: null, policy_id: null };
            if (open) {
              const prevOpen = prev && prev.status !== "solved" && prev.status !== "closed" && (prev.first_reply_due || prev.resolve_due);
              if (prevOpen) dues = { first_reply_due: prev.first_reply_due, resolve_due: prev.resolve_due, policy_id: null };
              else {
                const d = await duesFor(client, p.priority, teamId);
                if (d) dues = d;
              }
            }
            const pausedAt = open && paused ? (prev?.sla_paused_at ?? now.toISOString()) : null;
            const sourceRef = JSON.stringify({ import_label: p.label, import_source: job.source });
            let ticketId: number;
            if (prev) {
              await client.query(
                `UPDATE hd_tickets SET subject = $2, requester_id = $3, requester_name = $4, requester_email = $5, team_id = $6,
                        assignee_id = $7, status = $8, priority = $9, category = $10, tags = $11, source_ref = source_ref || $12::jsonb,
                        created_at = $13::timestamptz, solved_at = $14::timestamptz, closed_at = $15, first_reply_due = $16, resolve_due = $17,
                        sla_policy_id = COALESCE($18::int, sla_policy_id), sla_paused_at = $19,
                        updated_at = GREATEST(updated_at, $13::timestamptz, COALESCE($14::timestamptz, $13::timestamptz))
                  WHERE id = $1`,
                [prev.id, p.subject, p.requester.id, p.requester.name, p.requester.email, teamId, p.agentUserId, p.status, p.priority, p.category, p.tags, sourceRef,
                  new Date(p.created), p.solved ? new Date(p.solved) : null, p.closed ? new Date(p.closed) : null, dues.first_reply_due, dues.resolve_due, dues.policy_id, pausedAt]
              );
              ticketId = prev.id;
              c.tickets_update++;
            } else {
              const r = await client.query<{ id: number }>(
                `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status, priority, category, tags,
                        source, source_ref, sla_policy_id, first_reply_due, resolve_due, reply_token, created_at, updated_at, solved_at, closed_at,
                        sla_paused_at, import_source, import_ref)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz,
                         GREATEST($17::timestamptz, COALESCE($18::timestamptz, $17::timestamptz)), $18::timestamptz, $19, $20, $21, $22)
                 RETURNING id`,
                [p.subject, p.requester.id, p.requester.name, p.requester.email, teamId, p.agentUserId, p.status, p.priority, p.category, p.tags,
                  p.source, sourceRef, dues.policy_id, dues.first_reply_due, dues.resolve_due, newTicketReplyToken(), new Date(p.created),
                  p.solved ? new Date(p.solved) : null, p.closed ? new Date(p.closed) : null, pausedAt, key, p.ref]
              );
              ticketId = r.rows[0].id;
              c.tickets_create++;
            }
            // The description is the opening public message, from the requester at the created time.
            if (p.body) {
              await client.query(
                `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, attachments, created_at, import_ref)
                 VALUES ($1, $2, $3, $4, 'public', $5, $6, '[]', $7, 'description')
                 ON CONFLICT (ticket_id, import_ref) WHERE import_ref IS NOT NULL
                 DO UPDATE SET author_id = EXCLUDED.author_id, author_name = EXCLUDED.author_name, author_email = EXCLUDED.author_email,
                               body = EXCLUDED.body, created_at = EXCLUDED.created_at`,
                [ticketId, p.requester.id, p.requester.name, p.requester.email, p.body, p.source === "email" ? "email" : "portal", new Date(p.created)]
              );
            }
          }
          const last = batch[batch.length - 1].index;
          progress.phase = "tickets";
          progress.done = last;
          progress.tickets_done = c.tickets_create + c.tickets_update;
          await saveCursor(client, lease, progress, c);
        }));
        await onBatch?.({ ...progress });
        return true;
      } catch (e) {
        if (e instanceof Cancelled) return false;
        throw e;
      }
    },
    async writeMessages(batch, c, ctx, layout) {
      const saved: string[] = [];
      try {
        await exclusive(() => withTx(async (client) => {
          await claimBatch(client, lease);
          const refs = [...new Set(batch.map((b) => cell(b.row.values, (b.kind === "threads" ? ctx.mapping.columns.messages : ctx.mapping.columns.comments).ticket_ref).replace(/^#/, "")).filter(Boolean))];
          const tickets = await existingRefs(key, refs, client);
          const firstReply = new Map<number, number>();
          const latest = new Map<number, number>();
          for (const b of batch) {
            const cols = b.kind === "threads" ? ctx.mapping.columns.messages : ctx.mapping.columns.comments;
            const ticketRef = cell(b.row.values, cols.ticket_ref).replace(/^#/, "");
            const t = tickets.get(ticketRef);
            if (t?.anonymised) {
              addSkipped(c, skip(b.row.file, b.row.line, ticketRef, ANONYMISED_MESSAGE));
              continue;
            }
            const m = planMessage(b.row, cols, b.kind, ctx, t ? { requester_id: t.requester_id, requester_name: t.requester_name, requester_email: t.requester_email, created: Date.parse(t.created_at) } : undefined);
            if ("reason" in m) {
              addSkipped(c, m);
              continue;
            }
            if (m.kind === "internal") c.notes++;
            else c.messages++;
            // Attachments: checked first so a refusal can be noted in the body.
            const ok: Extract<AttachmentVerdict, { ok: true }>[] = [];
            const problems: { name: string; why: string }[] = [];
            let nth = 0;
            for (const name of m.attachments) {
              const v = await checkAttachment(layout, name, m.ticketRef, m.ref, nth);
              if (v.ok) {
                ok.push(v);
                nth++;
                c.attachments_import++;
              } else {
                problems.push({ name: v.name, why: v.why });
                if (v.reason === "missing") c.attachments_missing++;
                else c.attachments_refused++;
              }
            }
            const body = (m.body + attachmentNote(problems)).trim();
            const r = await client.query<{ id: number; inserted: boolean }>(
              `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, attachments, created_at, import_ref)
               VALUES ($1, $2, $3, $4, $5, $6, $7, '[]', $8, $9)
               ON CONFLICT (ticket_id, import_ref) WHERE import_ref IS NOT NULL
               DO UPDATE SET author_id = EXCLUDED.author_id, author_name = EXCLUDED.author_name, author_email = EXCLUDED.author_email,
                             kind = EXCLUDED.kind, body = EXCLUDED.body, via = EXCLUDED.via, created_at = EXCLUDED.created_at
               RETURNING id, (xmax = 0) AS inserted`,
              [t!.id, m.author.id, m.author.name, m.author.email, m.kind, body, m.via, new Date(m.created), m.ref]
            );
            const messageId = r.rows[0].id;
            // A message seen before keeps the files it got then (a re-run never doubles them).
            const have = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM hd_attachments WHERE message_id = $1", [messageId]);
            if (ok.length && have.rows[0].n === 0) {
              const refsOut: { id: number; name: string; size: number; type: string }[] = [];
              for (const a of ok) {
                const { mime, ext } = classifyUpload(a.buf, a.name);
                const storedName = await saveUpload(a.buf, ext);
                saved.push(storedName);
                const ar = await client.query<{ id: string }>(
                  `INSERT INTO hd_attachments (stored_name, filename, mime_type, size, ticket_id, message_id, uploaded_by, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) RETURNING id`,
                  [storedName, a.name, mime, a.buf.length, t!.id, messageId, new Date(m.created)]
                );
                refsOut.push({ id: Number(ar.rows[0].id), name: a.name, size: a.buf.length, type: mime });
              }
              await client.query("UPDATE hd_messages SET attachments = $2 WHERE id = $1", [messageId, JSON.stringify(refsOut)]);
            }
            if (m.agent && m.kind === "public") firstReply.set(t!.id, Math.min(firstReply.get(t!.id) ?? Infinity, m.created));
            latest.set(t!.id, Math.max(latest.get(t!.id) ?? 0, m.created));
          }
          for (const [ticketId, at] of latest) {
            const fr = firstReply.get(ticketId);
            await client.query(
              `UPDATE hd_tickets SET updated_at = GREATEST(updated_at, $2::timestamptz),
                      first_replied_at = CASE WHEN $3::timestamptz IS NULL THEN first_replied_at ELSE LEAST(COALESCE(first_replied_at, $3), $3) END
                WHERE id = $1`,
              [ticketId, new Date(at), fr !== undefined ? new Date(fr) : null]
            );
          }
          progress.phase = "messages";
          progress.done = batch[batch.length - 1].index;
          progress.messages_done = c.messages + c.notes;
          await saveCursor(client, lease, progress, c);
        }));
        await onBatch?.({ ...progress });
        return true;
      } catch (e) {
        for (const s of saved) await deleteUpload(s).catch(() => {});
        if (e instanceof Cancelled) return false;
        throw e;
      }
    },
    async phase(phase, done, c) {
      progress.phase = phase;
      progress.done = done;
      await exclusive(() => withTx(async (client) => {
        await claimBatch(client, lease).catch((e) => {
          // Asked to stop: the cursor is still saved. Taken over: nothing is.
          if (!(e instanceof Cancelled) || e instanceof LeaseLost) throw e;
        });
        await saveCursor(client, lease, progress, c);
      }));
    },
    async finalize(c) {
      if (lease.lost) return;
      // A description that repeats the first conversation entry (Zoho keeps both) is dropped.
      await hq(
        `DELETE FROM hd_messages d USING hd_tickets t
          WHERE d.ticket_id = t.id AND t.import_source = $1 AND t.anonymised_at IS NULL AND d.import_ref = 'description'
            AND EXISTS (SELECT 1 FROM hd_messages m WHERE m.ticket_id = t.id AND m.import_ref IS NOT NULL AND m.import_ref <> 'description'
                         AND m.kind = 'public' AND abs(extract(epoch FROM m.created_at - t.created_at)) <= 120)`,
        [key]
      );
      progress.phase = "done";
      progress.done = 0;
      const done = await exclusive(() =>
        hqOne<{ id: number }>(
          `UPDATE hd_import_jobs SET progress = $2, counts = counts || jsonb_build_object('result', $3::jsonb), status = 'completed',
                  finished_at = now(), updated_at = now(), heartbeat_at = now(), error = '' WHERE id = $1 AND status = 'running' AND heartbeat_at = $4
            RETURNING id`,
          [job.id, JSON.stringify(progress), JSON.stringify(c), lease.at]
        )
      );
      run.completed = !!done;
    },
  };
  return run;
}

/** Create the teams the mapping asks for (by name, idempotent); remembered on the job for a resume. */
async function createMappedTeams(job: JobRow, actor: { id: number | null; name: string }): Promise<Record<string, number>> {
  const mapping = job.mapping as ImportMapping;
  const teams = { ...(job.counts.teams ?? {}) };
  const byName = await teamsByName();
  const toCreate = await teamsToCreate(job);
  for (const d of job.counts.scan?.departments ?? []) {
    const t = mapping.departments[d.name];
    if (t?.action !== "create") continue;
    const key = t.name.toLowerCase();
    if (teams[key]) continue;
    let id = byName.get(key);
    if (!id && toCreate.includes(t.name)) {
      const created = await createTeam({ name: t.name, description: `Imported from ${job.source === "zoho" ? "Zoho Desk" : "CSV"}` });
      id = created?.id ?? (await teamsByName()).get(key);
      if (created) {
        await audit({
          actor: { id: actor.id, name: actor.name, role: null },
          action: "helpdesk.team.created",
          targetType: "helpdesk_team",
          targetId: String(created.id),
          targetLabel: created.name,
          details: { via: "import", job_id: job.id },
        });
      }
    }
    if (id) {
      teams[key] = id;
      byName.set(key, id);
    }
  }
  await hq("UPDATE hd_import_jobs SET counts = counts || jsonb_build_object('teams', $2::jsonb), updated_at = now() WHERE id = $1", [job.id, JSON.stringify(teams)]);
  return teams;
}

/** Queue a job (after its dry run) or a resume of a stopped/failed one. */
export async function startImport(id: number): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  if (job.status === "uploaded") throw new ImportError("Run the dry run first.", 409);
  assertNotChecking(job);
  if (!["ready", "cancelled", "failed"].includes(job.status)) throw new ImportError("This import is already running or finished.", 409);
  const key = importSourceKey(job.source, job.mapping);
  const active = await hq<{ id: number; source: ImportSource; mapping: JobRow["mapping"] }>(
    `SELECT id, source, mapping FROM hd_import_jobs WHERE id <> $1 AND source = $2 AND status IN ('queued', 'running', 'cancelling')`,
    [id, job.source]
  );
  const busy = active.some((j) => importSourceKey(j.source, j.mapping) === key);
  if (busy) throw new ImportError("Another import from the same source is running. Wait for it to finish.", 409);
  const row = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET status = 'queued', error = '', finished_at = NULL, updated_at = now() WHERE id = $1 AND status IN ('ready', 'cancelled', 'failed') RETURNING *`,
    [id]
  );
  if (!row) throw new ImportError("This import is already running or finished.", 409);
  return row;
}

/** Ask a job to stop: a queued one stops at once, a running one after its current batch. */
export async function cancelImport(id: number): Promise<JobRow> {
  const job = await getImportJob(id);
  if (!job || job.status === "discarded") throw new ImportError("That import was not found.", 404);
  const row = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancelling' END,
            finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END, updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`,
    [id]
  );
  if (!row) throw new ImportError("This import isn't running.", 409);
  return row;
}

/**
 * Run (or resume) a queued job to the end, a stop, or a failure. Claims the
 * job first (queued → running, or a running one whose heartbeat stalled),
 * so two callers never run it at once: the claim's heartbeat is the run's
 * lease (ImportLease), refreshed while it runs, and a run whose job was
 * taken over stops before its next write and changes no status. Never
 * throws.
 */
export async function runImportJob(
  id: number,
  opts: {
    now?: Date;
    /** Called after each committed batch (tests stop a run here). */
    onBatch?: (p: ImportProgress) => Promise<void>;
    /** Tests: the heartbeat interval (default IMPORT_HEARTBEAT_MS). */
    heartbeatMs?: number;
  } = {}
): Promise<JobRow | undefined> {
  // The claim writes the lease's first token (lib: ImportLease).
  const claimed = await hqOne<JobRow>(
    `UPDATE hd_import_jobs SET status = 'running', heartbeat_at = ${BEAT_SQL}, updated_at = now()
      WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $2))))
      RETURNING *`,
    [id, IMPORT_STALL_MS / 1000]
  ).catch(() => undefined);
  if (!claimed?.heartbeat_at) return getImportJob(id);
  const lease: ImportLease = { jobId: id, at: new Date(claimed.heartbeat_at), lost: false };
  const exclusive = serialiser();
  // The heartbeat while the run plans or replays between batches.
  const timer = setInterval(() => {
    void exclusive(() => beat(lease)).catch((e) => logEvent("warn", "helpdesk.import.heartbeat_failed", { job: id, error: e instanceof Error ? e.message : String(e) }));
  }, opts.heartbeatMs ?? IMPORT_HEARTBEAT_MS);
  timer.unref?.();
  const actor = { id: claimed.created_by, name: claimed.created_by_name || "Import" };
  let completed = false;
  try {
    const teams = await createMappedTeams(claimed, actor);
    const fresh = (await getImportJob(id))!;
    const run = makeRun(fresh, opts.now ?? new Date(), lease, exclusive, opts.onBatch);
    run.teams = teams;
    await planAll(fresh, run);
    completed = run.completed;
  } catch (e) {
    if (e instanceof LeaseLost || lease.lost) {
      logEvent("info", "helpdesk.import.taken_over", { job: id });
    } else {
      const message = e instanceof ImportError ? e.message : "The import stopped on an unexpected error. Resume to try again.";
      logEvent("error", "helpdesk.import.failed", { job: id, error: e instanceof Error ? e.message : String(e) });
      // Only while the job is still this run's: never over a run that took it over, or one that finished.
      await exclusive(() =>
        hq(
          "UPDATE hd_import_jobs SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('running', 'cancelling') AND heartbeat_at = $3",
          [id, message, lease.at]
        )
      ).catch(() => {});
    }
  } finally {
    clearInterval(timer);
  }
  // A stop asked for while the last batch ran (only while the job is still this run's).
  if (!lease.lost) {
    await exclusive(() =>
      hq(
        "UPDATE hd_import_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('cancelling', 'running') AND heartbeat_at = $2",
        [id, lease.at]
      )
    ).catch(() => {});
  }
  const done = await getImportJob(id);
  // 1.20.6 (lib/helpdesk/categories): an import writes each ticket's category as the old helpdesk named it. Whatever
  // the run stored (finished, stopped or failed part-way), those names join the admin's list now, so no imported
  // ticket shows a category that is not on it. Never fails the import.
  await (await import("./categories")).adoptCategories().catch((e) => logEvent("warn", "helpdesk.import.categories_failed", { job: id, error: e instanceof Error ? e.message : String(e) }));
  if (completed && done?.status === "completed") {
    await removeJobFiles(done.files);
    await hq("UPDATE hd_import_jobs SET files = files - 'main' - 'messages' WHERE id = $1", [id]).catch(() => {});
    const { skipped_rows: _rows, ...counts } = done.counts.result ?? emptyCounts();
    await audit({
      actor: { id: actor.id, name: actor.name, role: null },
      action: "helpdesk.import.completed",
      targetType: "helpdesk_import",
      targetId: String(id),
      targetLabel: done.filename,
      details: { source: done.source, counts },
    }).catch(() => {});
  }
  return getImportJob(id);
}

/** Fire-and-forget start for a route (the sweep picks it up if this process dies). */
export function runImportInBackground(id: number): void {
  void runImportJob(id).catch((e) => logEvent("error", "helpdesk.import.background_failed", { job: id, error: e instanceof Error ? e.message : String(e) }));
}

/**
 * The periodic sweep (lib/periodic HELPDESK_SWEEPS "hd_import"): runs queued
 * jobs and resumes stalled ones (a restart mid-import), one at a time, and
 * deletes upload files of jobs that finished or are older than 7 days.
 */
export async function importSweep(): Promise<{ resumed: number; cleaned: number }> {
  let resumed = 0;
  const due = await hq<{ id: number }>(
    `SELECT id FROM hd_import_jobs
      WHERE status = 'queued' OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1)))
      ORDER BY id LIMIT 1`,
    [IMPORT_STALL_MS / 1000]
  );
  for (const j of due) {
    resumed++;
    runImportInBackground(j.id);
  }
  // 1.19.2 (agent W5, lib/helpdesk/import-check): background dry runs and rescans nobody is running.
  await (await import("./import-check")).importCheckSweep().catch((e) =>
    logEvent("error", "helpdesk.import.check_sweep_failed", { error: e instanceof Error ? e.message : String(e) })
  );
  // A stop asked of a job no process is running any more.
  await hq(
    `UPDATE hd_import_jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE status = 'cancelling' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1))`,
    [IMPORT_STALL_MS / 1000]
  );
  const old = await hq<{ id: number; files: ImportFiles }>(
    `SELECT id, files FROM hd_import_jobs
      WHERE files ? 'main' AND status NOT IN ('queued', 'running', 'cancelling', 'checking')
        AND (status IN ('completed', 'discarded') OR created_at < now() - make_interval(secs => $1))
      LIMIT 50`,
    [IMPORT_FILE_TTL_MS / 1000]
  );
  for (const j of old) {
    await removeJobFiles(j.files);
    await hq("UPDATE hd_import_jobs SET files = files - 'main' - 'messages' WHERE id = $1", [j.id]);
  }
  return { resumed, cleaned: old.length };
}

// --- The skipped rows download ---------------------------------------------------------------

/** The dry run's (or the run's) skipped rows as CSV. */
export function skippedCsv(job: JobRow, which: "dry_run" | "result"): string {
  const c = job.counts[which];
  let out = csvLine(["File", "Line", "Ticket id", "Reason"]);
  for (const s of c?.skipped_rows ?? []) out += csvLine([s.file, s.line, s.ref, s.reason]);
  if (c && c.skipped > c.skipped_rows.length) out += csvLine(["", "", "", `${c.skipped - c.skipped_rows.length} more rows were skipped and are not listed.`]);
  return out;
}
