"use client";

// The desk's Calendar (1.20.6, /desk/calendar; STYLEGUIDE §Helpdesk: the
// event calendar): the events tickets carry, by day, week or month, in the
// viewer's own time zone. Previous, Next and Today move through time; the
// team filter narrows to one team; colour follows the team or the status
// (always with the words too); two layers can be switched on: tickets' due
// times and the tickets recurring schedules will open. What the person
// chooses (view, team, colour, layers) is remembered on their account.
//
// The view and the date travel in the address (?view=week&date=2026-11-20),
// so a link opens the same range and Back works. From md the views are
// grids; on a narrower screen a list stands in for them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Printer, Rss } from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { EmptyState, Select } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Segmented } from "@/components/Segmented";
import { useAppSettings } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import {
  parseDay,
  stepDay,
  viewRange,
  viewTitle,
  type HdCalendarColour,
  type HdCalendarData,
  type HdCalendarLayer,
  type HdCalendarPrefs,
  type HdCalendarView,
} from "@/lib/helpdesk/desk-calendar-shared";
import { getJson, sendJson } from "../api";
import { abbreviate, calendarItems, teamSlots } from "./calendar-model";
import { AgendaList, MonthGrid, TimeGrid, type ViewProps } from "./CalendarViews";
import { FeedLinksDialog } from "./FeedLinks";
import styles from "./Calendar.module.css";

const VIEW_WORD: Record<HdCalendarView, string> = { day: "day", week: "week", month: "month" };
const STATUS_KEY: [string, string, string][] = [
  ["New", "#0ea5e9", "New"],
  ["Open", "rgb(var(--compass-500))", "Open"],
  ["Waiting", "#f59e0b", "Waiting on requester"],
  ["On hold", "rgb(var(--slate-400))", "On hold"],
  ["Solved", "#10b981", "Solved"],
  ["Closed", "rgb(var(--slate-300))", "Closed"],
];

