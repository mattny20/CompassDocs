"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import type { AppSettings, BackupFrequency } from "@/lib/settings";
import { BACKUP_KEEP_MIN, BACKUP_KEEP_MAX } from "@/lib/settings";

interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}
interface Dest {
  key: string;
  label: string;
  configured: boolean;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const field =
  "rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

export function BackupsClient({
  backups,
  destinations,
  settings,
}: {
  backups: BackupInfo[];
  destinations: Dest[];
  settings: AppSettings;
}) {
  const router = useRouter();
  const [freq, setFreq] = useState<BackupFrequency>(settings.backup_frequency);
  const [keep, setKeep] = useState(settings.backup_keep);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function saveSchedule() {
    setSavingSchedule(true);
    setScheduleSaved(false);
    await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup_frequency: freq, backup_keep: keep }),
    });
    setSavingSchedule(false);
    setScheduleSaved(true);
    router.refresh();
  }

  async function backupNow() {
    setBusy("__create__");
    setErr("");
    setMsg("");
    const res = await fetch("/api/backups", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setErr(data?.error || "Backup failed.");
      return;
    }
    const up = data.backup?.uploaded?.length ? ` · uploaded to ${data.backup.uploaded.join(", ")}` : "";
    setMsg(`Backup created (${bytes(data.backup?.size ?? 0)})${up}.`);
    router.refresh();
  }

  async function remove(b: BackupInfo) {
    if (!confirm(`Delete backup ${b.name}? This removes it locally and from remote destinations.`))
      return;
    setBusy(b.name);
    const res = await fetch(`/api/backups/${b.name}`, { method: "DELETE" });
    setBusy(null);
    if (res.ok) router.refresh();
    else setErr((await res.json().catch(() => ({})))?.error || "Delete failed.");
  }

  async function restore(b: BackupInfo) {
    if (
      !confirm(
        `Restore from ${b.name}?\n\nThis OVERWRITES the entire database — all current users, documents, and settings are replaced with the contents of this backup. This cannot be undone.`
      )
    )
      return;
    if (!confirm("Are you absolutely sure? Everyone will need to sign in again.")) return;
    setBusy(b.name);
    setErr("");
    setMsg("");
    const res = await fetch(`/api/backups/${b.name}/restore`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      setMsg("Database restored. You may need to sign in again.");
      router.refresh();
    } else {
      setErr((await res.json().catch(() => ({})))?.error || "Restore failed.");
    }
  }

  return (
    <div className="space-y-6">
      {/* Schedule + destinations */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <h3 className="mb-1 font-semibold text-slate-900">Automatic backups</h3>
          <p className="mb-3 text-sm text-slate-500">
            Run a full database backup on a schedule, keeping the newest few.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Frequency</span>
              <select value={freq} onChange={(e) => setFreq(e.target.value as BackupFrequency)} className={field}>
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                Keep ({BACKUP_KEEP_MIN}–{BACKUP_KEEP_MAX})
              </span>
              <input
                type="number"
                min={BACKUP_KEEP_MIN}
                max={BACKUP_KEEP_MAX}
                value={keep}
                onChange={(e) => setKeep(Number(e.target.value))}
                className={`${field} w-24`}
              />
            </label>
            <button
              onClick={saveSchedule}
              disabled={savingSchedule}
              className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
            >
              {savingSchedule ? "Saving…" : "Save"}
            </button>
            {scheduleSaved && <span className="text-sm text-green-600">✓</span>}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <h3 className="mb-1 font-semibold text-slate-900">Destinations</h3>
          <p className="mb-3 text-sm text-slate-500">
            Backups are written locally and mirrored to any off-site destination configured below.
          </p>
          <div className="flex flex-wrap gap-2">
            {destinations.map((d) => (
              <span
                key={d.key}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  d.configured
                    ? "bg-green-100 text-green-700"
                    : "bg-slate-100 text-slate-400"
                }`}
              >
                {d.configured ? "✓" : "○"} {d.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Backups list */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">Backups ({backups.length})</h3>
          <button
            onClick={backupNow}
            disabled={busy === "__create__"}
            className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
          >
            {busy === "__create__" ? "Backing up…" : "Back up now"}
          </button>
        </div>

        {msg && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
        {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {backups.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No backups yet. Click <strong>Back up now</strong> or set a schedule.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {backups.map((b) => (
              <div key={b.name} className={`flex items-center justify-between py-2.5 ${busy === b.name ? "opacity-50" : ""}`}>
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-slate-700">{b.name}</div>
                  <div className="text-xs text-slate-400">
                    {formatDateTime(b.created_at, settings)} · {bytes(b.size)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5 text-xs">
                  <a
                    href={`/api/backups/${b.name}`}
                    className="rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Download
                  </a>
                  <button
                    onClick={() => restore(b)}
                    disabled={busy === b.name}
                    className="rounded-md border border-amber-200 px-2 py-1 font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => remove(b)}
                    disabled={busy === b.name}
                    className="rounded-md border border-red-200 px-2 py-1 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
