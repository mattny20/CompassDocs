// Helpdesk 1.20.6: reminders to agents about a ticket's event
// (lib/helpdesk/desk-calendar). One entry in lib/periodic HELPDESK_SWEEPS,
// run every minute by every instance.
//
//   when      Desk settings → Event calendar lists lead times before "ready
//             by" (the event's start minus its setup lead time): by default
//             one day and one hour. A reminder is due from its lead time
//             until "ready by" passes. When an event is added late, so that
//             several are due at once, only the nearest is sent and the
//             others count as sent: nobody gets "in 1 day" and "in 1 hour"
//             in the same minute. One more, "late", is due once the event
//             has started with its setup still not marked complete (for a
//             day after the start, so a desk that was switched off over a
//             weekend does not wake to reminders about last week).
//   to whom   the ticket's owner; with no owner, its team's agents (or the
//             owner and the team, by the setting). "Late" also goes to the
//             team's leads. Each agent's own notification settings decide
//             the channels (Desk settings → Notifications, "Event
//             reminders": bell, email, push; quiet hours and pause apply).
//             With the setting on, agents a connected chat app knows also
//             get a direct message in Microsoft Teams or Slack.
//   once      a reminder is claimed by inserting (ticket, kind, time_rev)
//             into hd_event_reminders before it is sent: the row's primary
//             key lets exactly one instance win, and a restart finds it
//             there. A changed start, end or lead time bumps the event's
//             time_rev, so its reminders are due again for the new time.
//   never     a cancelled event, one whose setup is marked complete, or a
//             ticket that is solved, closed, merged or in the recycle bin.
//
// Server-only.

import "server-only";
import { logEvent } from "../log";
import { hq } from "./db-core";
import { hoursForTeam } from "./calendars";
import { eventWhen, leadLabel, readyByLabel, validZone, zoneLabel, type HdCalendarSettings } from "./desk-calendar-shared";
import { getCalendarSettings, toEvent, type EventRow } from "./desk-calendar";

const LATE_WINDOW_MS = 24 * 3600_000;
const BATCH = 200;

interface DueRow extends EventRow {
  number: number;
  subject: string;
  team_id: number | null;
  assignee_id: number | null;
}

/** The reminder kinds due for an event at `now`, nearest first: "late", or "lead:<minutes>" for each lead time whose moment has come. */
export function dueKinds(e: { starts_at: string; ready_at: string }, settings: Pick<HdCalendarSettings, "reminder_minutes" | "late_reminder">, now: number): string[] {
  const start = new Date(e.starts_at).getTime();
  const ready = new Date(e.ready_at).getTime();
  if (now >= start) return settings.late_reminder && now - start < LATE_WINDOW_MS ? ["late"] : [];
  if (now >= ready) return [];
  return [...settings.reminder_minutes].sort((a, b) => a - b).filter((m) => now >= ready - m * 60_000).map((m) => `lead:${m}`);
}

/** Who a reminder goes to (active accounts only). */
export async function reminderRecipients(t: { team_id: number | null; assignee_id: number | null }, kind: string, settings: Pick<HdCalendarSettings, "recipients">): Promise<number[]> {
  const { teamMemberIds } = await import("./notify");
  const ids = new Set<number>();
  if (t.assignee_id) {
    const live = await hq<{ id: number }>("SELECT id FROM users WHERE id = $1 AND status = 'active'", [t.assignee_id]);
    if (live.length) ids.add(t.assignee_id);
  }
  if (settings.recipients === "owner_and_team" || !ids.size) for (const id of await teamMemberIds(t.team_id)) ids.add(id);
  if (kind === "late") for (const id of await teamMemberIds(t.team_id, { leadsOnly: true })) ids.add(id);
  return [...ids].slice(0, 200);
}

/** "Setup due in 1 hour", "Setup due now", "The event has started and setup isn't marked complete". */
export function reminderHeadline(kind: string, e: { ready_at: string }, now: number): string {
  if (kind === "late") return "The event has started and setup isn't marked complete";
  const left = Math.round((new Date(e.ready_at).getTime() - now) / 60_000);
  return left <= 1 ? "Setup due now" : `Setup due in ${leadLabel(roundLead(left))}`;
}

/** 59 → 60, 1439 → 1440: a sweep that runs a few seconds late still says "1 hour". */
function roundLead(minutes: number): number {
  if (minutes >= 1440) return Math.round(minutes / 60) * 60;
  if (minutes >= 120) return Math.round(minutes / 15) * 15;
  if (minutes >= 55) return Math.round(minutes / 5) * 5;
  return minutes;
}

/**
 * The minute sweep: send every reminder that is due and not yet claimed.
 * Answers what was sent (tests read it). Never throws for one ticket's
 * failure: the claim stands and the next one goes on.
 */