export function CalendarPage({ today, initial }: { /** Today's date in the viewer's zone, from the server. */ today: string; initial: HdCalendarPrefs & { day: string } }) {
  const { timezone: tz, time_format } = useAppSettings();
  const h12 = time_format === "12h";
  const [view, setView] = useState<HdCalendarView>(initial.view);
  const [day, setDay] = useState(initial.day);
  const [teamId, setTeamId] = useState(initial.team_id);
  const [colour, setColour] = useState<HdCalendarColour>(initial.colour);
  const [layers, setLayers] = useState<HdCalendarLayer[]>(initial.layers);
  const [data, setData] = useState<HdCalendarData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [feeds, setFeeds] = useState(false);

  const range = useMemo(() => viewRange(view, day), [view, day]);
  const layerKey = layers.join(",");

  // The address follows the view, without a server round trip.
  useEffect(() => {
    const q = new URLSearchParams({ view, date: day });
    if (teamId) q.set("team", String(teamId));
    window.history.replaceState(window.history.state, "", `/desk/calendar?${q}`);
  }, [view, day, teamId]);

  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    const q = new URLSearchParams({ from: range.from, to: range.to });
    if (teamId) q.set("team", String(teamId));
    if (layerKey) q.set("layers", layerKey);
    getJson<HdCalendarData>(`/api/helpdesk/calendar?${q}`, "Couldn't load the calendar.")
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError("");
      })
      .catch((e: Error) => mine === seq.current && setError(e.message))
      .finally(() => mine === seq.current && setLoading(false));
  }, [range.from, range.to, teamId, layerKey]);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 120_000);
    return () => clearInterval(t);
  }, [load]);

  // What the person chose is kept on their account (not the date: that is where they are, not a preference).
  const firstPrefs = useRef(true);
  useEffect(() => {
    if (firstPrefs.current) {
      firstPrefs.current = false;
      return;
    }
    const t = setTimeout(() => void sendJson("/api/helpdesk/calendar/prefs", "PUT", { view, team_id: teamId, colour, layers: layerKey ? layerKey.split(",") : [] }).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [view, teamId, colour, layerKey]);

  const items = useMemo(() => (data ? calendarItems(data) : []), [data]);
  const slots = useMemo(() => teamSlots(data?.teams ?? []), [data?.teams]);
  const openDay = useCallback((d: string) => {
    setDay(d);
    setView("day");
  }, []);
  const props: ViewProps = { days: range.days, items, tz: data?.timezone ?? tz, h12, today, colour, slots, onOpenDay: openDay };
  const month = parseDay(day)!.m;
  const toggleLayer = (l: HdCalendarLayer, on: boolean) => setLayers((cur) => (on ? [...cur.filter((x) => x !== l), l].sort() : cur.filter((x) => x !== l)));
  const empty = !!data && items.length === 0;
  const printHref = useMemo(() => {
    const q = new URLSearchParams({ view, date: day, colour });
    if (teamId) q.set("team", String(teamId));
    if (layerKey) q.set("layers", layerKey);
    q.set("print", "1");
    return `/desk/calendar/print?${q}`;
  }, [view, day, teamId, colour, layerKey]);
  const teamsInUse = useMemo(() => {
    const seen = new Map<number, string>();
    for (const i of items) if (i.teamId !== null && !seen.has(i.teamId)) seen.set(i.teamId, i.teamName ?? "Team");
    return [...seen.entries()];
  }, [items]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto print:overflow-visible">
      <PageContainer>
        <PageHeader
          icon={<CalendarDays />}
          title="Calendar"
          subtitle="The events on tickets: room setups, meetings and visits. Times are in your time zone."
          actions={
            <>
              <Button variant="secondary" icon={<Rss />} onClick={() => setFeeds(true)} className="print:hidden">
                Subscribe
              </Button>
              <a href={printHref} target="_blank" rel="noopener" className={`${buttonClass("secondary")} print:hidden`} data-testid="calendar-print">
                <Printer className="h-4 w-4" aria-hidden />
                Print
              </a>
            </>
          }
        />

        <div className={`${styles.root} flex flex-col gap-3`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" onClick={() => setDay(today)} data-testid="calendar-today">
                Today
              </Button>
              <button type="button" onClick={() => setDay(stepDay(view, day, -1))} aria-label={`Previous ${VIEW_WORD[view]}`} data-tt={`Previous ${VIEW_WORD[view]}`} className={iconButtonClass("bordered", "md")} data-testid="calendar-prev">
                <ChevronLeft aria-hidden />
              </button>
              <button type="button" onClick={() => setDay(stepDay(view, day, 1))} aria-label={`Next ${VIEW_WORD[view]}`} data-tt={`Next ${VIEW_WORD[view]}`} className={iconButtonClass("bordered", "md")} data-testid="calendar-next">
                <ChevronRight aria-hidden />
              </button>
            </div>
            <h2 className="min-w-0 text-lg font-semibold text-slate-900" aria-live="polite" data-testid="calendar-title">
              {viewTitle(view, day)}
            </h2>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Segmented<HdCalendarView>
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ]}
              />
              <Select value={String(teamId)} onChange={(e) => setTeamId(Number(e.target.value))} aria-label="Team" className="w-auto max-w-48" data-testid="calendar-team">
                <option value="0">All my teams</option>
                {(data?.teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm print:hidden">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500" id="cal-colour-label">
                Colour by
              </span>
              <Segmented<HdCalendarColour>
                label="Colour by"
                size="sm"
                value={colour}
                onChange={setColour}
                options={[
                  { value: "team", label: "Team" },
                  { value: "status", label: "Status" },
                ]}
              />
            </div>
            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="sr-only">Layers</legend>
              <span className="text-xs text-slate-500" aria-hidden>
                Also show
              </span>
              {(
                [
                  ["due", "Due dates", "When your open tickets' reply and resolve targets are due"],
                  ["recurring", "Recurring tickets", "The tickets recurring schedules will open"],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${layers.includes(key) ? "border-compass-500 bg-compass-50 text-compass-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`} data-tt={hint} data-tt-wrap>
                  <input type="checkbox" checked={layers.includes(key)} onChange={(e) => toggleLayer(key, e.target.checked)} data-testid={`calendar-layer-${key}`} />
                  {label}
                </label>
              ))}
            </fieldset>
          </div>

          {error && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>}
          {!data && !error && <LoadingRow className="py-10" />}
          {data && data.truncated && <p className="text-xs text-slate-500">This range holds more than the calendar shows at once. Pick a team or a shorter view to see everything.</p>}

          {data && empty && (
            <EmptyState
              icon={<CalendarDays />}
              title={`Nothing on the calendar this ${VIEW_WORD[view]}`}
              body="Events show here when a ticket has one. Add an event from a ticket's side panel, or let a request type put its requests on the calendar."
              action={{ href: "/desk", label: "Open the tickets" }}
            />
          )}
          {data && !empty && (
            <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"} aria-busy={loading}>
              <div className="hidden md:block">{view === "month" ? <MonthGrid {...props} month={month} /> : <TimeGrid {...props} />}</div>
              <div className="md:hidden">
                <AgendaList {...props} view={view} month={month} />
              </div>
            </div>
          )}

          {data && !empty && (
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-600 print:hidden" aria-label="Key" data-testid="calendar-key">
              {colour === "team"
                ? teamsInUse.map(([id, name]) => (
                    <li key={id} className="inline-flex items-center gap-1.5">
                      <span className={styles.swatch} style={{ "--ev": `var(--s${slots.get(id) ?? 1})` } as React.CSSProperties} aria-hidden />
                      <span className={styles.tag}>{abbreviate(name)}</span> {name}
                    </li>
                  ))
                : STATUS_KEY.map(([tag, color, name]) => (
                    <li key={tag} className="inline-flex items-center gap-1.5">
                      <span className={styles.swatch} style={{ "--ev": color } as React.CSSProperties} aria-hidden />
                      {name}
                    </li>
                  ))}
              <li className="inline-flex items-center gap-1.5">
                <span className={`${styles.swatch} ${styles.swatchSetup}`} aria-hidden />
                Setup time before an event
              </li>
              {layers.length > 0 && (
                <li className="inline-flex items-center gap-1.5">
                  <span className={`${styles.swatch} ${styles.swatchLayer}`} aria-hidden />
                  Due dates and recurring tickets
                </li>
              )}
            </ul>
          )}
        </div>
      </PageContainer>
      {feeds && <FeedLinksDialog onClose={() => setFeeds(false)} />}
    </div>
  );
}
