// Helpdesk 1.19.0 (Enterprise "helpdesk"): the shared TypeScript contract.
//
// One file every helpdesk module, route and component imports, owned by the
// core (agent A). Row types mirror the tables in the "Helpdesk 1.19.0"
// block of SCHEMA_SQL (lib/db.ts); timestamps travel as ISO strings (the
// pg driver's Date is converted at the edge by lib/helpdesk/db-core), ids
// as numbers. The derived fields (sla_state, due_label, in_workflow) are
// computed by lib/helpdesk/sla and are never stored.
//
// Pure types and constants: no imports with side effects, safe in client
// components.

// --- Enumerations --------------------------------------------------------------

export const HD_STATUSES = ["new", "open", "pending", "on_hold", "solved", "closed"] as const;
export type HdStatus = (typeof HD_STATUSES)[number];

/** What an agent reads. The derived "In workflow" chip is HD_IN_WORKFLOW_LABEL. */
export const HD_STATUS_LABEL: Record<HdStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Waiting on requester",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

/** What the requester reads (pending is "Waiting on you"). */
export const HD_STATUS_LABEL_REQUESTER: Record<HdStatus, string> = {
  ...HD_STATUS_LABEL,
  pending: "Waiting on you",
};

/** The derived chip shown in place of the status while the ticket's workflow run is running or waiting. */
export const HD_IN_WORKFLOW_LABEL = "In workflow";

/** Statuses that count as "open" (in a queue, SLA clocks may run). */
export const HD_OPEN_STATUSES: readonly HdStatus[] = ["new", "open", "pending", "on_hold"];
/** Statuses that pause the SLA clock. */
export const HD_PAUSED_STATUSES: readonly HdStatus[] = ["pending", "on_hold"];

export const HD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type HdPriority = (typeof HD_PRIORITIES)[number];
export const HD_PRIORITY_LABEL: Record<HdPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const HD_SOURCES = ["portal", "email", "desk", "doc", "handbook", "space_access", "link", "workflow", "alert", "api", "recurring", "portal_external", "teams", "slack"] as const;
export type HdSource = (typeof HD_SOURCES)[number];
export const HD_SOURCE_LABEL: Record<HdSource, string> = {
  portal: "Get help",
  email: "Email",
  desk: "Desk",
  doc: "Document page",
  handbook: "Handbook policy",
  space_access: "Space access",
  link: "Quick link",
  workflow: "Workflow",
  alert: "Alert",
  api: "API",
  recurring: "Recurring schedule",
  // The customer portal for people outside the workspace (1.19.1, agent V6, lib/helpdesk/portal).
  portal_external: "Customer portal",
  // Chat apps (1.19.4, lib/helpdesk/chat): raised in Microsoft Teams or Slack.
  teams: "Microsoft Teams",
  slack: "Slack",
};

export type HdMessageKind = "public" | "internal" | "system";
/** "mcp": written through the Claude connector (1.19.1, lib/mcp/helpdesk-tools); the desk shows "via Claude". */
/** "customer_portal": written by an outside customer at /support (1.19.1, lib/helpdesk/portal); "portal" is Get help. */
/** "api": written with a helpdesk API token (1.19.4 C2, lib/helpdesk/api-v1); the desk shows "via API". */
export type HdMessageVia = "portal" | "desk" | "email" | "system" | "mcp" | "customer_portal" | "api";
export type HdTeamRole = "agent" | "lead";
export type HdAvailability = "available" | "away" | "offline";
export const HD_AVAILABILITY_LABEL: Record<HdAvailability, string> = {
  available: "Available",
  away: "Away",
  offline: "Offline",
};

/** Derived SLA state of a ticket (lib/helpdesk/sla.slaState). */
export type HdSlaState = "ok" | "warn" | "breached" | "paused" | "met";

// --- Teams ---------------------------------------------------------------------

export interface HdTeam {
  id: number;
  name: string;
  description: string;
  /** A lucide icon name ("monitor", "heart", "building"); '' = the default. */
  icon: string;
  email_alias: string;
  position: number;
  created_at: string;
}

export interface HdTeamMember {
  team_id: number;
  user_id: number;
  role: HdTeamRole;
  /** Joined from users. */
  name: string;
  email: string;
  username: string;
  availability?: HdAvailability;
}

export interface HdTeamWithMembers extends HdTeam {
  members: HdTeamMember[];
  /** 1.20.2 (GET /api/helpdesk/admin/teams, the Teams list): its live tickets that are not solved or closed. */
  open_tickets?: number;
  /** 1.20.2: the first help address mapped to the team (lib/helpdesk/mailboxes); null when none. */
  mailbox_address?: string | null;
}

// --- Request types and forms ---------------------------------------------------

export type HdFormFieldType = "choice" | "text" | "textarea" | "date" | "number" | "user" | "select" | "checkbox";

