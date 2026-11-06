"use client";

// Settings → Calendars → Office hours (agent L): the two-pane recipe
// (STYLEGUIDE §Settings pages, export presets): the calendars on the left
// (Default chip, the open-hours summary, the teams on it), the selected
// calendar's editor on the right (name and time zone, the weekly grid, the
// holiday sets it observes) with one SaveRow; under it, every team with
// its calendar (changed at once). Saving re-times the open tickets of the
// calendar's teams.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { CardTitle } from "@/components/Heading";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { EmptyState, Field, SectionEmpty, TextInput } from "@/components/form";
import { railIconClass, railRowClass } from "@/components/RailLink";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { Tooltip } from "@/components/Tooltip";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { summarizeSchedule, validateSchedule, validTimeZone } from "@/lib/helpdesk/calendars-shared";
import type { HdWeekSchedule } from "@/lib/helpdesk/calendars-shared";
import { sendJson } from "../api";
import { TimezoneField } from "./TimezoneField";
import { TeamCalendarSelect } from "./TeamCalendarSelect";
import { WeeklyGrid, normalizeSchedule } from "./WeeklyGrid";
import { useCalendarsData } from "./data";
import type { CalendarRow } from "./data";

interface Draft {
  name: string;
  timezone: string;
  schedule: HdWeekSchedule;
  holiday_set_ids: number[];
}

const draftOf = (c: CalendarRow): Draft => ({ name: c.name, timezone: c.timezone, schedule: c.schedule, holiday_set_ids: [...c.holiday_set_ids].sort((a, b) => a - b) });

