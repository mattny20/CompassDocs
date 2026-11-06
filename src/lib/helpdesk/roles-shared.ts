// Helpdesk 1.19.0: the desk role ladder as data and pure functions (agent
// J). The desk's Agents and Roles pages (client) and lib/helpdesk/roles
// (server) share this module, so the matrix an admin sees and the rules the
// server applies cannot drift. No server imports here.
//
//   Newbie     their teams' queues; public replies held for a lead's review
//   Agent      replies directly, changes status/priority, transfers
//   Team lead  assigns within their teams, reviews newbies, team macros and
//              reports, adds and removes newbies and agents in their teams
//   Manager    every team, every report, the helpdesk's configuration,
//              assigns roles up to Team lead
//   Admin      everything (always; the matrix cannot take anything away)
//
// The matrix is stored as overrides (setting `helpdesk_role_caps`): a
// complete capability list per customised role; a role without an entry
// uses its defaults. `checkMatrix()` holds the invariants every write must
// pass.

export const HD_ROLES = ["newbie", "agent", "team_lead", "manager", "admin"] as const;
export type HdRole = (typeof HD_ROLES)[number];

export const HD_ROLE_LABEL: Record<HdRole, string> = {
  newbie: "Newbie",
  agent: "Agent",
  team_lead: "Team lead",
  manager: "Manager",
  admin: "Admin",
};

export const HD_ROLE_DESCRIPTION: Record<HdRole, string> = {
  newbie: "Works their teams' queues. Public replies wait for a team lead's review before they are sent.",
  agent: "Replies directly, changes status and priority, and transfers tickets in their teams.",
  team_lead: "An agent who also assigns work, reviews newbies' replies and manages the people in their teams.",
  manager: "Works every team, reads every report and runs the helpdesk's configuration.",
  admin: "Everything, including email channels, templates, settings and this matrix. Replies directly.",
};

/** The ladder: a higher rank outranks a lower one. */
export const HD_ROLE_RANK: Record<HdRole, number> = { newbie: 0, agent: 1, team_lead: 2, manager: 3, admin: 4 };

export function isHdRole(v: unknown): v is HdRole {
  return typeof v === "string" && (HD_ROLES as readonly string[]).includes(v);
}

/** hd_team_members.role for a desk role (A's leadTeamIds and B's approver fallback read it). */
export function teamRoleForDeskRole(role: HdRole): "agent" | "lead" {
  return role === "team_lead" ? "lead" : "agent";
}

// --- Capabilities --------------------------------------------------------------

export const HD_CAP_SECTIONS = ["tickets", "replies", "macros", "reports", "people", "configuration"] as const;
export type HdCapSection = (typeof HD_CAP_SECTIONS)[number];

export const HD_CAP_SECTION_LABEL: Record<HdCapSection, string> = {
  tickets: "Tickets",
  replies: "Replies",
  macros: "Macros",
  reports: "Reports",
  people: "People and teams",
  configuration: "Configuration",
};

interface CapInfo {
  label: string;
  hint: string;
  section: HdCapSection;
}

