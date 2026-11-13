"use client";

// Desk settings → Request types: "Goes on the calendar" (1.20.6,
// lib/helpdesk/desk-calendar). A request raised through such a type creates
// its ticket with an event already filled in: the start, the end and the
// place are read from the form's answers, and the setup lead time comes from
// here. Any type can use it: a room setup, a new starter's first day, an
// equipment loan.
//
// The start is a "Date and time" question, or a "Date" question for whole
// days; the end must be the same kind. The server checks the same rules
// (desk-calendar-shared checkRequestTypeCalendar).

import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, Select, Toggle } from "@/components/form";
import { calendarFieldChoices, leadLabel, resolveRequestTypeCalendar, type HdRequestTypeCalendar } from "@/lib/helpdesk/desk-calendar-shared";
import type { HdFormField } from "@/lib/helpdesk/types";
import { SETUP_CHOICES } from "./EventDialog";

const KIND: Record<string, string> = { datetime: "date and time", date: "date, all day" };

export function RequestTypeCalendarCard({
  form,
  value,
  onChange,
  onAddQuestion,
  error,
}: {
  form: HdFormField[];
  value: Partial<HdRequestTypeCalendar> | undefined;
  onChange: (next: HdRequestTypeCalendar) => void;
  /** Append a "Date and time" question to the form and answer with its key. */
  onAddQuestion: () => string;
  error?: string;
}) {
  const v = resolveRequestTypeCalendar(value);
  const { when, place } = calendarFieldChoices(form);
  const start = when.find((f) => f.key === v.start_field);
  const ends = when.filter((f) => f.key !== v.start_field && (!start || f.type === start.type));
  const set = (p: Partial<HdRequestTypeCalendar>) => onChange({ ...v, ...p });
  const leads = SETUP_CHOICES.includes(v.lead_minutes) ? SETUP_CHOICES : [...SETUP_CHOICES, v.lead_minutes].sort((a, b) => a - b);
  const label = (f: HdFormField) => `${f.label.trim() || f.key} (${KIND[f.type] ?? f.type})`;

  return (
    <Card title="Goes on the calendar" description="Its requests create a ticket with an event already filled in from the answers." id="rt-calendar" className="scroll-mt-6">
      <div className="space-y-4" data-testid="rt-calendar">
        <Toggle
          label="Put its requests on the calendar"
          help="Room setups, first days, equipment loans: anything that happens at a set time. The ticket can't be solved until its setup is marked complete."
          checked={v.enabled}
          onChange={(on) => {
            // Switching on with nothing chosen picks the first date question, so the common case is one click.
            if (on && !start && when.length) set({ enabled: true, start_field: when[0].key });
            else set({ enabled: on });
          }}
          size="full"
        />
        {v.enabled && when.length === 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-sm text-slate-700">This form has no question that asks for a date yet.</p>
            <p className="mt-0.5 text-xs text-slate-500">Add a &quot;Date and time&quot; question for the start. Use a &quot;Date&quot; question instead for events that last whole days.</p>
            <Button variant="secondary" size="sm" icon={<CalendarPlus />} className="mt-2" onClick={() => set({ start_field: onAddQuestion() })}>
              Add a start question
            </Button>
          </div>
        )}
        {v.enabled && when.length > 0 && (
          <div className="grid gap-4 @2xl:grid-cols-2">
            <Field label="Start" help="The question that holds when the event starts.">
              <Select value={v.start_field} onChange={(e) => set({ start_field: e.target.value, end_field: "" })} data-testid="rt-calendar-start">
                {!start && <option value="">Choose a question…</option>}
                {when.map((f) => (
                  <option key={f.key} value={f.key}>
                    {label(f)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="End (optional)" help={start?.type === "date" ? "Left out, the event is that one day." : "Left out, the event is one hour long."}>
              <Select value={ends.some((f) => f.key === v.end_field) ? v.end_field : ""} onChange={(e) => set({ end_field: e.target.value })} data-testid="rt-calendar-end">
                <option value="">None</option>
                {ends.map((f) => (
                  <option key={f.key} value={f.key}>
                    {label(f)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Place (optional)" help="A short answer or a pick-one question: the room, the site.">
              <Select value={place.some((f) => f.key === v.place_field) ? v.place_field : ""} onChange={(e) => set({ place_field: e.target.value })} data-testid="rt-calendar-place">
                <option value="">None</option>
                {place.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label.trim() || f.key}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Setup ready" help="How long before the start the setup must be in place. Agents can change it on the ticket.">
              <Select value={String(v.lead_minutes)} onChange={(e) => set({ lead_minutes: Number(e.target.value) })} data-testid="rt-calendar-lead">
                {leads.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? "At the start (no setup time)" : `${leadLabel(m)} before`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
