// Access rules for the newsletter editorial workflow.
//
// Access is a per-user capability (users.newsletter_role), not a new org role:
//   none        — no access to the module (default)
//   contributor — write drafts, submit them for review
//   approver    — everything contributors do, plus review/approve/send
// Admins implicitly have full access. Each newsletter may carry an approver
// override list; when empty, any approver (or admin) may act on it.

import type { SessionUser } from "./types";
import type { Newsletter } from "./db";

export function canUseNewsletter(user: SessionUser): boolean {
  return user.role === "admin" || user.newsletter_role !== "none";
}

/** Approver capability in general (before per-newsletter scoping). */
export function isNewsletterApprover(user: SessionUser): boolean {
  return user.role === "admin" || user.newsletter_role === "approver";
}

/** Whether this user may act as an approver on THIS newsletter. */
export function canApprove(user: SessionUser, approverIds: number[]): boolean {
  if (user.role === "admin") return true;
  if (user.newsletter_role !== "approver") return false;
  return approverIds.length === 0 || approverIds.includes(user.id);
}

export function isAuthor(user: SessionUser, n: Newsletter): boolean {
  return n.created_by === user.id;
}

/**
 * Content edits. Sent newsletters are immutable. Authors may revise their own
 * piece until it's approved; once approved the content is locked to what was
 * signed off — only an in-scope approver or admin may still touch it.
 */
export function canEditContent(user: SessionUser, n: Newsletter, approverIds: number[]): boolean {
  if (n.status === "sent") return false;
  if (canApprove(user, approverIds)) return true;
  if (!isAuthor(user, n)) return false;
  return n.status === "draft" || n.status === "changes_requested" || n.status === "in_review";
}

/** Submitting for review: the author (or an admin) while it's with the author. */
export function canSubmit(user: SessionUser, n: Newsletter): boolean {
  if (n.status !== "draft" && n.status !== "changes_requested") return false;
  return isAuthor(user, n) || user.role === "admin";
}

/** Approve / request changes: in-scope approvers while the piece is in review. */
export function canDecide(user: SessionUser, n: Newsletter, approverIds: number[]): boolean {
  return n.status === "in_review" && canApprove(user, approverIds);
}

/** Sending: in-scope approvers or admins, only once approved. */
export function canSend(user: SessionUser, n: Newsletter, approverIds: number[]): boolean {
  return n.status === "approved" && canApprove(user, approverIds);
}

/** Commenting: anyone who can see the piece and act on it (author + approver scope). */
export function canComment(user: SessionUser, n: Newsletter, approverIds: number[]): boolean {
  if (n.status === "sent") return false;
  return isAuthor(user, n) || canApprove(user, approverIds);
}

/** Deleting: admins any time; authors while the piece is still theirs. */
export function canDelete(user: SessionUser, n: Newsletter): boolean {
  if (user.role === "admin") return true;
  return isAuthor(user, n) && (n.status === "draft" || n.status === "changes_requested");
}

/**
 * Anyone who may see this newsletter's detail page at all. Sent newsletters
 * are readable by every signed-in user — they were emailed org-wide and
 * surface on everyone's dashboard. Unsent drafts stay with the editorial crew.
 */
export function canView(user: SessionUser, n: Newsletter, approverIds: number[]): boolean {
  if (n.status === "sent") return true;
  return isAuthor(user, n) || canApprove(user, approverIds) || isNewsletterApprover(user);
}