/** Every desk capability, in the order the matrix shows them. */
export const HD_CAPABILITIES = {
  "tickets.view_team": { section: "tickets", label: "See their teams' queues", hint: "Tickets of the teams they belong to. Tickets assigned to them always show" },
  "tickets.view_all": { section: "tickets", label: "See every team's tickets", hint: "All queues, whichever teams they belong to" },
  "tickets.assign_self": { section: "tickets", label: "Take a ticket", hint: "Assign a ticket to themselves" },
  "tickets.assign_team": { section: "tickets", label: "Assign within their teams", hint: "Assign their teams' tickets to anyone in the team" },
  "tickets.assign_any": { section: "tickets", label: "Assign to anyone", hint: "Assign any ticket to any agent" },
  "tickets.change_status": { section: "tickets", label: "Change status", hint: "Mark tickets waiting, on hold, solved or closed" },
  "tickets.change_priority": { section: "tickets", label: "Change priority", hint: "Raise or lower a ticket's priority" },
  "tickets.transfer_team": { section: "tickets", label: "Transfer to another team", hint: "Move a ticket to a different team's queue" },
  // "tickets.merge" and "tickets.bulk" arrive with merging and bulk actions
  // (1.19.1). Until then they are not capabilities: a stored override that
  // names them is dropped on read (resolveMatrix keeps only known keys).
  "tickets.sla_override": { section: "tickets", label: "Override a ticket's SLA", hint: "Change the due times of one ticket" },
  "tickets.export": { section: "tickets", label: "Export tickets", hint: "Download tickets and reports as CSV" },
  "tickets.delete": { section: "tickets", label: "Delete tickets", hint: "Remove a ticket and its conversation for good" },
  "tickets.reply_public": { section: "replies", label: "Reply to the requester", hint: "Public replies are sent straight away" },
  "tickets.reply_needs_review": { section: "replies", label: "Reply after review", hint: "Public replies wait for a team lead to approve them" },
  "tickets.internal_note": { section: "replies", label: "Add internal notes", hint: "Notes only agents see" },
  "replies.review": { section: "replies", label: "Review newbies' replies", hint: "Approve, edit or return replies held for review" },
  "macros.use": { section: "macros", label: "Use macros", hint: "Apply canned replies" },
  "macros.manage_personal": { section: "macros", label: "Personal macros", hint: "Create and edit their own macros" },
  "macros.manage_team": { section: "macros", label: "Team macros", hint: "Create and edit macros for their teams" },
  "macros.manage_all": { section: "macros", label: "Everyone's macros", hint: "Create and edit macros for every team" },
  "reports.own": { section: "reports", label: "Their own stats", hint: "Their tickets, replies and satisfaction" },
  "reports.team": { section: "reports", label: "Team reports", hint: "Reports for the teams they belong to" },
  "reports.all": { section: "reports", label: "All reports", hint: "Reports across every team" },
  "agents.manage_team": { section: "people", label: "Manage people in their teams", hint: "Add and remove newbies and agents in their teams" },
  "agents.assign_roles": { section: "people", label: "Assign desk roles", hint: "Give people a desk role below their own" },
  "teams.manage": { section: "people", label: "Manage teams", hint: "Create, rename and delete teams and their members" },
  "sla.manage": { section: "configuration", label: "SLA and business hours", hint: "Targets per priority and working hours" },
  "automations.manage": { section: "configuration", label: "Automations", hint: "When/if/then rules" },
  "request_types.manage": { section: "configuration", label: "Request types", hint: "The forms people use in Get help" },
  "workflows.manage": { section: "configuration", label: "Workflows", hint: "Approvals, tasks and waits behind request types" },
  "csat.manage": { section: "configuration", label: "Satisfaction survey", hint: "Turn the survey on solve on or off" },
  "channels.manage": { section: "configuration", label: "Email channel", hint: "Inbound email address and outside senders" },
  "templates.manage": { section: "configuration", label: "Email templates", hint: "The helpdesk's email wording" },
  "settings.manage": { section: "configuration", label: "Helpdesk settings", hint: "Setup, starter set and everything else" },
  "roles.manage": { section: "configuration", label: "Roles and capabilities", hint: "This matrix" },
} as const satisfies Record<string, CapInfo>;

export type HdCap = keyof typeof HD_CAPABILITIES;
export const HD_CAP_KEYS = Object.keys(HD_CAPABILITIES) as HdCap[];

export function isHdCap(v: unknown): v is HdCap {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HD_CAPABILITIES, v);
}

/**
 * Team-scoped capabilities and the capability that lifts the scope. With
 * `{ teamId }`, hdCan admits a scoped capability only in a team the person
 * belongs to, unless they also hold the lifting one.
 */
export const HD_CAP_SCOPE: Partial<Record<HdCap, HdCap>> = {
  "tickets.view_team": "tickets.view_all",
  "tickets.assign_self": "tickets.view_all",
  "tickets.assign_team": "tickets.view_all",
  "tickets.change_status": "tickets.view_all",
  "tickets.change_priority": "tickets.view_all",
  "tickets.transfer_team": "tickets.view_all",
  "tickets.sla_override": "tickets.view_all",
  "tickets.reply_public": "tickets.view_all",
  "tickets.reply_needs_review": "tickets.view_all",
  "tickets.internal_note": "tickets.view_all",
  "replies.review": "tickets.view_all",
  "macros.use": "tickets.view_all",
  "macros.manage_team": "macros.manage_all",
  "reports.team": "reports.all",
  "agents.manage_team": "teams.manage",
};

