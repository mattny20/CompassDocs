"use client";

// Settings → Calendars → Test a due time (agent L): pick a team (its
// calendar and its effective reply targets), a start in that calendar's
// time zone, and either a priority's target or a number of hours; see the
// due and why ("Due Tue 29 Dec 2026 09:30 · opens Tue 09:00 (Christmas Day,
// Boxing Day closed)"), with the stretches counted. Reads only
// (POST /api/helpdesk/admin/calendars/preview).

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Timer } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, Select, TextInput } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { Segmented } from "@/components/Segmented";
import { toast } from "@/components/Toasts";
import { wallClock, zonedInstant } from "@/lib/helpdesk/sla";
import { formatMinutes } from "@/lib/helpdesk/calendars-shared";
import type { HdDuePreview } from "@/lib/helpdesk/calendars-shared";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority } from "@/lib/helpdesk/types";
import { sendJson } from "../api";
import { calendarOfTeam, useCalendarsData } from "./data";

const pad = (n: number) => String(n).padStart(2, "0");

export function DueTester({ initialTeam = null }: { initialTeam?: number | null }) {
  const { data, error } = useCalendarsData();
  const [team, setTeam] = useState<string>(initialTeam ? String(initialTeam) : "");
  const [mode, setMode] = useState<"target" | "minutes">("target");
  const [priority, setPriority] = useState<HdPriority>("normal");
  const [what, setWhat] = useState<"first_reply" | "resolve">("first_reply");
  const [hours, setHours] = useState("4");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HdDuePreview | null>(null);

  const cal = data ? calendarOfTeam(data, team ? Number(team) : null) : undefined;
  const tz = cal?.timezone ?? "UTC";
  useEffect(() => {
    if (!data || date) return;
    const w = wallClock(Date.now(), tz);
    setDate(`${w.y}-${pad(w.m)}-${pad(w.d)}`);
    setTime(`${pad(w.h)}:${pad(w.min)}`);
  }, [data, tz, date]);

  const startIso = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const t = /^(\d{2}):(\d{2})$/.exec(time);
    if (!m || !t) return null;
    return new Date(zonedInstant(+m[1], +m[2], +m[3], +t[1], +t[2], tz)).toISOString();
  }, [date, time, tz]);

  if (error && !data) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-10" />;

  const minutes = Math.round(Number(hours) * 60);
  const badHours = mode === "minutes" && !(Number.isFinite(minutes) && minutes >= 0 && minutes <= 525_600);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!startIso || badHours) return;
    setBusy(true);
    try {
      const body = {
        team_id: team ? Number(team) : null,
        start: startIso,
        ...(mode === "target" ? { priority, target: what } : { minutes }),
      };
      setResult(await sendJson<HdDuePreview>("/api/helpdesk/admin/calendars/preview", "POST", body, "Couldn't work out the due time."));
    } catch (er) {
      toast("error", (er as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const teamName = team ? data.teams.find((t) => String(t.id) === team)?.name : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <Card id="due-test" title="Test a due time" description="See when a target would fall due, and why." className="scroll-mt-6 self-start">
        <form onSubmit={run} className="flex flex-col gap-4" noValidate>
          <Field label="Team" help={cal ? `Works to ${cal.name}: ${cal.summary} (${cal.timezone})` : undefined}>
            <Select value={team} onChange={(e) => { setTeam(e.target.value); setResult(null); }}>
              <option value="">No team (the default calendar)</option>
              {data.teams.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
            <Field label="Starts on" error={!date ? "Pick a date." : undefined}>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="At" help={tz}>
              <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>
          <Segmented
            label="What to add"
            size="sm"
            value={mode}
            onChange={(v) => { setMode(v); setResult(null); }}
            options={[
              { value: "target", label: "A reply target" },
              { value: "minutes", label: "A number of hours" },
            ]}
          />
          {mode === "target" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority">
                <Select value={priority} onChange={(e) => setPriority(e.target.value as HdPriority)}>
                  {[...HD_PRIORITIES].reverse().map((p) => (
                    <option key={p} value={p}>
                      {HD_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Target">
                <Select value={what} onChange={(e) => setWhat(e.target.value as typeof what)}>
                  <option value="first_reply">First reply</option>
                  <option value="resolve">Resolution</option>
                </Select>
              </Field>
            </div>
          ) : (
            <Field label="Business hours to add" size="xs" error={badHours ? "Between 0 and 8760 hours." : undefined}>
              <TextInput type="number" min={0} step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
            </Field>
          )}
          <div>
            <Button type="submit" icon={<Timer />} busy={busy} disabled={!startIso || badHours}>
              Work out the due time
            </Button>
          </div>
        </form>
      </Card>

      <div aria-live="polite" className="min-w-0">
        {result ? (
          <Card title="Result" icon={<CalendarClock />} className="self-start">
            {result.no_open_hours ? (
              <p className="text-sm font-medium text-slate-800">{result.summary}</p>
            ) : (
              <>
                <p className="text-2xl font-semibold tabular-nums text-slate-900">{result.summary.split(" · ")[0].replace(/^Due /, "")}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {result.timezone}
                  {result.calendar ? ` · ${result.calendar.name}` : ""}
                </p>
                {result.summary.includes(" · ") && <p className="mt-3 text-sm text-slate-700">{result.summary.split(" · ").slice(1).join(" · ").replace(/^opens/, "Opens")}</p>}
              </>
            )}
            {result.target && (
              <p className="mt-3 text-sm text-slate-600">
                {result.target.source === "team" ? `${teamName ?? "This team"}'s own target` : "Workspace target"}: {result.target.what === "first_reply" ? "first reply" : "resolution"} in {formatMinutes(result.target.minutes)}
                {result.target.business_hours ? " of office hours" : " around the clock"}.
              </p>
            )}
            {result.lines.length > 0 && (
              <ol className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
                {result.lines.map((l, i) => (
                  <li key={i} className={l.startsWith("Closed") ? "text-slate-500" : "text-slate-700"}>
                    {l}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-500">The due time and the hours it counts appear here.</div>
        )}
      </div>
    </div>
  );
}
