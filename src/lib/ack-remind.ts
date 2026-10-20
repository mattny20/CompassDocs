// Reminder cadence and escalation copy (E2, 1.13.0): the pure half of the
// hourly sweep. The SQL claims in lib/db decide who is reminded; these
// helpers say when the next automatic reminder falls for a row the portal
// shows, and word every notice the sweep sends, so the server (lib/compliance)
// and the client (the portal row subtitle, the roster) read the same rules.
// No server-only import: safe in client components.

const DAY = 86_400_000;

/** The three numbers the reminder claim resolves per policy (policy → space → workspace → built-in). */
export interface ReminderCadence {
  remind_before_days: number;
  remind_every_days: number;
  nudge_every_days: number;
}

/** The columns of one policy_assignments row the cadence reads. */
export interface ReminderRow {
  due_at: string | null;
  reminded_at: string | null;
  snoozed_until?: string | null;
}

function addDays(iso: string, days: number): number {
  return new Date(iso).getTime() + days * DAY;
}

/**
 * When the hourly sweep will next remind this row, mirroring the claim's
 * WHERE: with a deadline, once the due date is within `remind_before_days`
 * and the last reminder is older than `remind_every_days`; without one,
 * every `nudge_every_days` when that is above 0, else never (null). A date
 * already past means the next tick, so `now` is answered. A snooze pushes
 * the date to its end. The row's confirmation state is the caller's to
 * check: a confirmed or exempt row is never reminded, whatever this says.
 */
export function nextReminderAt(row: ReminderRow, cadence: ReminderCadence, now: Date = new Date()): Date | null {
  let next: number;
  if (row.due_at) {
    next = addDays(row.due_at, -cadence.remind_before_days);
    if (row.reminded_at) next = Math.max(next, addDays(row.reminded_at, cadence.remind_every_days));
  } else {
    if (cadence.nudge_every_days <= 0) return null;
    next = row.reminded_at ? addDays(row.reminded_at, cadence.nudge_every_days) : now.getTime();
  }
  next = Math.max(next, now.getTime());
  if (row.snoozed_until) next = Math.max(next, new Date(row.snoozed_until).getTime());
  return new Date(next);
}

/** What the portal row's subtitle reads from (ackReminderSummary in lib/db, or a single row through nextReminderAt). */
export interface ReminderSubtitleRow {
  /** The newest reminder stamp over the policy's open rows, or the manual Remind's, whichever is later. */
  last_reminded_at: string | null;
  /** The earliest next automatic reminder over the policy's open rows; null when nothing is scheduled. */
  next_reminder_at: string | null;
}

/** "today", "yesterday", "2 days ago". */
export function daysAgoLabel(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The portal row's subtitle: "last reminded 2 days ago · next automatic
 * reminder 29 Oct 2026", either half alone, or null when there is nothing
 * to say. `fmt` formats an ISO date the way the page does.
 */
export function reminderSubtitle(row: ReminderSubtitleRow, fmt: (iso: string) => string, now: Date = new Date()): string | null {
  const parts: string[] = [];
  if (row.last_reminded_at) parts.push(`last reminded ${daysAgoLabel(row.last_reminded_at, now)}`);
  if (row.next_reminder_at) parts.push(`next automatic reminder ${fmt(row.next_reminder_at)}`);
  return parts.length ? parts.join(" · ") : null;
}

// --- The notices' words ----------------------------------------------------------

/** "29 Oct": the in-app body's date (no year: the notice is about this month). */
export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "29 Oct 2026": the email's {{due_date}}. */
export function longDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The {{status_label}} tag: a reminder with no deadline reads "Reminder". */
export type DueStatusLabel = "Due soon" | "Overdue" | "Reminder";

export function dueStatusLabel(dueAt: string | null, overdue: boolean): DueStatusLabel {
  if (!dueAt) return "Reminder";
  return overdue ? "Overdue" : "Due soon";
}

/**
 * The in-app title of one reminder: 'Due in 3 days: confirm "X"',
 * 'Due today: confirm "X"' (the date passed but the grace period has not),
 * 'Overdue: confirm "X"', or 'Reminder: confirm "X"' without a deadline.
 */
export function dueNoticeTitle(docTitle: string, dueAt: string | null, overdue: boolean, now: Date = new Date()): string {
  if (!dueAt) return `Reminder: confirm "${docTitle}"`;
  if (overdue) return `Overdue: confirm "${docTitle}"`;
  const days = Math.ceil((new Date(dueAt).getTime() - now.getTime()) / DAY);
  if (days <= 0) return `Due today: confirm "${docTitle}"`;
  return `Due in ${days} ${days === 1 ? "day" : "days"}: confirm "${docTitle}"`;
}

/** How a date is written: the server passes the workspace's formatter (lib/format formatDate); the defaults are en-GB. */
export type DayFormatter = (iso: string) => string;

/** The in-app body: 'Due 29 Oct.' or, without a deadline, the standing sentence. */
export function dueNoticeBody(docTitle: string, dueAt: string | null, fmt: DayFormatter = shortDay): string {
  return dueAt ? `Due ${fmt(dueAt)}.` : `You still need to read and confirm "${docTitle}".`;
}

/** 'Please confirm by 29 Oct 2026.' for the email, blank without a deadline. */
export function dueLine(dueAt: string | null, fmt: DayFormatter = longDay): string {
  return dueAt ? `Please confirm by ${fmt(dueAt)}.` : "";
}

export interface BundledPolicy {
  title: string;
  due_at: string | null;
  overdue: boolean;
}

/** One notice instead of four or more: 'You have 5 policies to confirm'. */
export function bundleTitle(count: number): string {
  return `You have ${count} ${count === 1 ? "policy" : "policies"} to confirm`;
}

/** The bundle's in-app body: 'Code of Conduct (due 29 Oct) · Expense policy (overdue) · +3'. */
export function bundleBody(items: BundledPolicy[], fmt: DayFormatter = shortDay, max = 4): string {
  const shown = items.slice(0, max).map((i) => `${i.title} (${i.overdue ? "overdue" : i.due_at ? `due ${fmt(i.due_at)}` : "no deadline"})`);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
}

/** The bundle email's {{policy_list}}: one markdown bullet per policy. */
export function bundleList(items: BundledPolicy[], fmt: DayFormatter = longDay): string {
  return items
    .map((i) => `- ${i.title}${i.overdue ? " (overdue)" : i.due_at ? ` (due ${fmt(i.due_at)})` : ""}`)
    .join("\n");
}

/** 'Overdue: 7 people on "Acceptable Use Policy"'. */
export function escalationTitle(count: number, docTitle: string): string {
  return `Overdue: ${count} ${count === 1 ? "person" : "people"} on "${docTitle}"`;
}

/** 'More than 7 days overdue: Ana Ruiz, Ben Lo, +5'. */
export function escalationBody(days: number, names: string[], max = 2): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
  return `More than ${days} ${days === 1 ? "day" : "days"} overdue: ${list}`;
}

/** The escalation email's {{overdue_list}}: one bullet per person with their due date. */
export function escalationList(people: { name: string; due_at: string | null }[], fmt: DayFormatter = longDay): string {
  return people.map((p) => `- ${p.name}${p.due_at ? ` (due ${fmt(p.due_at)})` : ""}`).join("\n");
}