/** Capabilities only a Manager or Admin may hold. */
export const HD_MANAGER_ONLY_CAPS: readonly HdCap[] = ["roles.manage", "agents.assign_roles"];

/** Pairs a role holds at most one of. */
export const HD_EXCLUSIVE_CAPS: readonly [HdCap, HdCap][] = [["tickets.reply_public", "tickets.reply_needs_review"]];

/**
 * Admin's column: every capability except tickets.reply_needs_review, which
 * is a restriction (hold public replies for review), not a power, and is
 * exclusive with tickets.reply_public. Admin replies directly.
 */
export const HD_ADMIN_CAPS: readonly HdCap[] = HD_CAP_KEYS.filter((c) => c !== "tickets.reply_needs_review");

/**
 * Capabilities an editor may grant or remove without holding them, because
 * they hold the stronger one: replying after review is a lesser form of
 * replying directly.
 */
const HD_GRANT_COVERED_BY: Partial<Record<HdCap, HdCap>> = { "tickets.reply_needs_review": "tickets.reply_public" };

/** May an editor holding `editorCaps` grant or remove `cap` on a role? */
function editorCovers(editorCaps: readonly HdCap[], cap: HdCap): boolean {
  if (editorCaps.includes(cap)) return true;
  const via = HD_GRANT_COVERED_BY[cap];
  return Boolean(via && editorCaps.includes(via));
}

// --- Defaults ----------------------------------------------------------------------

const NEWBIE: HdCap[] = [
  "tickets.view_team",
  "tickets.reply_needs_review",
  "tickets.internal_note",
  "tickets.assign_self",
  "macros.use",
  "reports.own",
];
const AGENT: HdCap[] = [
  ...NEWBIE.filter((c) => c !== "tickets.reply_needs_review"),
  "tickets.reply_public",
  "tickets.change_status",
  "tickets.change_priority",
  "tickets.transfer_team",
  "macros.manage_personal",
];
const TEAM_LEAD: HdCap[] = [
  ...AGENT,
  "tickets.assign_team",
  "replies.review",
  "macros.manage_team",
  "reports.team",
  "agents.manage_team",
  "tickets.sla_override",
];
const MANAGER: HdCap[] = [
  ...TEAM_LEAD,
  "tickets.view_all",
  "tickets.assign_any",
  "tickets.export",
  "reports.all",
  "sla.manage",
  "automations.manage",
  "macros.manage_all",
  "request_types.manage",
  "workflows.manage",
  "csat.manage",
  "teams.manage",
  "agents.assign_roles",
];

export type HdRoleMatrix = Record<HdRole, HdCap[]>;

function ordered(caps: Iterable<HdCap>): HdCap[] {
  const set = new Set(caps);
  return HD_CAP_KEYS.filter((k) => set.has(k));
}

export const HD_DEFAULT_MATRIX: HdRoleMatrix = {
  newbie: ordered(NEWBIE),
  agent: ordered(AGENT),
  team_lead: ordered(TEAM_LEAD),
  manager: ordered(MANAGER),
  admin: [...HD_ADMIN_CAPS],
};

/** Overrides as stored: a full capability list per customised role (never admin). */
export type HdRoleOverrides = Partial<Record<Exclude<HdRole, "admin">, HdCap[]>>;

/** Lay stored overrides over the defaults. Unknown keys are dropped; Admin is always everything (HD_ADMIN_CAPS). Never throws. */
export function resolveMatrix(raw: unknown): HdRoleMatrix {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...HD_DEFAULT_MATRIX };
  for (const r of HD_ROLES) {
    if (r === "admin") continue;
    const list = v[r];
    if (!Array.isArray(list)) continue;
    let caps = ordered(list.filter(isHdCap));
    // Invariants hold on read too, whatever was stored.
    if (r !== "manager") caps = caps.filter((c) => !HD_MANAGER_ONLY_CAPS.includes(c));
    for (const [a, b] of HD_EXCLUSIVE_CAPS) if (caps.includes(a) && caps.includes(b)) caps = caps.filter((c) => c !== b);
    out[r] = caps;
  }
  out.admin = [...HD_ADMIN_CAPS];
  return out;
}

