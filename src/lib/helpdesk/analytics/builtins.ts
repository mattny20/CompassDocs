// Helpdesk 1.19.0 reports (agent K): the built-in dashboards, the good
// defaults a small business gets without setting anything up, and the
// widget gallery's starting points. Pure data, safe in client components.
//
// Built-ins are read-only templates: lib/helpdesk/analytics/store seeds
// them into hd_dashboards (keyed by `builtin`) and keeps their layout in
// step with this file; people duplicate one to change it. Overview is the
// default dashboard.

import type { HdDashboardLayout, HdDimension, HdMeasureKey, HdTarget, HdWidget, HdWidgetType } from "./shared";

let n = 0;
function w(type: HdWidgetType, measure: HdMeasureKey, title: string, size: HdWidget["size"], groupBy: HdDimension[] = [], target?: HdTarget): HdWidget {
  n++;
  return { id: `b${n}`, type, title, measure, groupBy, filters: {}, size, target: target ?? null };
}

export interface HdBuiltinDashboard {
  key: string;
  name: string;
  description: string;
  is_default: number;
  layout: HdDashboardLayout;
}

const base = { filters: {}, range: { preset: "last_30" as const }, compare: "previous_period" as const };

export const HD_BUILTIN_DASHBOARDS: HdBuiltinDashboard[] = [
  {
    key: "overview",
    name: "Overview",
    description: "How the desk is doing: what is waiting now, volume, speed, service levels and satisfaction.",
    is_default: 1,
    layout: {
      ...base,
      widgets: [
        w("live", "open_now", "Open now", 1),
        w("live", "unassigned_now", "Unassigned now", 1),
        w("live", "breaching_now", "Breaching now", 1),
        w("kpi", "created", "Tickets created", 1),
        w("kpi", "solved", "Tickets solved", 1),
        w("kpi", "first_reply_median", "First reply time", 1, [], { value: 240, warn: 60 }),
        w("kpi", "resolution_median", "Resolution time", 1),
        w("kpi", "csat_pct", "Satisfaction", 1, [], { value: 90, warn: 5 }),
        w("area", "created", "Tickets created by day", 2, ["day"]),
        w("line", "solved", "Tickets solved by day", 2, ["day"]),
        w("gauge", "sla_first_reply_pct", "First reply SLA met", 1, [], { value: 90, warn: 5 }),
        w("gauge", "sla_resolution_pct", "Resolution SLA met", 1, [], { value: 90, warn: 5 }),
        w("donut", "created", "Tickets by channel", 2, ["channel"]),
        w("bar", "created", "Tickets by team", 2, ["team"]),
        w("table", "created", "Tickets by request type", 2, ["request_type"]),
        w("heatmap", "created", "When tickets come in", 4, ["weekday", "hour"]),
      ],
    },
  },
  {
    key: "team_performance",
    name: "Team performance",
    description: "Each team's volume, speed and quality side by side.",
    is_default: 0,
    layout: {
      ...base,
      widgets: [
        w("kpi", "solved", "Tickets solved", 1),
        w("kpi", "first_reply_median", "First reply time", 1, [], { value: 240, warn: 60 }),
        w("kpi", "resolution_median", "Resolution time", 1),
        w("kpi", "one_touch_pct", "One-touch resolution", 1),
        w("stacked", "created", "Tickets created by week and team", 4, ["week", "team"]),
        w("table", "solved", "Solved by team", 2, ["team"]),
        w("bar", "first_reply_median", "First reply time by team", 2, ["team"]),
        w("bar", "backlog", "Backlog by team", 2, ["team"]),
        w("bar", "resolution_median", "Resolution time by team", 2, ["team"]),
        w("table", "replies_per_ticket", "Replies per ticket by team", 2, ["team"]),
        w("table", "reopened", "Reopened by team", 2, ["team"]),
      ],
    },
  },
  {
    key: "sla",
    name: "SLA",
    description: "Reply and resolution targets: how often they are met, and where they are missed.",
    is_default: 0,
    layout: {
      ...base,
      widgets: [
        w("gauge", "sla_first_reply_pct", "First reply SLA met", 1, [], { value: 90, warn: 5 }),
        w("gauge", "sla_resolution_pct", "Resolution SLA met", 1, [], { value: 90, warn: 5 }),
        w("kpi", "sla_breaches", "SLA breaches", 1),
        w("live", "breaching_now", "Breaching now", 1),
        w("line", "sla_first_reply_pct", "First reply SLA met by week", 2, ["week"], { value: 90 }),
        w("line", "sla_resolution_pct", "Resolution SLA met by week", 2, ["week"], { value: 90 }),
        w("bar", "sla_breaches", "Breaches by team", 2, ["team"]),
        w("bar", "sla_breaches", "Breaches by priority", 2, ["priority"]),
        w("table", "sla_first_reply_pct", "First reply SLA by priority", 2, ["priority"]),
        w("table", "sla_resolution_pct", "Resolution SLA by team", 2, ["team"]),
      ],
    },
  },
  {
    key: "satisfaction",
    name: "Satisfaction",
    description: "What requesters say when a request is solved, and how often they come back.",
    is_default: 0,
    layout: {
      ...base,
      widgets: [
        w("kpi", "csat_pct", "Satisfaction", 1, [], { value: 90, warn: 5 }),
        w("kpi", "csat_responses", "Ratings", 1),
        w("kpi", "csat_response_rate", "Survey response rate", 1),
        w("kpi", "reopened", "Reopened", 1),
        w("line", "csat_pct", "Satisfaction by week", 2, ["week"], { value: 90 }),
        w("bar", "csat_pct", "Satisfaction by team", 2, ["team"]),
        w("leaderboard", "csat_pct", "Satisfaction by agent", 2, ["assignee"]),
        w("table", "csat_pct", "Satisfaction by request type", 2, ["request_type"]),
      ],
    },
  },
  {
    key: "agent_workload",
    name: "Agent workload",
    description: "Who is holding what right now, and who solved what in the period.",
    is_default: 0,
    layout: {
      ...base,
      widgets: [
        w("live", "open_now", "Open now", 1),
        w("live", "unassigned_now", "Unassigned now", 1),
        w("kpi", "solved", "Tickets solved", 1),
        w("kpi", "replies_per_ticket", "Replies per ticket", 1),
        w("leaderboard", "agent_workload", "Open tickets per agent", 2, ["assignee"]),
        w("leaderboard", "solved", "Solved per agent", 2, ["assignee"]),
        w("table", "first_reply_median", "First reply time per agent", 2, ["assignee"]),
        w("bar", "backlog", "Backlog by team", 2, ["team"]),
        w("kpi", "reviews_done", "Newbie replies reviewed", 1),
        w("kpi", "reviews_returned", "Newbie replies returned", 1),
      ],
    },
  },
  {
    key: "workflows",
    name: "Workflows and approvals",
    description: "How long requests spend in their workflows, which team holds them up, and approvals waiting. Pick a workflow in the filters to focus on it.",
    is_default: 0,
    layout: {
      ...base,
      widgets: [
        w("kpi", "workflow_started", "Runs started", 1),
        w("kpi", "workflow_finished", "Runs finished", 1),
        w("kpi", "workflow_duration_median", "Run time", 1),
        w("kpi", "approvals_pending", "Approvals pending", 1),
        w("bar", "workflow_team_time_median", "Median time by team", 2, ["team"]),
        w("kpi", "approval_decision_median", "Approval decision time", 1),
        w("kpi", "steps_skipped", "Skipped steps", 1),
        w("table", "workflow_team_time_median", "Time by step and team", 4, ["workflow_step", "team"]),
        w("bar", "task_cant_do_pct", "Can't-be-done rate by team", 2, ["team"]),
        w("table", "task_pickup_median", "Task wait before pickup by team", 2, ["team"]),
        w("line", "workflow_started", "Runs started by week", 2, ["week"]),
        w("table", "workflow_duration_median", "Run time by workflow", 2, ["workflow"]),
      ],
    },
  },
];