export interface HdFormOption {
  value: string;
  label: string;
  hint?: string;
}

export interface HdFormField {
  key: string;
  label: string;
  type: HdFormFieldType;
  required?: boolean;
  options?: HdFormOption[];
  /** e.g. "directory:cost_centre": prefill from the requester's directory entry. */
  default_from?: string;
  help?: string;
}

/** Answers keyed by HdFormField.key. user fields hold a user id; checkbox a boolean. */
export type HdFormAnswers = Record<string, string | number | boolean | null>;

export interface HdRequestType {
  id: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  team_id: number | null;
  category: string;
  form: HdFormField[];
  workflow_id: number | null;
  sla_priority: HdPriority;
  visibility: "all" | "groups";
  active: number;
  position: number;
  eta_label: string;
  created_at: string;
  updated_at: string;
  /** Joined: the restricted type's groups (visibility 'groups'). */
  group_ids?: number[];
  /** Joined: team name for display. */
  team_name?: string | null;
}

// --- Tickets -------------------------------------------------------------------

export interface HdAttachment {
  id: number;
  name: string;
  size: number;
  type: string;
}

/** The stored row (hd_tickets). */
export interface HdTicketRow {
  id: number;
  number: number;
  subject: string;
  requester_id: number | null;
  requester_name: string;
  requester_email: string;
  team_id: number | null;
  assignee_id: number | null;
  status: HdStatus;
  priority: HdPriority;
  category: string;
  tags: string[];
  request_type_id: number | null;
  form_answers: HdFormAnswers;
  source: HdSource;
  /** e.g. {doc_id}, {space_id}, {link_id}, {handbook_id, doc_id}. */
  source_ref: Record<string, unknown>;
  parent_ticket_id: number | null;
  workflow_run_id: number | null;
  sla_policy_id: number | null;
  first_reply_due: string | null;
  resolve_due: string | null;
  first_replied_at: string | null;
  solved_at: string | null;
  closed_at: string | null;
  sla_paused_at: string | null;
  sla_paused_ms: number;
  /** Set once by the SLA sweep when the first-reply target was missed. */
  first_reply_breached_at: string | null;
  /** Set once by the SLA sweep when the resolution target was missed. */
  resolve_breached_at: string | null;
  /** Set once when the "nearing" warning went (cleared when the due moves). */
  sla_warned_at: string | null;
  reply_token: string | null;
  csat_score: number | null;
  csat_comment: string;
  csat_at: string | null;
  created_at: string;
  updated_at: string;
  /** 1 = opened by a machine (alert or API intake, lib/helpdesk/intake): requester_id is NULL. */
  automated?: number;
  /** The intake integration that opened it. */
  integration_id?: number | null;
  /** The customer-portal contact who raised it (source portal_external, requester_id NULL; lib/helpdesk/portal). */
  portal_contact_id?: number | null;
  /** Closed as a duplicate: the ticket it was merged into (1.19.1, lib/helpdesk/merge). */
  merged_into?: number | null;
  /** Imported (1.19.1, lib/helpdesk/import): the source ('zoho' | 'csv') and its ticket id; source_ref.import_label is "Zoho #1234". */
  import_source?: string | null;
  import_ref?: string | null;
  /** In the recycle bin since (1.19.4, lib/helpdesk/recycle-bin); NULL = live. */
  deleted_at?: string | null;
  deleted_by?: number | null;
  deleted_by_name?: string;
  /** The help address the ticket came in on or is answered from (1.20.2, lib/helpdesk/mailboxes); NULL = its team's, else the default. */
  mailbox_id?: number | null;
}

/** A ticket as the desk reads it: the row plus joins and the derived SLA fields. */
export interface HdTicket extends HdTicketRow {
  team_name: string | null;
  assignee_name: string | null;
  request_type_title: string | null;
  /** The workflow run's state when there is one (running|waiting|done|cancelled|declined). */
  workflow_state: HdWorkflowRunState | null;
  /** True while the run is running or waiting: show HD_IN_WORKFLOW_LABEL. */
  in_workflow: boolean;
  sla_state: HdSlaState | null;
  /** "Reply overdue 25m", "Reply due in 1h 20m", "Resolve due tomorrow", "Paused", "Met", "" (no SLA). */
  due_label: string;
  /** The ticket's own help address and its From name (1.20.2, lib/helpdesk/mailboxes); null when it has none of its own. */
  mailbox_address?: string | null;
  mailbox_name?: string | null;
}

