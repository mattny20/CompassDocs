"use client";

// The desk's bell: the same notifications as the CompassDocs sidebar bell
// (one /api/notifications, one NotificationRow), anchored for a top bar's
// right-hand side (the sidebar bell hangs from its left edge, which would
// run off the screen here). Its footer adds "Notification settings" for the
// desk's own push and email choices (/desk/settings/notifications).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Popover } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import { iconButtonClass } from "@/components/Button";
import { NotificationRow, type NotificationItem } from "@/components/NotificationRow";

export function DeskBell({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // A network hiccup: the next poll catches up.
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function post(body: unknown) {
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) setUnread((await res.json()).unread);
    } catch {
      // Non-fatal: the row stays unread.
    }
  }

  function openItem(item: NotificationItem) {
    setOpen(false);
    setItems((prev) => (prev ? prev.map((i) => (i.id === item.id ? { ...i, read_at: i.read_at || "now" } : i)) : prev));
    if (!item.read_at) void post({ action: "read", id: item.id });
    if (item.link) router.push(item.link);
  }

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-tt="Notifications"
        data-tt-pos="bottom"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={iconButtonClass("quiet", "md", "relative")}
      >
        <Bell aria-hidden />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-compass-600 px-1 text-3xs font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={btn}
        role="dialog"
        label="Notifications"
        align="end"
        width="w-[min(22rem,calc(100vw-1rem))]"
        padding="p-0"
        className="mt-2 overflow-hidden rounded-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-sm font-semibold text-slate-900">Notifications</span>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => {
                void post({ action: "read_all" });
                setItems((prev) => (prev ? prev.map((i) => ({ ...i, read_at: i.read_at || new Date().toISOString() })) : prev));
              }}
              className="flex items-center gap-1 text-xs font-medium text-compass-600 hover:text-compass-700"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items === null && <LoadingRow className="px-3 py-6" />}
          {items !== null && items.length === 0 && (
            <SectionEmpty className="px-3 py-6 text-center">You&apos;re all caught up.</SectionEmpty>
          )}
          {items?.map((item) => <NotificationRow key={item.id} item={item} onOpen={openItem} dense />)}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2 text-xs">
          <Link href="/notifications" target="_blank" onClick={() => setOpen(false)} className="font-medium text-compass-600 hover:text-compass-700">
            See all notifications
          </Link>
          <Link href="/desk/settings/notifications" onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-700">
            Notification settings
          </Link>
        </div>
      </Popover>
    </div>
  );
}