export function CalendarsPanel() {
  const { data, error, reload } = useCalendarsData();
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const snap = JSON.stringify(draft);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const cal = data?.calendars.find((c) => c.id === selected) ?? null;
  useEffect(() => {
    if (!data) return;
    if (selected == null || !data.calendars.some((c) => c.id === selected)) setSelected(data.default_id ?? data.calendars[0]?.id ?? null);
  }, [data, selected]);
  useEffect(() => {
    if (cal && !dirty) setDraft(draftOf(cal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal?.id, cal?.updated_at]);

  const teamsOn = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const t of data?.teams ?? []) {
      const id = t.calendar_id ?? data!.default_id;
      if (id == null) continue;
      m.set(id, [...(m.get(id) ?? []), t.name]);
    }
    return m;
  }, [data]);

  if (error && !data) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-10" />;

  const set = (p: Partial<Draft>) => {
    markDirty();
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  async function pick(id: number) {
    if (id === selected) return;
    if (dirty && !(await confirmDialog({ title: "Discard unsaved changes?", body: "This calendar has changes you haven't saved.", confirmLabel: "Discard", danger: true }))) return;
    markClean(JSON.stringify(null));
    setDraft(null);
    setSelected(id);
    setTried(false);
  }

  async function create() {
    const v = await formDialog({
      title: "New calendar",
      body: "Office hours for a team in another time zone, a 24/7 desk or a shorter Friday. It starts as Monday to Friday, 09:00 to 17:30.",
      fields: [{ key: "name", label: "Name", placeholder: "New York office", validate: (s) => (s.trim().length > 80 ? "Up to 80 characters." : undefined) }],
      confirmLabel: "Create calendar",
    });
    if (!v) return;
    const def = data!.calendars.find((c) => c.is_default);
    const day = [{ start: "09:00", end: "17:30" }];
    try {
      const r = await sendJson<{ calendar: CalendarRow }>(
        "/api/helpdesk/admin/calendars",
        "POST",
        { name: v.name.trim(), timezone: def?.timezone ?? "Europe/London", schedule: [[], day, day, day, day, day, []], holiday_set_ids: def?.holiday_set_ids ?? [] },
        "Couldn't create the calendar."
      );
      toast("ok", `${r.calendar.name} created. Set its hours, then pick it for a team.`);
      await reload();
      markClean(JSON.stringify(null));
      setDraft(null);
      setSelected(r.calendar.id);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const sched = draft ? validateSchedule(normalizeSchedule(draft.schedule)) : null;
  const errs = {
    name: draft && !draft.name.trim() ? "Name the calendar." : undefined,
    timezone: draft && !validTimeZone(draft.timezone.trim()) ? "Pick a time zone from the list." : undefined,
    schedule: sched && !sched.ok ? sched.error : undefined,
  };

  async function save() {
    setTried(true);
    if (!draft || !cal || Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const r = await sendJson<{ retimed: number }>(
        `/api/helpdesk/admin/calendars/${cal.id}`,
        "PATCH",
        { name: draft.name.trim(), timezone: draft.timezone.trim(), schedule: normalizeSchedule(draft.schedule), holiday_set_ids: draft.holiday_set_ids },
        "Couldn't save the calendar."
      );
      markClean(snap);
      toast("ok", `${draft.name.trim()} saved.${r.retimed ? ` ${r.retimed} open ticket${r.retimed === 1 ? "" : "s"} re-timed.` : ""}`);
      await reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    if (!cal) return;
    const ok = await confirmDialog({
      title: `Make ${cal.name} the default?`,
      body: "Teams without a calendar of their own, and tickets without a team, will count their reply targets in these hours. Their open tickets are re-timed.",
      confirmLabel: "Make default",
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/calendars/${cal.id}/default`, "POST", {}, "Couldn't change the default calendar.");
      toast("ok", `${cal.name} is now the default calendar.`);
      await reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove() {
    if (!cal) return;
    const using = teamsOn.get(cal.id) ?? [];
    const ok = await confirmDialog({
      title: `Delete ${cal.name}?`,
      body: using.length ? `${using.join(", ")} will use the default calendar instead, and their open tickets are re-timed.` : "No team uses it.",
      confirmLabel: "Delete calendar",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/calendars/${cal.id}`, "DELETE", undefined, "Couldn't delete the calendar.");
      toast("ok", `${cal.name} deleted.`);
      markClean(JSON.stringify(null));
      setDraft(null);
      setSelected(null);
      await reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  if (!data.calendars.length) {
    return <EmptyState icon={<CalendarClock />} title="No calendars yet" body="Calendars hold each team's office hours and the holidays it observes." action={{ label: "New calendar", onClick: create }} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card id="calendars" padding="none" title="Calendars" className="scroll-mt-6 self-start lg:sticky lg:top-6">
          <ul role="list" className="space-y-0.5 p-2">
            {data.calendars.map((c) => {
              const active = c.id === selected;
              const teams = teamsOn.get(c.id) ?? [];
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => void pick(c.id)} aria-current={active ? "true" : undefined} className={`w-full text-left ${railRowClass(active, { dense: true })}`}>
                    <CalendarClock className={`h-4 w-4 self-start mt-0.5 ${railIconClass(active)}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{c.name}</span>
                        {c.is_default && (
                          <span className={chipClass("info", "sm")}>
                            <span className="sr-only">, </span>Default
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-2xs font-normal text-slate-500">
                        <span className="sr-only">, </span>
                        {c.summary} · {c.timezone}
                      </span>
                      <span className="block truncate text-2xs font-normal text-slate-500">
                        <span className="sr-only">, </span>
                        {teams.length ? `${c.is_default ? "Default for " : ""}${teams.join(", ")}` : "No teams"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-slate-100 px-4 py-3">
            <Button variant="secondary" icon={<Plus />} onClick={create}>
              New calendar
            </Button>
          </div>
        </Card>

        {cal && draft && (
          <div className="@container flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{cal.name}</CardTitle>
              <div className="flex flex-wrap gap-2">
                {!cal.is_default && (
                  <Button variant="secondary" size="sm" icon={<Star />} onClick={makeDefault}>
                    Make default
                  </Button>
                )}
                {cal.is_default ? (
                  <Tooltip label="The default calendar can't be deleted. Make another one the default first.">
                    <Button variant="danger" size="sm" icon={<Trash2 />} disabled>
                      Delete
                    </Button>
                  </Tooltip>
                ) : (
                  <Button variant="danger" size="sm" icon={<Trash2 />} onClick={remove}>
                    Delete
                  </Button>
                )}
              </div>
            </div>

            <Card id="calendar-name" title="Name and time zone" description="The zone the hours below are in." className="scroll-mt-6">
              <div className="grid gap-4 @lg:grid-cols-2">
                <Field label="Name" size="md" error={tried ? errs.name : undefined}>
                  <TextInput value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <TimezoneField value={draft.timezone} onChange={(timezone) => set({ timezone })} error={tried ? errs.timezone : undefined} />
              </div>
            </Card>

            <Card id="calendar-hours" title="Weekly hours" description={`When reply targets count. Now: ${summarizeSchedule(normalizeSchedule(draft.schedule))}.`} className="scroll-mt-6">
              <WeeklyGrid value={draft.schedule} onChange={(schedule) => set({ schedule })} problems={tried || (sched && !sched.ok && sched.error.includes("overlap")) ? errs.schedule : undefined} />
            </Card>

            <Card
              id="calendar-holidays"
              title="Holidays"
              description="Days (or parts of days) this calendar is closed. The clock stops and requesters see why."
              className="scroll-mt-6"
              actions={
                <Link href="/desk/settings/calendars/holidays" className="link text-sm font-medium">
                  Manage holidays
                </Link>
              }
            >
              {data.holiday_sets.length === 0 ? (
                <SectionEmpty action={{ href: "/desk/settings/calendars/holidays", label: "Add a holiday set" }}>No holiday sets yet.</SectionEmpty>
              ) : (
                <fieldset>
                  <legend className="sr-only">Holiday sets this calendar observes</legend>
                  <ul role="list" className="flex flex-col gap-2">
                    {data.holiday_sets.map((s) => {
                      const on = draft.holiday_set_ids.includes(s.id);
                      return (
                        <li key={s.id}>
                          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4"
                              checked={on}
                              onChange={() => set({ holiday_set_ids: on ? draft.holiday_set_ids.filter((x) => x !== s.id) : [...draft.holiday_set_ids, s.id].sort((a, b) => a - b) })}
                            />
                            <span>
                              <span className="font-medium text-slate-800">{s.name}</span>
                              <span className="block text-xs text-slate-500">
                                {s.holiday_count} holiday{s.holiday_count === 1 ? "" : "s"}
                                {s.description ? ` · ${s.description}` : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}
            </Card>
            <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save calendar" />
          </div>
        )}
      </div>

      <Card id="calendar-teams" padding="none" title="Teams" description="Each team counts its reply targets in its own calendar. Changes apply at once." className="scroll-mt-6">
        {data.teams.length === 0 ? (
          <SectionEmpty className="px-4 py-6" action={{ href: "/desk/settings/teams", label: "Create a team" }}>
            No teams yet.
          </SectionEmpty>
        ) : (
          <ul role="list" className="divide-y divide-slate-100">
            {data.teams.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm font-medium text-slate-800">{t.name}</span>
                <div className="sm:w-80">
                  <TeamCalendarSelect teamId={t.id} data={data} onChanged={reload} showLabel={false} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