/** The stored form of a matrix: only the roles that differ from their defaults. */
export function toOverrides(m: HdRoleMatrix): HdRoleOverrides {
  const out: HdRoleOverrides = {};
  for (const r of HD_ROLES) {
    if (r === "admin") continue;
    const a = ordered(m[r]);
    const d = HD_DEFAULT_MATRIX[r];
    if (a.length !== d.length || a.some((c, i) => c !== d[i])) out[r] = a;
  }
  return out;
}

/**
 * Why `role` may not hold `cap` whatever the editor wants, or null. The
 * Roles page shows the reason on the disabled checkbox.
 */
export function capForbiddenReason(role: HdRole, cap: HdCap): string | null {
  if (role === "admin" && cap === "tickets.reply_needs_review") return "Admin replies directly, never after review.";
  if (role === "admin") return "Admin always has every capability.";
  if (HD_MANAGER_ONLY_CAPS.includes(cap) && HD_ROLE_RANK[role] < HD_ROLE_RANK.manager) return "Only Managers and Admins can hold this.";
  return null;
}

/**
 * Why `editor` (holding `editorCaps`, of rank `editorRole`) may not change
 * `role`'s column, or null. Admins edit every column but their own (locked
 * on); everyone else only roles below their own, and only capabilities they
 * hold themselves.
 */
export function columnLockedReason(role: HdRole, editorRole: HdRole | null): string | null {
  if (role === "admin") return "Admin always has every capability.";
  if (!editorRole) return "You can't change desk roles.";
  if (editorRole !== "admin" && HD_ROLE_RANK[role] >= HD_ROLE_RANK[editorRole]) return "You can only change roles below your own.";
  return null;
}

export function cellLockedReason(role: HdRole, cap: HdCap, editorRole: HdRole | null, editorCaps: readonly HdCap[]): string | null {
  return (
    capForbiddenReason(role, cap) ??
    columnLockedReason(role, editorRole) ??
    (editorCovers(editorCaps, cap) ? null : "You can't grant a capability you don't have.")
  );
}

/**
 * Validate a proposed matrix against the current one, for this editor.
 * Returns the clean matrix, or the first problem as a sentence.
 */
export function checkMatrix(
  proposed: unknown,
  current: HdRoleMatrix,
  editor: { role: HdRole | null; caps: readonly HdCap[] }
): { ok: true; matrix: HdRoleMatrix; changed: HdRole[] } | { ok: false; error: string } {
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) return { ok: false, error: "Send the matrix as an object of role → capabilities." };
  const p = proposed as Record<string, unknown>;
  const next: HdRoleMatrix = { ...current, admin: [...HD_ADMIN_CAPS] };
  const changed: HdRole[] = [];
  for (const key of Object.keys(p)) {
    if (!isHdRole(key)) return { ok: false, error: `Unknown role "${key.slice(0, 40)}".` };
  }
  for (const r of HD_ROLES) {
    if (r === "admin" || p[r] === undefined) continue;
    const list = p[r];
    if (!Array.isArray(list) || list.length > HD_CAP_KEYS.length * 2) return { ok: false, error: `${HD_ROLE_LABEL[r]}: send a list of capabilities.` };
    const bad = list.find((c) => !isHdCap(c));
    if (bad !== undefined) return { ok: false, error: `Unknown capability "${String(bad).slice(0, 60)}".` };
    const caps = ordered(list as HdCap[]);
    const before = new Set(current[r]);
    const after = new Set(caps);
    const diff = HD_CAP_KEYS.filter((c) => before.has(c) !== after.has(c));
    if (!diff.length) continue;
    const col = columnLockedReason(r, editor.role);
    if (col) return { ok: false, error: `${HD_ROLE_LABEL[r]}: ${col}` };
    for (const c of diff) {
      if (after.has(c)) {
        const why = capForbiddenReason(r, c);
        if (why) return { ok: false, error: `${HD_ROLE_LABEL[r]} → ${HD_CAPABILITIES[c].label}: ${why}` };
      }
      if (!editorCovers(editor.caps, c)) {
        return { ok: false, error: `${HD_ROLE_LABEL[r]} → ${HD_CAPABILITIES[c].label}: you can't grant or remove a capability you don't have.` };
      }
    }
    for (const [a, b] of HD_EXCLUSIVE_CAPS) {
      if (after.has(a) && after.has(b)) {
        return { ok: false, error: `${HD_ROLE_LABEL[r]}: "${HD_CAPABILITIES[a].label}" and "${HD_CAPABILITIES[b].label}" can't both be on.` };
      }
    }
    next[r] = caps;
    changed.push(r);
  }
  return { ok: true, matrix: next, changed };
}

