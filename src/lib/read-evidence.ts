// Reading evidence on the attestation record (C3, 1.11.0): the pure rules
// behind the two columns the record carries beside each confirmation.
//
// read_seconds is derived on the server when the confirmation is posted
// (src/lib/analytics.ts readSecondsSince: the view heartbeats for this person
// and document since everyone was last asked) and copied onto the row because
// doc_views is not retained with the document. reached_end is the reader's
// own report from use-reached-end.ts and is labelled as such everywhere it is
// shown. Neither is proof of comprehension, and no control is gated by either.
//
// Nothing here touches the database, so the Record page, the CSV route, the
// confirmation route and the tests share one definition of the threshold,
// the labels and the body parsing.

import { isOverdue } from "./ack-due";

/** Reading speed the "typical read" of a document is measured at. */
export const WORDS_PER_MINUTE = 200;

/** Below this share of a typical read the Read time cell takes the warn tone. */
export const SHORT_READ_SHARE = 0.25;

/** The warn tone's tooltip on the Record page. */
export const SHORT_READ_TOOLTIP = "Shorter than a typical read of this document";

/**
 * The six columns 1.12.0 (C4) appends to both the roster and the matrix, in
 * this order: the confirmation statement the person saw, the typed signature
 * and how the signer was identified (C2), then the policy's re-confirmation
 * interval, effective date and next re-confirmation date (G1), read from the
 * documents row.
 */
export const ATTESTATION_CSV_COLUMNS = "statement,signed_name,identity_proof,recert_months,effective_at,next_recert_at";

/** The roster header as 1.11.0 shipped it: the prefix every later release keeps in place. */
const ROSTER_CSV_HEADER_1110 =
  "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,ip,user_agent,version_published_by,version_approved_by,read_seconds,reached_end_self_reported";

/**
 * The five columns 1.13.0 (D2) appends to both files after the six, in this
 * order: the exemption's reason, who recorded it and until when (blank on a
 * row that is not exempt), when a snooze ends (blank when not snoozed) and
 * the person's deadline (blank when the policy sets none). On the roster an
 * exempt row carries status 'exempt'; the matrix has no status column, so
 * there an exempt row is one whose exempt_reason is filled.
 */
export const EXEMPTION_CSV_COLUMNS = "exempt_reason,exempt_by,exempt_until,snoozed_until,due_at";

/**
 * The roster CSV header (GET /api/documents/[id]/acknowledgements?format=csv).
 * Existing columns stay in place and new ones are appended, never renamed:
 * the two evidence columns follow the provenance pair, the six attestation
 * and re-confirmation columns (1.12.0) follow those, and the five exemption
 * and deadline columns (1.13.0) close the line.
 */
export const ROSTER_CSV_HEADER = `${ROSTER_CSV_HEADER_1110},${ATTESTATION_CSV_COLUMNS},${EXEMPTION_CSV_COLUMNS}`;

/** The matrix header as 1.10.1 shipped it (GET /api/admin/compliance?format=csv). */
const MATRIX_CSV_HEADER_1101 =
  "document,space,revision_as_of,name,username,email,role,acknowledged_at,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,version_published_by,version_approved_by";

/**
 * The two columns 1.14.0 appends to the matrix after the five (the roster
 * has had its own status column at position 5 since 1.11.0): the person's
 * standing on the policy as the portal's tiles and bars count it (F1:
 * confirmed | pending | overdue | exempt, matrixStatus below) and the
 * policy sets the policy belongs to (D3: the names joined with "; ", blank
 * when none). The F1 spec also named due_at, snoozed_until and
 * exempt_reason, which have been on the line since 1.13.0 (EXEMPTION_CSV_COLUMNS).
 */
export const STANDING_CSV_COLUMNS = "status,set";

/** The matrix CSV header: the 1.10.1 columns in place, the same six (1.12.0), the same five (1.13.0) and the two of 1.14.0 appended. */
export const MATRIX_CSV_HEADER = `${MATRIX_CSV_HEADER_1101},${ATTESTATION_CSV_COLUMNS},${EXEMPTION_CSV_COLUMNS},${STANDING_CSV_COLUMNS}`;

/** The roster's status column: 'exempt' outranks the confirmation, since an exempt row is in no denominator. */
export type RosterStatus = "acknowledged" | "pending" | "exempt";
export function rosterStatus(row: { acknowledged_at: string | null; exempt?: boolean | null }): RosterStatus {
  if (row.exempt) return "exempt";
  return row.acknowledged_at ? "acknowledged" : "pending";
}

