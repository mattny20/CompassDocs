"use client";

// The builder's "Count" choice (1.19.1, mock-up #12): a Wait step, a task's
// due offset and an approval's reminder count calendar time (the default,
// and every step saved before 1.19.1) or business time in a team's
// calendar (office hours and holidays, Settings → Calendars). For an
// offset from a form date the panel adds a worked example computed from
// the real calendar: "Start date Mon Jan 4 → moves on Tue Dec 29 (Dec 31
// and Jan 1 are holidays)."

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Field, Select } from "@/components/form";
import { RadioCards } from "@/components/PolicyFields";
import type { HdCountDef } from "@/lib/helpdesk/types";
import { getJson } from "../api";

export interface CountExampleQuery {
  /** Days before (negative) or after the form date. */
  offset: number;
  /** The form field's label ("Start date"). */
  field: string;
  kind: "wait" | "due";
}

export function CountSetting({
  stepKey,
  value,
  unit,
  teams,
  defaultTeamId,
  defaultLabel,
  example,
  onChange,
}: {
  stepKey: string;
  value: HdCountDef;
  /** Days for an offset from a form date, hours for a delay. */
  unit: "days" | "hours";
  teams: { id: number; name: string }[];
  /** The team counted when none is chosen (the task's, else the request type's). */
  defaultTeamId: number | null;
  /** "The task's team" / "The request type's team". */
  defaultLabel: string;
  /** Show the worked example for this offset (business days only). */
  example?: CountExampleQuery | null;
  onChange: (next: HdCountDef) => void;
}) {
  const business = value.count === "business";
  const teamId = value.count_team_id ?? defaultTeamId;
  const teamName = teams.find((t) => t.id === teamId)?.name ?? null;
  const calendarLabel = unit === "days" ? "Calendar days" : "Calendar hours";
  const businessLabel = unit === "days" ? "Business days" : "Business hours";
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold text-slate-800">Count</legend>
      <RadioCards
        label="Count"
        name={`count-${stepKey}`}
        value={business ? "business" : "calendar"}
        onChange={(v) => onChange(v === "business" ? { count: "business", ...(value.count_team_id ? { count_team_id: value.count_team_id } : {}) } : {})}
        options={[
          { value: "calendar", label: calendarLabel, description: "Weekends and holidays count." },
          {
            value: "business",
            label: businessLabel,
            description: teamName ? `Uses the office hours and holidays of ${teamName}.` : "Uses the default calendar's office hours and holidays.",
            extra: (
              <Field label="Whose calendar">
                <Select
                  dense
                  value={value.count_team_id ?? ""}
                  onChange={(e) => onChange({ count: "business", ...(e.target.value ? { count_team_id: Number(e.target.value) } : {}) })}
                >
                  <option value="">{defaultLabel}</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ),
          },
        ]}
      />
      {business && example && <CountExampleStrip teamId={teamId} query={example} />}
    </fieldset>
  );
}

/** The worked example, from the counting team's real calendar. */
function CountExampleStrip({ teamId, query }: { teamId: number | null; query: CountExampleQuery }) {
  const [text, setText] = useState<string | null>(null);
  const key = `${teamId ?? ""}|${query.offset}|${query.kind}|${query.field}`;
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ offset: String(query.offset), kind: query.kind, field: query.field });
    if (teamId) qs.set("team", String(teamId));
    getJson<{ example: { text: string } | null }>(`/api/helpdesk/admin/workflows/count-example?${qs}`, "Couldn't work out an example.")
      .then((d) => live && setText(d.example?.text ?? "This calendar has no business days, so the step counts calendar days instead."))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!text) return null;
  return (
    <p
      className="mt-3 flex gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 text-sm text-slate-700"
      data-testid="count-example"
    >
      <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
      <span>{text}</span>
    </p>
  );
}
