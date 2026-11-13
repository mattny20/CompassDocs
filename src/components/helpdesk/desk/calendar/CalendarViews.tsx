"use client";

// The Calendar page's views (1.20.6, STYLEGUIDE §Helpdesk: the event
// calendar): the day and week time grids, the month grid, and the list that
// stands in for all three on a narrow screen. Every item is a link to its
// ticket, in reading order (day by day, then by time), so the whole calendar
// is reachable with Tab; a day's heading opens that day.
//
// An event is drawn with its setup block (hatched) above it. A due time or a
// recurring ticket (the optional layers) is an outline, never a filled
// block. Colour follows the team or the status, and each item also says
// which in words.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Clock, MapPin, Repeat, TriangleAlert } from "lucide-react";
import { SectionEmpty } from "@/components/form";
import { addDays, dayLabel, dayOf, parseDay, timeLabel, wallMinutes, weekdayShort, type HdCalendarColour, type HdCalendarView } from "@/lib/helpdesk/desk-calendar-shared";
import { dayBlocks, dayItems, itemStartLabel, itemSummary, itemTime, itemTone, layerShort, type CalItem, type GridBlock } from "./calendar-model";
import styles from "./Calendar.module.css";

export interface ViewProps {
  days: string[];
  items: CalItem[];
  tz: string;
  h12: boolean;
  today: string;
  colour: HdCalendarColour;
  slots: Map<number, number>;
  /** Open one day in the Day view. */
  onOpenDay: (day: string) => void;
}

const ev = (color: string) => ({ "--ev": color }) as React.CSSProperties;

