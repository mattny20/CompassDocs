"use client";

// Compose and manage organization announcements. Posting always puts the
// message on every user's dashboard; email (everyone or selected groups) and
// chat webhooks are optional extra deliveries chosen per post.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Megaphone, TriangleAlert, Siren, Archive, ArchiveRestore, Trash2 } from "lucide-react";

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  level: "info" | "warning" | "critical";
  author_name: string;
  created_at: string;
  expires_at: string | null;
  archived_at: string | null;
  dismissed_count: number;
}

interface GroupLite {
  id: number;
  name: string;
  member_count: number;
}

const field =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100";

const LEVELS = [
  { value: "info", label: "Info", icon: <Megaphone className="h-3.5 w-3.5" />, cls: "border-compass-400 bg-compass-50 text-compass-700" },
  { value: "warning", label: "Warning", icon: <TriangleAlert className="h-3.5 w-3.5" />, cls: "border-amber-400 bg-amber-50 text-amber-700" },
  { value: "critical", label: "Critical", icon: <Siren className="h-3.5 w-3.5" />, cls: "border-red-400 bg-red-50 text-red-700" },
] as const;

export function AnnouncementsAdmin({
  initial,
  groups,
  smtpReady,
  webhookCount,
}: {
  initial: AnnouncementRow[];
  groups: GroupLite[];
  smtpReady: boolean;
  webhookCount: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState<"info" | "warning" | "critical">("info");
  const [expiresDays, setExpiresDays] = useState(0);
  const [emailMode, setEmailMode] = useState<"none" | "all" | "groups">("none");
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [toWebhooks, setToWebhooks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function reload() {
    const res = await fetch("/api/admin/announcements");
    if (res.ok) setRows((await res.json()).announcements);
    router.refresh();
  }

  async function post() {
    setBusy(true);
    setError("");
    setDone("");
    const res = await fetch("/api/admin/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body: message,
        level,
        expires_days: expiresDays || undefined,
        email_mode: emailMode,
        email_group_ids: emailMode === "groups" ? groupIds : [],
        notify_webhooks: toWebhooks,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data?.error || "Could not post the announcement.");
      return;
    }
    setTitle("");
    setMessage("");
    setLevel("info");
    setExpiresDays(0);
    setEmailMode("none");
    setGroupIds([]);
    setToWebhooks(false);
    setDone(
      `Posted to every dashboard${data.emailed ? ` and emailed to ${data.emailed} ${data.emailed === 1 ? "person" : "people"}` : ""}.`
    );
    await reload();
  }

  async function setArchived(row: AnnouncementRow, archived: boolean) {
    await fetch(`/api/admin/announcements/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    await reload();
  }

  async function remove(row: AnnouncementRow) {
    if (!confirm(`Delete "${row.title}"? It disappears from all dashboards.`)) return;
    await fetch(`/api/admin/announcements/${row.id}`, { method: "DELETE" });
    await reload();
  }

  const now = Date.now();
  const status = (r: AnnouncementRow) =>
    r.archived_at
      ? { label: "Archived", cls: "bg-slate-100 text-slate-500" }
      : r.expires_at && new Date(r.expires_at).getTime() < now
        ? { label: "Expired", cls: "bg-slate-100 text-slate-500" }
        : { label: "Live", cls: "bg-green-100 text-green-700" };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Announcements</h1>
        <p className="mt-1 text-sm text-slate-500">
          Post a message to every user&apos;s dashboard. Optionally, also send it by email
          (to everyone or to selected groups) and to your chat webhooks — the dashboard
          message always shows for all users either way.
        </p>
      </div>

      {/* Compose */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-slate-900">New announcement</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Scheduled maintenance this Saturday" maxLength={150} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Message</span>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} className={`${field} min-h-28`} placeholder="What does everyone need to know?" maxLength={4000} />
          </label>

          <div className="flex flex-wrap items-end gap-6">
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">Severity</span>
              <div className="flex gap-2">
                {LEVELS.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => setLevel(l.value)}
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
                      level === l.value ? l.cls : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {l.icon}
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Auto-hide after</span>
              <select value={expiresDays} onChange={(e) => setExpiresDays(Number(e.target.value))} className={field}>
                <option value={0}>Never (until archived)</option>
                <option value={1}>1 day</option>
                <option value={3}>3 days</option>
                <option value={7}>1 week</option>
                <option value={14}>2 weeks</option>
                <option value={30}>30 days</option>
              </select>
            </label>
          </div>

          {/* Delivery */}
          <fieldset className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
            <legend className="px-1 text-xs font-medium text-slate-500">
              Also deliver (optional)
            </legend>
            <div className="space-y-1.5 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="email_mode" checked={emailMode === "none"} onChange={() => setEmailMode("none")} className="accent-compass-600" />
                No email — dashboard only
              </label>
              <label className={`flex items-center gap-2 ${smtpReady ? "cursor-pointer" : "opacity-50"}`}>
                <input type="radio" name="email_mode" disabled={!smtpReady} checked={emailMode === "all"} onChange={() => setEmailMode("all")} className="accent-compass-600" />
                Email everyone (all active accounts)
              </label>
              <label className={`flex items-center gap-2 ${smtpReady && groups.length > 0 ? "cursor-pointer" : "opacity-50"}`}>
                <input type="radio" name="email_mode" disabled={!smtpReady || groups.length === 0} checked={emailMode === "groups"} onChange={() => setEmailMode("groups")} className="accent-compass-600" />
                Email selected groups only
              </label>
              {emailMode === "groups" && (
                <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1 pt-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={(e) =>
                          setGroupIds((prev) =>
                            e.target.checked ? [...prev, g.id] : prev.filter((x) => x !== g.id)
                          )
                        }
                        className="accent-compass-600"
                      />
                      {g.name}
                      <span className="text-xs text-slate-400">{g.member_count}</span>
                    </label>
                  ))}
                </div>
              )}
              {!smtpReady && (
                <p className="text-xs text-amber-600">
                  Email options need SMTP — set it up under{" "}
                  <a href="/admin/notifications" className="underline">Settings → Notifications</a>.
                </p>
              )}
              <label className={`flex items-center gap-2 pt-1 ${webhookCount > 0 ? "cursor-pointer" : "opacity-50"}`}>
                <input type="checkbox" disabled={webhookCount === 0} checked={toWebhooks} onChange={(e) => setToWebhooks(e.target.checked)} className="accent-compass-600" />
                Send to chat webhooks
                <span className="text-xs text-slate-400">
                  {webhookCount > 0
                    ? `${webhookCount} channel${webhookCount === 1 ? "" : "s"} subscribed to announcements`
                    : "no channels subscribe to the announcement event yet"}
                </span>
              </label>
            </div>
          </fieldset>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {done && <p className="text-sm text-green-600">✓ {done}</p>}
          <button
            onClick={post}
            disabled={busy || !title.trim() || !message.trim()}
            className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
          >
            {busy ? "Posting…" : "Post announcement"}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-slate-900">Posted</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing posted yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const s = status(r);
              return (
                <li key={r.id} className="flex items-start gap-3 py-3 text-sm">
                  <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                    {s.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-800">{r.title}</p>
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-slate-500">{r.body}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {r.level} · {r.author_name} · {new Date(r.created_at).toLocaleString()}
                      {r.expires_at && ` · hides ${new Date(r.expires_at).toLocaleDateString()}`}
                      {r.dismissed_count > 0 && ` · dismissed by ${r.dismissed_count}`}
                    </p>
                  </div>
                  {r.archived_at ? (
                    <button onClick={() => setArchived(r, false)} title="Restore to dashboards" className="rounded p-1 text-slate-400 hover:bg-slate-100">
                      <ArchiveRestore className="h-4 w-4" />
                    </button>
                  ) : (
                    <button onClick={() => setArchived(r, true)} title="Archive (hide from all dashboards)" className="rounded p-1 text-slate-400 hover:bg-slate-100">
                      <Archive className="h-4 w-4" />
                    </button>
                  )}
                  <button onClick={() => remove(r)} title="Delete" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
