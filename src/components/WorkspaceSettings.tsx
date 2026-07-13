"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Brand } from "./Brand";
import {
  DATE_FORMATS,
  DATE_FORMAT_LABEL,
  SESSION_TIMEOUT_MIN,
  SESSION_TIMEOUT_MAX,
  TRASH_RETENTION_MIN,
  TRASH_RETENTION_MAX,
  ATTACHMENT_MB_MIN,
  ATTACHMENT_MB_MAX,
} from "@/lib/settings";
import type { AppSettings } from "@/lib/settings";

// IANA zones the runtime knows about, with a couple of common ones pinned first.
function timeZones(): string[] {
  const all =
    typeof (Intl as any).supportedValuesOf === "function"
      ? ((Intl as any).supportedValuesOf("timeZone") as string[])
      : ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London"];
  return all.includes("UTC") ? all : ["UTC", ...all];
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function WorkspaceSettings({ initial }: { initial: AppSettings }) {
  const router = useRouter();
  const [s, setS] = useState<AppSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || "Could not save settings.");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data?.settings) setS(data.settings);
    setSaved(true);
    router.refresh();
  }

  const zones = timeZones();

  return (
    <div className="space-y-6">
      {/* Branding */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-3 font-semibold text-slate-900">Branding</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Company name</span>
            <input
              value={s.company_name}
              onChange={(e) => set("company_name", e.target.value)}
              className={field}
              placeholder="CompassDocs"
              maxLength={80}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Logo URL <span className="text-slate-400">(optional)</span>
            </span>
            <input
              value={s.logo_url}
              onChange={(e) => set("logo_url", e.target.value)}
              className={field}
              placeholder="https://…/logo.png or leave blank for the compass mark"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-3">
          <span className="text-xs font-medium text-slate-500">Preview</span>
          <Brand name={s.company_name || "CompassDocs"} logoUrl={s.logo_url || undefined} />
        </div>
      </div>

      {/* Localization */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-3 font-semibold text-slate-900">Date &amp; time</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block sm:col-span-1">
            <span className="mb-1 block text-xs font-medium text-slate-500">Timezone</span>
            <select value={s.timezone} onChange={(e) => set("timezone", e.target.value)} className={field}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-1">
            <span className="mb-1 block text-xs font-medium text-slate-500">Date format</span>
            <select
              value={s.date_format}
              onChange={(e) => set("date_format", e.target.value as AppSettings["date_format"])}
              className={field}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {DATE_FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-1">
            <span className="mb-1 block text-xs font-medium text-slate-500">Time format</span>
            <select
              value={s.time_format}
              onChange={(e) => set("time_format", e.target.value as AppSettings["time_format"])}
              className={field}
            >
              <option value="24h">24-hour (14:05)</option>
              <option value="12h">12-hour (2:05 PM)</option>
            </select>
          </label>
        </div>
      </div>

      {/* Trash retention */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Trash retention</h3>
        <p className="mb-3 text-sm text-slate-500">
          Days to keep deleted documents in the Trash before they&rsquo;re permanently
          removed. Set to 0 to keep them until deleted by hand.
        </p>
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Days ({TRASH_RETENTION_MIN}–{TRASH_RETENTION_MAX})
          </span>
          <input
            type="number"
            min={TRASH_RETENTION_MIN}
            max={TRASH_RETENTION_MAX}
            value={s.trash_retention_days}
            onChange={(e) => set("trash_retention_days", Number(e.target.value))}
            className={field}
          />
        </label>
      </div>

      {/* Attachments */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Attachments</h3>
        <p className="mb-3 text-sm text-slate-500">
          Maximum size for a single file attached to a document.
        </p>
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Max size in MB ({ATTACHMENT_MB_MIN}–{ATTACHMENT_MB_MAX})
          </span>
          <input
            type="number"
            min={ATTACHMENT_MB_MIN}
            max={ATTACHMENT_MB_MAX}
            value={s.max_attachment_mb}
            onChange={(e) => set("max_attachment_mb", Number(e.target.value))}
            className={field}
          />
        </label>
      </div>

      {/* Security */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Session timeout</h3>
        <p className="mb-3 text-sm text-slate-500">
          Signed-in users are logged out after this many minutes of inactivity.
        </p>
        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Minutes ({SESSION_TIMEOUT_MIN}–{SESSION_TIMEOUT_MAX})
          </span>
          <input
            type="number"
            min={SESSION_TIMEOUT_MIN}
            max={SESSION_TIMEOUT_MAX}
            value={s.session_timeout_minutes}
            onChange={(e) => set("session_timeout_minutes", Number(e.target.value))}
            className={field}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-sm text-green-600">✓ Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
