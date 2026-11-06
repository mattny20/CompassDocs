// Helpdesk 1.19.2: recurring schedules follow calendar edits (agent W5).
// A schedule stores its next run (hd_recurring.next_run_at / next_key),
// worked out on its team's calendar when it was saved or last ran. When a
// calendar, a holiday set or a holiday changes, or a team moves calendar,
// the stored next run of every enabled schedule of the teams that change
// reaches is worked out again here, so the list and the editor never show
// a date the calendar no longer gives (1.19.1 corrected it only when the
// sweep reached the old date).
//
// Called once per calendar write from lib/helpdesk/calendars recompute(),
// after its ticket re-timing, with the teams it re-timed. Each schedule is
// locked (FOR UPDATE) and re-read in its own short transaction, so a sweep
// opening it (which holds the same row) is waited for, never raced. A run
// already due (next_run_at <= now) is left to the sweep, which asks the
// calendar again before opening it (recurring.ts occurrenceToday), so a
// due occurrence is never skipped by a recompute. Occurrences that already
// opened a ticket stay spent (computeNextRun skips their keys). Never
// throws into the calendar write: a failure is logged and the sweep still
// corrects the date when it gets there. Server-only.

import "server-only";
import { logEvent } from "../log";
import { hq, withTx } from "./db-core";
import { computeNextRun } from "./recurring";
import { isHolidayRule, type RecurringPattern } from "./recurring-shared";

interface Sched {
  id: number;
  team_id: number;
  pattern: RecurringPattern;
  holiday_rule: string;
  timezone: string;
  next_run_at: Date | string | null;
  next_key: string | null;
}

/**
 * Work out again the stored next run of every enabled schedule of these
 * teams. Answers how many changed.
 */
export async function recomputeRecurringForTeams(teamIds: number[], now = Date.now()): Promise<number> {
  const teams = [...new Set(teamIds)].filter((n) => Number.isInteger(n));
  if (!teams.length) return 0;
  const ids = await hq<{ id: number }>("SELECT id FROM hd_recurring WHERE enabled = 1 AND team_id = ANY($1::int[]) ORDER BY id", [teams]);
  let changed = 0;
  for (const { id } of ids) {
    try {
      const moved = await withTx(async (client) => {
        const r = await client.query<Sched>(
          "SELECT id, team_id, pattern, holiday_rule, timezone, next_run_at, next_key FROM hd_recurring WHERE id = $1 AND enabled = 1 FOR UPDATE",
          [id]
        );
        const s = r.rows[0];
        if (!s) return false;
        const storedAt = s.next_run_at ? new Date(s.next_run_at).getTime() : null;
        // Due already: the sweep's own check decides what it is today.
        if (storedAt !== null && storedAt <= now) return false;
        const next = await computeNextRun(
          {
            id: s.id,
            team_id: s.team_id,
            pattern: s.pattern,
            holiday_rule: isHolidayRule(s.holiday_rule) ? s.holiday_rule : "next_working_day",
            timezone: s.timezone,
            enabled: true,
          },
          now,
          client
        );
        const nextAt = next ? next.at.getTime() : null;
        if (nextAt === storedAt && (next?.key ?? null) === s.next_key) return false;
        await client.query("UPDATE hd_recurring SET next_run_at = $2, next_key = $3 WHERE id = $1", [s.id, next?.at ?? null, next?.key ?? null]);
        return true;
      });
      if (moved) changed++;
    } catch (e) {
      logEvent("error", "helpdesk.recurring_recompute_failed", { recurring_id: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (changed) logEvent("info", "helpdesk.recurring_recomputed", { teams: teams.length, changed });
  return changed;
}
