"use client";

// The ticket's Time card (1.19.1, agent V8), in the side column (approved
// mock #3): the agent's timer as a tabular-number clock with Stop or Start,
// the entries ("Ana Kowalski · investigation 25m", "You · today 18m"), the
// total, and Log time (a dialog taking hours and minutes and a note).
// People edit and delete their own entries; a team lead the team's (the
// API decides, each entry carries can_edit). One timer per agent: Start
// here while it runs on another ticket stops it there and logs that time.
// Agents only: the requester's side never loads this.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Pencil, Play, Plus, Square, Timer, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { SectionEmpty } from "@/components/form";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { formatClock, formatMinutes, TIME_LIMITS, type HdTicketTime, type HdTimeEntry } from "@/lib/helpdesk/time-shared";
import { getJson, sendJson } from "../api";
import { useDeskMe } from "../me";

/** Today / yesterday / "Mon 3 Nov" for an entry without a note. */
function dayWord(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** The Log time / Edit dialog: hours and minutes and a note → { minutes, note }, or null. */
export async function timeDialog(opts: { title: string; confirmLabel: string; minutes?: number; note?: string; body?: string }): Promise<{ minutes: number; note: string } | null> {
  const r = await formDialog({
    title: opts.title,
    body: opts.body,
    confirmLabel: opts.confirmLabel,
    fields: [
      { key: "hours", label: "Hours", type: "number", min: 0, max: 24, required: false, initial: opts.minutes ? String(Math.floor(opts.minutes / 60)) : "" },
      {
        key: "minutes",
        label: "Minutes",
        type: "number",
        min: 0,
        max: 59,
        required: false,
        initial: opts.minutes ? String(opts.minutes % 60) : "",
        validate: (_v, all) => {
          const total = Math.round((Number(all.hours) || 0) * 60 + (Number(all.minutes) || 0));
          if (total < 1) return "Log at least a minute.";
          if (total > TIME_LIMITS.maxMinutes) return "Log at most 24 hours at a time.";
          return undefined;
        },
      },
      { key: "note", label: "Note", required: false, initial: opts.note ?? "", placeholder: "What you did (optional)", validate: (v) => (v.length > TIME_LIMITS.note ? "Keep the note under 300 characters." : undefined) },
    ],
  });
  if (!r) return null;
  return { minutes: Math.round((Number(r.hours) || 0) * 60 + (Number(r.minutes) || 0)), note: r.note.trim() };
}

export function TimeCard({ ticketNumber, refreshKey }: { ticketNumber: number; refreshKey?: unknown }) {
  const me = useDeskMe();
  const [data, setData] = useState<HdTicketTime | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () =>
      getJson<HdTicketTime>(`/api/helpdesk/tickets/${ticketNumber}/time`, "Couldn't load the time.")
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    [ticketNumber]
  );
  useEffect(() => void load(), [load, refreshKey]);

  const here = data?.timer && data.timer.ticket_number === ticketNumber ? data.timer : null;
  const elsewhere = data?.timer && !here ? data.timer : null;
  useEffect(() => {
    if (!here) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [here]);

  async function start() {
    setBusy(true);
    try {
      const r = await sendJson<{ logged: { minutes: number; ticket_number: number } | null }>(`/api/helpdesk/tickets/${ticketNumber}/time/timer`, "POST", undefined, "Couldn't start the timer.");
      toast("ok", r.logged ? `Timer moved here. Logged ${formatMinutes(r.logged.minutes)} on #${r.logged.ticket_number}.` : "Timer started.");
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const r = await sendJson<{ logged: { minutes: number } | null }>(`/api/helpdesk/tickets/${ticketNumber}/time/timer`, "DELETE", {}, "Couldn't stop the timer.");
      toast("ok", r.logged ? `Logged ${formatMinutes(r.logged.minutes)}.` : "Timer stopped.");
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logTime() {
    const v = await timeDialog({ title: "Log time", confirmLabel: "Log time" });
    if (!v) return;
    try {
      await sendJson(`/api/helpdesk/tickets/${ticketNumber}/time`, "POST", v, "Couldn't log the time.");
      toast("ok", `Logged ${formatMinutes(v.minutes)}.`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function edit(e: HdTimeEntry) {
    const v = await timeDialog({ title: "Edit logged time", confirmLabel: "Save", minutes: e.minutes, note: e.note });
    if (!v) return;
    try {
      await sendJson(`/api/helpdesk/time/${e.id}`, "PATCH", v, "Couldn't save the time.");
      toast("ok", "Time saved.");
      await load();
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }

  async function remove(e: HdTimeEntry) {
    const mine = e.user_id === me.id;
    const ok = await confirmDialog({
      title: `Delete ${formatMinutes(e.minutes)}${mine ? "" : ` logged by ${e.user_name}`}?`,
      body: "It comes off this ticket's total and the time reports.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/time/${e.id}`, "DELETE", undefined, "Couldn't delete the time.");
      toast("ok", "Time deleted.");
      await load();
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }

  const running = here ? now - new Date(here.started_at).getTime() : 0;

  return (
    <section aria-labelledby="time-h" className={`${CARD_CLASS} p-4`} data-testid="time-card">
      <h3 id="time-h" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
        <Timer className="h-3.5 w-3.5" aria-hidden /> Time
      </h3>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2.5 flex items-center gap-2.5">
        <span
          className={`text-2xl font-bold tabular-nums ${here ? "text-slate-900" : "text-slate-500"}`}
          role="timer"
          aria-label={here ? `Timer running: ${formatMinutes(running / 60_000)}` : "Timer stopped"}
        >
          {formatClock(running)}
        </span>
        {here ? (
          <Button variant="secondary" size="sm" icon={<Square />} onClick={stop} busy={busy} className="h-8 print:hidden">
            Stop
          </Button>
        ) : (
          <Button variant="secondary" size="sm" icon={<Play />} onClick={start} busy={busy} disabled={!data} className="h-8 print:hidden">
            Start
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500" aria-live="polite">
        {here ? (
          "Timer running · you"
        ) : elsewhere ? (
          <>
            Your timer is running on{" "}
            <Link href={`/desk/tickets/${elsewhere.ticket_number}`} className="font-medium text-compass-700 hover:underline">
              #{elsewhere.ticket_number}
            </Link>
            . Start moves it here.
          </>
        ) : (
          "Start the timer while you work, or log time afterwards."
        )}
      </p>

      <div className="mt-3 border-t border-slate-100 pt-2 text-sm">
        {data && data.entries.length === 0 && <SectionEmpty className="py-1.5">No time logged yet.</SectionEmpty>}
        {data && data.entries.length > 0 && (
          <ul aria-label="Time logged">
            {data.entries.map((e) => {
              const who = e.user_id === me.id ? "You" : e.user_name;
              const what = e.note || dayWord(e.logged_at);
              return (
                <li key={e.id} className="group flex min-h-9 items-center gap-1.5 border-b border-slate-100 py-1">
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {who} · {what}
                  </span>
                  {e.can_edit && (
                    // Shown on hover or focus where there is a pointer that hovers (they keep the name readable), always on touch.
                    <span className="flex shrink-0 items-center gap-0.5 overflow-hidden [@media(hover:hover)]:w-0 [@media(hover:hover)]:group-hover:w-auto [@media(hover:hover)]:focus-within:w-auto">
                      <button type="button" onClick={() => edit(e)} aria-label={`Edit ${formatMinutes(e.minutes)} by ${who}`} data-tt="Edit" className={iconButtonClass("quiet", "sm", "h-6 w-6")}>
                        <Pencil aria-hidden />
                      </button>
                      <button type="button" onClick={() => remove(e)} aria-label={`Delete ${formatMinutes(e.minutes)} by ${who}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "h-6 w-6 hover-danger")}>
                        <Trash2 aria-hidden />
                      </button>
                    </span>
                  )}
                  <b className="shrink-0 tabular-nums text-slate-900">{formatMinutes(e.minutes)}</b>
                </li>
              );
            })}
          </ul>
        )}
        {data && (
          <div className="flex min-h-9 items-center justify-between gap-2 py-1">
            <span className="text-slate-500">Total on this ticket</span>
            <b className="tabular-nums text-slate-900" data-testid="time-total">
              {formatMinutes(data.total_minutes)}
            </b>
          </div>
        )}
      </div>
      <Button variant="secondary" icon={<Plus />} onClick={logTime} disabled={!data} className="mt-2.5 w-full print:hidden">
        Log time
      </Button>
    </section>
  );
}

/**
 * Before a solve (TicketPane): when the ticket's team asks for time on
 * solve and the agent has none logged here, ask for it. Resolves false when
 * the agent cancels (the ticket stays unsolved). A timer running here is
 * offered as the time and stopped. Never blocks on a failed lookup.
 */
export async function askTimeOnSolve(ticketNumber: number, meId: number): Promise<boolean> {
  let data: HdTicketTime;
  try {
    data = await getJson<HdTicketTime>(`/api/helpdesk/tickets/${ticketNumber}/time`);
  } catch {
    return true;
  }
  if (!data.ask_on_solve) return true;
  const here = data.timer && data.timer.ticket_number === ticketNumber ? data.timer : null;
  if (!here && data.entries.some((e) => e.user_id === meId)) return true;
  const running = here ? Math.max(1, Math.round((Date.now() - new Date(here.started_at).getTime()) / 60_000)) : 0;
  const v = await formDialog({
    title: "Log your time before solving?",
    body: here ? `Your timer has run for ${formatMinutes(running)}. Adjust it if you need to.` : "This team records the time spent on each ticket. Leave it empty to solve without logging time.",
    confirmLabel: "Solve",
    fields: [
      { key: "hours", label: "Hours", type: "number", min: 0, max: 24, required: false, initial: running ? String(Math.floor(running / 60)) : "" },
      { key: "minutes", label: "Minutes", type: "number", min: 0, max: 59, required: false, initial: running ? String(running % 60) : "" },
      { key: "note", label: "Note", required: false, placeholder: "What you did (optional)" },
    ],
  });
  if (!v) return false;
  const minutes = Math.min(TIME_LIMITS.maxMinutes, Math.round((Number(v.hours) || 0) * 60 + (Number(v.minutes) || 0)));
  try {
    if (here) await sendJson(`/api/helpdesk/tickets/${ticketNumber}/time/timer`, "DELETE", { note: v.note.trim() });
    if (here && minutes > 0 && minutes !== running) {
      // The timer logged its own minutes; correct them to what the agent typed.
      const fresh = await getJson<HdTicketTime>(`/api/helpdesk/tickets/${ticketNumber}/time`);
      const mine = fresh.entries.find((e) => e.user_id === meId && e.source === "timer");
      if (mine) await sendJson(`/api/helpdesk/time/${mine.id}`, "PATCH", { minutes });
    } else if (!here && minutes > 0) {
      await sendJson(`/api/helpdesk/tickets/${ticketNumber}/time`, "POST", { minutes, note: v.note.trim() });
    }
  } catch (e) {
    toast("error", (e as Error).message);
  }
  return true;
}