/**
 * The matrix's status column (F1, 1.14.0), the four states the Overview's
 * tiles and the stacked bars count: 'exempt' outranks everything (the row
 * is in no denominator), a current confirmation is 'confirmed', a deadline
 * past the policy's grace with none is 'overdue' (isOverdue, the same rule
 * the SQL counts apply), the rest 'pending'. `graceDays` is the policy's
 * resolved grace (ComplianceDocRow.overdue_grace_days). A former-staff row
 * (no assignment: no due_at, never exempt) reads 'confirmed'.
 */
export type MatrixStatus = "confirmed" | "pending" | "overdue" | "exempt";
export function matrixStatus(
  row: { acknowledged_at: string | null; exempt?: boolean | null; due_at?: string | Date | null },
  graceDays: number,
  now: Date = new Date()
): MatrixStatus {
  if (row.exempt) return "exempt";
  if (row.acknowledged_at) return "confirmed";
  return isOverdue({ due_at: row.due_at ?? null }, { overdue_grace_days: graceDays }, now) ? "overdue" : "pending";
}

/** A timestamp column as the CSV writes it: ISO whether pg handed back a Date or a string; blank when null. */
function stampCell(v: string | Date | null | undefined): string {
  if (v == null || v === "") return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  return String(v);
}

/**
 * The five exemption and deadline cells (1.13.0, D2 fields on the record
 * row), before csvCell: the three exemption cells only on an exempt row,
 * the snooze end only while snoozed, the deadline when the row has one.
 * Optional on the input so a former-staff row (no assignment) writes five
 * blanks and a row type without the fields still compiles.
 */
export function exemptionCsvCells(row: {
  exempt?: boolean | null;
  exempt_reason?: string | null;
  exempt_by_name?: string | null;
  exempt_until?: string | Date | null;
  snoozed_until?: string | Date | null;
  due_at?: string | Date | null;
}): [string, string, string, string, string] {
  const exempt = Boolean(row.exempt);
  return [
    exempt ? (row.exempt_reason ?? "") : "",
    exempt ? (row.exempt_by_name ?? "") : "",
    exempt ? stampCell(row.exempt_until) : "",
    stampCell(row.snoozed_until),
    stampCell(row.due_at),
  ];
}

/**
 * The ledger CSV header (1.12.0, C4): every confirmation ever recorded,
 * including superseded rows and rows whose account or document is gone.
 * GET /api/admin/compliance?format=ledger covers every document and
 * GET /api/documents/[id]/acknowledgements?format=ledger one; both need
 * compliance.export, so ip and user_agent are always filled here.
 */
export const LEDGER_CSV_HEADER =
  "document,document_id,space,name,username,email,role,acknowledged_at,superseded,version,version_id,content_sha256,version_source,statement,signed_name,identity_proof,read_seconds,reached_end_self_reported,ip,user_agent,account_removed";

/**
 * Words in a document's text, counted the way the change heuristic counts
 * them (a token with at least one letter or digit): markup-only tokens such
 * as "##" or "---" are not words. Tags are stripped first so HTML content
 * counts its text, not its markup.
 */
