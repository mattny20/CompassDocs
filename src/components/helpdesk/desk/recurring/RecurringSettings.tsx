"use client";

// Desk settings → Recurring tickets (1.19.1, agent V8): schedules that open
// a ticket by themselves, for checks and maintenance. The two-pane recipe
// (STYLEGUIDE §Helpdesk: the desk, Settings): the schedules in a table
// card (Schedule · Next, the chosen row tinted), the chosen schedule's
// editor beside it. Repeats is a Segmented (Daily, Weekly, Monthly,
// Custom); weekday and month picks are bordered checkbox labels; the next
// three runs are previewed by the server with the team calendar's
// holidays applied. Open one now saves first when there are changes.
// A team lead sees and schedules for their own teams; settings.manage for
// every team (the API checks the same).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Card, CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EmptyState, Field, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, TD, TH } from "@/components/Table";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { HD_PRIORITIES, HD_PRIORITY_LABEL } from "@/lib/helpdesk/types";
import {
  MONTH_SHORT,
  NTH_LABEL,
  RECURRING_PLACEHOLDERS,
  patternSummary,
  scheduleTitle,
  type HdHolidayRule,
  type HdRecurring,
  type HdRecurringAssignMode,
  type HdRecurringPreviewItem,
  type RecurringPattern,
} from "@/lib/helpdesk/recurring-shared";
import { getJson, itemOf, listOf, sendJson } from "../api";

interface TeamOption {
  id: number;
  name: string;
  timezone: string;
  members: { id: number; name: string }[];
}

type Kind = "daily" | "weekly" | "monthly" | "interval";

/** Everything the editor holds; the pattern is built from it on save. */
interface Draft {
  team_id: number;
  subject: string;
  body: string;
  priority: string;
  request_type_id: number | null;
  assign_mode: HdRecurringAssignMode;
  assignee_id: number | null;
  due_business_days: number | null;
  holiday_rule: HdHolidayRule;
  timezone: string;
  enabled: boolean;
  kind: Kind;
  time: string;
  days: number[];
  monthMode: "nth_weekday" | "day";
  nth: number;
  weekday: number;
  day: number;
  months: number[];
  /** Only in the months picked (quarterly, yearly); off = every month. */
  someMonths: boolean;
  unit: "days" | "weeks";
  every: number;
  start: string;
}

const WEEK = [1, 2, 3, 4, 5, 6, 7];
const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_LONG = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DUE_CHOICES = [1, 2, 3, 4, 5, 7, 10, 15, 20];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function blankDraft(team: TeamOption | undefined): Draft {
  return {
    team_id: team?.id ?? 0,
    subject: "",
    body: "",
    priority: "normal",
    request_type_id: null,
    assign_mode: "team_rules",
    assignee_id: null,
    due_business_days: null,
    holiday_rule: "next_working_day",
    timezone: team?.timezone ?? "",
    enabled: true,
    kind: "monthly",
    time: "09:00",
    days: [1],
    monthMode: "nth_weekday",
    nth: 1,
    weekday: 1,
    day: 1,
    months: [],
    someMonths: false,
    unit: "weeks",
    every: 2,
    start: todayIso(),
  };
}

function draftOf(s: HdRecurring): Draft {
  const d = blankDraft(undefined);
  const p = s.pattern;
  const base: Draft = {
    ...d,
    team_id: s.team_id,
    subject: s.subject,
    body: s.body,
    priority: s.priority,
    request_type_id: s.request_type_id,
    assign_mode: s.assign_mode,
    assignee_id: s.assignee_id,
    due_business_days: s.due_business_days,
    holiday_rule: s.holiday_rule,
    timezone: s.timezone,
    enabled: s.enabled,
    kind: p.kind,
    time: p.time,
  };
  if (p.kind === "weekly") base.days = p.days;
  if (p.kind === "monthly") {
    base.monthMode = p.mode;
    base.months = p.months;
    base.someMonths = p.months.length > 0;
    if (p.mode === "nth_weekday") {
      base.nth = p.nth;
      base.weekday = p.weekday;
    } else base.day = p.day;
  }
  if (p.kind === "interval") {
    base.unit = p.unit;
    base.every = p.every;
    base.start = p.start;
  }
  return base;
}

