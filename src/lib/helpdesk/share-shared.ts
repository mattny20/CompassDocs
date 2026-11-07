// Helpdesk 1.19.4 (area C6): share a ticket with another agent, and print a
// ticket or save it as a PDF. The words, limits and pure rules the desk's
// dialogs, the print page and the server share. No server imports here.
//
// Sharing never grants access: only agents who already work the ticket
// (lib/helpdesk/access canWorkTicket) can receive it. Printing is one
// ticket at a time; bulk print is not offered.

/** The optional message on a share. */
export const HD_SHARE_MESSAGE_MAX = 500;
/** Agents one share may reach. */
export const HD_SHARE_RECIPIENTS_MAX = 10;

/** hd_messages.event of a share's timeline line (lib/helpdesk/share-schema). */
export const HD_SHARE_EVENT = "share";

/** The refusal for a ticket in the recycle bin (409). */
export const HD_SHARE_BINNED = "This ticket is in the recycle bin. Restore it before sharing it.";

/** One agent the share dialog lists. Agents who can't see the ticket are listed, disabled, with the reason. */
export interface HdShareCandidate {
  user_id: number;
  name: string;
  /** Their teams' names, "IT Service Desk, Facilities"; "" when none. */
  teams: string;
  /** Works the ticket, so it can be shared with them. */
  can_see: boolean;
  /** Why not, when not: "Can't see IT Service Desk tickets". */
  reason: string | null;
  /** Has the ticket open right now (presence). */
  viewing: boolean;
  /** Already follows the ticket. */
  following: boolean;
}

/** GET /api/helpdesk/tickets/[number]/share */
export interface HdShareOptions {
  candidates: HdShareCandidate[];
}

/** POST /api/helpdesk/tickets/[number]/share → */
export interface HdShareResult {
  shared: { user_id: number; name: string }[];
  /** Of those, the ones who now follow the ticket (not already, and not after unfollowing it). */
  followed: number[];
}

/** Why an agent can't receive a ticket: the dialog's disabled row and the server's refusal. */
export function shareRefusalReason(teamName: string | null): string {
  return teamName ? `Can't see ${teamName} tickets` : "Can't see this ticket";
}

/** "Sam Lee", "Sam Lee and Marco Rossi", "Sam Lee, Marco Rossi and Lena Fischer". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The internal timeline line a share leaves (kind internal, via system: agents only). */
export function shareLine(actorName: string, names: string[]): string {
  return `${actorName} shared this with ${nameList(names)}`;
}

/**
 * Is this message a share's timeline line? The desk draws it as one muted
 * "Agents only" line rather than a note card. Decided by the structured
 * marker only shareTicket writes (hd_messages.event = 'share'), never by
 * the text: a checklist item or asset name that reads "… shared this with …"
 * stays what it is.
 */
export function isShareLine(m: { kind: string; event?: string | null }): boolean {
  return m.kind === "internal" && m.event === HD_SHARE_EVENT;
}

/** The bell's title for a recipient. */
export function sharedTitle(actorName: string, number: number): string {
  return `${actorName} shared #${number} with you`;
}

/** The bell's body: the subject, the message and whether they now follow it. */
export function sharedBody(subject: string, message: string, followed: boolean): string {
  const parts = [subject];
  if (message) parts.push(`“${message}”`);
  if (followed) parts.push("You now follow it.");
  return parts.join(" · ");
}

/** A clean share message: trimmed, line breaks kept, control characters dropped. Null when too long. */
export function cleanShareMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return v.length > HD_SHARE_MESSAGE_MAX ? null : v;
}

// --- Print ----------------------------------------------------------------------

/** What a printed ticket may include beside the conversation, which is always printed. */
export const HD_PRINT_PARTS = ["details", "notes", "checklists", "time", "attachments"] as const;
export type HdPrintPart = (typeof HD_PRINT_PARTS)[number];
export type HdPrintOptions = Record<HdPrintPart, boolean>;

/** The dialog's defaults (mock-up u4): notes and time off, the rest on. */
export const HD_PRINT_DEFAULTS: HdPrintOptions = { details: true, notes: false, checklists: true, time: false, attachments: true };

export const HD_PRINT_PART_INFO: Record<HdPrintPart, { label: string; hint?: string }> = {
  details: { label: "Details", hint: "Status, priority, team, owner, requester, CCs and dates." },
  notes: { label: "Internal notes", hint: "Only agents should see these. Leave off for anything you hand to the requester." },
  checklists: { label: "Checklists and linked assets" },
  time: { label: "Time logged" },
  attachments: { label: "Attachment names", hint: "Files themselves aren't printed." },
};

/** The print page's query: ?include=details,checklists,attachments. Absent = the defaults; unknown parts are ignored. */
export function parsePrintInclude(raw: string | string[] | null | undefined): HdPrintOptions {
  if (raw === undefined || raw === null) return { ...HD_PRINT_DEFAULTS };
  const v = Array.isArray(raw) ? raw.join(",") : raw;
  const wanted = new Set(v.split(",").map((s) => s.trim()));
  const out = {} as HdPrintOptions;
  for (const p of HD_PRINT_PARTS) out[p] = wanted.has(p);
  return out;
}

export function printIncludeQuery(o: HdPrintOptions): string {
  return HD_PRINT_PARTS.filter((p) => o[p]).join(",");
}

/** The print page for a ticket; `print` opens the browser's dialog once it has loaded. */
export function printHref(number: number, o: HdPrintOptions, print = true): string {
  const qs = new URLSearchParams({ include: printIncludeQuery(o) });
  if (print) qs.set("print", "1");
  return `/desk/tickets/${number}/print?${qs.toString()}`;
}

/** The footer's sentence: "Printed by Ana Kowalski on 6 Nov 2026, 14:05. Internal notes not included." */
export function printFooter(printedBy: string, printedOn: string, notes: boolean): string {
  return `Printed by ${printedBy} on ${printedOn}. Internal notes ${notes ? "included" : "not included"}.`;
}
