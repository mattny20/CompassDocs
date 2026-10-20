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
  ClipboardClock,
  ShieldAlert,
} from "lucide-react";
import { timeAgo } from "@/lib/ui";
import { CONFIRM_SECTION_ID } from "@/lib/use-reached-end";

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
  ack_due: <ClipboardClock className="h-4 w-4" aria-hidden />,
  ack_escalation: <ShieldAlert className="h-4 w-4" aria-hidden />,
};

/** The inbox kinds that ask for a read confirmation (a request, a reminder, a re-confirmation notice share one kind; the automatic reminder (E2) is its own). */
const ACK_KINDS = new Set(["ack_requested", "ack_due"]);

/**
 * Where a notification opens. A read-confirmation notice lands on the
 * confirmation card at the end of the document (H1, 1.10.1): the outbox
 * writes `/doc/{id}#confirm-reading`, and rows written before 1.10.1 carry
 * the bare document link, so the hash is added here for the ack kinds when
 * it is missing. Every other kind opens exactly what it stored.
 */
export function notificationHref(item: Pick<NotificationItem, "kind" | "link">): string {
  const link = item.link || "";
  if (!ACK_KINDS.has(item.kind) || !link || link.includes("#")) return link;
  return /^\/doc\/\d+/.test(link) ? `${link}#${CONFIRM_SECTION_ID}` : link;
}

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
  const href = notificationHref(item);
  return (
    <button
      onClick={() => onOpen(href === item.link ? item : { ...item, link: href })}
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
