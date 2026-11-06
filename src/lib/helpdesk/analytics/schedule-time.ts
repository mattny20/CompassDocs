// Helpdesk 1.19.0 reports (agent K): when a report schedule is due, and
// which period its digest covers. Pure (the zone arithmetic is
// lib/helpdesk/sla's), so the schedules dialog shows the same "Next: Monday
// 08:00" the sweep acts on.
//
//   daily     every day at `hour`, covering yesterday
//   weekly    every `weekday` (1 = Monday) at `hour`, covering the 7 days before
//   monthly   the 1st of each month at `hour`, covering the previous month
//
// Hours are in the helpdesk's time zone. A schedule is due when its most
// recent slot is after the last send (or its creation): a server that was
// down at 08:00 sends at the next sweep, once.

import { wallClock, zonedInstant } from "../sla";
import { addDays } from "./shared";

export type HdFrequency = "daily" | "weekly" | "monthly";
export type HdScheduleFormat = "email" | "csv" | "pdf";
export const HD_FREQUENCY_LABEL: Record<HdFrequency, string> = { daily: "Every day", weekly: "Every week", monthly: "Every month" };
export const HD_FORMAT_LABEL: Record<HdScheduleFormat, string> = {
  email: "Summary in the email",
  csv: "Summary and a CSV link",
  pdf: "Summary and a PDF link",
};

export interface HdRecipients {
  users: number[];
  teams: number[];
}

export interface HdReportSchedule {
  id: number;
  dashboard_id: number;
  dashboard_name: string;
  created_by: number | null;
  created_by_name: string | null;
  recipients: HdRecipients;
  /** Names for the dialog. */
  recipient_labels: { users: { id: number; name: string }[]; teams: { id: number; name: string }[] };
  frequency: HdFrequency;
  weekday: number;
  hour: number;
  format: HdScheduleFormat;
  last_sent_at: string | null;
  next_at: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleTiming {
  frequency: HdFrequency;
  weekday: number;
  hour: number;
}

function localDate(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}
function at(date: string, hour: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return zonedInstant(y, m, d, hour, 0, tz);
}
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

/** The most recent slot at or before `now` (ms). */
export function latestSlot(s: ScheduleTiming, tz: string, now: number): number {
  const today = localDate(now, tz);
  if (s.frequency === "daily") {
    const t = at(today, s.hour, tz);
    return t <= now ? t : at(addDays(today, -1), s.hour, tz);
  }
  if (s.frequency === "weekly") {
    let d = addDays(today, -((dow(today) - s.weekday + 7) % 7));
    let t = at(d, s.hour, tz);
    if (t > now) {
      d = addDays(d, -7);
      t = at(d, s.hour, tz);
    }
    return t;
  }
  const first = `${today.slice(0, 7)}-01`;
  const t = at(first, s.hour, tz);
  if (t <= now) return t;
  const [y, m] = today.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
  return at(prev, s.hour, tz);
}

/** The next slot strictly after `now` (ms). */
export function nextSlot(s: ScheduleTiming, tz: string, now: number): number {
  const last = latestSlot(s, tz, now);
  const d = localDate(last, tz);
  if (s.frequency === "daily") return at(addDays(d, 1), s.hour, tz);
  if (s.frequency === "weekly") return at(addDays(d, 7), s.hour, tz);
  const [y, m] = d.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return at(next, s.hour, tz);
}

export function isDue(s: ScheduleTiming & { enabled: number; last_sent_at: string | null; created_at: string }, tz: string, now: number): boolean {
  if (!s.enabled) return false;
  const slot = latestSlot(s, tz, now);
  const since = Date.parse(s.last_sent_at ?? s.created_at);
  return slot > since;
}

/** The dates a digest sent at `slot` covers (inclusive, in the zone). */
export function digestPeriod(s: ScheduleTiming, tz: string, slot: number): { from: string; to: string } {
  const day = localDate(slot, tz);
  const yesterday = addDays(day, -1);
  if (s.frequency === "daily") return { from: yesterday, to: yesterday };
  if (s.frequency === "weekly") return { from: addDays(day, -7), to: yesterday };
  const [y, m] = day.split("-").map(Number);
  const from = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
  return { from, to: yesterday };
}
