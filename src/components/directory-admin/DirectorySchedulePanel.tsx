"use client";

// When each provider syncs on its own, and who gets the report. The sync
// buttons stay for "now"; this is "every night at three, and tell me".

import { useState } from "react";
import { buttonClass } from "@/components/Button";
import { CalendarClock } from "lucide-react";
import { Field, Select, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { jsonFetch } from "./shared";

export interface ScheduleState {
  microsoft: "off" | "hourly" | "daily";
  google: "off" | "hourly" | "daily";
  hour: number;
  report_to: string[];
  report_quiet: boolean;
  last: Partial<Record<"microsoft" | "google", { at: string; ok: boolean; summary?: string }>>;
}

export function DirectorySchedulePanel({ initial, smtpConfigured }: { initial: ScheduleState; smtpConfigured: boolean }) {
  const fmt = useFormatDate();
  const [s, setS] = useState(initial);
  const [recipients, setRecipients] = useState(initial.report_to.join(", "));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<ScheduleState>) => {
    setS((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  };

  async function save() {
    setSaving(true);
    const r = await jsonFetch("/api/admin/directory/schedule", {
      method: "PUT",
      body: JSON.stringify({ microsoft: s.microsoft, google: s.google, hour: s.hour, report_to: recipients, report_quiet: s.report_quiet }),
    });
    setSaving(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the schedule.");
      return;
    }
    setS(r.data);
    setRecipients(r.data.report_to.join(", "));
    setDirty(false);
    toast("ok", "Schedule saved.");
  }

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const lastLine = (p: "microsoft" | "google") => {
    const l = s.last[p];
    if (!l) return "Not run on schedule yet.";
    return `${l.ok ? "Ran" : "Failed"} ${fmt.dateTime(l.at)}${l.summary ? ` — ${l.summary}` : ""}`;
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h3 className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
        <CalendarClock className="h-4 w-4 text-compass-600" aria-hidden /> Schedule & reports
      </h3>
      <p className="mb-3 text-sm text-slate-500">
        Sync on a schedule instead of a button, and email a report of what changed — who was added, changed or
        removed, what could not be matched, and whether the removal brake held anything back.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Microsoft 365" help={lastLine("microsoft")}>
          <Select value={s.microsoft} onChange={(e) => set({ microsoft: e.target.value as ScheduleState["microsoft"] })} className="w-full">
            <option value="off">Only when I click Sync now</option>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
          </Select>
        </Field>
        <Field label="Google Workspace" help={lastLine("google")}>
          <Select value={s.google} onChange={(e) => set({ google: e.target.value as ScheduleState["google"] })} className="w-full">
            <option value="off">Only when I click Sync now</option>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
          </Select>
        </Field>
        <Field label="Daily runs at (UTC)" help="Hourly runs ignore this.">
          <Select value={String(s.hour)} onChange={(e) => set({ hour: Number(e.target.value) })} className="w-full" disabled={s.microsoft !== "daily" && s.google !== "daily"}>
            {hours.map((h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field
          label="Email the report to"
          help={smtpConfigured ? "Comma-separated. Leave blank for no email — the Sync page still shows every run." : "SMTP is not set up (Settings → Notifications); reports will not be sent until it is."}
        >
          <TextInput value={recipients} onChange={(e) => { setRecipients(e.target.value); setDirty(true); }} placeholder="it@firm.com, office-manager@firm.com" />
        </Field>
        <Toggle label="Email even when nothing changed" checked={s.report_quiet} onChange={(v) => set({ report_quiet: v })} />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving || !dirty} className={buttonClass("primary")}>
          {saving ? "Saving…" : "Save schedule"}
        </button>
        {dirty ? <span className="text-xs ink-warn">Unsaved changes</span> : <span className="text-xs text-slate-500">Saved</span>}
      </div>
    </div>
  );
}
