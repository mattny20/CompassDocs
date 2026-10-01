"use client";

// One notification, as the bell dropdown and the Notifications page both
// render it: kind icon, title (prefixed "Unread:" for readers), body, age,
// and the unread dot.

import {
  Bell,
  MessageSquareText,
  MessageCircle,
  FileText,
  GitPullRequest,
  CheckCircle2,
  CalendarClock,
  ClipboardCheck,
} from "lucide-react";
import { timeAgo } from "@/lib/ui";

export interface NotificationItem {
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

export function NotificationRow({
  item,
  onOpen,
  dense = false,
}: {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
  /** The dropdown's tighter row; the page uses the default. */
  dense?: boolean;
}) {
  return (
    <button
      onClick={() => onOpen(item)}
      className={`flex w-full items-start gap-2.5 text-left transition hover:bg-slate-50 ${
        dense ? "px-3 py-2.5" : "px-4 py-3"
      } ${item.read_at ? "opacity-70" : ""}`}
    >
      <span className={`mt-0.5 shrink-0 ${item.read_at ? "text-slate-300" : "text-compass-500"}`}>
        {KIND_ICON[item.kind] ?? <Bell className="h-4 w-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${item.read_at ? "text-slate-600" : "font-medium text-slate-900"}`}>
          {!item.read_at && <span className="sr-only">Unread: </span>}
          {item.title}
        </span>
        {item.body && (
          <span className={`mt-0.5 block text-xs text-slate-500 ${dense ? "line-clamp-2" : ""}`}>
            {item.body}
          </span>
        )}
        <span className="mt-0.5 block text-xs text-slate-500">{timeAgo(item.created_at)}</span>
      </span>
      {!item.read_at && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-compass-500" aria-hidden />
      )}
    </button>
  );
}
