"use client";

// Desk settings → Event calendar (1.20.6, lib/helpdesk/desk-calendar;
// settings.manage). Reminders to agents about a ticket's event: how long
// before the setup is due, whether to remind again when an event starts with
// its setup still open, and who gets them. Under them, the events whose setup
// was never marked (they still hold their tickets open), and the calendar
// feed links: the admin's own, and everyone's, each with Revoke.
//
// This page is the "Event calendar" in the settings rail. "Calendars" there
// is a different thing: the business hours that reply targets count in.

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Card } from "@/components/Card";
import { Field, Select, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { Segmented } from "@/components/Segmented";
import { useAppSettings } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, TD, TH, TR } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { EVENT_LIMITS, eventWhen, leadLabel, type HdCalendarSettings } from "@/lib/helpdesk/desk-calendar-shared";
import { getJson, sendJson } from "../api";
import { ticketHref } from "../ui";
import { SETUP_CHOICES } from "./EventDialog";
import { FeedLinks } from "./FeedLinks";

interface Overdue {
  number: number;
  subject: string;
  team_name: string | null;
  assignee_name: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
  place: string;
  status: string;
}

/** The lead times offered as tick boxes (minutes before "ready by"). */
const LEAD_CHOICES = [15, 30, 60, 120, 240, 1440, 2880, 10080];

export function CalendarSettings() {
  const { timezone: tz, time_format } = useAppSettings();
  const [s, setS] = useState<HdCalendarSettings | null>(null);
  const [chat, setChat] = useState(false);
  const [overdue, setOverdue] = useState<Overdue[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(s);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ settings: HdCalendarSettings; chat_connected: boolean; overdue: Overdue[] }>("/api/helpdesk/admin/calendar", "Couldn't load the calendar settings.")
      .then((d) => {
        setS(d.settings);
        setChat(d.chat_connected);
        setOverdue(d.overdue ?? []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !s) {
    return (
      <PageContainer>
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (!s) {
    return (
      <PageContainer>
        <LoadingRow className="py-10" />
      </PageContainer>
    );
  }

  const change = (p: Partial<HdCalendarSettings>) => {
    markDirty();
    setS({ ...s, ...p });
  };
  const leads = [...new Set([...LEAD_CHOICES, ...s.reminder_minutes])].sort((a, b) => a - b);
  const full = s.reminder_minutes.length >= EVENT_LIMITS.reminderLeads;
  const setups = SETUP_CHOICES.includes(s.default_setup_minutes) ? SETUP_CHOICES : [...SETUP_CHOICES, s.default_setup_minutes].sort((a, b) => a - b);

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const d = await sendJson<{ settings: HdCalendarSettings }>("/api/helpdesk/admin/calendar", "PUT", s, "Couldn't save the calendar settings.");
      setS(d.settings);
      markClean(JSON.stringify(d.settings));
      toast("ok", "Calendar settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<CalendarDays />} title="Event calendar" subtitle="Reminders about the events on tickets, and the links calendar apps subscribe to." />
      <div className="flex flex-col gap-4">
        <Card title="Reminders" description="Sent to agents before an event's setup must be ready. A ticket's Event block says when that is.">
          <div className="space-y-5" data-testid="calendar-reminders">
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Remind this long before setup is due</legend>
              <p className="mt-0.5 text-xs text-slate-500">Up to {EVENT_LIMITS.reminderLeads}. None ticked: no reminders before the event.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {leads.map((m) => {
                  const on = s.reminder_minutes.includes(m);
                  return (
                    <label
                      key={m}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${on ? "border-compass-500 bg-compass-50 text-compass-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"} ${!on && full ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && full}
                        onChange={(e) => change({ reminder_minutes: (e.target.checked ? [...s.reminder_minutes, m] : s.reminder_minutes.filter((x) => x !== m)).sort((a, b) => b - a) })}
                        data-testid={`lead-${m}`}
                      />
                      {leadLabel(m)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Toggle
              label="Remind again when an event starts before its setup is marked complete"
              help="Goes to the ticket's owner and the team's leads, once."
              checked={s.late_reminder}
              onChange={(v) => change({ late_reminder: v })}
              size="full"
            />
            <div>
              <p className="text-sm font-medium text-slate-800" id="cal-recipients">
                Who gets them
              </p>
              <Segmented<HdCalendarSettings["recipients"]>
                label="Who gets them"
                className="mt-1.5"
                value={s.recipients}
                onChange={(v) => change({ recipients: v })}
                options={[
                  { value: "owner_else_team", label: "The owner, or the team when nobody owns it" },
                  { value: "owner_and_team", label: "The owner and the team" },
                ]}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Each agent chooses how they hear about it (bell, email, push) under Event reminders in{" "}
                <Link href="/desk/settings/notifications" className="font-medium text-compass-700 hover:underline">
                  Notifications
                </Link>
                . Quiet hours apply.
              </p>
            </div>
            <Toggle
              label="Also message agents in Microsoft Teams or Slack"
              help={chat ? "A direct message from the helpdesk app, to agents it knows." : "Connect Microsoft Teams or Slack under Integrations first."}
              checked={s.chat && chat}
              disabled={!chat}
              onChange={(v) => change({ chat: v })}
              size="full"
            />
            <Field label="Setup time for an event added by hand" help="What the Event block offers first. Request types set their own." size="sm">
              <Select value={String(s.default_setup_minutes)} onChange={(e) => change({ default_setup_minutes: Number(e.target.value) })}>
                {setups.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? "At the start (no setup time)" : `${leadLabel(m)} before`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save reminders" />
        </Card>

        {overdue.length > 0 && (
          <Card padding="none" title="Setup never marked" description="These events are over, but their setup was never marked complete, so their tickets can't be solved. Open each one and mark the setup, or remove its event.">
            <Table scroll minWidth="36rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={TH}>Ticket</th>
                  <th scope="col" className={TH}>Event</th>
                  <th scope="col" className={TH}>Owner</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((o) => (
                  <tr key={o.number} className={TR}>
                    <td className={TD}>
                      <Link href={ticketHref(o.number)} className="font-medium text-slate-800 hover:underline">
                        #{o.number} {o.subject}
                      </Link>
                    </td>
                    <td className={`${TD} text-slate-600`}>
                      {eventWhen(o, tz, time_format === "12h")}
                      {o.place ? ` · ${o.place}` : ""}
                    </td>
                    <td className={`${TD} text-slate-600`}>{o.assignee_name ?? o.team_name ?? "Nobody"}</td>
                    <td className={`${TD} whitespace-nowrap text-slate-600`}>{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}

        <FeedLinks all />
      </div>
    </PageContainer>
  );
}
