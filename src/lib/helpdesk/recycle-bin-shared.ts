// Helpdesk 1.19.4 (C7): the recycle bin's constants, shapes and pure
// helpers, shared by lib/helpdesk/recycle-bin (server) and the desk's bin
// view, delete dialog and binned-ticket banner (client). No server imports.

/** How long a ticket stays in the bin before the purge sweep deletes it for good. */
export const BIN_DAYS = 30;
/** Up to this many tickets per bulk delete, restore or purge (the bulk bar's limit). */
export const BIN_BULK_MAX = 200;
/** The name a system delete is shown under in the bin ("Deleted by Retention rule"). */
export const BIN_RETENTION_ACTOR = "Retention rule";

const DAY_MS = 86_400_000;

/** When a ticket binned at `deletedAt` is deleted for good. */
export function binPurgeAt(deletedAt: string | Date): Date {
  return new Date(new Date(deletedAt).getTime() + BIN_DAYS * DAY_MS);
}

/** Whole days left before the purge (rounded up; 0 once due). A ticket binned today has 30. */
export function binDaysLeft(deletedAt: string | Date, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((binPurgeAt(deletedAt).getTime() - now) / DAY_MS));
}

/** "30 days", "1 day", "today". */
export function binDaysLeftLabel(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

/** A binned ticket as the bin lists it. */
export interface HdBinRow {
  number: number;
  subject: string;
  team_id: number | null;
  team_name: string | null;
  status: string;
  requester_name: string;
  deleted_at: string;
  /** "Ana Kowalski", or a system actor such as "Retention rule". */
  deleted_by_name: string;
  /** ISO time of the purge (deleted_at + BIN_DAYS). */
  purge_at: string;
  days_left: number;
  /** A hold placed after it was binned: the purge skips it. */
  legal_hold: boolean;
}

/** One ticket's answer to a bulk bin, restore or purge (and the delete dialog's preview). */
export interface HdBinResult {
  number: number;
  subject?: string;
  ok: boolean;
  /** The reason it stays, as a sentence ("On legal hold. It stays."). */
  error?: string;
  /** Short chip text for the dialog ("Legal hold, stays"). */
  chip?: string;
  /** One more line about its task tickets ("Its task #1101 goes with it." / "Task #1102 stays: …"). */
  note?: string;
}

/** The binned ticket's banner (GET /api/helpdesk/recycle-bin/[number]). */
export interface HdBinnedInfo {
  number: number;
  deleted_at: string;
  deleted_by_name: string;
  purge_at: string;
  days_left: number;
  can_restore: boolean;
  can_purge: boolean;
  legal_hold: boolean;
}

/**
 * The Roles page's 1.19.4 markers (mock-up v4): "Delete tickets" changed
 * meaning (it now moves to the bin), "Delete for good" is new.
 */
export const HD_CAP_BADGES: Record<string, "New" | "Changed"> = {
  "tickets.delete": "Changed",
  "tickets.purge": "New",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();

/** "Today, 14:02", "Yesterday, 09:15", "2 Nov", "9 Oct 2025": when it was binned, in the viewer's clock. */
export function binWhenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayKey(d) === dayKey(now)) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return `Yesterday, ${time}`;
  return binDateLabel(iso, now);
}

/** "6 Dec" ("6 Dec 2027" in another year). */
export function binDateLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

/** The binned ticket's banner sentence (v3): "Ana Kowalski deleted it today at 14:02. It's deleted for good on 6 Dec unless it's restored." */
export function binBannerText(info: Pick<HdBinnedInfo, "deleted_at" | "deleted_by_name" | "purge_at" | "legal_hold">, now: Date = new Date()): string {
  const when = binWhenLabel(info.deleted_at, now);
  const at = /^(Today|Yesterday), /.test(when) ? `${when.replace(/, .*/, "").toLowerCase()} at ${when.replace(/^.*, /, "")}` : `on ${when}`;
  const tail = info.legal_hold
    ? "It's on legal hold, so it stays until the hold is lifted."
    : `It's deleted for good on ${binDateLabel(info.purge_at, now)} unless it's restored.`;
  return `${info.deleted_by_name} deleted it ${at}. ${tail}`;
}
