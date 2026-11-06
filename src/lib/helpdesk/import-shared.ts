// Helpdesk 1.19.1 import, the shared half: client-safe (the wizard imports
// it) and pure. What an export's columns can mean, how a column is
// recognised from its header, how a source's statuses and priorities map
// by default, how its dates read, and the shapes the API sends.
//
// Zoho Desk (documented assumptions; everything is matched by header name,
// so a column in another position or a file that is missing is tolerated):
//   - Setup → Data Administration → Export/Backup gives a zip of CSV files,
//     one per module, sometimes split ("Tickets_001.csv", "Tickets_002.csv")
//     and sometimes in folders. Files are recognised by name:
//     Tickets/Cases, Threads/Conversations, Comments, Contacts, Agents/Users,
//     Departments. Anything else in the zip is a candidate attachment.
//   - Tickets: "Ticket Id" (Zoho's record id, the idempotency key),
//     "Ticket Reference Id" / "Request Id" / "Ticket Number" (the number
//     people know: "Zoho #1234"), Subject, Description (HTML), Status,
//     Priority, Department (or Department Id), Ticket Owner (or Ticket
//     Owner Id / owner email), Contact Name, Email (or Contact Id),
//     Channel, Category / Classification, Tags, Created Time, Closed Time,
//     Is Escalated.
//   - Threads: Thread Id, Ticket Id, Content (HTML), From / Author, Author
//     Type or Direction (in = the customer, out = an agent), Visibility or
//     Is Private, Channel, Created Time, Attachments (file names).
//   - Comments: Comment Id, Ticket Id, Content, Commented By, Commented
//     Time, Is Public (comments are private notes unless public).
//   - Contacts: Contact Id, First Name, Last Name / Contact Name, Email.
//   - Agents: Agent Id, Name / First + Last Name, Email.
//   - Departments: Department Id, Department Name.
// A generic CSV is one row per ticket with an optional second CSV of
// messages keyed by ticket id; the same aliases pre-fill its column map.

import { HD_PRIORITIES, HD_STATUSES } from "./types";
import type { HdPriority, HdStatus } from "./types";

export type ImportSource = "zoho" | "csv";
export const IMPORT_SOURCE_LABEL: Record<ImportSource, string> = { zoho: "Zoho Desk", csv: "CSV" };
/** The prefix of the reference shown on an imported ticket ("Zoho #1234"). */
export const IMPORT_REF_PREFIX: Record<ImportSource, string> = { zoho: "Zoho", csv: "Imported" };

export type ImportFileKind = "tickets" | "threads" | "comments" | "contacts" | "agents" | "departments";
export const IMPORT_FILE_LABEL: Record<ImportFileKind, string> = {
  tickets: "Tickets",
  threads: "Conversations",
  comments: "Comments",
  contacts: "Contacts",
  agents: "Agents",
  departments: "Departments",
};

// --- Fields and their header aliases ------------------------------------------------

export const TICKET_FIELDS = [
  "ref",
  "number",
  "subject",
  "body",
  "status",
  "priority",
  "department",
  "department_id",
  "agent_name",
  "agent_email",
  "agent_id",
  "contact_name",
  "contact_email",
  "contact_id",
  "created_at",
  "closed_at",
  "tags",
  "category",
  "channel",
  "escalated",
] as const;
export type TicketField = (typeof TICKET_FIELDS)[number];

export const MESSAGE_FIELDS = [
  "ticket_ref",
  "ref",
  "body",
  "author_name",
  "author_email",
  "author_type",
  "direction",
  "visibility",
  "channel",
  "created_at",
  "attachments",
] as const;
export type MessageField = (typeof MESSAGE_FIELDS)[number];

export const TICKET_FIELD_LABEL: Record<TicketField, string> = {
  ref: "Ticket id",
  number: "Ticket number",
  subject: "Subject",
  body: "Description",
  status: "Status",
  priority: "Priority",
  department: "Department or team",
  department_id: "Department id",
  agent_name: "Owner (agent) name",
  agent_email: "Owner (agent) email",
  agent_id: "Owner (agent) id",
  contact_name: "Requester name",
  contact_email: "Requester email",
  contact_id: "Requester (contact) id",
  created_at: "Created",
  closed_at: "Closed or solved",
  tags: "Tags",
  category: "Category",
  channel: "Channel",
  escalated: "Escalated",
};

export const MESSAGE_FIELD_LABEL: Record<MessageField, string> = {
  ticket_ref: "Ticket id",
  ref: "Message id",
  body: "Message text",
  author_name: "Author name",
  author_email: "Author email",
  author_type: "Author type (agent or customer)",
  direction: "Direction (in or out)",
  visibility: "Public or private",
  channel: "Channel",
  created_at: "Sent",
  attachments: "Attachment file names",
};

