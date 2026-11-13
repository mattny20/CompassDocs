"use client";

// The ticket side panel's "Event" card (1.20.6, lib/helpdesk/desk-calendar;
// STYLEGUIDE §Helpdesk: the event calendar). A ticket carries at most one
// event: when, where, and how long before the start its setup must be
// ready. Agents who work the ticket add, change and remove it here and mark
// "Setup complete"; until that is marked the ticket can't be solved. Another
// event at the same place at an overlapping time shows as a warning with a
// link to its ticket, never a refusal.
//
// Times are shown in the viewer's own time zone (the workspace's, or the one
// on their account), as everywhere in the desk; whole-day events are their
// calendar days, whatever the zone.

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { CalendarDays, Check, MapPin, Pencil, Plus, Repeat, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { EYEBROW_TEXT } from "@/components/Heading";
import { RelativeTime } from "@/components/RelativeTime";
import { useAppSettings } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { eventWhen, leadLabel, readyByLabel, type HdEventConflict, type HdTicketEvent, type HdTicketEventView } from "@/lib/helpdesk/desk-calendar-shared";
import { getJson, sendJson } from "../api";
import { ticketHref } from "../ui";
import { EventDialog } from "./EventDialog";

export function TicketEventCard({
  number,
  subject,
  canWork,
  locked,
  initial,
  refreshKey,
  onChanged,
}: {
  number: number;
  subject: string;
  canWork: boolean;
  /** The ticket is closed or merged: its event can no longer be changed. */
  locked?: boolean;
  /** The event the ticket detail already carries, so the card paints at once. */
  initial?: HdTicketEvent;
  /** Reload when this changes (the ticket's updated_at). */
  refreshKey?: unknown;
  /** The event changed: reload the ticket (its timeline has a new line). */
  onChanged?: () => void;
}) {
  const { timezone: tz, time_format } = useAppSettings();
  const h12 = time_format === "12h";
  const [view, setView] = useState<HdTicketEventView | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const headId = useId();

  const load = useCallback(
    () =>
      getJson<HdTicketEventView>(`/api/helpdesk/tickets/${number}/event`)
        .then(setView)
        .catch(() => setView((v) => v ?? { event: initial ?? null, conflicts: [], can_edit: false, default_setup_minutes: 30 })),
    [number, initial]
  );
  // A ticket with no event asks the server nothing: the ticket itself says there is none. With one, the block
  // reads its double-bookings and what the agent may change.
  const hasEvent = !!initial;
  useEffect(() => {
    if (!canWork) return;
    if (hasEvent) void load();
    else setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, canWork, refreshKey, hasEvent]);

  const event = view ? view.event : initial ?? null;
  const canEdit = canWork && (view ? view.can_edit : !locked);
  if (!event && !canEdit) return null;

  async function setup(complete: boolean) {
    setBusy(true);
    try {
      const v = await sendJson<HdTicketEventView>(`/api/helpdesk/tickets/${number}/event/setup`, "POST", { complete }, "Couldn't save that.");
      setView(v);
      toast("ok", complete ? "Setup marked complete." : "Setup marked as not complete.");
      onChanged?.();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: "Remove the event?",
      body: "It comes off the calendar and its reminders stop. The ticket stays as it is.",
      confirmLabel: "Remove event",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/tickets/${number}/event`, "DELETE", undefined, "Couldn't remove the event.");
      toast("ok", "Event removed.");
      load();
      onChanged?.();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <section aria-labelledby={headId} className={`${CARD_CLASS} p-4`} data-testid="event-card">
      <div className="flex items-center gap-1">
        <h3 id={headId} className={`${EYEBROW_TEXT} flex min-w-0 flex-1 items-center gap-1.5`}>
          <CalendarDays className="h-3.5 w-3.5" aria-hidden /> Event
        </h3>
        {event && canEdit && (
          <>
            <button type="button" onClick={() => setEditing(true)} aria-label="Change the event" data-tt="Change" className={`${iconButtonClass("quiet", "sm")} print:hidden`}>
              <Pencil aria-hidden />
            </button>
            <button type="button" onClick={remove} aria-label="Remove the event" data-tt="Remove" className={`${iconButtonClass("quiet", "sm", "hover-danger")} print:hidden`}>
              <Trash2 aria-hidden />
            </button>
          </>
        )}
      </div>

      {!event ? (
        <>
          <p className="mt-2 text-xs text-slate-500">For a meeting, a room setup or a visit: put it on the desk&apos;s calendar and get reminders before it starts.</p>
          <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => void load().finally(() => setEditing(true))} className="mt-2.5 w-full print:hidden">
            Add an event
          </Button>
        </>
      ) : (
        <>
          <p className={`mt-2 text-sm font-medium ${event.cancelled ? "text-slate-500 line-through" : "text-slate-800"}`} data-testid="event-when">
            {eventWhen(event, tz, h12)}
          </p>
          {event.place && (
            <p className="mt-1 flex items-start gap-1.5 text-sm text-slate-700">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="min-w-0 break-words">
                <span className="sr-only">Place: </span>
                {event.place}
              </span>
            </p>
          )}
          {!event.cancelled && (
            <p className="mt-1 text-xs text-slate-500">
              {event.setup_minutes > 0 ? `Ready by ${readyByLabel(event, tz, h12)} · ${leadLabel(event.setup_minutes)} before` : "No setup time before the start"}
            </p>
          )}
          {event.repeats && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
              <Repeat className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              From a meeting that repeats. Only this date is on the calendar.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {event.cancelled ? (
              <Chip tone="neutral" size="sm">
                Cancelled
              </Chip>
            ) : event.setup_complete ? (
              <>
                <Chip tone="ok" size="sm">
                  <Check className="h-3 w-3" aria-hidden /> Setup complete
                </Chip>
                <span className="text-xs text-slate-500">
                  {event.setup_completed_by ? `${event.setup_completed_by} · ` : ""}
                  {event.setup_completed_at && <RelativeTime value={event.setup_completed_at} />}
                </span>
              </>
            ) : (
              <Chip tone="warn" size="sm">
                Setup not complete
              </Chip>
            )}
          </div>
          {event.cancelled && <p className="mt-1.5 text-xs text-slate-500">A cancelled event doesn&apos;t hold the ticket open.</p>}

          {canEdit && !event.cancelled && !event.setup_complete && (
            <>
              <Button variant="secondary" size="sm" icon={<Check />} busy={busy} onClick={() => setup(true)} className="mt-2.5 w-full print:hidden" data-testid="event-setup-complete">
                Mark setup complete
              </Button>
              <p className="mt-1.5 text-xs text-slate-500">The ticket can&apos;t be solved until setup is complete.</p>
            </>
          )}
          {canEdit && !event.cancelled && event.setup_complete && (
            <Button variant="ghost" size="sm" icon={<Undo2 />} busy={busy} onClick={() => setup(false)} className="mt-1.5 print:hidden">
              Not complete after all
            </Button>
          )}

          {(view?.conflicts.length ?? 0) > 0 && <Conflicts place={event.place} conflicts={view!.conflicts} tz={tz} h12={h12} />}
        </>
      )}

      {editing && (
        <EventDialog
          number={number}
          subject={subject}
          event={event}
          defaultSetup={view?.default_setup_minutes ?? 30}
          onClose={() => setEditing(false)}
          onSaved={(v) => {
            setView(v);
            setEditing(false);
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

/** The double-booking warning: the other events at this place whose time overlaps, each linked to its ticket. */
export function Conflicts({ place, conflicts, tz, h12 }: { place: string; conflicts: HdEventConflict[]; tz: string; h12: boolean }) {
  return (
    <div role="status" className="notice-warn mt-3 rounded-lg border px-3 py-2 text-xs" data-testid="event-conflicts">
      <p className="flex items-center gap-1.5 font-semibold">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Double-booked: {place}
      </p>
      <ul className="mt-1 space-y-1">
        {conflicts.map((c, i) => (
          <li key={c.number ?? `x${i}`}>
            {c.number ? (
              <Link href={ticketHref(c.number)} className="font-medium underline">
                #{c.number} {c.subject}
              </Link>
            ) : (
              <span className="font-medium">An event of {c.team_name ?? "another team"}</span>
            )}
            <span className="block">{eventWhen(c, tz, h12)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1">Setup time counts. Nothing is blocked: check with the other ticket&apos;s owner.</p>
    </div>
  );
}
