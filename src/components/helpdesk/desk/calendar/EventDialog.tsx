"use client";

// Add or change a ticket's event (1.20.6, lib/helpdesk/desk-calendar): the
// Event card's dialog. Start and end as the agent's own clock reads them (the
// desk's time zone for this person), or whole days; the place, with the
// places used before as suggestions; and how long before the start the setup
// must be ready. Saved with one PUT; the server checks it again.

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/Button";
import { Field, Select, TextInput } from "@/components/form";
import { Modal } from "@/components/Modal";
import { useAppSettings } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import {
  addDays,
  daysBetween,
  EVENT_LIMITS,
  eventWhen,
  instantToWall,
  leadLabel,
  parseDay,
  readyByLabel,
  wallToInstant,
  zoneLabel,
  type HdTicketEvent,
  type HdTicketEventView,
} from "@/lib/helpdesk/desk-calendar-shared";
import { getJson, sendJson } from "../api";

/** The setup lead times the dialog offers (minutes); a stored value that isn't one of them is added. */
export const SETUP_CHOICES = [0, 15, 30, 45, 60, 90, 120, 180, 240, 1440];

export function EventDialog({
  number,
  subject,
  event,
  defaultSetup,
  onClose,
  onSaved,
}: {
  number: number;
  subject: string;
  event: HdTicketEvent | null;
  defaultSetup: number;
  onClose: () => void;
  onSaved: (v: HdTicketEventView) => void;
}) {
  const { timezone: tz, time_format } = useAppSettings();
  const h12 = time_format === "12h";
  const titleId = useId();
  const listId = useId();

  // A new event starts at the next full hour and runs for one.
  const initial = useMemo(() => {
    if (event && !event.all_day) return { start: instantToWall(event.starts_at, tz), end: instantToWall(event.ends_at, tz) };
    const next = Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000;
    return { start: instantToWall(next, tz), end: instantToWall(next + 3_600_000, tz) };
  }, [event, tz]);
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [firstDay, setFirstDay] = useState(event?.all_day && event.start_date ? event.start_date : initial.start.slice(0, 10));
  const [lastDay, setLastDay] = useState(event?.all_day && event.end_date ? event.end_date : initial.start.slice(0, 10));
  const [place, setPlace] = useState(event?.place ?? "");
  const [setup, setSetup] = useState(event ? event.setup_minutes : defaultSetup);
  const [places, setPlaces] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Places used before, narrowed as the agent types.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getJson<{ places: string[] }>(`/api/helpdesk/calendar/places?q=${encodeURIComponent(place.trim())}`, "", ctrl.signal)
        .then((d) => setPlaces(d.places ?? []))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [place]);

  const startAt = allDay ? null : wallToInstant(start, tz);
  const endAt = allDay ? null : wallToInstant(end, tz);
  const startError = allDay
    ? !parseDay(firstDay)
      ? "Choose the day."
      : undefined
    : startAt === null
      ? "Choose when it starts."
      : undefined;
  const endError = allDay
    ? !parseDay(lastDay)
      ? "Choose the last day."
      : daysBetween(firstDay, lastDay) < 0
        ? "The last day is before the first."
        : daysBetween(firstDay, lastDay) >= EVENT_LIMITS.maxDays
          ? `An event is at most ${EVENT_LIMITS.maxDays} days long.`
          : undefined
    : endAt === null
      ? "Choose when it ends."
      : startAt !== null && endAt <= startAt
        ? "The end must be after the start."
        : startAt !== null && endAt - startAt > EVENT_LIMITS.maxDays * 86_400_000
          ? `An event is at most ${EVENT_LIMITS.maxDays} days long.`
          : undefined;

  // What the event will read as, while the fields are valid.
  const preview = useMemo((): HdTicketEvent | null => {
    if (startError || endError) return null;
    const base = { timezone: tz, place, setup_minutes: setup, setup_complete: false, setup_completed_at: null, setup_completed_by: null, cancelled: false, cancelled_at: null, source: "agent" as const, repeats: false };
    if (allDay) {
      const s = wallToInstant(`${firstDay}T00:00`, tz)!;
      const e = wallToInstant(`${addDays(lastDay, 1)}T00:00`, tz)!;
      return { ...base, starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), all_day: true, start_date: firstDay, end_date: lastDay, ready_at: new Date(s - setup * 60_000).toISOString() };
    }
    return { ...base, starts_at: new Date(startAt!).toISOString(), ends_at: new Date(endAt!).toISOString(), all_day: false, start_date: null, end_date: null, ready_at: new Date(startAt! - setup * 60_000).toISOString() };
  }, [allDay, firstDay, lastDay, startAt, endAt, startError, endError, place, setup, tz]);

  // Moving the start keeps the length, as calendars do.
  function changeStart(v: string) {
    const was = wallToInstant(start, tz);
    const wasEnd = wallToInstant(end, tz);
    const now = wallToInstant(v, tz);
    setStart(v);
    if (was !== null && wasEnd !== null && now !== null && wasEnd > was) setEnd(instantToWall(now + (wasEnd - was), tz));
  }
  function changeFirstDay(v: string) {
    const span = parseDay(firstDay) && parseDay(lastDay) ? Math.max(0, daysBetween(firstDay, lastDay)) : 0;
    setFirstDay(v);
    if (parseDay(v)) setLastDay(addDays(v, span));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (startError || endError) return;
    const body = allDay
      ? { all_day: true, start_date: firstDay, end_date: lastDay, timezone: tz, place: place.trim(), setup_minutes: setup }
      : { all_day: false, starts_at: new Date(startAt!).toISOString(), ends_at: new Date(endAt!).toISOString(), timezone: tz, place: place.trim(), setup_minutes: setup };
    setBusy(true);
    try {
      const v = await sendJson<HdTicketEventView>(`/api/helpdesk/tickets/${number}/event`, "PUT", body, "Couldn't save the event.");
      toast("ok", event ? "Event changed." : "Event added.");
      onSaved(v);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setupChoices = SETUP_CHOICES.includes(setup) ? SETUP_CHOICES : [...SETUP_CHOICES, setup].sort((a, b) => a - b);

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6">
      <form onSubmit={submit} noValidate data-testid="event-dialog">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <CalendarDays className="h-5 w-5 shrink-0 text-slate-700" aria-hidden />
          {event ? "Change the event" : "Add an event"} on #{number}
        </h2>
        {subject && <p className="mt-1 text-sm text-slate-600">{subject}</p>}

        <div className="mt-4 flex flex-col gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} data-testid="event-all-day" />
            All day
          </label>
          {allDay ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First day" error={tried ? startError : undefined}>
                <TextInput type="date" value={firstDay} onChange={(e) => changeFirstDay(e.target.value)} data-testid="event-first-day" />
              </Field>
              <Field label="Last day" error={tried ? endError : undefined}>
                <TextInput type="date" value={lastDay} min={firstDay} onChange={(e) => setLastDay(e.target.value)} data-testid="event-last-day" />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts" error={tried ? startError : undefined}>
                <TextInput type="datetime-local" value={start} onChange={(e) => changeStart(e.target.value)} data-testid="event-start" />
              </Field>
              <Field label="Ends" error={tried ? endError : undefined}>
                <TextInput type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="event-end" />
              </Field>
            </div>
          )}
          <Field label="Place (optional)" help="A room, a site or an address. Two events at the same place at the same time get a warning.">
            <TextInput value={place} onChange={(e) => setPlace(e.target.value)} maxLength={EVENT_LIMITS.place} list={listId} autoComplete="off" data-testid="event-place" />
          </Field>
          <datalist id={listId}>
            {places.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Field label="Setup ready" help="How long before the start everything must be in place. Reminders count from this time." size="sm">
            <Select value={String(setup)} onChange={(e) => setSetup(Number(e.target.value))} data-testid="event-setup">
              {setupChoices.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "At the start (no setup time)" : `${leadLabel(m)} before`}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-slate-500" aria-live="polite">
            {preview ? (
              <>
                {eventWhen(preview, tz, h12)}
                {setup > 0 ? `. Ready by ${readyByLabel(preview, tz, h12)}.` : "."} {allDay ? "" : `Times are in ${zoneLabel(tz)}.`}
              </>
            ) : (
              `Times are in ${zoneLabel(tz)}.`
            )}
          </p>
          {/* A wall-clock time the clocks skip or repeat is read as the calendar reads it; the line above shows the result. */}
          {!allDay && startAt !== null && instantToWall(startAt, tz) !== start.slice(0, 16) && (
            <p className="text-xs text-slate-500">The clocks change that night, so that start time doesn&apos;t exist. The time shown above is used.</p>
          )}
        </div>

        {error && (
          <p role="alert" className="notice-error mt-4 rounded-lg border px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} data-testid="event-save">
            {event ? "Save event" : "Add event"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
