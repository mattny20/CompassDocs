"use client";

// <TeamCalendarSelect teamId /> (agent L, for D's Teams settings): the
// team's "Office hours" calendar, changed at once (PATCH
// /api/helpdesk/admin/calendars/assign, toasted; the team's open tickets are
// re-timed). "Default" follows whichever calendar is the default. Renders
// nothing for someone who can't manage calendars (the route answers 403).
// Pass `data` when the page already has the calendars (the Calendars page).

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/form";
import { toast } from "@/components/Toasts";
import { sendJson } from "../api";
import { useCalendarsData } from "./data";
import type { CalendarsData } from "./data";

export function TeamCalendarSelect({
  teamId,
  data: given,
  onChanged,
  label = "Office hours",
  showLabel = true,
}: {
  teamId: number;
  data?: CalendarsData | null;
  onChanged?: () => void;
  label?: string;
  /** False when a row already names the team (the label stays for readers). */
  showLabel?: boolean;
}) {
  const own = useCalendarsData();
  const data = given ?? own.data;
  const id = useId();
  const team = data?.teams.find((t) => t.id === teamId);
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (team) setValue(team.calendar_id == null ? "" : String(team.calendar_id));
  }, [team]);
  if (!given && own.status === 403) return null;
  if (!data || !team) return null;
  const def = data.calendars.find((c) => c.is_default);

  async function change(next: string) {
    const prev = value;
    setValue(next);
    setBusy(true);
    try {
      const r = await sendJson<{ retimed: number }>(
        "/api/helpdesk/admin/calendars/assign",
        "PATCH",
        { team_id: teamId, calendar_id: next === "" ? null : Number(next) },
        "Couldn't change the team's office hours."
      );
      const name = next === "" ? `the default (${def?.name ?? "Office hours"})` : data!.calendars.find((c) => String(c.id) === next)?.name;
      toast("ok", `${team!.name} now works to ${name}.${r.retimed ? ` ${r.retimed} open ticket${r.retimed === 1 ? "" : "s"} re-timed.` : ""}`);
      if (given) onChanged?.();
      else await own.reload();
    } catch (e) {
      setValue(prev);
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = value === "" ? def : data.calendars.find((c) => String(c.id) === value);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={showLabel ? "mb-1 block text-sm font-medium text-slate-800" : "sr-only"}>
        {showLabel ? label : `${label} for ${team.name}`}
      </label>
      <Select id={id} dense={!showLabel} value={value} disabled={busy} onChange={(e) => void change(e.target.value)} className="w-full max-w-64" aria-describedby={`${id}-hint`}>
        <option value="">Default{def ? ` (${def.name})` : ""}</option>
        {data.calendars
          .filter((c) => !c.is_default)
          .map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
      </Select>
      <p id={`${id}-hint`} className="mt-1 text-xs break-words text-slate-500">
        {chosen ? `${chosen.summary} · ${chosen.timezone}` : ""}
        {showLabel && (
          <>
            {" · "}
            <Link href="/desk/settings/calendars" className="link">
              Manage calendars
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
