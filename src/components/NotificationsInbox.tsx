"use client";

// The Notifications page: the same rows as the bell, with history. "Load
// older" pages through /api/notifications?before=<id>; "Mark all read"
// clears the badge for the bell too (it polls, and the router refresh
// re-renders the layout's count).

import { useState } from "react";
import { buttonClass } from "@/components/Button";
import { useRouter } from "next/navigation";
import { BellOff, CheckCheck, LoaderCircle } from "lucide-react";
import { EmptyState } from "./form";
import { NotificationRow, type NotificationItem } from "./NotificationRow";

const PAGE = 50;

export function NotificationsInbox({
  initial,
  initialMore,
  initialUnread,
}: {
  initial: NotificationItem[];
  initialMore: boolean;
  initialUnread: number;
}) {
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initialMore);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState<"older" | "all" | null>(null);
  const router = useRouter();

  async function loadOlder() {
    const last = items[items.length - 1];
    if (!last || busy) return;
    setBusy("older");
    try {
      const res = await fetch(`/api/notifications?before=${last.id}&limit=${PAGE}`);
      if (res.ok) {
        const data = await res.json();
        setItems((prev) => [...prev, ...data.items]);
        setMore(Boolean(data.more));
      }
    } catch {
      // Leave the button; the next click retries.
    } finally {
      setBusy(null);
    }
  }

  async function markAllRead() {
    if (busy) return;
    setBusy("all");
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read_all" }),
      });
      if (res.ok) {
        setUnread((await res.json()).unread);
        const now = new Date().toISOString();
        setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at || now })));
        router.refresh();
      }
    } catch {
      // Non-fatal.
    } finally {
      setBusy(null);
    }
  }

  async function openItem(item: NotificationItem) {
    if (!item.read_at) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read_at: "now" } : i)));
      try {
        const res = await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "read", id: item.id }),
        });
        if (res.ok) setUnread((await res.json()).unread);
      } catch {
        // Non-fatal.
      }
    }
    if (item.link) router.push(item.link);
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<BellOff />}
        title="Nothing here yet"
        body="Mentions, comments on your documents, review requests and reminders land here. Choose what reaches you under Account › Notifications."
        action={{ href: "/account/notifications", label: "Notification preferences" }}
      />
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface shadow-xs">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <span className="text-sm text-slate-500">
          {unread > 0 ? `${unread} unread` : "All read"}
        </span>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            disabled={busy !== null}
            className="flex items-center gap-1 text-xs font-medium text-compass-600 hover:text-compass-700 disabled:opacity-60"
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
          </button>
        )}
      </div>
      <ul className="divide-y divide-slate-100">
        {items.map((item) => (
          <li key={item.id}>
            <NotificationRow item={item} onOpen={openItem} />
          </li>
        ))}
      </ul>
      {more && (
        <div className="border-t border-slate-100 px-4 py-3 text-center">
          <button
            onClick={loadOlder}
            disabled={busy !== null}
            className={buttonClass("secondary")}
          >
            {busy === "older" && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
            Load older
          </button>
        </div>
      )}
    </div>
  );
}
