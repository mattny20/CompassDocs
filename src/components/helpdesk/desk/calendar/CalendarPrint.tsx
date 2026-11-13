// The calendar on paper (1.20.6, /desk/calendar/print; STYLEGUIDE §Helpdesk:
// the event calendar and §Print's print-first pattern). Three layouts:
//
//   day    a day sheet, portrait: the agenda as a table with a tick box per
//          event, its time, ticket number and subject, place, owner and when
//          setup must be ready. For the people who set the rooms up.
//   week   a week grid, landscape: one column per day.
//   month  a month grid, landscape: one cell per day.
//
// On screen it is a preview: a white sheet on the canvas (the printed
// handbook's sheet styles, light in both themes). On paper the header and
// footer are @page margin boxes with the printer's page numbers. Readable in
// black and white: an item is told apart by its words (time, number, team,
// "Setup by"), its edge prints black, and the layers are labelled.
//
// Server-safe: the toolbar is the only client piece.

import { Check } from "lucide-react";
import { cssString } from "@/components/handbooks/print/page-css";
import { PAPER_CSS } from "@/components/handbooks/print/print-model";
import sheetStyles from "@/components/handbooks/print/HandbookPrint.module.css";
import { dayLabel, parseDay, timeLabel, viewTitle, weekdayLong, weekdayShort, type HdCalendarColour, type HdCalendarView } from "@/lib/helpdesk/desk-calendar-shared";
import { dayItems, itemStartLabel, itemTime, itemTone, type CalItem } from "./calendar-model";
import styles from "./Calendar.module.css";

export interface CalendarPrintModel {
  view: HdCalendarView;
  day: string;
  days: string[];
  items: CalItem[];
  tz: string;
  h12: boolean;
  colour: HdCalendarColour;
  slots: Map<number, number>;
  workspace: string;
  /** "All my teams" or the team's name. */
  scope: string;
  /** "Printed by Ana Kowalski on 13 Nov 2026, 10:42. Times are in London time." */
  footer: string;
  paper: "a4" | "letter";
  truncated: boolean;
}

const FURNITURE = `font-family: "Aileron", ui-sans-serif, system-ui, sans-serif; font-size: 7.5pt; color: #5a6980;`;

export function calendarPageCss(m: Pick<CalendarPrintModel, "view" | "day" | "workspace" | "scope" | "footer" | "paper">): string {
  const top = `vertical-align: bottom; padding-bottom: 2.5mm; border-bottom: 0.5pt solid #e2e8f0; ${FURNITURE}`;
  const bottom = `vertical-align: top; padding-top: 2.5mm; border-top: 0.5pt solid #e2e8f0; ${FURNITURE}`;
  const size = `${PAPER_CSS[m.paper].size}${m.view === "day" ? "" : " landscape"}`;
  return `@page {
  size: ${size};
  margin: 16mm 12mm 16mm;
  @top-left { content: ${cssString(`${m.workspace} · Helpdesk calendar · ${m.scope}`)}; text-align: left; ${top} }
  @top-right { content: ${cssString(viewTitle(m.view, m.day))}; text-align: right; ${top} }
  @bottom-left { content: ${cssString(m.footer)}; text-align: left; width: 75%; ${bottom} }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); text-align: right; ${bottom} }
}
@media print {
  html { font-size: ${m.view === "day" ? "10.5pt" : "9pt"}; }
}`;
}

const MUTED = "text-slate-500";
const ev = (color: string) => ({ "--ev": color }) as React.CSSProperties;

/** "13:30" or "Thu 19 Nov 13:30": when setup must be ready, for the day sheet. */
function setupBy(i: CalItem, day: string, m: CalendarPrintModel): string {
  if (i.kind !== "event" || i.cancelled) return "";
  if (i.ready >= i.start) return "At the start";
  const t = timeLabel(i.ready, m.tz, m.h12);
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: m.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(i.ready));
  return d === day ? t : `${dayLabel(d, { year: false })} ${t}`;
}

