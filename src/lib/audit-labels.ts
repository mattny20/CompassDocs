// Human labels for audit-log action keys (STYLEGUIDE §Vocabulary). The log
// never prints a raw "directory.person_updated": every key the codebase emits
// has a verb-first label here, and actionLabel() humanises anything older or
// newer than this map ("Directory · Person updated") so a missing entry is a
// dull row, never a code identifier. test/audit-labels.test.ts fails the build
// when a new audit() call ships without a label.
//
// Client-safe (AuditLog imports it); no server imports, so an export or an
// email can reuse it.

export const AUDIT_LABELS: Record<string, string> = {
  // Sign-in
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.login_failed": "Failed sign-in",
  "auth.lockout": "Locked out after failed sign-ins",

  // Accounts (the Users section)
  "user.create": "Created user",
  "user.role_change": "Changed role",
  "user.reset_password": "Reset password",
  "user.enable": "Enabled user",
  "user.disable": "Disabled user",
  "user.delete": "Deleted user",
  "users.directory_autolink": "Linked accounts to directory entries",

  // The signed-in person's own account
  "account.profile_updated": "Updated own profile",
  "account.session_revoked": "Signed out a session",
  "account.sessions_revoked": "Signed out all other sessions",
  "account.token_created": "Created API token",
  "account.token_revoked": "Revoked API token",
  "account.oauth_authorized": "Authorized an app",
  "account.oauth_revoked": "Revoked an app's access",

  // Documents
  "document.create": "Created document",
  "document.update": "Edited document",
  "document.publish": "Published document",
  "document.delete": "Deleted document",
  "document.trash": "Moved document to Trash",
  "document.restore": "Restored document",
  "document.purge": "Deleted document permanently",
  "document.restore_version": "Restored previous version",
  "document.branch_create": "Created draft branch",
  "document.branch_merge": "Merged draft branch",
  "document.review_schedule": "Changed review schedule",
  "document.reviewed": "Marked document reviewed",
  "document.share_created": "Created share link",
  "document.share_revoked": "Revoked share link",
  "document.acknowledge": "Confirmed reading document",
  "document.ack_required": "Required read confirmation",
  "document.ack_removed": "Removed read-confirmation requirement",
  "document.scheduled_publish": "Published document on schedule",
  "document.scheduled_unpublish": "Unpublished document on schedule",
  "document.dms_link_add": "Linked document to DMS record",
  "document.dms_link_remove": "Unlinked document from DMS record",
  "document.bulk_move": "Moved documents",
  "document.bulk_status": "Changed status of documents",
  "document.bulk_type": "Changed type of documents",
  "document.bulk_add_tag": "Tagged documents",
  "document.bulk_remove_tag": "Untagged documents",
  "attachment.upload": "Uploaded attachment",
  "document.import": "Imported documents",
  "comment.create": "Added comment",
  "comment.delete": "Deleted comment",
  "content.migrate": "Migrated content",

  // Review
  "change_request.submit": "Submitted for review",
  "change_request.approve": "Approved change",
  "change_request.reject": "Rejected change",
  "ack.requested": "Asked for read confirmations",
  "ack.reminder_sent": "Sent read confirmation reminder",
  "ack.anonymised": "Anonymised compliance record",

  // Read confirmation decisions and settings (C1). Every key the ack family
  // can emit lives under "ack." so the category filter groups them; the three
  // document.* keys above stay for compatibility. lib/audit's auditAck()
  // takes these as a literal union, and test/ack-ledger.test.ts checks each
  // one has a label here.
  "ack.edit_default_set": "Changed re-confirmation default",
  "ack.settings_changed": "Changed read-confirmation settings",
  "ack.reconfirmation_requested": "Asked to re-confirm",
  "ack.confirmations_kept": "Kept confirmations after an edit",
  "ack.confirmations_reset": "Reset confirmations after an edit",
  "ack.reset_notified": "Sent re-confirmation notices",
  "ack.export": "Exported read confirmation record",
  "ack.retired": "Retired policy",
  "ack.unretired": "Resumed retired policy",
  "ack.notice_failed": "Could not deliver read-confirmation notices",
  "ack.exempted": "Exempted person from read confirmation",
  "ack.exemption_revoked": "Revoked read confirmation exemption",
  "ack.due_extended": "Extended read confirmation due date",
  "ack.due_extension_undone": "Undid read confirmation due date extension",
  "ack.bulk_extended": "Extended read confirmation due dates in bulk",
  "ack.snoozed": "Snoozed read confirmation reminder",
  "ack.unsnoozed": "Resumed read confirmation reminder",
  "ack.escalated": "Escalated overdue read confirmation",
  "ack.reminder_auto": "Sent automatic read confirmation reminders",
  "ack.recert": "Asked for annual re-confirmation",
  "ack.audience_set": "Set who must confirm a policy",
  "ack.auto_enrolled": "Enrolled new account in policies",
  "ack.audience_reconciled": "Updated a policy's audience",
  "ack.due_set": "Set read confirmation deadline",
  "ack.due_moved": "Moved read confirmation deadlines",
  "ack.defaults_set": "Changed policy defaults",
  "ack.snapshot": "Took read confirmation snapshot",
  "ack.snapshot_failed": "Could not take read confirmation snapshot",
  "ack.snapshot_rewritten": "Rewrote read confirmation snapshot for an erasure",
  "ack.audit_export": "Exported read confirmation evidence",
  "ack.report_settings": "Changed compliance report settings",
  "ack.report_sent": "Sent compliance report",
  "ack.retention_purge": "Purged read confirmation records past retention",
  "ack.record_exported": "Exported a person's compliance record",
  // Policy sets (D3, 1.14.0)
  "ack.set_created": "Created policy set",
  "ack.set_updated": "Edited policy set",
  "ack.set_deactivated": "Deactivated policy set",
  "ack.set_deleted": "Deleted policy set",
  "ack.set_assigned": "Assigned policy set",
  // Bulk actions across policies and people (F5, 1.14.0): one summary row
  // per call beside the per-policy and per-row rows the writes emit
  // (ack.bulk_extended, above, is the dispatcher's since 1.13.0).
  "ack.bulk_remind": "Sent read confirmation reminders in bulk",
  "ack.bulk_due_set": "Set read confirmation deadlines in bulk",
  "ack.bulk_owner_set": "Set policy owners in bulk",
  "ack.bulk_reminders_set": "Set policy reminders in bulk",
  "ack.bulk_reasked": "Asked to re-confirm in bulk",
  "ack.bulk_added_to_set": "Added policies to a set",
  "ack.bulk_people_reminded": "Reminded people about everything outstanding",
  "ack.bulk_exempted": "Exempted people from read confirmation in bulk",

  // Spaces and categories
  "space.create": "Created space",
  "space.update": "Edited space",
  "space.delete": "Deleted space",
  "space_category.created": "Created category",
  "space_category.updated": "Edited category",
  "space_category.deleted": "Deleted category",

  // Groups, roles and permissions
  "group.create": "Created group",
  "group.rename": "Renamed group",
  "group.delete": "Deleted group",
  "group.member_add": "Added group member",
  "group.member_remove": "Removed group member",
  "role.created": "Created role",
  "role.updated": "Edited role",
  "role.deleted": "Deleted role",
  "role.assigned": "Assigned role",
  "role.unassigned": "Revoked role",

  // Directory
  "directory.person_added": "Added person",
  "directory.person_updated": "Updated person",
  "directory.person_deleted": "Deleted person",
  "directory.photo_set": "Set photo",
  "directory.photo_cleared": "Cleared photo",
  "directory.field_added": "Added directory field",
  "directory.field_updated": "Updated directory field",
  "directory.field_deleted": "Deleted directory field",
  "directory.offices_updated": "Updated offices",
  "directory.pins_updated": "Updated pinned people",
  "directory.schedule_updated": "Updated directory sync schedule",
  "directory.imported": "Imported people",
  "directory.exported": "Exported directory",

  // Links
  "link.created": "Created link",
  "link.updated": "Edited link",
  "link.deleted": "Deleted link",
  "link.icon_uploaded": "Uploaded link icon",
  "link_category.created": "Created link category",
  "link_category.updated": "Edited link category",
  "link_category.deleted": "Deleted link category",

  // Announcements, newsletter, digest
  "announcement.posted": "Posted announcement",
  "announcement.deleted": "Deleted announcement",
  "newsletter.created": "Created newsletter issue",
  "newsletter.deleted": "Deleted newsletter issue",
  "newsletter.submitted": "Submitted newsletter issue for review",
  "newsletter.scheduled": "Scheduled newsletter issue",
  "newsletter.unscheduled": "Unscheduled newsletter issue",
  "newsletter.sent": "Sent newsletter issue",
  "newsletter.senders_updated": "Updated newsletter senders",
  "newsletter.appearance_updated": "Updated newsletter appearance",
  "newsletter.role_changed": "Changed newsletter role",
  "digest.sent": "Sent digest email",

  // Training
  "training.deck_create": "Created training deck",
  "training.deck_update": "Edited training deck",
  "training.deck_delete": "Deleted training deck",
  "training.program_create": "Created training program",
  "training.program_update": "Edited training program",
  "training.program_delete": "Deleted training program",
  "training.program_assigned": "Assigned training program",
  "training.assigned": "Assigned training",
  "training.unassigned": "Unassigned training",
  "training.completed": "Completed training",
  "training.reopened": "Reopened training",
  "training.waived": "Waived training",
  "training.snoozed": "Snoozed training reminder",
  "training.reminded": "Sent training reminder",
  "training.due_extended": "Extended training due date",
  "training.leads_set": "Set team leads",
  "training.report_settings": "Updated training report settings",
  "training.snapshot": "Took training snapshot",
  "training.audit_export": "Exported training records",

  // Status page
  "status.service_added": "Added status service",
  "status.service_removed": "Removed status service",
  "status.incident_declared": "Declared incident",
  "status.incident_resolved": "Resolved incident",

  // Settings
  "settings.workspace": "Updated workspace settings",
  "settings.approval_mode": "Changed approval mode",
  "settings.editors_edit_all": "Changed who can edit spaces",
  "settings.domain": "Updated domain & HTTPS",
  "settings.smtp": "Updated email delivery settings",
  "settings.public_site": "Updated public site settings",
  "settings.sso": "Updated SSO settings",
  "settings.saml": "Updated SAML settings",
  "settings.section_access": "Changed section access",
  "settings.compliance": "Updated compliance settings",
  "settings.ai_provider": "Changed AI provider",
  "settings.ai_model": "Changed AI model",
  "settings.ai_key_set": "Set AI API key",
  "settings.ai_key_removed": "Removed AI API key",
  "settings.chat_ask": "Updated chat assistant settings",
  "settings.semantic_search": "Updated semantic search settings",
  "settings.semantic_reindex": "Rebuilt semantic index",
  "settings.backup_destination": "Updated backup destination",
  "settings.backup_destination_removed": "Removed backup destination",
  "settings.email_template": "Edited email template",
  "settings.email_template_reset": "Reset email template",
  "settings.template_created": "Created document template",
  "settings.template_updated": "Edited document template",
  "settings.template_reset": "Reset document template",
  "settings.template_deleted": "Deleted document template",
  "settings.webhook_created": "Created webhook",
  "settings.webhook_updated": "Edited webhook",
  "settings.webhook_deleted": "Deleted webhook",
  "settings.directory_google": "Updated Google directory settings",
  "settings.directory_google_cleared": "Disconnected Google directory",
  "settings.directory_graph": "Updated Microsoft 365 directory settings",
  "settings.directory_list": "Updated directory list layout",
  "settings.directory_print": "Updated directory print layout",
  "settings.directory_export": "Updated directory export settings",
  "settings.directory_markers": "Updated directory markers",
  "branding.logo_uploaded": "Uploaded logo",
  "branding.logo_fetched": "Fetched logo from website",
  "branding.logo_removed": "Removed logo",

  // Provisioning and system
  "scim.user_create": "SCIM provisioned user",
  "scim.user_update": "SCIM updated user",
  "scim.user_disable": "SCIM deactivated user",
  "scim.user_enable": "SCIM reactivated user",
  "scim.token_generated": "Generated SCIM token",
  "scim.enabled": "Enabled SCIM provisioning",
  "scim.disabled": "Disabled SCIM provisioning",
  "license.set": "Installed license",
  "license.removed": "Removed license",
  "backup.create": "Created backup",
  "backup.delete": "Deleted backup",
  "backup.restore": "Restored backup",
  "audit.export": "Exported audit log",
  "system.update_triggered": "Started system update",
};

/** "person_updated" → "Person updated"; "ai_key_set" → "Ai key set". */
export function humanise(key: string): string {
  const words = key.replace(/[_\s]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : "";
}

/** True when the key has its own label; false when actionLabel() would fall back. */
export function hasActionLabel(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIT_LABELS, action);
}

/**
 * The label for an audit action. Known keys get their verb-first label;
 * anything else is humanised as "Family · Action" so a raw key is never
 * shown: "directory.person_updated" → "Directory · Person updated".
 */
export function actionLabel(action: string): string {
  const known = AUDIT_LABELS[action];
  if (known) return known;
  const dot = action.indexOf(".");
  if (dot <= 0) return humanise(action) || "Unknown action";
  const family = humanise(action.slice(0, dot));
  const rest = humanise(action.slice(dot + 1));
  return rest ? `${family} · ${rest}` : family;
}
