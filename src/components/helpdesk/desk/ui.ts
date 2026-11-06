// Display helpers shared by the desk screens: status chip tones, the
// priority dot, SLA ink and the compact due label of the queue. Pure
// functions and constants (safe in client and server components).

import type { ChipTone } from "@/components/Chip";
import {
  HD_IN_WORKFLOW_LABEL,
  HD_PRIORITY_LABEL,
  HD_STATUS_LABEL,
  type HdPriority,
  type HdSlaState,
  type HdStatus,
} from "@/lib/helpdesk/types";

/** Status chip tones (STYLEGUIDE "Helpdesk: the desk"). */
export const STATUS_TONE: Record<HdStatus, ChipTone> = {
  new: "info",
  open: "accent",
  pending: "warn",
  on_hold: "neutral",
  solved: "ok",
  closed: "neutral",
};

/** The queue's narrow column says "Waiting"; everywhere else says it in full. */
export const STATUS_SHORT: Record<HdStatus, string> = {
  ...HD_STATUS_LABEL,
  pending: "Waiting",
};

export function statusChip(t: { status: HdStatus; in_workflow?: boolean }, short = false): { tone: ChipTone; label: string } {
  if (t.in_workflow && t.status !== "solved" && t.status !== "closed") return { tone: "accent", label: HD_IN_WORKFLOW_LABEL };
  return { tone: STATUS_TONE[t.status], label: (short ? STATUS_SHORT : HD_STATUS_LABEL)[t.status] };
}

/** The 8px priority dot. Decorative; callers add the sr-only label. */
export const PRIORITY_DOT: Record<HdPriority, string> = {
  urgent: "bg-red-600",
  high: "bg-orange-500",
  normal: "bg-compass-600",
  low: "bg-slate-400",
};

export function priorityLabel(p: HdPriority): string {
  return `${HD_PRIORITY_LABEL[p]} priority`;
}

/** Ink for an SLA measurement (a measurement is ink, never a chip). */
export function slaInk(state: HdSlaState | null | undefined): string {
  switch (state) {
    case "breached":
      return "font-semibold text-red-600";
    case "warn":
      return "font-medium ink-warn";
    case "ok":
    case "met":
      return "ink-ok";
    default:
      return "text-slate-500";
  }
}

/**
 * The queue's compact due: "Reply overdue 25m" → "Overdue 25m",
 * "Reply due in 1h 20m" → "1h 20m", "Resolve due tomorrow" → "Tomorrow".
 * The full label stays the row's accessible text.
 */
export function compactDue(label: string): string {
  if (!label) return "";
  let s = label.replace(/^(Reply|Resolve|Resolution)\s+/i, "");
  s = s.replace(/^overdue/i, "Overdue").replace(/^due in\s+/i, "").replace(/^due\s+/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "38m", "4h 10m", "2d 3h" from minutes; "None yet" for null. */
export function minutesLabel(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "None yet";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function percentLabel(p: number | null | undefined): string {
  return p === null || p === undefined ? "None yet" : `${Math.round(p)}%`;
}

/** First name for "Reply to Daniel". */
export function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "";
}

/** Bytes as "142 KB". */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Where a ticket lives in the desk. */
export const ticketHref = (n: number, qs = "") => `/desk/tickets/${n}${qs}`;
