"use client";

// The weekly hours editor: one row per day, Monday first. A day is Closed,
// Open all day (00:00–24:00), or a list of intervals (split shifts; an end
// at or before the start runs past midnight). "Copy Monday to weekdays"
// copies Monday's hours to Tuesday–Friday. Times are native time inputs;
// an end of 00:00 means midnight and is stored as 24:00.

import { Copy, Plus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Select, TextInput } from "@/components/form";
import { DAY_LONG, WEEK_ORDER, weeklyOpenMinutes } from "@/lib/helpdesk/calendars-shared";
import type { HdWeekSchedule } from "@/lib/helpdesk/calendars-shared";
import type { HdTimeInterval } from "@/lib/helpdesk/types";

type Mode = "closed" | "allday" | "hours";

function modeOf(ivs: HdTimeInterval[]): Mode {
  if (!ivs.length) return "closed";
  if (ivs.length === 1 && ivs[0].start === "00:00" && ivs[0].end === "24:00") return "allday";
  return "hours";
}

const shown = (t: string) => (t === "24:00" ? "00:00" : t);

/** The schedule as saved: an end of 00:00 (midnight) is 24:00 unless the interval runs overnight from a later start. */
export function normalizeSchedule(s: HdWeekSchedule): HdWeekSchedule {
  return s.map((ivs) => ivs.map((iv) => ({ start: iv.start, end: iv.end === "00:00" && iv.start !== "00:00" ? "24:00" : iv.end })));
}

function overnight(iv: HdTimeInterval): boolean {
  return iv.end !== "24:00" && iv.end !== "00:00" && iv.end <= iv.start;
}

export function WeeklyGrid({ value, onChange, problems }: { value: HdWeekSchedule; onChange: (s: HdWeekSchedule) => void; problems?: string }) {
  const setDay = (day: number, ivs: HdTimeInterval[]) => onChange(value.map((d, i) => (i === day ? ivs : d)));
  const copyMonday = () => onChange(value.map((d, i) => (i >= 2 && i <= 5 ? value[1].map((iv) => ({ ...iv })) : d)));
  const total = weeklyOpenMinutes(normalizeSchedule(value));
  return (
    <fieldset>
      <legend className="sr-only">Weekly hours</legend>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {total === 0 ? "Closed all week" : `${Math.round((total / 60) * 10) / 10} hours a week`}
        </p>
        <Button variant="secondary" size="sm" icon={<Copy />} onClick={copyMonday} disabled={modeOf(value[1]) === "closed" && value.slice(2, 6).every((d) => !d.length)}>
          Copy Monday to weekdays
        </Button>
      </div>
      <ul role="list" className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {WEEK_ORDER.map((day) => {
          const ivs = value[day] ?? [];
          const mode = modeOf(ivs);
          const name = DAY_LONG[day];
          return (
            <li key={day} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
              <div className="flex items-center justify-between gap-3 sm:w-56 sm:shrink-0 sm:pt-1">
                <span className="text-sm font-medium text-slate-800">{name}</span>
                <Select
                  dense
                  className="w-auto"
                  aria-label={`${name} hours`}
                  value={mode}
                  onChange={(e) => {
                    const m = e.target.value as Mode;
                    setDay(day, m === "closed" ? [] : m === "allday" ? [{ start: "00:00", end: "24:00" }] : [{ start: "09:00", end: "17:30" }]);
                  }}
                >
                  <option value="closed">Closed</option>
                  <option value="hours">Open</option>
                  <option value="allday">Open 24 hours</option>
                </Select>
              </div>
              <div className="min-w-0 flex-1">
                {mode === "closed" && <p className="text-sm text-slate-500 sm:pt-1">Closed</p>}
                {mode === "allday" && <p className="text-sm text-slate-600 sm:pt-1">Open 24 hours</p>}
                {mode === "hours" && (
                  <div className="flex flex-col gap-1.5">
                    {ivs.map((iv, j) => (
                      <div key={j}>
                      <div className="flex items-center gap-1.5">
                        <TextInput
                          dense
                          type="time"
                          className="min-w-0 flex-1 sm:w-32 sm:flex-none"
                          aria-label={`${name} opens, interval ${j + 1}`}
                          value={shown(iv.start)}
                          onChange={(e) => setDay(day, ivs.map((x, k) => (k === j ? { ...x, start: e.target.value || "00:00" } : x)))}
                        />
                        <span className="text-sm text-slate-500" aria-hidden>
                          to
                        </span>
                        <TextInput
                          dense
                          type="time"
                          className="min-w-0 flex-1 sm:w-32 sm:flex-none"
                          aria-label={`${name} closes, interval ${j + 1}`}
                          value={shown(iv.end)}
                          onChange={(e) => setDay(day, ivs.map((x, k) => (k === j ? { ...x, end: e.target.value || "00:00" } : x)))}
                        />
                        <button
                          type="button"
                          className={iconButtonClass("quiet", "sm")}
                          aria-label={`Remove ${name} ${shown(iv.start)} to ${shown(iv.end)}`}
                          data-tt="Remove"
                          onClick={() => setDay(day, ivs.filter((_, k) => k !== j))}
                        >
                          <X aria-hidden />
                        </button>
                      </div>
                      {overnight(iv) && <p className="mt-0.5 text-xs text-slate-500">Closes {shown(iv.end)} the next day</p>}
                      </div>
                    ))}
                    {ivs.length < 6 && (
                      <div>
                        <button
                          type="button"
                          className="link inline-flex items-center gap-1 text-xs font-medium"
                          onClick={() => {
                            const last = ivs[ivs.length - 1];
                            const start = last && last.end !== "24:00" && last.end > last.start ? last.end : "13:00";
                            setDay(day, [...ivs, { start, end: start < "17:00" ? "17:00" : "23:00" }]);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden />
                          Add hours
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {problems && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {problems}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">A shift that ends at or before it starts (22:00 to 06:00) runs into the next morning. An end of 00:00 is midnight.</p>
    </fieldset>
  );
}