/** The roles `editor` may hand out. Admin: all. Manager-like (agents.assign_roles): below their own. Team lead-like (agents.manage_team): Newbie and Agent below their own. */
export function assignableRolesFor(role: HdRole | null, caps: readonly HdCap[]): HdRole[] {
  if (!role) return [];
  if (role === "admin") return [...HD_ROLES];
  if (caps.includes("agents.assign_roles")) return HD_ROLES.filter((r) => HD_ROLE_RANK[r] < HD_ROLE_RANK[role]);
  if (caps.includes("agents.manage_team")) {
    return (["newbie", "agent"] as HdRole[]).filter((r) => HD_ROLE_RANK[r] < HD_ROLE_RANK[role]);
  }
  return [];
}

// --- Effective role -------------------------------------------------------------

export type HdRoleSource = "workspace" | "assigned" | "derived";

export interface HdRoleFacts {
  /** The hd_agent_roles row, if any. */
  explicit: HdRole | null;
  /** Workspace permissions held (helpdesk.*). */
  admin: boolean;
  agentAll: boolean;
  agent: boolean;
  reports: boolean;
  /** Lead (hd_team_members.role) in any team. */
  leadAnywhere: boolean;
}

/**
 * The effective desk role. A workspace helpdesk.admin holder is always
 * Admin (a floor the desk can't lower); otherwise an explicit row wins;
 * otherwise it is derived from the workspace permissions so nobody who
 * worked tickets before the ladder loses access.
 */
export function resolveRole(f: HdRoleFacts): { role: HdRole; source: HdRoleSource } | null {
  if (f.admin) return { role: "admin", source: "workspace" };
  if (f.explicit) return { role: f.explicit, source: "assigned" };
  if (f.agentAll && f.reports) return { role: "manager", source: "derived" };
  const worker = f.agent || f.agentAll;
  if (worker && f.leadAnywhere) return { role: "team_lead", source: "derived" };
  if (worker) return { role: "agent", source: "derived" };
  return null;
}

/** "Admin (from workspace role)" and friends. */
export function roleDisplayLabel(role: HdRole, source: HdRoleSource): string {
  return source === "workspace" ? `${HD_ROLE_LABEL[role]} (from workspace role)` : HD_ROLE_LABEL[role];
}

/** What hdCapsFor returns, and the desk UI reads. */
export interface HdCapsView {
  role: HdRole | null;
  role_label: string;
  source: HdRoleSource | null;
  /** The role can't be changed in the desk (workspace Admin). */
  locked: boolean;
  caps: HdCap[];
  team_ids: number[];
  lead_team_ids: number[];
  assignable_roles: HdRole[];
}

// --- Agents page rows ---------------------------------------------------------------

export interface HdDeskAgent {
  user_id: number;
  name: string;
  email: string;
  username: string;
  role: HdRole;
  role_label: string;
  source: HdRoleSource;
  locked: boolean;
  team_ids: number[];
  lead_team_ids: number[];
  availability: "available" | "away" | "offline";
  assigned_at: string | null;
}

// --- Review ---------------------------------------------------------------------------

export type HdReviewState = "pending" | "approved" | "returned";

export interface HdPendingReview {
  message_id: number;
  ticket_id: number;
  ticket_number: number;
  ticket_subject: string;
  team_id: number | null;
  team_name: string | null;
  requester_name: string;
  author_id: number | null;
  author_name: string;
  body: string;
  created_at: string;
}