export async function eventReminderSweep(now: Date = new Date(), opts: { only?: number[] } = {}): Promise<{ sent: { ticket_id: number; kind: string; recipients: number }[] }> {
  const out: { ticket_id: number; kind: string; recipients: number }[] = [];
  const settings = await getCalendarSettings();
  if (!settings.reminder_minutes.length && !settings.late_reminder) return { sent: out };
  const maxLead = Math.max(0, ...settings.reminder_minutes);
  const rows = await hq<DueRow>(
    `SELECT e.ticket_id, e.starts_at, e.ends_at, e.all_day, to_char(e.start_date, 'YYYY-MM-DD') AS start_date, to_char(e.end_date, 'YYYY-MM-DD') AS end_date,
            e.timezone, e.place, e.place_key, e.setup_minutes, e.ready_at, e.setup_done_at, e.setup_done_by, e.setup_done_by_name, e.cancelled_at,
            e.source, e.ics_uid, e.ics_sequence, e.repeats, e.time_rev, e.updated_at, t.number, t.subject, t.team_id, t.assignee_id
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
      WHERE e.cancelled_at IS NULL AND e.setup_done_at IS NULL
        AND t.deleted_at IS NULL AND t.merged_into IS NULL AND t.status IN ('new', 'open', 'pending', 'on_hold')
        AND e.ready_at <= $1::timestamptz + make_interval(mins => $2) AND e.starts_at > $1::timestamptz - interval '24 hours'
        AND ($3::int[] IS NULL OR e.ticket_id = ANY($3::int[]))
        -- Nothing left to send for this revision once "late" has gone.
        AND NOT EXISTS (SELECT 1 FROM hd_event_reminders r WHERE r.ticket_id = e.ticket_id AND r.time_rev = e.time_rev AND r.kind = 'late')
      ORDER BY e.ready_at LIMIT ${BATCH}`,
    [now, maxLead, opts.only ?? null]
  );
  for (const r of rows) {
    try {
      const due = dueKinds(r, settings, now.getTime());
      if (!due.length) continue;
      // Claim every due kind in one statement; the nearest one that this instance won is the one it sends.
      const won = await hq<{ kind: string }>(
        `INSERT INTO hd_event_reminders (ticket_id, kind, time_rev, sent_at)
         SELECT $1, k, $3, $4 FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING RETURNING kind`,
        [r.ticket_id, due, r.time_rev, now]
      );
      // The nearest due kind was already sent (or is another instance's): the rest are only marked.
      if (!won.some((w) => w.kind === due[0])) continue;
      const n = await send(r, due[0], settings, now);
      await hq("UPDATE hd_event_reminders SET recipients = $4 WHERE ticket_id = $1 AND kind = $2 AND time_rev = $3", [r.ticket_id, due[0], r.time_rev, n]);
      out.push({ ticket_id: r.ticket_id, kind: due[0], recipients: n });
    } catch (e) {
      logEvent("error", "helpdesk.event_reminder_failed", { ticket_id: r.ticket_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { sent: out };
}

async function send(r: DueRow, kind: string, settings: HdCalendarSettings, now: Date): Promise<number> {
  const ids = await reminderRecipients(r, kind, settings);
  if (!ids.length) return 0;
  const event = toEvent(r);
  let tz = "UTC";
  try {
    const z = (await hoursForTeam(r.team_id)).timezone;
    if (validZone(z)) tz = z;
  } catch {
    /* UTC */
  }
  const headline = reminderHeadline(kind, r, now.getTime());
  const when = event.all_day ? eventWhen(event, tz) : `${eventWhen(event, tz)} (${zoneLabel(tz)})`;
  const readyBy = `${readyByLabel(event, tz)}${event.setup_minutes > 0 ? ` (${leadLabel(event.setup_minutes)} before)` : ""}`;
  const { deliverToAgent } = await import("./notify");
  const { hdLinks, helpdeskOrigin } = await import("./email");
  const origin = await helpdeskOrigin(undefined).catch(() => "");
  const url = hdLinks.ticket(r.number);
  const body = `${r.subject} · ${when}${event.place ? ` · ${event.place}` : ""}`;
  let n = 0;
  for (const id of ids) {
    await deliverToAgent(
      id,
      "event_reminder",
      {
        ticketNumber: r.number,
        title: `#${r.number}: ${headline}`,
        body,
        urgent: kind === "late",
        url,
        teamId: r.team_id,
        email: {
          template: "hd_event_reminder",
          vars: { ticket_number: String(r.number), subject: r.subject, headline, event_when: when, event_place: event.place || "No place given", ready_by: readyBy, ticket_url: url },
        },
      },
      { origin }
    );
    n++;
  }
  if (settings.chat) await chatReminders(ids, `**#${r.number}: ${headline}**\n${r.subject}\n${when}${event.place ? ` at ${event.place}` : ""}\nReady by ${readyBy}.`, origin ? `${origin}${url}` : "");
  return n;
}

/** A direct message in each connected chat app to the agents it knows. Never throws; an app that is not connected is skipped. */
async function chatReminders(userIds: number[], text: string, link: string): Promise<void> {
  try {
    const { appConnected, getChatSettings } = await import("./chat/settings");
    const { portFor } = await import("./chat/core");
    const s = await getChatSettings();
    for (const app of ["teams", "slack"] as const) {
      if (!appConnected(s, app)) continue;
      const port = await portFor(app, s);
      if (!port) continue;
      for (const id of userIds.slice(0, 50)) {
        try {
          const dm = await port.dmFor(id);
          if (dm) await port.post(dm, { kind: "text", text: link ? `${text}\n[Open the ticket](${link})` : text });
        } catch (e) {
          logEvent("warn", "helpdesk.event_reminder_chat_failed", { app, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  } catch (e) {
    logEvent("warn", "helpdesk.event_reminder_chat_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}
