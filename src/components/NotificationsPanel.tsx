"use client";

// Account → Notifications: the personal master switch for subscription
// emails, plus every space the user follows (directly or via a group).

import { useState } from "react";
import Link from "next/link";
import { BellOff, BellRing, UsersRound } from "lucide-react";

type Sub = {
  space_id: number;
  name: string;
  slug: string;
  icon: string;
  state: "subscribed" | "muted" | null;
  via_group: boolean;
};

export function NotificationsPanel({
  initialEnabled,
  email,
  initialSubs,
}: {
  initialEnabled: boolean;
  email: string;
  initialSubs: Sub[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [subs, setSubs] = useState<Sub[]>(initialSubs);
  const [busy, setBusy] = useState(false);

  async function toggleMaster(on: boolean) {
    setBusy(true);
    const res = await fetch("/api/account/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_notifications: on }),
    });
    setBusy(false);
    if (res.ok) setEnabled(on);
  }

  async function setSub(s: Sub, action: "subscribe" | "mute" | "clear") {
    const res = await fetch(`/api/spaces/${s.space_id}/subscription`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return;
    const next = (await res.json()).state as Sub["state"];
    setSubs((prev) =>
      prev
        .map((x) => (x.space_id === s.space_id ? { ...x, state: next } : x))
        // Direct-only subscriptions vanish from the list once cleared.
        .filter((x) => x.state !== null || x.via_group)
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => toggleMaster(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-compass-600"
          />
          <span>
            <span className="font-medium text-slate-900">Email me about my subscriptions</span>
            <span className="block text-sm text-slate-500">
              {email
                ? `Sent to ${email} when a document in a subscribed space is published or updated.`
                : "Your account has no email address — ask an admin to add one."}
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Subscribed spaces</h3>
        {subs.length === 0 ? (
          <p className="text-sm text-slate-400">
            You aren&apos;t subscribed to any spaces yet — open a space and click{" "}
            <strong>Subscribe</strong>.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {subs.map((s) => {
              const effective = s.state === "subscribed" || (s.via_group && s.state !== "muted");
              return (
                <li key={s.space_id} className="flex items-center gap-2.5 py-2">
                  <span className="text-lg">{s.icon}</span>
                  <Link
                    href={`/spaces/${s.slug}`}
                    className="font-medium text-slate-800 hover:text-compass-700"
                  >
                    {s.name}
                  </Link>
                  {s.via_group && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700"
                      title="An admin subscribed one of your groups to this space."
                    >
                      <UsersRound className="h-3 w-3" /> via group
                    </span>
                  )}
                  <span className="ml-auto">
                    {effective ? (
                      <button
                        onClick={() => setSub(s, s.via_group ? "mute" : "clear")}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <BellOff className="h-3 w-3" /> {s.via_group ? "Mute" : "Unsubscribe"}
                      </button>
                    ) : (
                      <button
                        onClick={() => setSub(s, "subscribe")}
                        className="inline-flex items-center gap-1 rounded-md border border-compass-200 bg-compass-50 px-2 py-1 text-xs font-medium text-compass-700 hover:bg-compass-100"
                      >
                        <BellRing className="h-3 w-3" /> Resubscribe
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
