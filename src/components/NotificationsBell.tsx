"use client";

// The sidebar bell: unread badge, a dropdown of recent notifications, and
// mark-read plumbing. Polls the unread count once a minute; the full list
// loads on open so the common case (no clicks) costs one tiny request. The
// dropdown's footer leads to the full inbox (/notifications, with history)
// and to notification preferences; rows are NotificationRow, shared with
// the inbox page.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Popover } from "./Popover";
import { LoadingRow } from "./Spinner";
import { NotificationRow, type NotificationItem } from "./NotificationRow";

export function NotificationsBell({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // Network hiccup — the next poll will catch up.
    }
  }, []);

  // Badge poll: keep the count fresh without keeping the list warm.
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // The list loads on open; Popover owns outside-click, Escape (through the
  // overlay stack) and focus return to the bell.
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  async function markRead(id: number) {
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read", id }),
      });
      if (res.ok) setUnread((await res.json()).unread);
    } catch {
      // Non-fatal; the row just stays unread.
    }
  }

  async function markAllRead() {
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read_all" }),
      });
      if (res.ok) {
        setUnread((await res.json()).unread);
        setItems((prev) =>
          prev ? prev.map((i) => ({ ...i, read_at: i.read_at || new Date().toISOString() })) : prev
        );
      }
    } catch {
      // Non-fatal.
    }
  }

  function openItem(item: NotificationItem) {
    setOpen(false);
    setItems((prev) =>
      prev
        ? prev.map((i) => (i.id === item.id ? { ...i, read_at: i.read_at || "now" } : i))
        : prev
    );
    if (!item.read_at) void markRead(item.id);
    if (item.link) router.push(item.link);
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        data-tt="Notifications"
        data-tt-pos="bottom"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        // A finger-sized target on phones; desktop geometry unchanged.
        className="relative rounded-md p-3.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 sm:p-1.5"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-compass-600 px-1 text-3xs font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={btnRef}
        role="dialog"
        label="Notifications"
        align="start"
        width="w-80"
        padding="p-0"
        className="mt-2 overflow-hidden rounded-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-sm font-semibold text-slate-900">Notifications</span>
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-xs font-medium text-compass-600 hover:text-compass-700"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items === null && (
            <LoadingRow className="px-3 py-6" />
          )}
          {items !== null && items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              You're all caught up.
            </p>
          )}
          {items?.map((item) => (
            <NotificationRow key={item.id} item={item} onOpen={openItem} dense />
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="font-medium text-compass-600 hover:text-compass-700"
          >
            See all notifications
          </Link>
          <Link
            href="/account/notifications"
            onClick={() => setOpen(false)}
            className="text-slate-500 hover:text-slate-700"
          >
            Preferences
          </Link>
        </div>
      </Popover>
    </div>
  );
}