export function documentWordCount(content: string): number {
  const text = (content ?? "").replace(/<[^>]+>/g, " ");
  return (text.match(/\S+/g) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Seconds a typical read of `words` words takes at WORDS_PER_MINUTE. */
export function typicalReadSeconds(words: number): number {
  return (Math.max(0, words) / WORDS_PER_MINUTE) * 60;
}

/**
 * The threshold rule: the warn tone applies only when a recorded read time is
 * below SHORT_READ_SHARE of a typical read of the document. An unknown read
 * time (null: no view was recorded, or a confirmation from before 1.11.0)
 * is never flagged, and neither is a document with no words to read.
 */
export function isShortRead(readSeconds: number | null | undefined, words: number): boolean {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return false;
  if (words <= 0) return false;
  return readSeconds < SHORT_READ_SHARE * typicalReadSeconds(words);
}

/**
 * The Read time cell: "under 1 min", "6 min", "1 h 5 min"; blank when the
 * record holds no read time.
 */
export function readTimeLabel(readSeconds: number | null | undefined): string {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return "";
  const seconds = Math.max(0, Math.floor(readSeconds));
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The self-reported flag from the confirmation body: true only for the JSON
 * boolean `true`. A string, a number, a missing field or a body that is not
 * an object all read as false, so the record never says "reached the end"
 * on anything but the card's own report.
 */
export function reachedEndFromBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as { reached_end?: unknown }).reached_end === true;
}

/**
 * The seconds a confirmation stores: a whole non-negative number, or null
 * when nothing was recorded.
 */
export function storedReadSeconds(readSeconds: number | null | undefined): number | null {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return null;
  return Math.max(0, Math.floor(readSeconds));
}

/**
 * The two evidence cells of a roster CSV row, before csvCell: read_seconds as
 * a number or blank, reached_end_self_reported as "yes" / "no" on a
 * confirmed row and blank on a pending one (no confirmation, no report).
 */
export function evidenceCsvCells(row: {
  acknowledged_at: string | null;
  read_seconds: number | null;
  reached_end: boolean | null;
}): [string | number, string] {
  if (!row.acknowledged_at) return ["", ""];
  return [row.read_seconds ?? "", row.reached_end ? "yes" : "no"];
}

/**
 * The three attestation cells (1.12.0, C2 fields on the record row): the
 * statement the person confirmed, the name they typed and how they were
 * identified ('password', 'sso_session', 'typed_name_only'). Blank on a
 * pending row, and blank on rows from before 1.12.0 (the columns default to
 * '' / NULL). The fields are optional on the input so a row type that has
 * not grown them yet still compiles.
 */
export function attestationCsvCells(row: {
  acknowledged_at: string | null;
  statement_text?: string | null;
  signed_name?: string | null;
  identity_proof?: string | null;
}): [string, string, string] {
  if (!row.acknowledged_at) return ["", "", ""];
  return [row.statement_text ?? "", row.signed_name ?? "", row.identity_proof ?? ""];
}

/** A date column as the CSV writes it: YYYY-MM-DD whether pg handed back a Date or a string; blank when null. */
function dateCell(v: string | Date | null | undefined): string {
  if (v == null || v === "") return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * The three re-confirmation cells (1.12.0, G1 columns on the documents row):
 * the interval in months, the effective date and the next re-confirmation
 * date. Blank while the policy has none. Optional on the input for the same
 * reason as above.
 */
export function recertCsvCells(doc: {
  ack_recert_months?: number | null;
  ack_effective_at?: string | Date | null;
  ack_next_recert_at?: string | Date | null;
}): [string | number, string, string] {
  return [doc.ack_recert_months ?? "", dateCell(doc.ack_effective_at), dateCell(doc.ack_next_recert_at)];
}

/**
 * The two personal-data cells, ip and user_agent, as the viewer may see
 * them: the recorded values for a caller who holds compliance.export, blank
 * for everyone else. One rule for the roster CSV, the ledger JSON and the
 * JSON roster, so the IP never leaks through a column the record page
 * happens to carry.
 */
export function personalDataCells(
  row: { ip?: string | null; user_agent?: string | null } | null | undefined,
  canExport: boolean
): [string, string] {
  if (!canExport || !row) return ["", ""];
  return [row.ip ?? "", row.user_agent ?? ""];
}

/** The same rule on a whole row: ip and user_agent replaced by '' unless the viewer may export. */
export function personalDataForViewer<T extends { ip: string; user_agent: string }>(row: T, canExport: boolean): T {
  if (canExport) return row;
  return { ...row, ip: "", user_agent: "" };
}

/** One ledger row as the ledger CSV needs it (the db's AckLedgerRow satisfies this). */
export interface LedgerCsvRow {
  document_title: string;
  document_id: number | null;
  space_name: string;
  name: string;
  username: string;
  email: string;
  role: string;
  acknowledged_at: string;
  superseded: boolean;
  rev: number | null;
  version_id: number | null;
  content_sha256: string | null;
  version_source: string;
  statement_text: string;
  signed_name: string | null;
  identity_proof: string;
  read_seconds: number | null;
  reached_end: boolean;
  ip: string;
  user_agent: string;
  account_removed: boolean;
}

/**
 * The cells of one ledger CSV line, in LEDGER_CSV_HEADER's order and before
 * csvCell. `canExport` applies the personal-data rule above; both ledger
 * routes require compliance.export, so they pass true, and the test pins
 * that false blanks exactly the ip and user_agent columns.
 */
export function ledgerCsvCells(row: LedgerCsvRow, canExport: boolean): (string | number)[] {
  const evidence = evidenceCsvCells({
    acknowledged_at: row.acknowledged_at,
    read_seconds: row.read_seconds,
    reached_end: row.reached_end,
  });
  return [
    row.document_title,
    row.document_id ?? "",
    row.space_name,
    row.name,
    row.username,
    row.email,
    row.role,
    row.acknowledged_at,
    row.superseded ? "yes" : "no",
    row.rev ? `v${row.rev}` : "",
    row.version_id ?? "",
    row.content_sha256 ?? "",
    row.version_source,
    ...attestationCsvCells(row),
    ...evidence,
    ...personalDataCells(row, canExport),
    row.account_removed ? "yes" : "no",
  ];
}

/**
 * The per-person record CSV (1.14.0, F3): GET
 * /api/admin/compliance/people/[id]?format=csv, one line per row of the
 * record (the current requirements, then the prior confirmations, the closed
 * assignments and the rows on retired policies), through the same viewer
 * filter as the page, so a lead's file never carries a private-space policy.
 * 21 columns: `status` is confirmed | pending | overdue | exempt on an
 * assignment row and superseded on a prior confirmation; `removed_at` is
 * filled on a closed assignment; `superseded_by` on a prior confirmation
 * (supersededByText); `ip` only where the viewer may see it.
 */
export const RECORD_CSV_HEADER =
  "policy,set,status,source,assigned_at,removed_at,due_at,acknowledged_at,version,version_id,version_source,content_sha256,signed_name,identity_proof,read_seconds,reached_end,ip,exempt_reason,exempt_by,exempt_until,superseded_by";

/** What replaced a superseded confirmation (the db's TranscriptSuccessor satisfies this). */
export interface RecordSuccessor {
  version: number | null;
  at: string;
  reason: string;
  kind: "reset" | "recert" | "confirmation";
}

/** One record row as the CSV needs it (the db's PolicyTranscriptRow satisfies this). */
export interface RecordCsvRow {
  title: string;
  set_names: string[];
  status: string;
  source: string;
  assigned_at: string | Date | null;
  removed_at: string | Date | null;
  due_at: string | Date | null;
  acknowledged_at: string | Date | null;
  version: number | null;
  version_id: number | null;
  version_source: string | null;
  content_sha256: string | null;
  signed_name: string | null;
  identity_proof: string | null;
  read_seconds: number | null;
  reached_end: boolean | null;
  ip: string | null;
  exempt: boolean;
  exempt_reason: string;
  exempt_by_name: string;
  exempt_until: string | Date | null;
  superseded_by: RecordSuccessor | null;
}

/**
 * What follows "Superseded by:" on the record page, and the CSV's last
 * column: 'v13 on 3 Sep 2026 - "Section 4 now covers contractors"' (a
 * decision asked everyone again), "annual re-confirmation on 1 Oct 2026"
 * (the cycle) or "v13 on 3 Sep 2026" (the person confirmed again with no
 * decision between). Dates go through `fmt` (ISO in the CSV, the
 * workspace's format on the page).
 */
export function supersededByText(s: RecordSuccessor, fmt: (iso: string) => string = (iso) => iso): string {
  if (s.kind === "recert") return `annual re-confirmation on ${fmt(s.at)}`;
  const head = `${s.version ? `v${s.version} ` : ""}on ${fmt(s.at)}`;
  return s.kind === "reset" && s.reason ? `${head} - "${s.reason}"` : head;
}

/** The cells of one record CSV line, in RECORD_CSV_HEADER's order and before csvCell. */
export function recordCsvCells(row: RecordCsvRow): (string | number)[] {
  const confirmed = Boolean(row.acknowledged_at);
  return [
    row.title,
    row.set_names.join("; "),
    row.status,
    row.source,
    stampCell(row.assigned_at),
    stampCell(row.removed_at),
    stampCell(row.due_at),
    stampCell(row.acknowledged_at),
    row.version ? `v${row.version}` : "",
    row.version_id ?? "",
    row.version_source ?? "",
    row.content_sha256 ?? "",
    confirmed ? (row.signed_name ?? "") : "",
    confirmed ? (row.identity_proof ?? "") : "",
    confirmed ? (row.read_seconds ?? "") : "",
    confirmed ? (row.reached_end ? "yes" : "no") : "",
    row.ip ?? "",
    row.exempt ? row.exempt_reason : "",
    row.exempt ? row.exempt_by_name : "",
    row.exempt ? stampCell(row.exempt_until) : "",
    row.superseded_by ? supersededByText(row.superseded_by) : "",
  ];
}
