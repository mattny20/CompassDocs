// Helpdesk 1.19.1: saved queue views, the parts the desk's client code and
// the server share (agent V4). Dependency-free apart from the shared types.
//
// A saved view is a name and the tickets API's queue parameters
// (lib/helpdesk/ticket-filters TICKET_FILTER_KEYS, minus sort), personal
// (owner_id) or shared with a team (team_id).

import { HD_PRIORITY_LABEL, HD_STATUS_LABEL, type HdPriority, type HdStatus } from "./types";

export const SAVED_VIEW_NAME_MAX = 60;
/** Per person (personal views) and per team (team views). */
export const SAVED_VIEW_LIMIT = 50;

export type HdViewFilters = Record<string, string>;

export interface HdSavedView {
  id: number;
  name: string;
  /** Set: a personal view (only its owner sees it). */
  owner_id: number | null;
  /** Set: shared with this team. */
  team_id: number | null;
  team_name: string | null;
  filters: HdViewFilters;
  position: number;
  created_at: string;
  updated_at: string;
  /** The viewer may rename, change or delete it. */
  can_edit: boolean;
  /** Tickets it holds for the viewer (their scope), when counted. */
  count?: number | null;
}

/** What GET /api/helpdesk/views answers. */
export interface HdSavedViewsList {
  views: HdSavedView[];
  /** Teams the viewer may share a view with (team lead and up there). */
  share_teams: { id: number; name: string }[];
}

const VIEW_LABEL: Record<string, string> = {
  mine: "My open",
  unassigned: "Unassigned",
  open: "All open",
  overdue: "Overdue",
  workflow: "In a workflow",
  waiting: "Waiting",
  solved_week: "Solved this week",
};

const ORIGIN_LABEL: Record<string, string> = { people: "Opened by people", automated: "Automated only" };

/** "Created in the last 7 days" for created_within. */
export function createdWithinLabel(days: string | number): string {
  const n = Number(days);
  if (n === 1) return "Created today";
  return `Created in the last ${n} days`;
}

/**
 * The filters in words, for the Save dialog and the filter strip:
 * 'Contains "VPN" · Created this week · Not solved'. Team names come from
 * `teams` (the desk counts' list); unknown ids read "team 3".
 */
export function filterSummary(f: HdViewFilters, teams: { team_id?: number; id?: number; name: string }[] = []): string {
  const teamName = (id: string) => teams.find((t) => String(t.team_id ?? t.id) === id)?.name ?? `team ${id}`;
  const parts: string[] = [];
  const view = f.view ?? "";
  if (view.startsWith("team:")) parts.push(`${teamName(view.slice(5))} open`);
  else if (VIEW_LABEL[view]) parts.push(VIEW_LABEL[view]);
  if (f.q) parts.push(`Contains "${f.q}"`);
  if (f.team) parts.push(teamName(f.team));
  if (f.created_within) parts.push(createdWithinLabel(f.created_within));
  if (f.status_group === "open") parts.push("Not solved");
  if (f.status) parts.push(HD_STATUS_LABEL[f.status as HdStatus] ?? f.status);
  if (f.priority) parts.push(`${HD_PRIORITY_LABEL[f.priority as HdPriority] ?? f.priority} priority`);
  if (f.assignee === "me") parts.push("Assigned to me");
  else if (f.assignee === "none") parts.push("Unassigned");
  else if (f.assignee) parts.push("One owner");
  if (f.tag) parts.push(`Tagged ${f.tag}`);
  if (f.breached) parts.push(f.breached === "now" ? "Past a target now" : "Missed a target");
  if (f.origin) parts.push(ORIGIN_LABEL[f.origin] ?? f.origin);
  if (f.vip) parts.push(f.vip === "yes" ? "VIP requesters" : "Not VIP requesters");
  if (f.created_from) parts.push(`Created from ${f.created_from}`);
  if (f.created_to) parts.push(`Created to ${f.created_to}`);
  if (f.solved_from) parts.push(`Solved from ${f.solved_from}`);
  if (f.solved_to) parts.push(`Solved to ${f.solved_to}`);
  for (const k of ["request_type", "channel", "category", "department", "office", "integration", "requester", "requester_email"]) {
    if (f[k]) parts.push(`${k.replace(/_/g, " ")} ${f[k].replace(/_/g, " ")}`);
  }
  if (!parts.length) return view === "all" ? "Every ticket" : "All open";
  return parts.join(" · ");
}
