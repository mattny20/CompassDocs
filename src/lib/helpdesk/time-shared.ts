// Helpdesk 1.19.1: time tracking, the parts both sides use (agent V8):
// the shapes the API returns and how minutes read ("1h 25m").

export const TIME_LIMITS = {
  /** One entry: 1 minute to 24 hours (a timer left running stops counting at 24 hours). */
  maxMinutes: 1440,
  note: 300,
} as const;

export interface HdTimeEntry {
  id: number;
  ticket_id: number;
  user_id: number | null;
  user_name: string;
  minutes: number;
  note: string;
  started_at: string | null;
  logged_at: string;
  source: "manual" | "timer";
  /** The viewer may edit or delete it (their own, or as a lead of the ticket's team). */
  can_edit: boolean;
}

export interface HdTimer {
  ticket_id: number;
  ticket_number: number;
  started_at: string;
}

export interface HdTicketTime {
  entries: HdTimeEntry[];
  total_minutes: number;
  /** The viewer's running timer, on this ticket or another. */
  timer: HdTimer | null;
  /** The ticket's team asks for time when an agent solves it. */
  ask_on_solve: boolean;
}

/** "45m", "1h", "1h 25m", "26h 5m". */
export function formatMinutes(m: number): string {
  const n = Math.max(0, Math.round(m));
  const h = Math.floor(n / 60);
  const r = n % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** A running timer's face: "00:12:40". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** "1h 30m", "90", "1.5h", "45m", "2h" → minutes; null when it doesn't read as a duration. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?|ins?)?)?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const h = m[1] ? Number(m[1].replace(",", ".")) : 0;
  const min = m[2] ? Number(m[2]) : 0;
  const total = Math.round(h * 60 + min);
  return Number.isFinite(total) ? total : null;
}
