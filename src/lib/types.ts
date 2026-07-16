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
  /** App-wide page width preference: normal | wide | full. */
  page_width: string;
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
}

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
  created_at: string;
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
}