function Marks({ i }: { i: CalItem }) {
  if (i.kind === "due") return <Clock className={`h-3 w-3 shrink-0 ${i.overdue ? "text-red-600" : "text-slate-500"}`} aria-hidden />;
  if (i.kind === "recurring") return <Repeat className="h-3 w-3 shrink-0 text-slate-500" aria-hidden />;
  return (
    <>
      {i.conflicts.length > 0 && !i.cancelled && <TriangleAlert className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />}
      {i.setupComplete && !i.cancelled && <Check className="h-3 w-3 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />}
    </>
  );
}

/** What the visible words leave out, for a screen reader. */
function Hidden({ i }: { i: CalItem }) {
  if (i.kind !== "event") return <span className="sr-only">{i.overdue ? ", overdue" : ""}</span>;
  return (
    <span className="sr-only">
      , {i.statusLabel}
      {i.cancelled ? ", cancelled" : i.setupComplete ? ", setup complete" : ", setup not complete"}
      {i.conflicts.length > 0 && !i.cancelled ? ", double-booked" : ""}
    </span>
  );
}

/** One line: the month's cells and the whole-day strip. */
function ItemRow({ i, day, p }: { i: CalItem; day: string; p: ViewProps }) {
  const tone = itemTone(i, p.colour, p.slots);
  const cls = `${styles.row} ${i.kind !== "event" ? styles.rowLayer : ""} ${i.cancelled ? styles.cancelled : ""}`;
  const inner = (
    <>
      <span className={styles.tag}>{tone.tag}</span>
      <Marks i={i} />
      <span className="shrink-0 tabular-nums">{itemStartLabel(i, day, p.tz, p.h12)}</span>
      <span className={`min-w-0 truncate ${styles.title}`}>
        {i.kind !== "event" && <span className="font-semibold">{layerShort(i)} </span>}
        {i.number ? `#${i.number} ` : ""}
        {i.title}
      </span>
      <Hidden i={i} />
    </>
  );
  const tip = itemSummary(i, day, p.tz, p.h12);
  return i.href ? (
    <Link href={i.href} className={cls} style={ev(tone.color)} data-tt={tip} data-tt-wrap data-cal-item={i.key}>
      {inner}
    </Link>
  ) : (
    <span className={cls} style={ev(tone.color)} tabIndex={0} data-tt={tip} data-tt-wrap data-cal-item={i.key}>
      {inner}
    </span>
  );
}

// --- Day and week: the time grid ------------------------------------------------------

function Block({ b, day, p, wide }: { b: GridBlock; day: string; p: ViewProps; wide: boolean }) {
  const i = b.item;
  const tone = itemTone(i, p.colour, p.slots);
  const top = (b.top / 1440) * 100;
  const height = ((b.bottom - b.top) / 1440) * 100;
  const width = 100 / b.cols;
  const style: React.CSSProperties = { ...ev(tone.color), top: `${top}%`, height: `${height}%`, left: `calc(${b.col * width}% + 1px)`, width: `calc(${width}% - 3px)` };
  const setupShare = i.kind === "event" && b.eventTop > b.top ? ((b.eventTop - b.top) / (b.bottom - b.top)) * 100 : 0;
  const tip = itemSummary(i, day, p.tz, p.h12);
  const cls = `${styles.block} ${i.kind !== "event" ? styles.layer : ""} ${i.cancelled ? styles.cancelled : ""}`;
  // A short block (a layer item, a half-hour event) is one line: its time, then its words.
  const compact = i.kind !== "event" || b.bottom - b.eventTop < 45;
  const inner = (
    <>
      {setupShare > 0 && (
        <span className={styles.setup} style={{ height: `${setupShare}%` }}>
          Setup<span className="sr-only"> from {timeLabel(i.ready, p.tz, p.h12)}. </span>
        </span>
      )}
      {compact ? (
        <span className={`${styles.body} flex items-center gap-1 text-2xs leading-tight`}>
          <Marks i={i} />
          <span className="shrink-0 font-semibold tabular-nums text-slate-700">
            {i.kind === "event" ? timeLabel(i.start, p.tz, p.h12) : `${layerShort(i)} ${timeLabel(i.start, p.tz, p.h12)}`}
          </span>
          <span className={`min-w-0 truncate font-semibold ${styles.title}`}>
            {i.number ? `#${i.number} ` : ""}
            {i.title}
          </span>
          <span className="sr-only">
            {i.kind === "event" ? `, until ${timeLabel(i.end, p.tz, p.h12)}${i.place ? `, ${i.place}` : ""}` : i.kind === "recurring" ? ", a recurring ticket" : ""}, {tone.label}
          </span>
          <Hidden i={i} />
        </span>
      ) : (
        <span className={styles.body}>
          <span className="flex items-center gap-1 text-2xs font-semibold tabular-nums text-slate-700">
            <Marks i={i} />
            <span className="truncate">{itemTime(i, day, p.tz, p.h12)}</span>
          </span>
          <span className={`block text-xs font-semibold leading-tight ${wide ? "" : "break-words"} ${styles.title}`}>
            {i.number ? `#${i.number} ` : ""}
            {i.title}
          </span>
          {i.place && (
            <span className="mt-0.5 flex items-start gap-0.5 text-2xs leading-tight text-slate-700">
              <MapPin className="mt-px h-2.5 w-2.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{i.place}</span>
            </span>
          )}
          <span className="mt-0.5 block truncate text-2xs leading-tight text-slate-600">
            {tone.label}
            {wide && i.assignee ? ` · ${i.assignee}` : ""}
          </span>
          <Hidden i={i} />
        </span>
      )}
    </>
  );
  return i.href ? (
    <Link href={i.href} className={cls} style={style} data-tt={tip} data-tt-wrap data-cal-item={i.key}>
      {inner}
    </Link>
  ) : (
    <span className={cls} style={style} tabIndex={0} data-tt={tip} data-tt-wrap data-cal-item={i.key}>
      {inner}
    </span>
  );
}

export function TimeGrid(p: ViewProps) {
  const { days, items, tz, h12, today } = p;
  const wide = days.length === 1;
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const perDay = useMemo(() => days.map((d) => ({ day: d, blocks: dayBlocks(items, d, tz), allDay: items.filter((i) => i.kind === "event" && i.allDay && i.startDate! <= d && i.endDate! >= d) })), [days, items, tz]);
  const first = Math.min(8 * 60, ...perDay.flatMap((d) => d.blocks.map((b) => b.top)));
  const key = days.join(",");
  // Open on the working day (or just above the first thing on it), not on midnight.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (el.scrollHeight * (first - 30)) / 1440);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const anyAllDay = perDay.some((d) => d.allDay.length > 0);
  const cols = `3.25rem repeat(${days.length}, minmax(0, 1fr))`;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const hourText = (h: number) => (h12 ? `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:00`);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" data-testid="calendar-grid">
      <div className="grid border-b border-slate-200" style={{ gridTemplateColumns: cols }}>
        <div />
        {days.map((d) => {
          const dd = parseDay(d)!;
          const isToday = d === today;
          return (
            <div key={d} className="min-w-0 border-l border-slate-200 px-1 py-1.5 text-center">
              {wide ? (
                <p className={`text-sm font-semibold ${isToday ? "text-compass-700" : "text-slate-800"}`}>
                  {dayLabel(d, { long: true })}
                  {isToday && <span className="sr-only"> (today)</span>}
                </p>
              ) : (
                <button type="button" onClick={() => p.onOpenDay(d)} aria-label={`Open ${dayLabel(d, { long: true })}${isToday ? " (today)" : ""}`} className="rounded-md px-1.5 py-0.5 hover:bg-slate-100">
                  <span className="block text-2xs font-semibold uppercase tracking-wider text-slate-500">{weekdayShort(d)}</span>
                  <span className={`mx-auto mt-0.5 grid h-7 w-7 place-items-center rounded-full text-sm font-semibold ${isToday ? "bg-compass-600 text-white" : "text-slate-800"}`}>{dd.d}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {anyAllDay && (
        <div className="grid border-b border-slate-200" style={{ gridTemplateColumns: cols }}>
          <div className="px-1 py-1 text-right text-2xs text-slate-500">All day</div>
          {perDay.map((d) => (
            <div key={d.day} className="flex min-w-0 flex-col gap-0.5 border-l border-slate-200 p-0.5">
              {d.allDay.map((i) => (
                <ItemRow key={i.key} i={i} day={d.day} p={p} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={scroller} className="max-h-[calc(100dvh-19rem)] min-h-80 overflow-y-auto" tabIndex={0} role="group" aria-label="Hours of the day">
        <div className="grid" style={{ gridTemplateColumns: cols }}>
          <div className={styles.hours} aria-hidden>
            {hours.map((h) =>
              h === 0 ? null : (
                <span key={h} className={styles.hourLabel} style={{ top: `${(h / 24) * 100}%` }}>
                  {hourText(h)}
                </span>
              )
            )}
          </div>
          {perDay.map((d) => (
            <div key={d.day} className={`${styles.dayCol} ${d.day === today ? styles.today : ""}`} data-day={d.day}>
              {now !== null && dayOf(now, tz) === d.day && <span className={styles.nowLine} style={{ top: `${(wallMinutes(now, tz) / 1440) * 100}%` }} aria-hidden />}
              {d.blocks.map((b) => (
                <Block key={b.item.key} b={b} day={d.day} p={p} wide={wide} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Month -------------------------------------------------------------------------

const MONTH_ROWS = 3;

export function MonthGrid(p: ViewProps & { month: number }) {
  const { days, items, tz, today } = p;
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" data-testid="calendar-grid">
      <div className="grid grid-cols-7 border-b border-slate-200">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
            {weekdayShort(d)}
          </div>
        ))}
      </div>
      {weeks.map((w) => (
        <div key={w[0]} className="grid grid-cols-7 border-b border-slate-200 last:border-b-0">
          {w.map((d, di) => {
            const dd = parseDay(d)!;
            const list = dayItems(items, d, tz);
            const out = dd.m !== p.month;
            const isToday = d === today;
            return (
              <div key={d} className={`min-h-28 min-w-0 p-1 ${di > 0 ? "border-l border-slate-200" : ""} ${out ? "bg-canvas" : ""}`} data-day={d}>
                <button
                  type="button"
                  onClick={() => p.onOpenDay(d)}
                  aria-label={`Open ${dayLabel(d, { long: true })}${isToday ? " (today)" : ""}, ${list.length} ${list.length === 1 ? "item" : "items"}`}
                  className={`grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold hover:bg-slate-100 ${isToday ? "bg-compass-600 text-white hover:bg-compass-600" : out ? "text-slate-500" : "text-slate-800"}`}
                >
                  {dd.d}
                </button>
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {list.slice(0, MONTH_ROWS).map((i) => (
                    <ItemRow key={i.key} i={i} day={d} p={p} />
                  ))}
                  {list.length > MONTH_ROWS && (
                    <button type="button" onClick={() => p.onOpenDay(d)} className="rounded px-1 text-left text-2xs font-medium text-slate-600 hover:bg-slate-100">
                      {list.length - MONTH_ROWS} more<span className="sr-only"> on {dayLabel(d, { long: true })}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// --- The list (narrow screens) ----------------------------------------------------------

export function AgendaList(p: ViewProps & { view: HdCalendarView; month?: number }) {
  const { days, items, tz, h12, today } = p;
  const shown = days.filter((d) => (p.view === "month" && p.month ? parseDay(d)!.m === p.month : true));
  const groups = shown.map((d) => ({ day: d, list: dayItems(items, d, tz) })).filter((g) => p.view === "day" || g.list.length > 0);
  return (
    <div className="flex flex-col gap-3" data-testid="calendar-list">
      {groups.map((g) => (
        <section key={g.day} aria-labelledby={`cal-day-${g.day}`} className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs">
          <h3 id={`cal-day-${g.day}`} className={`border-b border-slate-100 px-3 py-2 text-sm font-semibold ${g.day === today ? "text-compass-700" : "text-slate-800"}`}>
            {dayLabel(g.day, { long: true })}
            {g.day === today && <span className="font-normal text-slate-500"> · Today</span>}
          </h3>
          {g.list.length === 0 ? (
            <SectionEmpty className="px-3 py-4">Nothing is on the calendar this day.</SectionEmpty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {g.list.map((i) => {
                const tone = itemTone(i, p.colour, p.slots);
                const body = (
                  <>
                    <span className={`${styles.swatch} mt-1 ${i.kind !== "event" ? styles.swatchLayer : ""}`} style={ev(tone.color)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-slate-600">
                        <Marks i={i} />
                        {i.kind === "event" ? itemTime(i, g.day, tz, h12) : `${i.layerLabel} ${timeLabel(i.start, tz, h12)}`}
                        {i.kind === "event" && !i.cancelled && i.ready < i.start && <span>· setup from {timeLabel(i.ready, tz, h12)}</span>}
                      </span>
                      <span className={`block text-sm font-semibold text-slate-900 ${i.cancelled ? "line-through" : ""}`}>
                        {i.number ? `#${i.number} ` : ""}
                        {i.title}
                      </span>
                      <span className="block text-xs text-slate-600">{[i.place, tone.label, i.kind === "event" ? (i.cancelled ? "Cancelled" : i.setupComplete ? "Setup complete" : "Setup not complete") : "", i.conflicts.length && !i.cancelled ? "Double-booked" : ""].filter(Boolean).join(" · ")}</span>
                    </span>
                  </>
                );
                return (
                  <li key={i.key}>
                    {i.href ? (
                      <Link href={i.href} className="flex items-start gap-2 px-3 py-2 hover:bg-slate-50" data-cal-item={i.key}>
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-start gap-2 px-3 py-2" data-cal-item={i.key}>
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** The day after the last one shown, for "does anything fall in this view". */
export const afterLast = (days: string[]) => addDays(days[days.length - 1], 1);