function patternOf(d: Draft): RecurringPattern {
  switch (d.kind) {
    case "daily":
      return { kind: "daily", time: d.time };
    case "weekly":
      return { kind: "weekly", days: d.days, time: d.time };
    case "monthly":
      return d.monthMode === "day"
        ? { kind: "monthly", mode: "day", day: d.day, months: d.someMonths ? d.months : [], time: d.time }
        : { kind: "monthly", mode: "nth_weekday", nth: d.nth, weekday: d.weekday, months: d.someMonths ? d.months : [], time: d.time };
    case "interval":
      return { kind: "interval", unit: d.unit, every: d.every, start: d.start, time: d.time };
  }
}

function bodyOf(d: Draft) {
  return {
    team_id: d.team_id,
    subject: d.subject.trim(),
    body: d.body,
    priority: d.priority,
    request_type_id: d.request_type_id,
    assign_mode: d.assign_mode,
    assignee_id: d.assign_mode === "user" ? d.assignee_id : null,
    due_business_days: d.due_business_days,
    pattern: patternOf(d),
    holiday_rule: d.holiday_rule,
    timezone: d.timezone,
    enabled: d.enabled,
  };
}

/** "Dec 7" in the schedule's zone. */
function nextLabel(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz || undefined }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleDateString();
  }
}

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function RecurringSettings() {
  const router = useRouter();
  const sp = useSearchParams();
  const [schedules, setSchedules] = useState<HdRecurring[] | null>(null);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [types, setTypes] = useState<{ id: number; title: string; team_id: number | null }[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      getJson<{ schedules: HdRecurring[]; teams: TeamOption[]; request_types: { id: number; title: string; team_id: number | null }[] }>(
        "/api/helpdesk/admin/recurring",
        "Couldn't load the recurring tickets."
      )
        .then((d) => {
          setSchedules(listOf<HdRecurring>(d, "schedules"));
          setTeams(d.teams ?? []);
          setTypes(d.request_types ?? []);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    []
  );
  useEffect(() => void load(), [load]);

  const param = sp?.get("schedule") ?? "";
  const isNew = param === "new";
  const chosenId = isNew ? null : Number(param) || schedules?.[0]?.id || null;
  const chosen = schedules?.find((s) => s.id === chosenId) ?? null;
  const open = (id: number | "new") => {
    router.replace(`/desk/settings/recurring?schedule=${id}`, { scroll: false });
    // Stacked (under lg) the editor is below the list: bring it into view.
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
      setTimeout(() => document.getElementById("recurring-editor")?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
    }
  };

  const editorKey = isNew ? "new" : chosen ? `s${chosen.id}-${chosen.updated_at}` : "none";

  return (
    <PageContainer>
      <PageHeader
        icon={<Repeat />}
        title="Recurring tickets"
        subtitle="Tickets that open themselves on a schedule, for checks and maintenance."
        actions={
          teams.length > 0 ? (
            <Button icon={<Plus />} onClick={() => open("new")}>
              New schedule
            </Button>
          ) : undefined
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {schedules === null && !error && <LoadingRow className="py-10" />}
      {schedules && schedules.length === 0 && !isNew && (
        <EmptyState
          icon={<Repeat />}
          title="No recurring tickets yet"
          body={
            teams.length
              ? "Schedule the checks your team does every week or month, like a backup restore test or a fire alarm test. Each one opens a ticket on time, honouring the team's holidays."
              : "You don't lead a team yet. A team's leads schedule its recurring tickets."
          }
          action={teams.length ? { onClick: () => open("new"), label: "New schedule", icon: <Plus /> } : undefined}
        />
      )}
      {schedules && (schedules.length > 0 || isNew) && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Card padding="none" className="overflow-hidden">
            {schedules.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">Your first schedule appears here once it's saved.</p>
            ) : (
              <Table aria-label="Recurring tickets" className="table-fixed">
                <thead className={TABLE_HEAD_ROW}>
                  <tr>
                    <th scope="col" className={TH}>
                      Schedule
                    </th>
                    <th scope="col" className={`${TH} w-24`}>
                      Next
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => {
                    const on = !isNew && s.id === chosenId;
                    return (
                      <tr
                        key={s.id}
                        className={`relative border-b border-slate-100 transition-colors last:border-b-0 ${on ? "bg-compass-50" : "hover:bg-slate-50/70"}`}
                      >
                        <td className={TD}>
                          <button
                            type="button"
                            onClick={() => open(s.id)}
                            aria-current={on ? "true" : undefined}
                            className="block w-full min-w-0 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-compass-500"
                          >
                            <span className="block truncate font-semibold text-slate-900">{scheduleTitle(s.subject)}</span>
                            <span className="mt-0.5 block truncate text-xs text-slate-500">
                              {s.team_name} · {patternSummary(s.pattern)}
                            </span>
                          </button>
                        </td>
                        <td className={`${TD} whitespace-nowrap text-slate-500`}>
                          {!s.enabled ? (
                            <span className={chipClass("neutral", "sm")}>Paused</span>
                          ) : s.next_run_at ? (
                            nextLabel(s.next_run_at, s.timezone)
                          ) : (
                            <span className="text-xs">Not again</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <div className="@container min-w-0">
            {(isNew || chosen) && teams.length > 0 && (
              <Editor
                key={editorKey}
                schedule={isNew ? null : chosen}
                teams={teams}
                types={types}
                onSaved={(s) => {
                  void load();
                  open(s.id);
                }}
                onDeleted={() => {
                  void load();
                  router.replace("/desk/settings/recurring", { scroll: false });
                }}
              />
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Editor({
  schedule,
  teams,
  types,
  onSaved,
  onDeleted,
}: {
  schedule: HdRecurring | null;
  teams: TeamOption[];
  types: { id: number; title: string; team_id: number | null }[];
  onSaved: (s: HdRecurring) => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<Draft>(() => (schedule ? draftOf(schedule) : blankDraft(teams[0])));
  const [busy, setBusy] = useState<"" | "save" | "run" | "delete">("");
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<{ items: HdRecurringPreviewItem[]; error: string } | null>(null);
  const snap = JSON.stringify(d);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);
  const tzList = useMemo(timezones, []);
  const team = teams.find((t) => t.id === d.team_id);
  const set = (p: Partial<Draft>) => {
    markDirty();
    setD((prev) => ({ ...prev, ...p }));
  };

  const subjectError = tried && !d.subject.trim() ? "Give the ticket a subject." : undefined;
  const assigneeError = tried && d.assign_mode === "user" && !d.assignee_id ? "Choose who the ticket goes to." : undefined;
  const daysError = tried && d.kind === "weekly" && d.days.length === 0 ? "Pick at least one day." : undefined;
  const monthsError = tried && d.kind === "monthly" && d.someMonths && d.months.length === 0 ? "Pick at least one month." : undefined;

  // The next three runs, from the server (it knows the team's holidays).
  const pattern = JSON.stringify(patternOf(d));
  const req = useRef(0);
  useEffect(() => {
    if (!d.team_id) return;
    const n = ++req.current;
    // Never show the old dates for a changed pattern while the new ones load.
    setPreview(null);
    const t = setTimeout(() => {
      sendJson<{ items: HdRecurringPreviewItem[] }>(
        "/api/helpdesk/admin/recurring/preview",
        "POST",
        { team_id: d.team_id, pattern: JSON.parse(pattern), holiday_rule: d.holiday_rule, timezone: d.timezone },
        "Couldn't preview the dates."
      )
        .then((r) => n === req.current && setPreview({ items: r.items ?? [], error: "" }))
        .catch((e: Error) => n === req.current && setPreview({ items: [], error: e.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [d.team_id, pattern, d.holiday_rule, d.timezone]);

  async function save(): Promise<HdRecurring | null> {
    setTried(true);
    if (!d.subject.trim() || (d.assign_mode === "user" && !d.assignee_id) || (d.kind === "weekly" && !d.days.length) || (d.kind === "monthly" && d.someMonths && !d.months.length)) return null;
    setBusy("save");
    try {
      const r = schedule
        ? await sendJson(`/api/helpdesk/admin/recurring/${schedule.id}`, "PATCH", bodyOf(d), "Couldn't save the schedule.")
        : await sendJson("/api/helpdesk/admin/recurring", "POST", bodyOf(d), "Couldn't save the schedule.");
      const saved = itemOf<HdRecurring>(r, "schedule");
      markClean();
      toast("ok", schedule ? "Schedule saved." : "Schedule created.");
      return saved;
    } catch (e) {
      toast("error", (e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function runNow() {
    let target = schedule;
    if (!target || dirty) {
      target = await save();
      if (!target) return;
    }
    setBusy("run");
    try {
      const r = await sendJson<{ ticket: { number: number } }>(
        `/api/helpdesk/admin/recurring/${target.id}/run`,
        "POST",
        { request_id: `${target.id}-${Date.now().toString(36)}` },
        "Couldn't open the ticket."
      );
      toast("ok", `Opened #${r.ticket.number}.`);
      onSaved(target);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!schedule) return;
    const ok = await confirmDialog({
      title: `Delete ${scheduleTitle(schedule.subject)}?`,
      body: "No more tickets open from this schedule. Tickets it already opened stay as they are.",
      confirmLabel: "Delete schedule",
      danger: true,
    });
    if (ok !== true) return;
    setBusy("delete");
    try {
      await sendJson(`/api/helpdesk/admin/recurring/${schedule.id}`, "DELETE", undefined, "Couldn't delete the schedule.");
      markClean();
      toast("ok", "Schedule deleted.");
      onDeleted();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const teamTypes = types.filter((t) => t.team_id === null || t.team_id === d.team_id);
  const time = (
    <TextInput type="time" aria-label="Time of day" value={d.time} onChange={(e) => set({ time: e.target.value || "09:00" })} className="w-32" />
  );

  return (
    <section
      id="recurring-editor"
      aria-label={schedule ? `Edit ${scheduleTitle(schedule.subject)}` : "New schedule"}
      className={`${CARD_CLASS} scroll-mt-4 p-4 sm:p-5`}
    >
      <div className="space-y-4">
        <Field label="Subject" error={subjectError} help={`Placeholders: ${RECURRING_PLACEHOLDERS.join(" ")}`}>
          <TextInput value={d.subject} maxLength={300} onChange={(e) => set({ subject: e.target.value })} placeholder="Monthly backup restore test: {{month}}" />
        </Field>
        <Field label="Description" help="The ticket's opening message. The same placeholders work here.">
          <Textarea rows={3} value={d.body} onChange={(e) => set({ body: e.target.value })} />
        </Field>
        <div className="grid gap-4 @md:grid-cols-2">
          <Field label="Team">
            <Select
              value={d.team_id}
              onChange={(e) => {
                const t = teams.find((x) => x.id === Number(e.target.value));
                // A new team: its calendar's zone (when the zone still followed the old team) and its own people.
                set({
                  team_id: Number(e.target.value),
                  timezone: !d.timezone || d.timezone === team?.timezone ? t?.timezone ?? d.timezone : d.timezone,
                  assignee_id: t?.members.some((m) => m.id === d.assignee_id) ? d.assignee_id : null,
                });
              }}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to" error={assigneeError}>
            <Select
              value={d.assign_mode === "user" ? String(d.assignee_id ?? "") : "team_rules"}
              onChange={(e) =>
                e.target.value === "team_rules" ? set({ assign_mode: "team_rules", assignee_id: null }) : set({ assign_mode: "user", assignee_id: Number(e.target.value) || null })
              }
            >
              <option value="team_rules">Team&apos;s assignment rules</option>
              {(team?.members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">
            Repeats
          </p>
          <Segmented<Kind>
            label="Repeats"
            value={d.kind}
            onChange={(k) => set({ kind: k })}
            className="flex-wrap"
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "interval", label: "Custom", hint: "Every few days or weeks" },
            ]}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
            {d.kind === "daily" && (
              <>
                <span>Every day at</span>
                {time}
              </>
            )}
            {d.kind === "monthly" && (
              <>
                <Select
                  aria-label="Which week of the month"
                  className="w-32"
                  value={d.monthMode === "day" ? "day" : String(d.nth)}
                  onChange={(e) => (e.target.value === "day" ? set({ monthMode: "day" }) : set({ monthMode: "nth_weekday", nth: Number(e.target.value) }))}
                >
                  {["1", "2", "3", "4", "-1"].map((n) => (
                    <option key={n} value={n}>
                      {NTH_LABEL[n]}
                    </option>
                  ))}
                  <option value="day">Day of month</option>
                </Select>
                {d.monthMode === "nth_weekday" ? (
                  <Select aria-label="Day of the week" className="w-36" value={d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                    {WEEK.map((w) => (
                      <option key={w} value={w}>
                        {DAY_LONG[w]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select aria-label="Day of the month" className="w-32" value={d.day} onChange={(e) => set({ day: Number(e.target.value) })}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value={-1}>Last day</option>
                  </Select>
                )}
                <span>at</span>
                {time}
              </>
            )}
            {d.kind === "interval" && (
              <>
                <span>Every</span>
                <TextInput
                  type="number"
                  aria-label="How many"
                  min={1}
                  max={d.unit === "weeks" ? 52 : 365}
                  value={d.every}
                  onChange={(e) => set({ every: Math.max(1, Math.min(d.unit === "weeks" ? 52 : 365, Math.round(Number(e.target.value) || 1))) })}
                  className="w-20"
                />
                <Select aria-label="Days or weeks" className="w-28" value={d.unit} onChange={(e) => set({ unit: e.target.value === "days" ? "days" : "weeks" })}>
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                </Select>
                <span>from</span>
                <TextInput type="date" aria-label="First date" value={d.start} onChange={(e) => e.target.value && set({ start: e.target.value })} className="w-40" />
                <span>at</span>
                {time}
              </>
            )}
          </div>
          {d.kind === "weekly" && (
            <fieldset className="mt-3">
              <legend className="sr-only">On these days</legend>
              <div className="flex flex-wrap items-center gap-2">
                {WEEK.map((w) => {
                  const on = d.days.includes(w);
                  return (
                    <label key={w} className={pickClass(on)}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => set({ days: e.target.checked ? [...d.days, w].sort() : d.days.filter((x) => x !== w) })}
                        className="h-4 w-4"
                      />
                      <span aria-hidden>{DAY_SHORT[w]}</span>
                      <span className="sr-only">{DAY_LONG[w]}</span>
                    </label>
                  );
                })}
                <span className="ml-1 text-sm text-slate-700">at</span>
                {time}
              </div>
              {daysError && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {daysError}
                </p>
              )}
            </fieldset>
          )}
          {d.kind === "monthly" && (
            <fieldset className="mt-3">
              <legend className="sr-only">Months</legend>
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={d.someMonths} onChange={(e) => set({ someMonths: e.target.checked })} />
                <span>Only in some months (quarterly or yearly)</span>
              </label>
              {d.someMonths && (
                <div className="ml-6 mt-2 flex flex-wrap gap-1.5">
                  {MONTH_SHORT.slice(1).map((label, i) => {
                    const m = i + 1;
                    const on = d.months.includes(m);
                    return (
                      <label key={m} className={pickClass(on, true)}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => set({ months: e.target.checked ? [...d.months, m].sort((a, b) => a - b) : d.months.filter((x) => x !== m) })}
                          className="h-3.5 w-3.5"
                        />
                        <span aria-hidden>{label}</span>
                        <span className="sr-only">{MONTH_LONG[m]}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {monthsError && (
                <p role="alert" className="ml-6 mt-1 text-xs text-red-600">
                  {monthsError}
                </p>
              )}
            </fieldset>
          )}
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={d.holiday_rule === "next_working_day"}
              onChange={(e) => set({ holiday_rule: e.target.checked ? "next_working_day" : "skip" })}
            />
            <span>If that day is a holiday for the team, open it on the next working day</span>
          </label>
          {d.holiday_rule !== "next_working_day" && (
            <div className="ml-6 mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <span>On a holiday:</span>
              <Select
                aria-label="On a holiday"
                className="w-44"
                value={d.holiday_rule}
                onChange={(e) => set({ holiday_rule: e.target.value === "same_day" ? "same_day" : "skip" })}
              >
                <option value="skip">Skip that date</option>
                <option value="same_day">Open it anyway</option>
              </Select>
            </div>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Priority and due</p>
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Priority" className="w-32" value={d.priority} onChange={(e) => set({ priority: e.target.value })}>
              {HD_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {HD_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Due"
              className="w-56"
              value={d.due_business_days ?? 0}
              onChange={(e) => set({ due_business_days: Number(e.target.value) || null })}
            >
              <option value={0}>No due date</option>
              {DUE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  Due in {n} business {n === 1 ? "day" : "days"}
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-2 text-xs text-slate-500" aria-live="polite" data-testid="recurring-preview">
            {preview === null
              ? "Working out the next dates…"
              : preview.error
                ? preview.error
                : preview.items.length
                  ? `Next three: ${preview.items.map((i) => (i.note ? `${i.label} (${i.note})` : i.label)).join(" · ")}`
                  : "This pattern doesn't fall on any date in the next year or so."}
          </p>
        </div>

        <div className="grid gap-4 @md:grid-cols-2">
          <Field label="Request type" help="Optional. Its workflow starts as for any request.">
            <Select value={d.request_type_id ?? 0} onChange={(e) => set({ request_type_id: Number(e.target.value) || null })}>
              <option value={0}>None</option>
              {teamTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Time zone" help={team && d.timezone === team.timezone ? "The team calendar's" : undefined}>
            <Select value={d.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {!tzList.includes(d.timezone) && d.timezone && <option value={d.timezone}>{d.timezone}</option>}
              {tzList.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Toggle label="Schedule is on" help="Paused schedules keep their settings and open nothing." checked={d.enabled} onChange={(v) => set({ enabled: v })} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 print:hidden">
        {schedule && (
          <Button variant="ghost" icon={<Trash2 />} onClick={remove} busy={busy === "delete"} className="mr-auto hover-danger">
            Delete
          </Button>
        )}
        {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
        <Button variant="secondary" onClick={runNow} busy={busy === "run"} disabled={busy !== ""}>
          Open one now
        </Button>
        <Button
          onClick={async () => {
            const s = await save();
            if (s) onSaved(s);
          }}
          busy={busy === "save"}
          disabled={busy !== ""}
        >
          Save
        </Button>
      </div>
    </section>
  );
}

function pickClass(on: boolean, small = false): string {
  return `inline-flex cursor-pointer items-center gap-1.5 rounded-lg border ${small ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm"} transition ${
    on ? "border-compass-300 bg-compass-50 text-compass-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"
  }`;
}