export interface HdMessage {
  id: number;
  ticket_id: number;
  author_id: number | null;
  author_name: string;
  author_email: string;
  kind: HdMessageKind;
  body: string;
  via: HdMessageVia;
  attachments: HdAttachment[];
  email_message_id: string | null;
  created_at: string;
  /** The team an agent's message is from ("IT · today 09:12"): the ticket's team when they are in it, else their first; null for the requester and system lines. */
  author_team_name?: string | null;
  /** Newbie reply review (lib/helpdesk/review): null = not reviewed; 'pending' waits for a lead (not sent); 'returned' sent back with a note; 'approved' sent. */
  review_state?: HdReviewState | null;
  reviewed_by?: number | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  /** 1.19.4 (C6): a feature's own internal timeline line ('share'), else null; agent-side only (lib/helpdesk/share-schema). */
  event?: string | null;
}

export type HdReviewState = "pending" | "approved" | "returned";

// --- SLA and settings ----------------------------------------------------------

export interface HdSlaPolicy {
  id: number;
  name: string;
  priority: HdPriority;
  first_reply_minutes: number;
  resolve_minutes: number;
  /** 1 = minutes count business hours only; 0 = calendar time. */
  business_hours: number;
}

export interface HdBusinessHours {
  /** IANA zone, e.g. "Europe/London". */
  timezone: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "09:00" */
  start: string;
  /** "17:30" */
  end: string;
  /** "YYYY-MM-DD" dates in the timezone. */
  holidays: string[];
  // --- Business calendars (agent L, lib/helpdesk/calendars). When `schedule`
  // is present it replaces days/start/end (which then only summarise it), and
  // `holidayRanges` add to `holidays`. Absent: the legacy single daily window.
  /** Open intervals per weekday, index 0 = Sunday … 6 = Saturday; [] = closed. */
  schedule?: HdTimeInterval[][];
  /** Closures: whole or partial days, optionally repeating every year. */
  holidayRanges?: HdHolidayRange[];
  /** The calendar these hours came from (display only). */
  calendar?: { id: number; name: string };
}

/** "09:00"–"17:30"; end "24:00" = midnight; end ≤ start = runs past midnight. */
export interface HdTimeInterval {
  start: string;
  end: string;
}

/** One closure in a calendar's local time. from/to null = the whole day. */
export interface HdHolidayRange {
  /** "YYYY-MM-DD" (with `yearly`, only the month and day count). */
  date: string;
  name: string;
  /** Closed from "HH:MM" (null = midnight). */
  from?: string | null;
  /** Closed until "HH:MM" (null = the end of the day). */
  to?: string | null;
  yearly?: boolean;
}

export const HD_SETUP_STEPS = ["teams", "hours", "email", "forms", "csat"] as const;
export type HdSetupStep = (typeof HD_SETUP_STEPS)[number];

/** The `helpdesk_settings` JSON in the settings table (lib/helpdesk/settings). */
export interface HdSettings extends HdBusinessHours {
  /** Accept inbound email from addresses that are not workspace users. */
  outside_senders: boolean;
  /** The address people forward to (display only; set by the admin). */
  inbound_address: string;
  /** The secret path segment of POST /api/helpdesk/inbound/[secret]; '' = inbound off. */
  inbound_secret: string;
  csat_enabled: boolean;
  setup_steps_done: HdSetupStep[];
  email_from_name: string;
  /** True once the starter set (or the first team) exists: the desk opens instead of /desk/setup. */
  setup_complete: boolean;
}

// --- Macros and automations (agent C) ------------------------------------------

export interface HdMacroActions {
  status?: HdStatus;
  priority?: HdPriority;
  team_id?: number;
  tags_add?: string[];
}