/** Fields a ticket file must have a column for (one of ref/number). */
export const REQUIRED_TICKET_FIELDS: TicketField[] = ["subject", "created_at"];
export const REQUIRED_MESSAGE_FIELDS: MessageField[] = ["ticket_ref", "body"];

/** Header → key: lower case, letters and digits only ("Ticket Id" → "ticketid"). */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Aliases in priority order (normalised). */
const TICKET_ALIASES: Record<TicketField, string[]> = {
  ref: ["ticketid", "caseid", "zohoticketid", "recordid", "id", "externalid", "sourceid"],
  number: ["ticketreferenceid", "requestid", "ticketnumber", "ticketno", "referenceid", "casenumber", "number", "reference", "key"],
  subject: ["subject", "title", "ticketsubject", "summary"],
  body: ["description", "ticketdescription", "body", "content", "message", "details", "text"],
  status: ["status", "ticketstatus", "state", "statustype"],
  priority: ["priority", "ticketpriority", "urgency"],
  department: ["department", "departmentname", "team", "teamname", "group", "queue"],
  department_id: ["departmentid"],
  agent_name: ["ticketowner", "ticketownername", "owner", "ownername", "assignee", "assigneename", "assignedto", "agent", "agentname"],
  agent_email: ["ticketowneremail", "owneremail", "assigneeemail", "agentemail", "assignedtoemail"],
  agent_id: ["ticketownerid", "ownerid", "assigneeid", "agentid"],
  contact_name: ["contactname", "contact", "requestername", "requester", "customername", "customer", "fromname", "name"],
  contact_email: ["email", "contactemail", "requesteremail", "customeremail", "emailaddress", "fromemail", "from"],
  contact_id: ["contactid", "requesterid", "customerid"],
  created_at: ["createdtime", "createddate", "createdat", "created", "createdon", "datecreated", "opened", "openedat"],
  closed_at: ["closedtime", "closeddate", "closedat", "closed", "solvedat", "solvedtime", "resolvedat", "resolvedtime", "resolved", "completedtime"],
  tags: ["tags", "tag", "labels", "tickettags"],
  category: ["category", "classification", "tickettype", "type"],
  channel: ["channel", "source", "origin", "via"],
  escalated: ["isescalated", "escalated"],
};

const MESSAGE_ALIASES: Record<MessageField, string[]> = {
  ticket_ref: ["ticketid", "caseid", "ticket", "parentid", "entityid", "requestid", "ticketnumber", "ticketreferenceid"],
  ref: ["threadid", "conversationid", "commentid", "messageid", "noteid", "id"],
  body: ["content", "threadcontent", "body", "message", "comment", "commentcontent", "text", "plaintext", "summary"],
  author_name: ["authorname", "author", "fromname", "sendername", "sender", "commentedby", "commenter", "createdby", "agentname", "name"],
  author_email: ["authoremail", "fromemailaddress", "fromemail", "senderemail", "commenteremail", "commentedbyemail", "createdbyemail", "from", "email"],
  author_type: ["authortype", "sendertype", "usertype", "actortype", "role"],
  direction: ["direction", "type"],
  visibility: ["visibility", "isprivate", "ispublic", "private", "public", "kind", "internal"],
  channel: ["channel", "via", "source"],
  created_at: ["createdtime", "senttime", "sendtime", "sent", "sentat", "commentedtime", "createddate", "createdat", "created", "date", "time"],
  attachments: ["attachments", "attachment", "attachmentnames", "attachmentname", "files"],
};

/** Guess which header holds each field: the first alias present wins, each header used once. */
function guess<F extends string>(headers: string[], aliases: Record<F, string[]>, fields: readonly F[]): Partial<Record<F, string>> {
  const byKey = new Map<string, string>();
  for (const h of headers) if (!byKey.has(normKey(h))) byKey.set(normKey(h), h);
  const used = new Set<string>();
  const out: Partial<Record<F, string>> = {};
  for (const f of fields) {
    for (const a of aliases[f]) {
      const h = byKey.get(a);
      if (h && !used.has(h)) {
        out[f] = h;
        used.add(h);
        break;
      }
    }
  }
  return out;
}

export function guessTicketColumns(headers: string[]): Partial<Record<TicketField, string>> {
  return guess(headers, TICKET_ALIASES, TICKET_FIELDS);
}
export function guessMessageColumns(headers: string[]): Partial<Record<MessageField, string>> {
  return guess(headers, MESSAGE_ALIASES, MESSAGE_FIELDS);
}