/** The widget gallery: one ready-made starting point per type, each previewed live. */
export const HD_WIDGET_GALLERY: { type: HdWidgetType; widget: Omit<HdWidget, "id"> }[] = [
  { type: "kpi", widget: { type: "kpi", title: "Tickets solved", measure: "solved", groupBy: [], filters: {}, size: 1, target: null } },
  { type: "live", widget: { type: "live", title: "Open now", measure: "open_now", groupBy: [], filters: {}, size: 1, target: null } },
  { type: "line", widget: { type: "line", title: "Tickets created by day", measure: "created", groupBy: ["day"], filters: {}, size: 2, target: null } },
  { type: "area", widget: { type: "area", title: "Backlog by day", measure: "backlog", groupBy: ["day"], filters: {}, size: 2, target: null } },
  { type: "bar", widget: { type: "bar", title: "Tickets by team", measure: "created", groupBy: ["team"], filters: {}, size: 2, target: null } },
  { type: "stacked", widget: { type: "stacked", title: "Created by week and priority", measure: "created", groupBy: ["week", "priority"], filters: {}, size: 2, target: null } },
  { type: "table", widget: { type: "table", title: "First reply time by team", measure: "first_reply_median", groupBy: ["team"], filters: {}, size: 2, target: null } },
  { type: "donut", widget: { type: "donut", title: "Tickets by priority", measure: "created", groupBy: ["priority"], filters: {}, size: 1, target: null } },
  { type: "gauge", widget: { type: "gauge", title: "First reply SLA met", measure: "sla_first_reply_pct", groupBy: [], filters: {}, size: 1, target: { value: 90, warn: 5 } } },
  { type: "heatmap", widget: { type: "heatmap", title: "When tickets come in", measure: "created", groupBy: ["weekday", "hour"], filters: {}, size: 4, target: null } },
  { type: "leaderboard", widget: { type: "leaderboard", title: "Solved per agent", measure: "solved", groupBy: ["assignee"], filters: {}, size: 2, target: null } },
];
