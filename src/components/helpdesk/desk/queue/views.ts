// The queue's views (the left column of /desk) and how a view travels in
// the address: ?view=mine (default), ?view=overdue, or ?team=3 for a team's
// open tickets, plus ?sort=due|updated|created|priority. Opening a ticket
// keeps the query, so /desk/tickets/1047?view=overdue still shows the
// Overdue list beside it.

import { CircleAlert, CircleCheck, CirclePause, Inbox, List, UserRound, Workflow, type LucideIcon } from "lucide-react";
import type { HdNamedView, HdTicketSort } from "@/lib/helpdesk/types";

export const VIEWS: { key: HdNamedView; label: string; icon: LucideIcon; alarm?: boolean }[] = [
  { key: "mine", label: "My open", icon: UserRound },
  { key: "unassigned", label: "Unassigned", icon: Inbox },
  { key: "open", label: "All open", icon: List },
  { key: "overdue", label: "Overdue", icon: CircleAlert, alarm: true },
  { key: "workflow", label: "In a workflow", icon: Workflow },
  { key: "waiting", label: "Waiting", icon: CirclePause },
  { key: "solved_week", label: "Solved this week", icon: CircleCheck },
];

export const SORTS: { value: HdTicketSort; label: string }[] = [
  { value: "due", label: "Due first" },
  { value: "priority", label: "Priority first" },
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Newest first" },
];

/**
 * Report drill-down (agent K's report charts link into the queue): these
 * query parameters filter the list across every status, under a
 * "Filtered from Reports" bar. `team` alone is the ordinary team view; any
 * other key here (or from=reports) makes it a drill-down.
 */
export const DRILL_KEYS = [
  "team",
  "assignee",
  "priority",
  "request_type",
  "channel",
  "status",
  "tag",
  "created_from",
  "created_to",
  "solved_from",
  "solved_to",
  "breached",
  "requester",
  "requester_email",
  "category",
  "department",
  "office",
  "origin",
  "status_group",
  "vip",
  "integration",
] as const;

export interface QueueSel {
  view: HdNamedView | null;
  team: number | null;
  sort: HdTicketSort;
  /** The drill-down filters, when the list came from Reports. */
  drill: Record<string, string> | null;
}

const VIEW_KEYS = new Set<string>(VIEWS.map((v) => v.key));
const SORT_KEYS = new Set<string>(SORTS.map((s) => s.value));

export function readSel(sp: URLSearchParams | null): QueueSel {
  const team = Number(sp?.get("team"));
  const view = sp?.get("view") ?? "";
  const sort = sp?.get("sort") ?? "";
  const drill: Record<string, string> = {};
  for (const k of DRILL_KEYS) {
    const v = sp?.get(k);
    if (v) drill[k] = v.slice(0, k === "requester_email" ? 320 : 80);
  }
  const isDrill = sp?.get("from") === "reports" || Object.keys(drill).some((k) => k !== "team");
  return {
    drill: isDrill ? drill : null,
    team: Number.isSafeInteger(team) && team > 0 ? team : null,
    view: Number.isSafeInteger(team) && team > 0 ? null : VIEW_KEYS.has(view) ? (view as HdNamedView) : "mine",
    sort: SORT_KEYS.has(sort) ? (sort as HdTicketSort) : "due",
  };
}

/** The query string for a selection ("" for the default My open, due first). */
export function selQs(sel: QueueSel): string {
  const p = new URLSearchParams();
  if (sel.drill) {
    p.set("from", "reports");
    for (const [k, v] of Object.entries(sel.drill)) p.set(k, v);
    if (sel.sort !== "due") p.set("sort", sel.sort);
    return `?${p.toString()}`;
  }
  if (sel.team) p.set("team", String(sel.team));
  else if (sel.view && sel.view !== "mine") p.set("view", sel.view);
  if (sel.sort !== "due") p.set("sort", sel.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The API query for a selection. */
export function apiQs(sel: QueueSel): string {
  const p = new URLSearchParams();
  if (sel.drill) {
    // Every status unless the drill-down names one.
    p.set("view", "all");
    for (const [k, v] of Object.entries(sel.drill)) p.set(k, v);
    p.set("sort", sel.sort);
    return p.toString();
  }
  if (sel.team) {
    p.set("view", "open");
    p.set("team", String(sel.team));
  } else p.set("view", sel.view ?? "mine");
  p.set("sort", sel.sort);
  return p.toString();
}