// Side tables (Zoho): matched by alias, no mapping step.
export const CONTACT_ALIASES = {
  id: ["contactid", "id"],
  name: ["contactname", "fullname", "name", "displayname"],
  first: ["firstname"],
  last: ["lastname"],
  email: ["email", "emailaddress", "primaryemail", "emailid"],
};
export const AGENT_ALIASES = {
  id: ["agentid", "userid", "id"],
  name: ["agentname", "fullname", "name", "displayname"],
  first: ["firstname"],
  last: ["lastname"],
  email: ["email", "emailid", "emailaddress", "agentemail"],
};
export const DEPARTMENT_ALIASES = {
  id: ["departmentid", "id"],
  name: ["departmentname", "name", "department"],
};

/** The header (as written) for the first alias present; '' when none. */
export function pickHeader(headers: string[], aliases: string[]): string {
  const byKey = new Map(headers.map((h) => [normKey(h), h] as const));
  for (const a of aliases) if (byKey.has(a)) return byKey.get(a)!;
  return "";
}

// --- Files in a zip ---------------------------------------------------------------------

/** What a CSV in an export is, from its name; null when unknown. */
export function classifyCsvName(path: string): ImportFileKind | null {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (!base.endsWith(".csv") || base.startsWith("._")) return null;
  const n = base.replace(/\.csv$/, "").replace(/[\s_-]*(\(\d+\)|\d+)$/g, "").replace(/[^a-z]/g, "");
  if (/thread|conversation|repl(y|ies)|emails?$/.test(n)) return "threads";
  if (/comment|notes?$/.test(n)) return "comments";
  if (/department/.test(n)) return "departments";
  if (/^(agents?|users?|staff|agentdetails)$/.test(n) || /agents?$/.test(n)) return "agents";
  if (/contact|customer|enduser|requester/.test(n)) return "contacts";
  if (/^(tickets?|cases?|requests?)/.test(n) || /tickets?$/.test(n)) return "tickets";
  if (/message/.test(n)) return "threads";
  return null;
}

/** Natural order for split exports (Tickets_2 before Tickets_10). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// --- Values -------------------------------------------------------------------------------

export interface StatusTarget {
  status: HdStatus;
  /** A tag added to keep what the source status said ("escalated"); '' = none. */
  tag: string;
}

/** The default CompassDocs status for a source status. */
export function defaultStatusFor(raw: string): StatusTarget {
  const k = normKey(raw);
  if (!k || k === "open" || k === "reopened" || k === "inprogress" || k === "assigned" || k === "customerresponded") return { status: "open", tag: "" };
  if (k === "new" || k === "unassigned") return { status: "new", tag: "" };
  if (k === "escalated") return { status: "open", tag: "escalated" };
  if (k === "onhold" || k === "hold" || k === "paused") return { status: "on_hold", tag: "" };
  if (/^(pending|waiting|awaiting|waitingoncustomer|waitingforcustomer|waitingonrequester|awaitingreply|awaitingcustomer|needsinfo)/.test(k)) {
    return { status: "pending", tag: "" };
  }
  if (k === "closed" || k === "archived" || k === "done" || k === "cancelled" || k === "canceled") return { status: "closed", tag: "" };
  if (k === "solved" || k === "resolved" || k === "completed" || k === "fixed") return { status: "solved", tag: "" };
  return { status: "open", tag: normTag(raw) };
}

/** The default CompassDocs priority for a source priority. */
export function defaultPriorityFor(raw: string): HdPriority {
  const k = normKey(raw);
  if (k === "low" || k === "lowest" || k === "minor") return "low";
  if (k === "high" || k === "major") return "high";
  if (k === "urgent" || k === "critical" || k === "highest" || k === "blocker" || k === "emergency") return "urgent";
  return "normal";
}

/** A tag as the desk stores tags (lower case, dashes, at most 40). */
export function normTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, 40);
}

export function isHdStatus(v: unknown): v is HdStatus {
  return typeof v === "string" && (HD_STATUSES as readonly string[]).includes(v);
}
export function isHdPriority(v: unknown): v is HdPriority {
  return typeof v === "string" && (HD_PRIORITIES as readonly string[]).includes(v);
}

/** Tags out of one cell: comma, semicolon or pipe separated. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[;,|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Truthy cell ("true", "yes", "1", "y", "x"). */
export function truthy(raw: string): boolean {
  return /^(true|yes|y|1|x|t)$/i.test(raw.trim());
}