function DaySheet({ m }: { m: CalendarPrintModel }) {
  const all = dayItems(m.items, m.day, m.tz);
  const events = all.filter((i) => i.kind === "event");
  const layers = all.filter((i) => i.kind !== "event");
  return (
    <>
      {events.length === 0 ? (
        <p className={`mt-4 text-sm ${MUTED}`}>There are no events on this day.</p>
      ) : (
        <table className={`${styles.printTable} mt-4 text-xs`} data-testid="print-day">
          <thead>
            <tr className="text-2xs font-semibold uppercase tracking-wider text-slate-600">
              <th scope="col" style={{ width: "8mm" }}>
                <span className="sr-only">Done</span>
              </th>
              <th scope="col" style={{ width: "24mm" }}>Time</th>
              <th scope="col">Event</th>
              <th scope="col" style={{ width: "22%" }}>Place</th>
              <th scope="col" style={{ width: "17%" }}>Owner</th>
              <th scope="col" style={{ width: "22mm" }}>Setup by</th>
            </tr>
          </thead>
          <tbody>
            {events.map((i) => {
              const tone = itemTone(i, m.colour, m.slots);
              return (
                <tr key={i.key} className={i.cancelled ? "text-slate-500" : "text-slate-800"}>
                  <td>
                    {i.cancelled ? null : i.setupComplete ? (
                      <span className={`${styles.tick} grid place-items-center`} role="img" aria-label="Setup complete">
                        <Check className="h-3 w-3" aria-hidden />
                      </span>
                    ) : (
                      <span className={styles.tick} role="img" aria-label="Setup not complete" />
                    )}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{itemTime(i, m.day, m.tz, m.h12)}</td>
                  <td>
                    <span className={`font-semibold ${i.cancelled ? "line-through" : "text-slate-900"}`}>
                      #{i.number} {i.title}
                    </span>
                    <span className={`block ${MUTED}`}>
                      {[tone.label !== i.teamName ? i.teamName : null, tone.label, i.cancelled ? "Cancelled" : null, i.repeats ? "Repeats" : null, i.conflicts.length && !i.cancelled ? `Double-booked with ${i.conflicts.map((n) => (n ? `#${n}` : "another team's event")).join(", ")}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </td>
                  <td className="break-words">{i.place}</td>
                  <td className="break-words">{i.assignee ?? i.teamName ?? ""}</td>
                  <td className="whitespace-nowrap tabular-nums">{setupBy(i, m.day, m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {events.length > 0 && <p className={`mt-2 text-2xs ${MUTED}`}>Tick the box when the setup is done, then mark Setup complete on the ticket.</p>}
      {layers.length > 0 && (
        <section className={`${sheetStyles.keep} mt-5`}>
          <h3 className="border-b border-slate-200 pb-1 text-sm font-bold text-slate-900">Also today</h3>
          <ul className="mt-1.5 space-y-0.5 text-xs text-slate-800">
            {layers.map((i) => (
              <li key={i.key}>
                <span className="tabular-nums">{timeLabel(i.start, m.tz, m.h12)}</span> · <span className="font-semibold">{i.layerLabel}</span>
                {i.overdue ? " (overdue)" : ""}: {i.number ? `#${i.number} ` : ""}
                {i.title}
                {i.teamName ? ` · ${i.teamName}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function PrintItem({ i, day, m, full }: { i: CalItem; day: string; m: CalendarPrintModel; full: boolean }) {
  const tone = itemTone(i, m.colour, m.slots);
  return (
    <div className={`${styles.printItem} ${i.kind !== "event" ? styles.printLayer : ""} ${i.cancelled ? "text-slate-500" : "text-slate-800"}`} style={ev(tone.color)}>
      <span className="tabular-nums">{full && i.kind === "event" ? itemTime(i, day, m.tz, m.h12) : itemStartLabel(i, day, m.tz, m.h12)}</span>{" "}
      <span className={`font-semibold ${i.cancelled ? "line-through" : "text-slate-900"}`}>
        {i.kind !== "event" ? `${i.layerLabel}: ` : ""}
        {i.number ? `#${i.number} ` : ""}
        {i.title}
      </span>
      {full && (
        <span className={`block ${MUTED}`}>
          {[i.place, tone.label, i.kind === "event" && !i.cancelled && i.ready < i.start ? `Setup by ${setupBy(i, day, m)}` : null, i.kind === "event" ? (i.cancelled ? "Cancelled" : i.setupComplete ? "Setup complete" : null) : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {!full && <span className={MUTED}> {[i.place, tone.tag].filter(Boolean).join(" · ")}</span>}
    </div>
  );
}

function WeekSheet({ m }: { m: CalendarPrintModel }) {
  return (
    <table className={`${styles.printTable} mt-4 text-2xs`} data-testid="print-week">
      <thead>
        <tr>
          {m.days.map((d) => (
            <th key={d} scope="col" className="text-xs font-semibold text-slate-900">
              {weekdayLong(d)} <span className={`font-normal ${MUTED}`}>{dayLabel(d, { year: false }).replace(/^\S+ /, "")}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {m.days.map((d) => {
            const list = dayItems(m.items, d, m.tz);
            return (
              <td key={d} style={{ height: "120mm" }}>
                {list.map((i) => (
                  <PrintItem key={i.key} i={i} day={d} m={m} full />
                ))}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
}

const MONTH_MAX = 5;

function MonthSheet({ m }: { m: CalendarPrintModel }) {
  const month = parseDay(m.day)!.m;
  const weeks: string[][] = [];
  for (let i = 0; i < m.days.length; i += 7) weeks.push(m.days.slice(i, i + 7));
  return (
    <table className={`${styles.printTable} mt-4 text-2xs`} data-testid="print-month">
      <thead>
        <tr>
          {m.days.slice(0, 7).map((d) => (
            <th key={d} scope="col" className="text-xs font-semibold text-slate-900">
              {weekdayShort(d)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={w[0]}>
            {w.map((d) => {
              const dd = parseDay(d)!;
              const list = dayItems(m.items, d, m.tz);
              return (
                <td key={d} style={{ height: weeks.length > 5 ? "19mm" : "24mm" }}>
                  <span className={`block text-xs font-semibold ${dd.m === month ? "text-slate-900" : MUTED}`}>{dd.d}</span>
                  {list.slice(0, MONTH_MAX).map((i) => (
                    <PrintItem key={i.key} i={i} day={d} m={m} full={false} />
                  ))}
                  {list.length > MONTH_MAX && <span className={MUTED}>and {list.length - MONTH_MAX} more</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CalendarPrint({ m, toolbar }: { m: CalendarPrintModel; toolbar?: React.ReactNode }) {
  const landscape = m.view !== "day";
  const paper = landscape ? (m.paper === "letter" ? styles.landscapeLetter : styles.landscape) : m.paper === "letter" ? sheetStyles.letter : sheetStyles.a4;
  const tagsInUse = [...new Map(m.items.filter((i) => i.kind === "event").map((i) => [itemTone(i, m.colour, m.slots).tag, itemTone(i, m.colour, m.slots).label])).entries()];
  return (
    <div className={`${sheetStyles.stage} ${styles.root}`}>
      {/* The page boxes carry the workspace's and the printer's names, so they are written per request; cssString escapes them. */}
      <style dangerouslySetInnerHTML={{ __html: calendarPageCss(m) }} />
      {toolbar}
      <article className={`${sheetStyles.sheet} ${sheetStyles.paper} ${paper} text-sm leading-snug`} aria-labelledby="print-cal-title" data-testid="calendar-print-sheet">
        <div className={`flex justify-between gap-4 border-b border-slate-200 pb-2 text-2xs ${MUTED} print:hidden`}>
          <span>
            {m.workspace} · Helpdesk calendar · {m.scope}
          </span>
          <span>{viewTitle(m.view, m.day)}</span>
        </div>
        <div className={sheetStyles.grow}>
          <h2 id="print-cal-title" className="mt-4 text-xl font-bold text-slate-900 print:mt-0">
            {viewTitle(m.view, m.day)}
          </h2>
          <p className={`text-xs ${MUTED}`}>
            {m.scope} · {m.view === "day" ? "Day sheet" : m.view === "week" ? "Week" : "Month"}
            {m.truncated ? " · Some items are left out: this range holds more than one sheet shows." : ""}
          </p>
          {m.view === "day" ? <DaySheet m={m} /> : m.view === "week" ? <WeekSheet m={m} /> : <MonthSheet m={m} />}
          {m.view !== "day" && tagsInUse.length > 0 && (
            <p className={`mt-2 text-2xs ${MUTED}`}>
              {m.view === "month" ? `${tagsInUse.map(([tag, label]) => `${tag}: ${label}`).join(" · ")}. ` : ""}
              A dotted edge marks a due date or a recurring ticket.
            </p>
          )}
        </div>
        <p className={`mt-8 flex justify-between gap-4 border-t border-slate-200 pt-2 text-2xs ${MUTED} print:hidden`}>
          <span>{m.footer}</span>
          <span className="shrink-0">Page numbers are added on paper</span>
        </p>
      </article>
    </div>
  );
}
