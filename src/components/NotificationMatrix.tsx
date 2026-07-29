"use client";

// Account → Notifications: per-event delivery grid. Rows are the event kinds
// the inbox knows; columns are the channels. Unchecking stores an explicit
// opt-out (the default for everything is "on", matching pre-0.73 behavior).
// Email exists only for the kinds that actually send email today; the
// subscription email row points at its master switch instead of duplicating it.

import { useState } from "react";

type Channel = "inapp" | "webhook" | "email";
type Prefs = Record<string, Partial<Record<Channel, boolean>>>;

const ROWS: { kind: string; label: string; hint: string; email: boolean }[] = [
  { kind: "mention", label: "Mentions", hint: "Someone @mentions you in a comment", email: false },
  { kind: "comment", label: "Comment replies", hint: "New comments on threads you're in", email: false },
  { kind: "doc_update", label: "Subscribed spaces", hint: "A document you follow is published or updated", email: false },
  { kind: "cr_submitted", label: "Change requests", hint: "A change request arrives for your review", email: false },
  { kind: "cr_resolved", label: "Review decisions", hint: "Your change request is approved or rejected", email: false },
  { kind: "review_due", label: "Review reminders", hint: "A document you steward is due for review", email: true },
  { kind: "ack_requested", label: "Read confirmations", hint: "You're asked to read and acknowledge a document", email: true },
  { kind: "service_status", label: "Service status", hint: "A tracked SaaS tool goes down or recovers", email: false },
];

const COLS: { key: Channel; label: string }[] = [
  { key: "inapp", label: "In-app" },
  { key: "webhook", label: "Webhook" },
  { key: "email", label: "Email" },
];

export function NotificationMatrix({
  initial,
  webhookConfigured,
}: {
  initial: Prefs;
  webhookConfigured: boolean;
}) {
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [error, setError] = useState("");

  function isOn(kind: string, ch: Channel): boolean {
    return prefs[kind]?.[ch] !== false;
  }

  async function toggle(kind: string, ch: Channel) {
    const next: Prefs = structuredClone(prefs);
    if (isOn(kind, ch)) (next[kind] ??= {})[ch] = false;
    else delete next[kind]?.[ch];
    setPrefs(next);
    setError("");
    // The API stores only explicit opt-outs; send booleans for what changed.
    const body: Record<string, Record<string, boolean>> = {};
    for (const row of ROWS) {
      for (const col of COLS) {
        const v = next[row.kind]?.[col.key];
        if (v === false) (body[row.kind] ??= {})[col.key] = false;
      }
    }
    const res = await fetch("/api/account/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notify_prefs: body }),
    });
    if (!res.ok) {
      setPrefs(prefs); // roll back
      setError((await res.json().catch(() => null))?.error || "Couldn't save.");
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <h3 className="mb-1 text-sm font-semibold text-slate-900">What reaches you where</h3>
      <p className="mb-3 text-sm text-slate-500">
        In-app is the bell inbox; webhook is your chat webhook below
        {webhookConfigured ? "" : " (not set up yet)"}. Subscription and digest emails have
        their own switches below.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-sm">
          <thead>
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-2 font-medium">Event</th>
              {COLS.map((c) => (
                <th key={c.key} className="w-20 pb-2 text-center font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ROWS.map((row) => (
              <tr key={row.kind}>
                <td className="py-2.5 pr-2">
                  <span className="block font-medium text-slate-800">{row.label}</span>
                  <span className="block text-xs text-slate-500">{row.hint}</span>
                </td>
                {COLS.map((col) => (
                  <td key={col.key} className="py-2.5 text-center">
                    {col.key === "email" && !row.email ? (
                      <span className="text-slate-300" title="No email is sent for this event">
                        —
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={isOn(row.kind, col.key)}
                        onChange={() => toggle(row.kind, col.key)}
                        aria-label={`${row.label} via ${col.label}`}
                        className="h-4 w-4 accent-compass-600"
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
