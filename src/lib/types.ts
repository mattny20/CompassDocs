export type DocType = "sop" | "technical" | "policy" | "knowledge";
export type DocStatus = "draft" | "published";

// --- Auth & roles ------------------------------------------------------------

export type Role = "viewer" | "editor" | "approver" | "admin";

/** Ordered low → high. Used for "at least this role" checks. */
export const ROLE_ORDER: Role[] = ["viewer", "editor", "approver", "admin"];

export const ROLE_LABEL: Record<Role, string> = {
  viewer: "Viewer",
  editor: "Editor",
  approver: "Approver",
  admin: "Admin",
};

export const ROLE_BLURB: Record<Role, string> = {
  viewer: "Read documents and submit suggestions.",
  editor: "Create and edit documents. Changes to live docs go through review.",
  approver: "Everything editors do, plus publish and review the queue.",
  admin: "Full control, including managing users and settings.",
};

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export type ApprovalMode = "strict" | "open";

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  auth_provider: string;
  external_id: string | null;
  must_change_password: number;
  totp_enabled: number;
  /** Linked people-directory entry (auto-matched or admin-set); null = unlinked. */
  directory_person_id: number | null;
  /** Master switch for subscription emails (1 = on). */
  email_notifications: number;
  /** Personal Slack/Teams incoming-webhook URL; empty = off. */
  notify_webhook_url: string;
  /** App-wide page width preference: normal | wide | full. */
  page_width: string;
  /** Interface scale: compact | default | large | larger. */
  ui_scale: string;
  /** Bare-key shortcuts (/ @ > # ? c and the g-chords) on or off (WCAG 2.1.4). */
  single_key_shortcuts: boolean;
  /** Newsletter capability: none | contributor | approver. */
  newsletter_role: string;
  /** Color theme preference: light | dark | system. */
  theme: string;
  /** IANA time zone for rendered timestamps; empty = browser/server default. */
  timezone: string;
  /** Date rendering: auto | us | iso | eu. */
  date_format: string;
  /** Small data: URL avatar; empty = initials. */
  avatar: string;
  /** Per-event notification routing: kind -> {inapp?, webhook?, email?}. */
  notify_prefs: Record<string, Record<string, boolean>>;
  created_at: string;
  last_login_at: string | null;
}

/** The shape exposed to the client (never includes password material). */
export interface SessionUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: Role;
  must_change_password: boolean;
  /** App-wide page width preference: normal | wide | full. */
  page_width: "normal" | "wide" | "full";
  /** Interface scale, a multiplier on the fluid root size. */
  ui_scale: "compact" | "default" | "large" | "larger";
  /** Bare-key shortcuts on or off; Ctrl/⌘+K always works. */
  single_key_shortcuts: boolean;
  /** Newsletter capability: none | contributor | approver (admins: full). */
  newsletter_role: "none" | "contributor" | "approver";
  /** Color theme preference: light | dark | system. */
  theme: "light" | "dark" | "system";
  /** IANA time zone for rendered timestamps; empty = workspace default. */
  timezone: string;
  /** Date rendering; auto = workspace default. */
  date_format: "auto" | "medium" | "long" | "iso" | "us" | "eu";
  /** Small data: URL avatar; empty = initials. */
  avatar: string;
}

export interface Suggestion {
  id: number;
  document_id: number | null;
  proposed_title: string;
  body: string;
  status: "open" | "accepted" | "dismissed";
  created_by: number;
  author_name: string;
  document_title: string | null;
  created_at: string;
  resolved_by: number | null;
  resolved_at: string | null;
}

export interface ChangeRequest {
  id: number;
  document_id: number;
  kind: "edit" | "publish";
  title: string;
  content: string;
  summary: string;
  tags: string;
  type: DocType;
  target_status: DocStatus;
  note: string;
  status: "pending" | "approved" | "rejected";
  created_by: number;
  author_name: string;
  document_title: string | null;
  /** Visibility of the target doc's space — approvers see when a change goes to the open internet. */
  space_visibility: "public" | "internal" | "private" | null;
  /** When set, approving also moves the doc to this space. */
  space_id: number | null;
  target_space_name: string | null;
  /**
   * The submitter's recommendation for the readers of a confirmed document
   * (A6, 1.11.0): 'keep' (editorial fix), 'reset' (material change), or
   * 'auto' when none was given. The approver decides at approval.
   */
  ack_policy: "keep" | "reset" | "auto";
  ack_reason: string;
  /** The target document's requirement and confirmation marker (from the review list's join; null when the document is gone). */
  ack_required: number | null;
  ack_version_id: number | null;
  created_at: string;
  reviewed_by: number | null;
  reviewed_at: string | null;
  review_note: string;
}

