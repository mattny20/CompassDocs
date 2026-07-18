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
  const [siteUrl, setSiteUrl] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  // Logo fetch/upload/remove apply immediately (they store a file server-side),
  // unlike the text fields which wait for "Save changes".
  async function fetchSiteIcon() {
    if (!siteUrl.trim()) return;
    setLogoBusy(true);
    setLogoMsg(null);
    const res = await fetch("/api/admin/branding/logo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_url: siteUrl }),
    });
    const data = await res.json().catch(() => ({}));
    setLogoBusy(false);
    if (res.ok) {
      setS((prev) => ({ ...prev, logo_url: data.logo_url }));
      setLogoMsg({ ok: true, text: "Icon fetched and set as your logo." });
      router.refresh();
    } else {
      setLogoMsg({ ok: false, text: data?.error || "Could not fetch an icon." });
    }
  }

  async function uploadLogo(file: File | undefined | null) {
    if (!file) return;
    setLogoBusy(true);
    setLogoMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/branding/logo", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    setLogoBusy(false);
    if (res.ok) {
      setS((prev) => ({ ...prev, logo_url: data.logo_url }));
      setLogoMsg({ ok: true, text: "Logo uploaded." });
      router.refresh();
    } else {
      setLogoMsg({ ok: false, text: data?.error || "The upload failed." });
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    setLogoMsg(null);
    const res = await fetch("/api/admin/branding/logo", { method: "DELETE" });
    setLogoBusy(false);
    if (res.ok) {
      setS((prev) => ({ ...prev, logo_url: "" }));
      setLogoMsg({ ok: true, text: "Logo removed — back to the compass mark." });
      router.refresh();
    }
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
              Logo URL <span className="text-slate-400">(optional — or use the options below)</span>
            </span>
            <input
              value={s.logo_url}
              onChange={(e) => set("logo_url", e.target.value)}
              className={field}
              placeholder="https://…/logo.png or leave blank for the compass mark"
            />
          </label>
        </div>

        {/* Logo from a website or an upload — these apply immediately. */}
        <div className="mt-4 grid gap-4 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Use a website&apos;s icon
            </span>
            <p className="mb-2 text-xs text-slate-400">
              Enter your company site — we&apos;ll fetch its favicon and use it as the logo.
            </p>
            <div className="flex gap-2">
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && fetchSiteIcon()}
                className={field}
                placeholder="yourcompany.com"
              />
              <button
                type="button"
                onClick={fetchSiteIcon}
                disabled={logoBusy || !siteUrl.trim()}
                className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {logoBusy ? "Working…" : "Fetch icon"}
              </button>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Upload a logo</span>
            <p className="mb-2 text-xs text-slate-400">
              PNG, JPEG, GIF, WebP, or ICO up to 1 MB. Square images look best.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
                disabled={logoBusy}
                onChange={(e) => {
                  uploadLogo(e.target.files?.[0]);
                  e.target.value = "";
                }}
                className="text-xs"
              />
              {s.logo_url && (
                <button
                  type="button"
                  onClick={removeLogo}
                  disabled={logoBusy}
                  className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Remove logo
                </button>
              )}
            </div>
          </div>
        </div>
        {logoMsg && (
          <p className={`mt-2 text-xs ${logoMsg.ok ? "text-green-600" : "text-red-600"}`}>
            {logoMsg.text}
          </p>
        )}
        <div className="mt-4 border-t border-slate-100 pt-3">
          <span className="mb-1 block text-xs font-medium text-slate-500">Accent color</span>
          <p className="mb-2 text-xs text-slate-400">
            Re-tints buttons, links, highlights, and tinted surfaces across the whole app —
            light and dark theme, login page, and the public site.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              ["#2e75bd", "Compass blue (default)"],
              ["#4f46e5", "Indigo"],
              ["#7c3aed", "Violet"],
              ["#0d9488", "Teal"],
              ["#059669", "Emerald"],
              ["#d97706", "Amber"],
              ["#dc2626", "Red"],
              ["#db2777", "Pink"],
              ["#475569", "Graphite"],
            ].map(([hex, label]) => (
              <button
                key={hex}
                type="button"
                title={label}
                onClick={() => set("accent_color", hex)}
                className={`h-7 w-7 rounded-full border-2 transition ${
                  s.accent_color === hex ? "scale-110 border-slate-700" : "border-transparent hover:scale-105"
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            <input
              type="color"
              value={s.accent_color}
              onChange={(e) => set("accent_color", e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-md border border-slate-200"
              aria-label="Custom accent color"
            />
            <code className="text-xs text-slate-400">{s.accent_color}</code>
          </div>
          <p className="mt-1 text-xs text-slate-400">Applies everywhere after saving (pages refresh with the new color).</p>
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

      {/* Comments */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold text-slate-900">Comments</h3>
        <p className="mb-3 text-sm text-slate-500">
          Discussion threads under every document, with @mentions that notify
          people by email and on their dashboard. Turning comments off hides
          all existing comments immediately (nothing is deleted).
        </p>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={s.comments_enabled}
            onChange={(e) => set("comments_enabled", e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-compass-600"
          />
          Allow comments on documents
        </label>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-slate-500">
            Restricted words (comments containing these are rejected — one per
            line or comma-separated, case-insensitive)
          </span>
          <textarea
            value={s.comments_blocked_words}
            onChange={(e) => set("comments_blocked_words", e.target.value)}
            rows={3}
            placeholder={"confidential\nproject blue"}
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
