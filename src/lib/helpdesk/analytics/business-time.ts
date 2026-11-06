// Helpdesk 1.19.0 reports (agent K): business minutes for thousands of
// tickets at once. lib/helpdesk/sla's businessMinutesBetween is the
// definition (working days, a daily window, holidays, any IANA zone) but it
// works out each day's window afresh with Intl calls, which is right for
// one ticket and too slow for a 20,000-ticket report. A BusinessClock is the
// same rules with each local day's window and each hour's UTC offset worked
// out once and remembered, so a report pays for a day once, not once per
// ticket. test/helpdesk-analytics.test.ts checks it against
// businessMinutesBetween over random intervals, DST changes and holidays.
//
// Pure (no I/O); the hours come from lib/helpdesk/analytics/hours.

import { wallClock, zonedInstant } from "../sla";
import type { HdBusinessHours } from "../types";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_SCAN_DAYS = 3 * 366;

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h || 0, m || 0];
}

export class BusinessClock {
  private readonly days: Set<number>;
  private readonly holidays: Set<string>;
  private readonly sh: number;
  private readonly sm: number;
  private readonly eh: number;
  private readonly em: number;
  readonly calendarOnly: boolean;
  private readonly windows = new Map<number, [number, number] | null>();
  private readonly midnights = new Map<number, number>();
  private readonly offsets = new Map<number, number>();
  private readonly dayOffsets = new Map<number, number | null>();

  constructor(readonly hours: HdBusinessHours) {
    this.days = new Set(hours.days);
    this.holidays = new Set(hours.holidays);
    [this.sh, this.sm] = hm(hours.start);
    [this.eh, this.em] = hm(hours.end);
    this.calendarOnly = hours.days.length === 0 || this.eh * 60 + this.em <= this.sh * 60 + this.sm;
  }

  private offsetAt(t: number): number {
    const w = wallClock(t, this.hours.timezone);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000;
  }

  /**
   * The local calendar day (days since 1970-01-01 in the zone) of instant t.
   * The zone's offset is worked out once per UTC day (the same at both ends
   * means no change that day), and per hour only on a day the clocks change.
   */
  private localDay(t: number): number {
    const dk = Math.floor(t / DAY);
    let uniform = this.dayOffsets.get(dk);
    if (uniform === undefined) {
      const a = this.offsetAt(dk * DAY);
      const b = this.offsetAt(dk * DAY + DAY - 1000);
      uniform = a === b ? a : null;
      this.dayOffsets.set(dk, uniform);
    }
    let off = uniform;
    if (off === null) {
      const k = Math.floor(t / HOUR);
      off = this.offsets.get(k) ?? this.offsetAt(t);
      this.offsets.set(k, off);
    }
    return Math.floor((t + off) / DAY);
  }

  private ymd(day: number): [number, number, number, number] {
    const d = new Date(day * DAY);
    const dow = d.getUTCDay() || 7;
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), dow];
  }

  private window(day: number): [number, number] | null {
    if (this.windows.has(day)) return this.windows.get(day)!;
    const [y, m, d, dow] = this.ymd(day);
    let win: [number, number] | null = null;
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (this.days.has(dow) && !this.holidays.has(key)) {
      const open = zonedInstant(y, m, d, this.sh, this.sm, this.hours.timezone);
      const close = zonedInstant(y, m, d, this.eh, this.em, this.hours.timezone);
      win = close > open ? [open, close] : null;
    }
    this.windows.set(day, win);
    return win;
  }

  private midnight(day: number): number {
    let t = this.midnights.get(day);
    if (t === undefined) {
      const [y, m, d] = this.ymd(day);
      t = zonedInstant(y, m, d, 0, 0, this.hours.timezone);
      this.midnights.set(day, t);
    }
    return t;
  }

  /** Business minutes between two instants (ms); 0 when b ≤ a. Same answer as sla.businessMinutesBetween. */
  minutesBetween(a: number, b: number): number {
    if (b <= a) return 0;
    if (this.calendarOnly) return (b - a) / MIN;
    let total = 0;
    let day = this.localDay(a);
    for (let i = 0; i < MAX_SCAN_DAYS; i++, day++) {
      const win = this.window(day);
      if (win) {
        const [open, close] = win;
        if (open >= b) break;
        const lo = Math.max(open, a);
        const hi = Math.min(close, b);
        if (hi > lo) total += hi - lo;
      } else if (this.midnight(day) >= b) break;
    }
    return total / MIN;
  }
}

/** One clock per distinct set of hours (teams that share a calendar share a clock). */
export function clockCache(): (hours: HdBusinessHours) => BusinessClock {
  const clocks = new Map<string, BusinessClock>();
  return (hours) => {
    const key = JSON.stringify(hours);
    let c = clocks.get(key);
    if (!c) {
      c = new BusinessClock(hours);
      clocks.set(key, c);
    }
    return c;
  };
}