export const DOC_TYPES: { value: DocType; label: string; blurb: string }[] = [
  { value: "sop", label: "SOP", blurb: "Step-by-step standard operating procedures" },
  { value: "technical", label: "Technical", blurb: "Architecture, runbooks, and API docs" },
  { value: "policy", label: "Policy", blurb: "Company rules, compliance, and guidelines" },
  { value: "knowledge", label: "Knowledge", blurb: "How-tos, FAQs, and tribal knowledge" },
];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  sop: "SOP",
  technical: "Technical",
  policy: "Policy",
  knowledge: "Knowledge",
};

export interface Space {
  id: number;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  created_at: string;
  /** public = anyone on the internet; internal = any signed-in user; private = granted groups. */
  visibility: "public" | "internal" | "private";
  /** Template auto-applied when creating a doc from this space (null = blank). */
  default_template_id: number | null;
  /** Layout the space page opens with; visitors can switch and are remembered. */
  default_view: SpaceView;
}

export type SpaceView = "cards" | "table" | "tree" | "board" | "timeline" | "tags";
export const SPACE_VIEWS: SpaceView[] = ["cards", "table", "tree", "board", "timeline", "tags"];

export interface Document {
  id: number;
  space_id: number;
  /** Optional category within the space (null = General). */
  category_id: number | null;
  title: string;
  slug: string;
  type: DocType;
  status: DocStatus;
  content: string;
  summary: string;
  tags: string[];
  author: string;
  /** 1 = readers must confirm they've read this doc (enterprise). */
  ack_required: number;
  /**
   * The confirmation marker (1.10.0): a confirmation counts while its
   * acknowledged_at >= this. Moves only when an editor asks everyone to
   * re-confirm, never on a metadata-only save (updated_at is the conflict
   * token, not the currency marker).
   */
  ack_revision_at: string;
  /** The doc_versions id everyone is asked to confirm (null only before the first version). */
  ack_version_id: number | null;
  /** Last time a compliance reminder went out for this doc (enterprise). */
  ack_last_reminded_at?: string | null;
  /** How the document treats a text edit (A5, 1.10.1): 'ask' the editor each time, 'material' only when the change looks material, 'reset' always re-ask everyone. */
  ack_edit_default: AckEditDefault;
  /** Non-null = this doc is a draft branch of that document. */
  branch_of: number | null;
  /** Nested pages: the parent document (null = top level). */
  parent_id: number | null;
  /** Manual order among siblings under the same parent. */
  position: number;
  /** Content review cadence in days (null = no review schedule). */
  review_interval_days?: number | null;
  /** When the next review is due (null when no schedule). */
  review_due_at?: string | null;
  /** Last "mark as reviewed" (null = never explicitly reviewed). */
  last_reviewed_at?: string | null;
  last_reviewed_by?: string | null;
  /** One-shot: publish this draft at the given time (null = not scheduled). */
  publish_at?: string | null;
  /** One-shot: unpublish (back to draft) at the given time. */
  archive_at?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface DocumentWithSpace extends Document {
  space_name: string;
  space_slug: string;
  space_icon: string;
  space_color: string;
  space_visibility: "public" | "internal" | "private";
}

// --- Read confirmation decisions (1.10.0, A2/C1) ----------------------------

/** What a caller asks updateDocument to do with existing confirmations when the text changes. */
export type AckPolicy = "keep" | "reset" | "auto";

/** A document's answer to "when the text changes" (A5, 1.10.1); the workspace default lives in Program settings. */
export type AckEditDefault = "ask" | "material" | "reset";

/** Where a decision came from (the C1 vocabulary). */
export type AckSource =
  | "edit"
  | "merge"
  | "restore"
  | "approval"
  | "manual"
  | "api"
  | "mcp"
  | "import"
  | "image"
  | "ticket"
  | "bulk"
  | "schedule"
  | "recurrence"
  | "default";

/** 'reset' asked everyone again; 'kept' left confirmations standing; 'retired' is a lifecycle row with frozen counts (G3, later). */
export type AckOutcome = "reset" | "kept" | "retired";

/** One row of the decision ledger (ack_decisions), newest first from listAckDecisions. */
export interface AckDecision {
  id: number;
  /** Null once the policy has been purged; document_title keeps the name. */
  document_id: number | null;
  /** The version the decision was taken for (the new text). Plain id, no FK, like acknowledgements.version_id. */
  version_id: number | null;
  /** 1-based Version-history number of that version; null when it is gone. */
  rev: number | null;
  outcome: AckOutcome;
  decided_at: string;
  source: AckSource;
  /** 'all' = the whole audience; 'users' = a named subset (D4, later). */
  scope: "all" | "users";
  decided_by: number | null;
  decided_by_name: string;
  /** The policy the submitter proposed on an approval ('' when nobody proposed one). */
  submitted_policy: "keep" | "reset" | "";
  submitted_by: number | null;
  submitted_by_name: string;
  reason: string;
  /** What the change-size heuristic suggested ('' when it was not consulted). */
  suggested: "keep" | "reset" | "";
  overrode_suggestion: boolean;
  /** Share of words changed against the confirmed text, one decimal place; null when not measured. */
  change_pct: number | null;
  /** Confirmations made stale by a reset, or left standing by a keep. */
  confirmations_affected: number | null;
  /** People in the audience when the decision was taken. */
  eligible: number | null;
  /** When notices went out for a reset (H1/H4, later; null in 1.10.0). */
  notified_at: string | null;
}

/** What updateDocument did about confirmations, echoed by PUT /api/documents/[id]. */
export interface AckOutcomeInfo {
  /** False when the save changed nothing at all (no UPDATE, no version, no reset). */
  changed: boolean;
  /** The text or title differs from the version everyone was last asked to confirm. */
  substantive: boolean;
  /** The marker moved: everyone is asked again. */
  reset: boolean;
  /** Current confirmations that went stale (0 when kept or when nobody was asked). */
  confirmations_reset: number;
  policy: AckPolicy;
  source: AckSource;
  /** The ledger row this save wrote; null when no decision was taken. */
  decision_id?: number | null;
}

export interface Attachment {
  id: number;
  document_id: number;
  filename: string;
  stored_name: string;
  mime_type: string;
  size: number;
  created_by: number | null;
  created_at: string;
}

export interface DocVersion {
  id: number;
  document_id: number;
  title: string;
  content: string;
  author: string;
  note: string;
  /** If this version was created by restoring an older one, that version's id. */
  restored_from: number | null;
  created_at: string;
  /**
   * Provenance (1.10.1, C6): who published this version and, when it came
   * through a change request, who approved it. The ids are ON DELETE SET
   * NULL; the names are snapshots. Rows from before 1.10.1 have
   * published_by_name backfilled from `author` and approved_by_name from the
   * legacy "approved by" note suffix where one was written; everything else
   * is blank.
   */
  published_by: number | null;
  published_by_name: string;
  approved_by: number | null;
  approved_by_name: string;
  change_request_id: number | null;
}

// --- Read confirmation notices (1.10.1, E3/H4) ------------------------------

/** What an outbox row asks the drain to send (H4). 'digest' is a notice kind only (F4/E2, later). */
export type AckNoticeMode = "request" | "reminder" | "updated" | "due" | "overdue" | "escalation" | "welcome";
export type AckNoticeKind = AckNoticeMode | "digest";

/** A channel a notice actually went out on: 'email' only when the mail was accepted by the server. */
export type AckNoticeChannel = "inapp" | "email" | "webhook";

/** One row of the per-person notice log (ack_notices), newest first from listAckNotices. */
export interface AckNotice {
  id: number;
  /** Null once the account is deleted; user_name and user_email keep the snapshot. */
  user_id: number | null;
  user_name: string;
  user_email: string;
  /** Null once the policy is purged; document_title keeps the name. */
  document_id: number | null;
  document_title: string;
  kind: AckNoticeKind;
  channels: AckNoticeChannel[];
  sent_at: string;
  by_user_id: number | null;
  /** 'system' when no person asked (a sweep, a schedule). */
  by_name: string;
  outbox_id: number | null;
}

/** One queued fan-out (ack_outbox), as the drain claims it. */
export interface AckOutboxRow {
  id: number;
  document_id: number | null;
  mode: AckNoticeMode;
  source: AckSource | "";
  reason: string;
  actor_id: number | null;
  actor_name: string;
  /** Null = everyone pending at delivery time. */
  user_ids: number[] | null;
  not_before: string;
  claimed_at: string | null;
  done_at: string | null;
  attempts: number;
  emailed: number | null;
  noticed: number | null;
  error: string | null;
  /** The sending request's origin kept for the links; '' when no request queued the row (1.10.1). */
  origin: string;
}

export interface SearchHit {
  id: number;
  title: string;
  slug: string;
  type: DocType;
  status: DocStatus;
  space_name: string;
  space_slug: string;
  space_icon: string;
  space_color: string;
  tags: string[];
  snippet: string;
  updated_at: string;
  /** How the hit was found: keyword match, semantic similarity, or both. */
  match?: "keyword" | "semantic" | "both";
  /** Ancestor page titles, outermost first (nested pages, when enabled). */
  path?: string[];
}
