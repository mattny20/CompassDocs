"use client";

// The sidebar bell: unread badge, a dropdown of recent notifications, and
// mark-read plumbing. Polls the unread count once a minute; the full list
// loads on open so the common case (no clicks) costs one tiny request.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCheck,
  MessageSquareText,
  MessageCircle,
  FileText,
  GitPullRequest,
  CheckCircle2,
  CalendarClock,
  ClipboardCheck,
} from "lucide-react";
import { timeAgo } from "@/lib/ui";

interface Item {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  actor_name: string;
  created_at: string;
  read_at: string | null;
}

const KIND_ICON: Record<string, React.ReactNode> = {
  mention: <MessageSquareText className="h-4 w-4" aria-hidden />,
  comment: <MessageCircle className="h-4 w-4" aria-hidden />,
  doc_update: <FileText className="h-4 w-4" aria-hidden />,
  cr_submitted: <GitPullRequest className="h-4 w-4" aria-hidden />,
  cr_resolved: <CheckCircle2 className="h-4 w-4" aria-hidden />,
  review_due: <CalendarClock className="h-4 w-4" aria-hidden />,
  ack_requested: <ClipboardCheck className="h-4 w-4" aria-hidden />,
};

export function NotificationsBell({ initialUnread }: { initialUnread: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!open) return;
    void refresh();
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
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

  function openItem(item: Item) {
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
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-compass-600 px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xl">
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
              <p className="px-3 py-6 text-center text-sm text-slate-400">Loading…</p>
            )}
            {items !== null && items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-slate-400">
                You're all caught up.
              </p>
            )}
            {items?.map((item) => (
              <button
                key={item.id}
                onClick={() => openItem(item)}
                className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition hover:bg-slate-50 ${
                  item.read_at ? "opacity-70" : ""
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 ${item.read_at ? "text-slate-300" : "text-compass-500"}`}
                >
                  {KIND_ICON[item.kind] ?? <Bell className="h-4 w-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm ${item.read_at ? "text-slate-600" : "font-medium text-slate-900"}`}
                  >
                    {item.title}
                  </span>
                  {item.body && (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">
                      {item.body}
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {timeAgo(item.created_at)}
                  </span>
                </span>
                {!item.read_at && (
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-compass-500" aria-hidden />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
