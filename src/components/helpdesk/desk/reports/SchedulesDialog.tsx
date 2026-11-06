"use client";

// Desk reports (1.19.0): deliver a dashboard by email on a cadence. The
// dialog lists the dashboard's schedules (on/off, delete) above one form:
// who gets it (people and whole teams; each sees only their own numbers),
// how often, when (in the helpdesk's time zone) and what is attached. The
// next send is spelled out before saving.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Mail, Trash2, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, Select, SectionEmpty, Toggle } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { WEEKDAY_LABEL } from "@/lib/helpdesk/analytics/shared";
import { HD_FORMAT_LABEL, HD_FREQUENCY_LABEL, nextSlot, type HdFrequency, type HdReportSchedule, type HdScheduleFormat } from "@/lib/helpdesk/analytics/schedule-time";
import { getJson, sendJson } from "../api";
import type { ReportOptions } from "./data";

function when(s: { frequency: HdFrequency; weekday: number; hour: number }): string {
  const h = `${String(s.hour).padStart(2, "0")}:00`;
  if (s.frequency === "daily") return `Every day at ${h}`;
  if (s.frequency === "weekly") return `Every ${WEEKDAY_LABEL[s.weekday]} at ${h}`;
  return `The 1st of every month at ${h}`;
}

function fmtNext(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function SchedulesDialog({
  open,
  onClose,
  dashboard,
  options,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: { id: number; name: string };
  options: ReportOptions | null;
  /** May send to other people and teams (an editor, reports.all, a Manager). */
  canManage: boolean;
}) {
  const [list, setList] = useState<HdReportSchedule[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const me = options?.me ?? 0;
  const [users, setUsers] = useState<number[]>([]);
  const [teams, setTeams] = useState<number[]>([]);
  const [frequency, setFrequency] = useState<HdFrequency>("weekly");
  const [weekday, setWeekday] = useState(1);
  const [hour, setHour] = useState(8);
  const [format, setFormat] = useState<HdScheduleFormat>("email");
  const tz = options?.timezone ?? "UTC";

  const load = useCallback(() => {
    setError("");
    getJson<{ schedules: HdReportSchedule[] }>(`/api/helpdesk/analytics/schedules?dashboard=${dashboard.id}`, "Couldn't load the schedules.")
      .then((d) => setList(d.schedules))
      .catch((e: Error) => setError(e.message));
  }, [dashboard.id]);

  useEffect(() => {
    if (!open) return;
    setList(null);
    setUsers(me ? [me] : []);
    setTeams([]);
    load();
  }, [open, load, me]);

  const next = useMemo(() => new Date(nextSlot({ frequency, weekday, hour }, tz, Date.now())).toISOString(), [frequency, weekday, hour, tz]);
  const people = options?.agents ?? [];
  const toggleIn = (arr: number[], id: number) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const nobody = users.length === 0 && teams.length === 0;

  async function create() {
    setBusy(true);
    try {
      await sendJson("/api/helpdesk/analytics/schedules", "POST", { dashboard_id: dashboard.id, recipients: { users, teams }, frequency, weekday, hour, format }, "Couldn't save the schedule.");
      toast("ok", `Scheduled: ${when({ frequency, weekday, hour })}.`);
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(s: HdReportSchedule, enabled: boolean) {
    try {
      await sendJson(`/api/helpdesk/analytics/schedules/${s.id}`, "PATCH", { enabled }, "Couldn't change the schedule.");
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(s: HdReportSchedule) {
    const ok = await confirmDialog({ title: "Stop this schedule?", body: `${when(s)} to ${recipientsLine(s)} stops. The dashboard stays.`, confirmLabel: "Delete schedule", danger: true });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/analytics/schedules/${s.id}`, "DELETE", undefined, "Couldn't delete the schedule.");
      toast("ok", "Schedule deleted.");
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="hd-schedules-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 id="hd-schedules-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <CalendarClock className="h-5 w-5 text-compass-600" aria-hidden /> Email this dashboard
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {dashboard.name}: its numbers for the last day, week or month, by email. Everyone gets only the numbers they can see in Reports.
          </p>
        </div>
        <button type="button" onClick={onClose} className={iconButtonClass("quiet", "md")} data-tt="Close" aria-label="Close">
          <X aria-hidden />
        </button>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-slate-800">Schedules</h3>
      {error && <p className="notice-error mb-3 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {!error && list === null && <LoadingRow className="py-4" />}
      {list && list.length === 0 && <SectionEmpty className="mb-4">Nothing scheduled yet. Add the first one below.</SectionEmpty>}
      {list && list.length > 0 && (
        <ul className="mb-5 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Mail className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">{when(s)}</p>
                <p className="truncate text-xs text-slate-500">
                  To {recipientsLine(s)} · {HD_FORMAT_LABEL[s.format]} · {s.enabled ? `next ${fmtNext(s.next_at, tz)}` : "paused"}
                </p>
              </div>
              <Toggle label={<span className="sr-only">Send {when(s).toLowerCase()}</span>} checked={Boolean(s.enabled)} onChange={(v) => setEnabled(s, v)} size="xs" className="w-auto" />
              <button type="button" className={iconButtonClass("quiet", "sm", "hover-danger")} onClick={() => remove(s)} data-tt="Delete" aria-label={`Delete the schedule ${when(s).toLowerCase()}`}>
                <Trash2 aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-semibold text-slate-800">New schedule</h3>
      <div className="space-y-4 rounded-lg border border-slate-200 bg-canvas p-4">
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-slate-500">Send to</legend>
          {!canManage && <p className="mb-2 text-xs text-slate-500">You can send this dashboard to yourself. Its editors can send it to others.</p>}
          <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-surface p-2">
            {(canManage ? people : people.filter((p) => p.id === me)).map((p) => (
              <label key={p.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-50">
                <input type="checkbox" checked={users.includes(p.id)} onChange={() => setUsers((u) => toggleIn(u, p.id))} />
                {p.name}
                {p.id === me && <span className="text-xs text-slate-500">(you)</span>}
              </label>
            ))}
            {canManage && (options?.teams.length ?? 0) > 0 && (
              <>
                <p className="mt-2 px-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">Whole teams</p>
                {options!.teams.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-50">
                    <input type="checkbox" checked={teams.includes(t.id)} onChange={() => setTeams((x) => toggleIn(x, t.id))} />
                    Everyone in {t.name}
                  </label>
                ))}
              </>
            )}
          </div>
        </fieldset>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">How often</p>
          <Segmented
            label="How often"
            size="sm"
            value={frequency}
            onChange={setFrequency}
            options={(["daily", "weekly", "monthly"] as const).map((f) => ({ value: f, label: HD_FREQUENCY_LABEL[f] }))}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {frequency === "weekly" && (
            <Field label="On">
              <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <option key={d} value={d}>
                    {WEEKDAY_LABEL[d]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={`At (${tz})`}>
            <Select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What it sends" help={format === "email" ? undefined : "The link asks the reader to sign in, and needs the Export tickets capability."}>
            <Select value={format} onChange={(e) => setFormat(e.target.value as HdScheduleFormat)}>
              {(["email", "csv", "pdf"] as const).map((f) => (
                <option key={f} value={f}>
                  {HD_FORMAT_LABEL[f]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-sm text-slate-700">
          {when({ frequency, weekday, hour })}, covering {frequency === "daily" ? "the day before" : frequency === "weekly" ? "the 7 days before" : "the month before"}. First one:{" "}
          <span className="font-medium">{fmtNext(next, tz)}</span>.
        </p>
        <div className="flex justify-end">
          <Button onClick={create} busy={busy} disabled={nobody} icon={<CalendarClock />}>
            Add schedule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function recipientsLine(s: HdReportSchedule): string {
  const names = [...s.recipient_labels.users.map((u) => u.name), ...s.recipient_labels.teams.map((t) => `everyone in ${t.name}`)];
  if (!names.length) return "nobody";
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