/** A plausible email, lower-cased; '' otherwise. A "Name <a@b>" cell gives the address. */
export function cleanEmail(raw: string): string {
  const m = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  const v = (m ? m[1] : raw).trim().toLowerCase();
  return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[a-z]{2,24}$/.test(v) ? v : "";
}

/** The name part of "Name <a@b>", else the cell. */
export function cleanName(raw: string): string {
  const v = raw.replace(/<[^<>]*>/, "").replace(/^["']|["']$/g, "").trim();
  return v.slice(0, 200);
}

// --- Dates ----------------------------------------------------------------------------------

export type DateOrder = "mdy" | "dmy";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** The UTC offset of `zone` at `utcMs`, in minutes. */
function zoneOffsetMinutes(zone: string, utcMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** A wall-clock time in `zone` → epoch ms. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMinutes(zone, guess);
  const t = guess - off1 * 60_000;
  const off2 = zoneOffsetMinutes(zone, t);
  return off2 === off1 ? t : guess - off2 * 60_000;
}

function validParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  return y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 60;
}

function hour12(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const pm = /^p/i.test(ampm);
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/**
 * A source date → epoch ms, or null when unreadable. ISO 8601 with an
 * offset or Z is exact; a time without one is read in `zone`. Understood:
 * 2026-11-05 15:15[:00], 2026-11-05T15:15:00Z, 11/05/2026 3:15 PM (or
 * 05/11/2026 with order dmy), 05 Nov 2026 03:15 PM, Nov 05, 2026 03:15 PM,
 * and epoch milliseconds.
 */
export function parseSourceDate(raw: string, opts: { order?: DateOrder; zone?: string } = {}): number | null {
  const v = raw.trim();
  if (!v) return null;
  const zone = opts.zone || "UTC";
  if (/^\d{12,13}$/.test(v)) {
    const n = Number(v);
    return n > 0 ? n : null;
  }
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) {
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number);
    if (!validParts(y, mo, d, h, mi, s)) return null;
    if (m[7]) {
      const t = Date.parse(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7].toUpperCase() === "Z" ? "Z" : m[7].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`);
      return Number.isFinite(t) ? t : null;
    }
    return wallToUtc(y, mo, d, h, mi, s, zone);
  }
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [mo, d] = opts.order === "dmy" ? [b, a] : [a, b];
    const y = Number(m[3]);
    const h = hour12(Number(m[4] ?? 0), m[7]);
    const mi = Number(m[5] ?? 0);
    const s = Number(m[6] ?? 0);
    if (!validParts(y, mo, d, h, mi, s)) return null;
    return wallToUtc(y, mo, d, h, mi, s, zone);
  }
  // 05 Nov 2026 03:15 PM · Nov 05, 2026 03:15 PM · 5-Nov-2026 15:15
  m = v.match(/^(?:(\d{1,2})[\s-]+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2}),?)[\s-]+(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    const monName = (m[2] ?? m[3]).slice(0, 4).toLowerCase();
    const mo = MONTHS[monName] ?? MONTHS[monName.slice(0, 3)];
    const d = Number(m[1] ?? m[4]);
    const y = Number(m[5]);
    const h = hour12(Number(m[6] ?? 0), m[9]);
    const mi = Number(m[7] ?? 0);
    const s = Number(m[8] ?? 0);
    if (!mo || !validParts(y, mo, d, h, mi, s)) return null;
    return wallToUtc(y, mo, d, h, mi, s, zone);
  }
  return null;
}

/** dmy when any slash date's first part is over 12 (and none's second is), else mdy. */
export function detectDateOrder(samples: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const s of samples) {
    const m = s.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    if (Number(m[2]) > 12) mdy++;
  }
  return dmy > mdy ? "dmy" : "mdy";
}

// --- API shapes ----------------------------------------------------------------------------

export type DepartmentTarget = { action: "team"; team_id: number } | { action: "create"; name: string } | { action: "none" };

export interface ImportMapping {
  columns: {
    tickets: Partial<Record<TicketField, string>>;
    messages: Partial<Record<MessageField, string>>;
    comments: Partial<Record<MessageField, string>>;
  };
  /** Source department (or team) name → what it becomes. */
  departments: Record<string, DepartmentTarget>;
  /** Source status → CompassDocs status (+ tag). */
  statuses: Record<string, StatusTarget>;
  /** Source priority → CompassDocs priority. */
  priorities: Record<string, HdPriority>;
  /** Source agent key (lower-cased email, else name) → user id, or null = "Former agent <name>". */
  agents: Record<string, number | null>;
  date_order: DateOrder;
  /** Times without an offset are read in this zone. */
  timezone: string;
  /**
   * A CSV import's source system, as the admin names it (default: the
   * file's name). Ticket ids are unique per source, so two systems' "#12"
   * never meet and a re-run under the same name updates in place. Absent
   * on CSV jobs from before 1.19.1's review: those keep the key "csv".
   */
  source_name?: string;
}

export const IMPORT_SOURCE_NAME_MAX = 60;

/** A source name as stored: one line, single spaces, at most 60 characters; "" when none. */
export function cleanSourceName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, IMPORT_SOURCE_NAME_MAX);
}

/** The default source name of a CSV import: its file's name without the extension. */
export function defaultSourceName(filename: string): string {
  return cleanSourceName(filename.replace(/^.*[\\/]/, "").replace(/\.(csv|zip|txt)$/i, "")) || "CSV import";
}

/**
 * The idempotency key imported tickets carry (hd_tickets.import_source):
 * "zoho" for Zoho Desk; "csv:<name>" for a named CSV source (lower-case),
 * "csv" for CSV jobs from before source names.
 */
export function importSourceKey(source: ImportSource, mapping: Pick<ImportMapping, "source_name"> | Record<string, never> | null | undefined): string {
  if (source !== "csv") return source;
  const name = cleanSourceName((mapping as Partial<ImportMapping> | null | undefined)?.source_name).toLowerCase();
  return name ? `csv:${name}` : "csv";
}

export interface ImportScanValue {
  name: string;
  tickets: number;
}

export interface ImportScanAgent {
  key: string;
  name: string;
  email: string;
  tickets: number;
  /** The account their email matched (auto), null = none. */
  matched_user_id: number | null;
  matched_user_name: string;
}

export interface ImportScan {
  files: { name: string; kind: ImportFileKind | "attachment" | "ignored"; rows: number }[];
  headers: { tickets: string[]; messages: string[]; comments: string[] };
  tickets: number;
  messages: number;
  comments: number;
  contacts: number;
  attachments_in_zip: number;
  departments: ImportScanValue[];
  statuses: ImportScanValue[];
  priorities: ImportScanValue[];
  agents: ImportScanAgent[];
  contacts_matched: number;
  contacts_kept: number;
  /** Problems the admin should see before mapping (missing required columns, unreadable files). */
  warnings: string[];
}

export interface ImportSkippedRow {
  file: string;
  line: number;
  ref: string;
  reason: string;
}

export interface ImportCounts {
  tickets_create: number;
  tickets_update: number;
  messages: number;
  notes: number;
  contacts_matched: number;
  contacts_kept: number;
  teams_create: number;
  attachments_import: number;
  attachments_missing: number;
  attachments_refused: number;
  skipped: number;
  /** The first IMPORT_SKIPPED_KEEP skipped rows (the download). */
  skipped_rows: ImportSkippedRow[];
}

export const IMPORT_SKIPPED_KEEP = 5000;

export function emptyCounts(): ImportCounts {
  return {
    tickets_create: 0,
    tickets_update: 0,
    messages: 0,
    notes: 0,
    contacts_matched: 0,
    contacts_kept: 0,
    teams_create: 0,
    attachments_import: 0,
    attachments_missing: 0,
    attachments_refused: 0,
    skipped: 0,
    skipped_rows: [],
  };
}

export type ImportJobStatus = "uploaded" | "ready" | "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "discarded";

export interface ImportProgress {
  phase?: "teams" | "tickets" | "messages" | "finalize" | "done";
  /** Rows consumed in the current phase (the resume cursor). */
  done?: number;
  tickets_done?: number;
  messages_done?: number;
}

export interface ImportJobView {
  id: number;
  source: ImportSource;
  status: ImportJobStatus;
  filename: string;
  size: number;
  has_messages_file: boolean;
  created_by_name: string;
  created_at: string;
  finished_at: string | null;
  error: string;
  mapping: ImportMapping | null;
  scan: ImportScan | null;
  dry_run: Omit<ImportCounts, "skipped_rows"> | null;
  result: Omit<ImportCounts, "skipped_rows"> | null;
  progress: ImportProgress;
  /** The next ticket number new tickets will take. */
  next_number: number | null;
}

export const IMPORT_STATUS_LABEL: Record<ImportJobStatus, string> = {
  uploaded: "Uploaded",
  ready: "Dry run done",
  queued: "Starting",
  running: "Importing",
  cancelling: "Stopping",
  cancelled: "Stopped",
  completed: "Imported",
  failed: "Failed",
  discarded: "Discarded",
};