export interface HdMacro {
  id: number;
  title: string;
  body: string;
  actions: HdMacroActions;
  team_id: number | null;
  /** Set: a personal macro, only its owner sees it. */
  owner_id?: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type HdAutomationEvent = "ticket_created" | "ticket_updated" | "requester_message" | "sla_nearing" | "sla_breached";

export interface HdAutomationConditions {
  team_ids?: number[];
  categories?: string[];
  priorities?: HdPriority[];
  request_type_ids?: number[];
  /** Any of these words in the subject or body (case-insensitive). */
  keywords?: string[];
  sources?: HdSource[];
}

export interface HdAutomationActions {
  team_id?: number;
  assignee_id?: number;
  priority?: HdPriority;
  status?: HdStatus;
  category?: string;
  tags_add?: string[];
  internal_note?: string;
  macro_id?: number;
  /** "assignee" | "team" | {user_id}. */
  notify?: "assignee" | "team" | { user_id: number };
}

export interface HdAutomation {
  id: number;
  name: string;
  event: HdAutomationEvent;
  conditions: HdAutomationConditions;
  actions: HdAutomationActions;
  active: number;
  position: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

// --- Workflows (agent B) -------------------------------------------------------

/**
 * The approver of an approval step. `space_owner`: the "Request access"
 * workflow's approver, resolved when the step starts from the request's
 * source_ref.space_id: the space's Policy owner (spaces.policy_defaults
 * owner_user_id) when set and active, else anyone who manages space access
 * (space.manage_members, held globally).
 */
export type HdApproverDef =
  | { kind: "team"; team_id: number }
  | { kind: "manager" }
  | { kind: "user"; user_id: number }
  | { kind: "space_owner" };
export type HdDueDef = { field: string; offset_days?: number } | { after_hours: number };

/**
 * How a step's time counts (1.19.1, lib/helpdesk/business-waits-shared): a
 * Wait's until, a task's due, an approval's reminder. Absent = calendar
 * time, as before (definitions written earlier, and runs pinned to them,
 * are unchanged). "business": offsets in days are business days and hours
 * are business hours, in the calendar of count_team_id, else the task's
 * team (a task) or the request type's team (a wait or an approval).
 */
export interface HdCountDef {
  count?: "business";
  count_team_id?: number;
}

export interface HdApprovalStepDef {
  key: string;
  kind: "approval";
  title: string;
  approver: HdApproverDef;
  on_decline: "close" | "continue";
  remind_after_hours?: number;
  /** How the reminder delay counts (1.19.1, HdCountDef). */
  count?: HdCountDef["count"];
  count_team_id?: number;
}

export interface HdTaskStepDef {
  key: string;
  kind: "task";
  title: string;
  team_id: number;
  due?: HdDueDef;
  /** How the due offset counts (1.19.1, HdCountDef). */
  count?: HdCountDef["count"];
  count_team_id?: number;
  description?: string;
}

export interface HdParallelStepDef {
  key: string;
  kind: "parallel";
  title?: string;
  steps: HdTaskStepDef[];
}

export interface HdWaitStepDef {
  key: string;
  kind: "wait";
  title: string;
  /** offset_days (1.19.1): days before (negative) or after the form date. */
  until: { field: string; offset_days?: number } | { after_hours: number };
  /** How the wait counts (1.19.1, HdCountDef). */
  count?: HdCountDef["count"];
  count_team_id?: number;
}

export interface HdNotifyStepDef {
  key: string;
  kind: "notify";
  title: string;
  to: "requester" | { user_id: number } | { team_id: number };
  /** Markdown with {{placeholders}}. */
  message: string;
}

export interface HdFinishStepDef {
  key: string;
  kind: "finish";
  title: string;
  csat?: boolean;
}

/** A step of a workflow definition (the design-time shape). */
export type HdWorkflowStep =
  | HdApprovalStepDef
  | HdTaskStepDef
  | HdParallelStepDef
  | HdWaitStepDef
  | HdNotifyStepDef
  | HdFinishStepDef;
export type HdWorkflowStepKind = HdWorkflowStep["kind"];

export interface HdWorkflowDefinition {
  trigger: { request_type_id?: number | null };
  steps: HdWorkflowStep[];
}

export interface HdWorkflow {
  id: number;
  slug: string;
  title: string;
  description: string;
  /** The published definition (what new runs pin). */
  definition: HdWorkflowDefinition;
  /** Unpublished edits; null = none. */
  draft: HdWorkflowDefinition | null;
  published: number;
  version: number;
  created_at: string;
  updated_at: string;
}

/** 'blocked': a task could not be done and the coordinating team decides (retry, skip, cancel); still "In workflow". */
export type HdWorkflowRunState = "running" | "waiting" | "blocked" | "done" | "cancelled" | "declined";
/** Run states that show the "In workflow" chip and count in the workflow view. */
export const HD_ACTIVE_RUN_STATES: readonly HdWorkflowRunState[] = ["running", "waiting", "blocked"];

export interface HdWorkflowRun {
  id: number;
  workflow_id: number | null;
  workflow_version: number;
  ticket_id: number;
  state: HdWorkflowRunState;
  /** Runtime cursor; holds the pinned definition snapshot under `definition`. */
  current: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
}

export type HdRunStepKind = "approval" | "task" | "wait" | "notify" | "finish";
/** 'failed': a task recorded "can't be done". */
export type HdRunStepState = "pending" | "active" | "done" | "declined" | "skipped" | "cancelled" | "failed";

/** A runtime step (hd_workflow_steps). */
export interface HdRunStep {
  id: number;
  run_id: number;
  step_key: string;
  kind: HdRunStepKind;
  state: HdRunStepState;
  task_ticket_id: number | null;
  wait_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown>;
}

/** `cancelled`: the run stopped (the request was solved or closed by hand) before anyone decided. */
export type HdApprovalDecision = "pending" | "approved" | "declined" | "cancelled";

/**
 * Who a stored approval row waits for:
 *   user     approver_user_id
 *   manager  approver_user_id (the requester's manager from the directory),
 *            or, when nobody was found, approver_user_id NULL and
 *            approver_team_id = the request type's team: its leads decide
 *            (any member when the team has no leads)
 *   team     any one member of approver_team_id
 *   space    nobody named: anyone holding space.manage_members globally
 * The rule lives in lib/helpdesk/approvals (isApproverFor); never re-derive it.
 */
export type HdApproverKind = "team" | "manager" | "user" | "space";

export interface HdApproval {
  id: number;
  run_id: number;
  step_id: number;
  ticket_id: number;
  approver_kind: HdApproverKind;
  approver_team_id: number | null;
  approver_user_id: number | null;
  decided_by: number | null;
  decided_by_name: string;
  decision: HdApprovalDecision;
  note: string;
  reminded_at: string | null;
  created_at: string;
  decided_at: string | null;
}

/** An approval as the approver reads it (GET /api/helpdesk/approvals, /approvals/[id]). */
export interface HdApprovalCard {
  id: number;
  decision: HdApprovalDecision;
  /** The step's title ("Your manager approves"). */
  step_title: string;
  /** Why this person is asked: "your direct report", "for HR", "you are named", "you manage space access", "standing in for the manager". */
  reason: string;
  ticket_number: number;
  subject: string;
  request_type_title: string | null;
  requester_id: number | null;
  requester_name: string;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string;
  note: string;
  /** The form's answers, labelled, in form order (what the approver decides on). */
  answers: { key: string; label: string; value: string }[];
  /** The request's opening message (public), if any. */
  body: string;
  /** May the caller decide it now (pending, theirs, not their own request, run still going). */
  can_decide: boolean;
}

/**
 * One line of "What happens next" on a request form (GET
 * /api/helpdesk/request-types/[slug]): the request type's workflow as the
 * requester will live it, with the approver already resolved ("Sara Haddad
 * approves" / "Your manager, from the directory").
 */
export interface HdNextStep {
  kind: HdRunStepKind | "reply";
  /** "Sara Haddad approves", "IT orders and sets it up", "Collect it from the IT desk". */
  title: string;
  /** "Your manager, from the directory", "Usually 2 to 3 days", "We'll tell you when it's ready". */
  detail: string;
}

/** GET /api/helpdesk/request-types/[slug]. */
export interface HdRequestTypeForm {
  request_type: HdRequestType;
  next_steps?: HdNextStep[];
  /** Answers prefilled from the requester's directory entry (fields with default_from). */
  defaults?: HdFormAnswers;
}

/** One line of the progress tracker (request detail and the desk's ticket side panel). */
export interface HdProgressStep {
  key: string;
  kind: HdRunStepKind;
  title: string;
  state: HdRunStepState;
  /** "Approved by Sara Haddad", "IT · due Fri 14 Nov", "Until Mon 17 Nov". */
  detail: string;
  started_at: string | null;
  finished_at: string | null;
  /** Parallel group members (tasks), when this line is a group. */
  children?: HdProgressStep[];
  /** Child ticket number of a task (agents only; omitted for requesters). */
  task_ticket_number?: number | null;
  // --- Multi-team details (agents read all of it; requesters no notes of failures).
  team_id?: number | null;
  team_name?: string | null;
  assignee_name?: string | null;
  outcome?: "done" | "cant_do" | null;
  note?: string;
  outputs?: { key: string; label: string; value: string }[];
  handoff_note?: string;
  /** Why it was skipped, or how it was routed. */
  reason?: string;
  /** Who acted on it (approver, the person who finished the task, who skipped it), for "4 Nov · Sara Haddad". */
  actor?: string | null;
  /** When they acted (decided, finished, skipped). */
  acted_at?: string | null;
  transfers?: HdTaskTransfer[];
}

/** B's tracker (lib/helpdesk/engine getWorkflowProgress). */
export interface HdWorkflowProgress {
  run_id: number;
  workflow_title: string;
  state: HdWorkflowRunState;
  steps: HdProgressStep[];
  /** While blocked: which step and why. */
  blocked?: { step_key: string; title: string; note: string; at: string } | null;
}

// --- Views and lists -----------------------------------------------------------

export type HdNamedView = "mine" | "unassigned" | "open" | "overdue" | "workflow" | "waiting" | "solved_week";
export type HdView = HdNamedView | { team_id: number };
export const HD_VIEW_LABEL: Record<HdNamedView, string> = {
  mine: "My open",
  unassigned: "Unassigned",
  open: "All open",
  overdue: "Overdue",
  workflow: "In workflow",
  waiting: "Waiting",
  solved_week: "Solved this week",
};

export type HdTicketSort = "updated" | "created" | "due" | "priority" | "number";

/** One row of the desk's queue table. */
export interface HdTicketListRow {
  id: number;
  number: number;
  subject: string;
  requester_id: number | null;
  requester_name: string;
  team_id: number | null;
  team_name: string | null;
  assignee_id: number | null;
  assignee_name: string | null;
  status: HdStatus;
  priority: HdPriority;
  category: string;
  tags: string[];
  source: HdSource;
  parent_ticket_id: number | null;
  in_workflow: boolean;
  sla_state: HdSlaState | null;
  due_label: string;
  /** The due the "Due" column sorts by: first reply until met, then resolution. */
  next_due: string | null;
  created_at: string;
  updated_at: string;
  /** The requester is a VIP (lib/helpdesk/contact-cards vipMap), and why ("Leadership"). */
  requester_vip?: boolean;
  requester_vip_reason?: string;
  /** 1 = opened by an alert or API intake ("Automated · Grafana"). */
  automated?: number;
  /** Automated tickets only: the integration that opened it ({integration_kind, integration_name}); {} otherwise. */
  source_ref?: Record<string, unknown>;
  /** Why a running clock is stopped now ("Paused for Christmas Day, resumes Mon 09:00"), lib/helpdesk/calendars clockNotes. */
  clock_note?: string | null;
  /** 1.19.2: a major incident's own ticket, or one linked to it (lib/helpdesk/incidents incidentChips). */
  incident?: import("./incidents-shared").IncidentChip;
  /** 1.20.2: the help address the ticket came in on (lib/helpdesk/mailboxes); null when it has none of its own. */
  mailbox_id?: number | null;
  mailbox_address?: string | null;
  mailbox_name?: string | null;
}

export interface HdCounts {
  views: Record<HdNamedView, number>;
  teams: { team_id: number; name: string; icon: string; open: number }[];
  /** Headline tiles. */
  headline: {
    open: number;
    overdue: number;
    /** Median first-reply time over the last 30 days, minutes; null = no data. */
    first_reply_median_minutes: number | null;
    /** Percentage 0–100 of good CSAT answers (4–5) over the last 30 days; null = none. */
    csat_percent: number | null;
  };
  /** Approvals waiting for the caller (B's data; 0 when B's module is absent). */
  approvals_waiting: number;
  /** Newbies' replies waiting for the caller's review (lib/helpdesk/review; 0 without replies.review). */
  reviews_pending: number;
}

// --- Detail views --------------------------------------------------------------

export interface HdRequesterCard {
  user_id: number | null;
  name: string;
  email: string;
  title: string;
  department: string;
  /** "Reports to" name from the directory; '' = unknown. */
  manager: string;
  office: string;
  presence?: string | null;
  /** Earlier tickets by the same requester. */
  earlier_count: number;
  last_ticket_at: string | null;
  /** The configurable contact card (agent O, lib/helpdesk/contact-cards), as this agent may see it. */
  card?: import("./contact-cards-shared").HdContactCard;
}

export interface HdSuggestedArticle {
  doc_id: number;
  title: string;
  space_name: string;
  read_minutes: number;
  url: string;
}

/** GET /api/helpdesk/tickets/[number] (agents). */
export interface HdTicketDetail {
  ticket: HdTicket;
  messages: HdMessage[];
  requester: HdRequesterCard;
  /** The request type's form, so answers render with their labels. */
  form: HdFormField[];
  sla: {
    policy: HdSlaPolicy | null;
    first_reply: { due: string | null; met_at: string | null; state: HdSlaState | null; label: string };
    resolve: { due: string | null; met_at: string | null; state: HdSlaState | null; label: string };
    /** 0–100: how much of the resolution window has elapsed (business time). */
    resolve_elapsed_percent: number | null;
  };
  /** B's tracker (lib/helpdesk/engine getWorkflowProgress), with the multi-team details. */
  workflow: HdWorkflowProgress | null;
  /** Child tickets (workflow tasks) of this request. */
  children: HdTicketListRow[];
  /** `deleted` (1.19.4): the request is in the recycle bin: "a deleted ticket", without its number or subject. */
  parent: { number: number; subject: string; deleted?: boolean } | null;
  suggested_articles: HdSuggestedArticle[];
  /** What the caller may do. */
  can_work: boolean;
  /** Why a running clock is stopped now (lib/helpdesk/calendars clockNote), or null. */
  clock_note?: string | null;
  /** The SLA tooltip's source line: "IT team target: first reply in 2 business hours" (slaTargetNote). */
  sla_target_note?: string;
  /** Merges in and out (1.19.1, lib/helpdesk/merge mergeInfo). */
  merge?: import("./merge-shared").HdMergeInfo;
  /**
   * 1.20.2 (lib/helpdesk/mailboxes): the address mail about this ticket goes
   * out under (`own`: it is the ticket's own, the one it came in on or an
   * agent chose; otherwise its team's or the default stands in). Null when no
   * address is listed. `mailboxes` are the "Answer from" choices, sent only
   * while more than one is listed; `can_change_mailbox` whether this agent
   * may choose.
   */
  mailbox?: (import("./mailboxes-shared").HdTicketMailbox & { own: boolean }) | null;
  mailboxes?: import("./mailboxes-shared").HdMailboxOption[];
  can_change_mailbox?: boolean;
}

/** A requester-safe ticket: no internal fields (tags, assignee ids, SLA internals, tokens). */
export interface HdRequestSummary {
  number: number;
  subject: string;
  status: HdStatus;
  /** HD_STATUS_LABEL_REQUESTER, or HD_IN_WORKFLOW_LABEL. */
  status_label: string;
  in_workflow: boolean;
  team_name: string | null;
  request_type_title: string | null;
  source: HdSource;
  created_at: string;
  updated_at: string;
  solved_at: string | null;
  csat_score: number | null;
  /** "Matthew replied 2m ago" style hint data: who wrote the latest public message. */
  last_public_author: string | null;
  last_public_at: string | null;
  /** The active workflow step: "step 3 of 4: IT is setting it up" (null when not in a workflow). */
  current_step?: { index: number; total: number; title: string; team_name?: string | null } | null;
}

/** Extra hints on a requester's list row (merged into HdRequestSummary; kept as an alias for agent E). */
export type HdRequestSummaryExtras = Pick<HdRequestSummary, "current_step">;

/** GET /api/helpdesk/requests/[number] (requester, approver). */
export interface HdRequestDetail extends HdRequestSummary {
  requester_name: string;
  form: HdFormField[];
  form_answers: HdFormAnswers;
  /** Public and system messages only, never internal notes. */
  messages: HdMessage[];
  /** The form's answers, labelled and readable (a person field as the person's name), in form order. */
  answers: { key: string; label: string; value: string }[];
  /** B's tracker (lib/helpdesk/engine getWorkflowProgress), with the multi-team details. */
  workflow: HdWorkflowProgress | null;
  csat_comment: string;
  /** May the caller post a reply (the requester; not an approver-only viewer). */
  can_reply: boolean;
  /** May the caller rate it (requester, solved, CSAT on, not rated). */
  can_rate: boolean;
  /** The caller's own pending approval on this request, if any. */
  my_approval: { id: number; title: string } | null;
}

// --- Reports (agent C) ---------------------------------------------------------

export interface HdReportSummary {
  from: string;
  to: string;
  created: number;
  solved: number;
  first_reply_median_minutes: number | null;
  resolution_median_minutes: number | null;
  /** 0–100, of tickets with an SLA whose targets fell in range. */
  sla_met_percent: number | null;
  csat_percent: number | null;
  /** Mean score 1–5 of the answers in range; null = none. */
  csat_average?: number | null;
  csat_responses: number;
  /** One point per day (or week, for long ranges). */
  series: { date: string; created: number; solved: number }[];
  by_team: { team_id: number | null; name: string; created: number; solved: number; sla_met_percent: number | null }[];
  by_agent: { user_id: number; name: string; solved: number; first_reply_median_minutes: number | null; csat_percent: number | null }[];
  by_category: { category: string; created: number; solved: number }[];
}

// --- Web push and notification preferences (agent F) ---------------------------

export interface HdPushSubscription {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  label: string;
  platform: string;
  created_at: string;
  last_used_at: string | null;
  last_error: string;
}

export interface HdNotifyPrefs {
  user_id: number;
  /** Shape owned by lib/helpdesk/notify-prefs. */
  prefs: Record<string, unknown>;
  updated_at: string;
}

// --- API inputs ----------------------------------------------------------------

export interface HdCreateRequestInput {
  request_type_id?: number | null;
  subject: string;
  body: string;
  answers?: HdFormAnswers;
  source?: HdSource;
  source_ref?: Record<string, unknown>;
  attachments?: HdAttachment[];
}

export interface HdTicketPatch {
  status?: HdStatus;
  priority?: HdPriority;
  team_id?: number | null;
  assignee_id?: number | null;
  category?: string;
  tags?: string[];
  subject?: string;
}

// --- Multi-team workflows (agent B, 1.19.0) ------------------------------------

export const HD_CONDITION_OPS = ["equals", "not_equals", "in", "contains", "is_empty", "not_empty", "is_true", "is_false"] as const;
export type HdConditionOp = (typeof HD_CONDITION_OPS)[number];

/** The requester's directory facts a condition or a route may read. */
export const HD_REQUESTER_FIELDS = ["department", "office", "location", "title", "manager"] as const;
export type HdRequesterField = (typeof HD_REQUESTER_FIELDS)[number];

/**
 * One test. `field` is a form key (answer), a requester field
 * (HD_REQUESTER_FIELDS, or a custom directory field key), or
 * "<step_key>.<output_key>" (output: what an earlier task recorded).
 * `value` is compared as text, case-insensitively; yes/no answers read as
 * "yes"/"no" (and "true"/"false").
 */
export interface HdConditionRule {
  source: "answer" | "requester" | "output";
  field: string;
  op: HdConditionOp;
  value?: string | string[];
}

/** A step runs only when this holds; otherwise it is skipped with a note on the request. */
export interface HdStepCondition {
  match: "all" | "any";
  rules: HdConditionRule[];
}

/** Pick the task's team when it starts: the first map entry whose value equals the field's; else fallback; else the task's team_id. */
export interface HdTaskRoute {
  source: "answer" | "requester";
  field: string;
  map: { value: string; team_id: number }[];
  fallback_team_id?: number | null;
}

export type HdTaskOutputType = "text" | "number" | "date" | "select" | "yes_no";

/** What a task team records when it finishes (a hand-off to later steps). */
export interface HdTaskOutputDef {
  key: string;
  label: string;
  type: HdTaskOutputType;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface HdStepExtrasB {
  when?: HdStepCondition;
}

export type HdTaskStepDefB = HdTaskStepDef &
  HdStepExtrasB & {
    route?: HdTaskRoute;
    /** "Can't be done": stop the run for the coordinating team (default), or carry on. */
    on_cant_do?: "stop" | "continue";
    outputs?: HdTaskOutputDef[];
    /** 1.19.2: checklist templates added to the task's ticket when it starts (lib/helpdesk/checklists, agent W3). */
    checklist_ids?: number[];
  };

export type HdParallelStepDefB = Omit<HdParallelStepDef, "steps"> & HdStepExtrasB & { steps: HdTaskStepDefB[] };

export type HdWorkflowStepB =
  | ((HdApprovalStepDef | HdWaitStepDef | HdNotifyStepDef | HdFinishStepDef) & HdStepExtrasB)
  | HdTaskStepDefB
  | HdParallelStepDefB;

export interface HdWorkflowDefinitionB extends Omit<HdWorkflowDefinition, "steps"> {
  steps: HdWorkflowStepB[];
}

export interface HdTaskTransfer {
  from_team_id: number | null;
  from_team_name: string | null;
  to_team_id: number | null;
  to_team_name: string | null;
  at: string;
  /** Who moved it (recorded from 1.19.0 on; absent on older entries and engine-made moves). */
  actor_id?: number | null;
  actor_name?: string | null;
  /** Why, when the mover said. */
  note?: string;
}

/** A required hand-off field still empty: the 409/400 `missing` of a task's solve or outcome. */
export interface HdMissingOutput {
  key: string;
  label: string;
}

export type HdOutputValue = string | number | boolean | null;

/** POST /api/helpdesk/tickets/[number]/task-outcome. */
export interface HdTaskOutcomeInput {
  outcome: "done" | "cant_do";
  /** Required for cant_do. */
  note?: string;
  outputs?: Record<string, HdOutputValue>;
  handoff_note?: string;
}

export interface HdHandoff {
  step_key: string;
  title: string;
  team_name: string | null;
  outputs: { key: string; label: string; value: string }[];
  note: string;
  at: string | null;
}

/** The task a workflow context was opened from, as the run's pinned definition has it. */
export interface HdWorkflowContextTask {
  step_key: string;
  title: string;
  /** Hand-off fields asked when it is marked done. */
  outputs: HdTaskOutputDef[];
  /** "Can't be done": the run stops for the coordinating team, or carries on. */
  on_cant_do: "stop" | "continue";
  /** The team that takes the request back (the request type's team, else the request's). */
  coordinating_team: { id: number; name: string } | null;
}

/** GET /api/helpdesk/tickets/[number]/workflow-context: the request as a task team reads it. */
export interface HdWorkflowContext {
  request: { number: number; subject: string; status: HdStatus; request_type_title: string | null; created_at: string };
  requester: HdRequesterCard;
  form: HdFormField[];
  form_answers: HdFormAnswers;
  /** Public messages only: no internal notes, no replies waiting for review. */
  messages: HdMessage[];
  workflow: HdWorkflowProgress | null;
  handoffs: HdHandoff[];
  siblings: { number: number; subject: string; team_name: string | null; status: HdStatus; step_key: string; can_open: boolean }[];
  /** The task ticket's own step (null when the context was opened from the request itself). */
  task: HdWorkflowContextTask | null;
  /** Why the caller sees it: their teams with a task on it; and whether they may work the request itself. */
  viewer: { team_names: string[]; can_work_request: boolean };
}

/** Aliases kept from lib/helpdesk/types-b (merged here). */
export type HdApproverDefB = HdApproverDef;
export type HdApproverKindB = HdApproverKind;
export type HdApprovalDecisionB = HdApprovalDecision;
export type HdWorkflowRunStateB = HdWorkflowRunState;
export type HdRunStepStateB = HdRunStepState;
export type HdProgressStepB = HdProgressStep;
export type HdWorkflowProgressB = HdWorkflowProgress;
