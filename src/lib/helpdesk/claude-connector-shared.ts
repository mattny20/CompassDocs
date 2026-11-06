// Helpdesk 1.19.1: what the Claude connector (MCP) may do in the helpdesk
// (agent V1). Client-safe: Desk settings → Claude connector, the MCP tools
// (lib/mcp/helpdesk-tools) and the tests read one set of words and rules.
//
// Claude always acts as the person who connected it, with their desk role
// and teams; the workspace level below only ever narrows that.
//
//   read     find and read what the person can see, and summarise it
//   notes    (default) also write: internal notes, reply drafts, the
//            person's own requests and replies on them, and drafts of
//            workflows, request types and macros
//   update   also change tickets: status, priority, team, assignee, tags
//
// Whatever the level, three things are never possible (no tool exists and
// no setting adds one): sending a reply to a requester, deciding an
// approval, and publishing a workflow, request type or macro.

export const HD_CLAUDE_KEY = "helpdesk_claude_connector";

export const HD_CLAUDE_LEVELS = ["read", "notes", "update"] as const;
export type HdClaudeLevel = (typeof HD_CLAUDE_LEVELS)[number];

export const HD_CLAUDE_DEFAULT_LEVEL: HdClaudeLevel = "notes";

export const HD_CLAUDE_LEVEL_RANK: Record<HdClaudeLevel, number> = { read: 0, notes: 1, update: 2 };

export function isClaudeLevel(v: unknown): v is HdClaudeLevel {
  return typeof v === "string" && (HD_CLAUDE_LEVELS as readonly string[]).includes(v);
}

export const HD_CLAUDE_LEVEL_LABEL: Record<HdClaudeLevel, string> = {
  read: "Read only",
  notes: "Read, add internal notes and save reply drafts",
  update: "Also update tickets",
};

export const HD_CLAUDE_LEVEL_HINT: Record<HdClaudeLevel, string> = {
  read: "Find and read requests and tickets the person can see, and summarise them.",
  notes: "Recommended. Drafts wait in the ticket for an agent to send or discard.",
  update: "Status, priority, team, assignee and tags, within the person's role.",
};

/** The never-list, word for word as Desk settings shows it. */
export const HD_CLAUDE_NEVER: readonly string[] = [
  "Send a reply to a requester: Claude saves a draft and a person sends it.",
  "Approve or decline: Claude lists what's waiting and links to the approval.",
  "Publish a workflow, request type or macro: Claude saves a draft for someone to publish.",
];

/** Audit actions the connector writes (each row carries details.via = "mcp"). */
export const HD_CLAUDE_AUDIT_ACTIONS = [
  "helpdesk.request.created",
  "helpdesk.request.replied",
  "helpdesk.note.added",
  "helpdesk.reply_draft.created",
  "helpdesk.ticket.updated",
  "helpdesk.workflow.created",
  "helpdesk.workflow.updated",
  "helpdesk.request_type.created",
  "helpdesk.macro.created",
] as const;

/** One line of "Recent activity via Claude". */
export interface HdClaudeActivity {
  id: number;
  at: string;
  actor_id: number | null;
  actor_name: string;
  action: string;
  /** "Saved a reply draft on #1047". */
  summary: string;
}

/** The activity line for an audit row the connector wrote. */
export function claudeActivitySummary(action: string, details: Record<string, unknown> | null, label: string | null): string {
  const n = typeof details?.number === "number" ? `#${details.number}` : "";
  const name = (label ?? "").trim();
  switch (action) {
    case "helpdesk.request.created":
      return n ? `Raised ${n} from Claude` : "Raised a request from Claude";
    case "helpdesk.request.replied":
      return n ? `Replied on ${n}` : "Replied on a request";
    case "helpdesk.note.added":
      return n ? `Added an internal note on ${n}` : "Added an internal note";
    case "helpdesk.reply_draft.created":
      return n ? `Saved a reply draft on ${n}` : "Saved a reply draft";
    case "helpdesk.ticket.updated":
      return n ? `Updated ${n}` : "Updated a ticket";
    case "helpdesk.workflow.created":
    case "helpdesk.workflow.updated":
      return name ? `Saved a workflow draft: ${name}` : "Saved a workflow draft";
    case "helpdesk.request_type.created":
      return name ? `Saved a request type draft: ${name}` : "Saved a request type draft";
    case "helpdesk.macro.created":
      return name ? `Saved a macro draft: ${name}` : "Saved a macro draft";
    default:
      return name || action;
  }
}
