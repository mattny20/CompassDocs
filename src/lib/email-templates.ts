import "server-only";
import { getAppSettings } from "./settings-store";
import type { AppSettings } from "./settings";
import { renderBodyHtml } from "./newsletter";
import { NOTIFY_EVENTS } from "./notify-policy-shared";

// Editable templates for every alert email CompassDocs sends. Admins customize
// the subject and body (markdown, written in the doc editor) under Settings →
// Notifications → Email templates; senders render through here so overrides
// apply everywhere. {{tags}} substitute per-message values; unknown tags are
// left visible so mistakes are easy to spot. Defaults preserve the historical
// copy, so untouched installs keep sending exactly what they always have.

export interface EmailTemplateDef {
  key: string;
  label: string;
  description: string;
  tags: { tag: string; label: string }[];
  subject: string;
  body: string;
  /**
   * Tags whose values are free text a person typed (a title, a name, a
   * change note, a reason): rendered as written in the body, never as
   * markdown or HTML, so "[x](https://evil.example)" in a change note is
   * those characters in the mail and not a link. Tags not listed here are
   * substituted before the markdown pass, as they always were.
   */
  text?: string[];
  /**
   * Tags whose values are a sentence the sender builds around `text` tags
   * (1.18.3: ack_request's and ack_due's {{handbook_line}}, "It's in
   * **{{handbook_title}}**."): a `{{tag}}` inside the value that names one
   * of this template's `text` tags is filled in as that tag is (inert in
   * the markdown pass, escaped in the html part), so the sentence keeps its
   * markdown while the title it carries is never read as markdown. Nothing
   * else inside the value is substituted.
   */
  compose?: string[];
  /**
   * Documented tags that render blank when the sender passes no value
   * (1.18.3: the handbook tags, so a caller that predates them never shows
   * a raw {{handbook_line}}). Every other unknown tag stays visible.
   */
  optional?: string[];
  /**
   * 1.19.0: false when the recipients' personal notification settings do
   * not govern this email (an email-type notification channel's arbitrary
   * addresses): a footer's "Manage your notifications" link is left out.
   */
  manageLink?: false;
}

const T = (tag: string, label: string) => ({ tag, label });

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: "doc_update",
    label: "Document published / updated",
    description: "Sent to space subscribers when a document in their space is published or updated.",
    tags: [
      T("doc_title", "Document title"),
      T("space_name", "Space name"),
      T("actor_name", "Who made the change"),
      T("action", "published / updated"),
      T("doc_url", "Link to the document"),
      T("org_name", "Workspace name"),
      T("manage_url", "Manage-notifications link"),
    ],
    subject: "[{{space_name}}] {{doc_title}} was {{action}}",
    body:
      "**{{doc_title}}** was {{action}} in **{{space_name}}** by {{actor_name}}.\n\n" +
      "[Read the document]({{doc_url}})\n\n" +
      "You're getting this because you subscribe to the {{space_name}} space. " +
      "[Manage subscriptions]({{manage_url}})",
  },
  {
    key: "announcement",
    label: "Announcement",
    description: "Sent when an announcement is posted with email delivery turned on.",
    tags: [
      T("title", "Announcement title"),
      T("body", "Announcement body"),
      T("author_name", "Posted by"),
      T("org_name", "Workspace name"),
      T("dashboard_url", "Dashboard link"),
      T("level_prefix", "Urgency marker (critical/warning)"),
    ],
    subject: "{{level_prefix}}[{{org_name}}] {{title}}",
    body:
      "## {{title}}\n\n{{body}}\n\n— {{author_name}}\n\n" +
      "[See it on your dashboard]({{dashboard_url}})",
  },
  {
    key: "mention",
    label: "Comment @mention",
    description: "Sent to a user when someone @mentions them in a document comment.",
    tags: [
      T("author_name", "Who mentioned them"),
      T("doc_title", "Document title"),
      T("comment", "The comment text"),
      T("doc_url", "Link to the discussion"),
      T("org_name", "Workspace name"),
      T("manage_url", "Manage-notifications link"),
    ],
    subject: '[{{org_name}}] {{author_name}} mentioned you in "{{doc_title}}"',
    body:
      "**{{author_name}}** mentioned you in a comment on **{{doc_title}}**:\n\n" +
      "> {{comment}}\n\n" +
      "[View the document and reply]({{doc_url}})\n\n" +
      "[Manage notification emails]({{manage_url}})",
  },
  {
    key: "ack_request",
    label: "Read confirmation request",
    description:
      "Sent when someone asks people to read and confirm a policy, reminds them, or changes a policy they had confirmed. Sent regardless of personal notification settings.",
    // 1.10.1 (H1): one template for every read-confirmation notice. The
    // mode-specific tags are blank when they do not apply, so a line that
    // holds only {{change_note}} or {{reason}} disappears from the rendered
    // mail. A workspace that overrode this template keeps its own body and
    // adopts the new tags and the final sentence when it next edits it.
    tags: [
      T("requester_name", "Who asked (or who made the change)"),
      T("doc_title", "Policy title"),
      T("doc_url", "Link to the policy (lands on the confirmation card)"),
      T("request_type", "requested / sent a reminder / changed the document and asks again / asks again"),
      T("request_label", "Action required / Reminder / Updated / Annual re-confirmation"),
      T("change_note", "What changed (blank unless the document changed)"),
      T("reason", "Why you are asked again (blank unless someone gave a reason)"),
      T("due_date", "Confirm-by date (blank when there is none)"),
      T("due_line", 'The sentence "Please confirm by 29 Oct 2026." (blank when there is no due date)'),
      T("due_suffix", 'Subject ending " by 29 Oct 2026" (blank when there is no due date)'),
      T("days_left", "Days until the due date (blank when there is none)"),
      T("handbook_title", "The handbook the person reads the policy in (blank unless they read it only through a handbook)"),
      T("handbook_line", 'The sentence "It\'s in Employee Handbook." (blank unless they read it only through a handbook)'),
      T("org_name", "Workspace name"),
    ],
    // 1.13.0 (E1): the due tags come from each recipient's own assignment row,
    // so one fan-out may render as several mails when people's dates differ.
    // 1.18.3: so do the handbook tags and {{doc_url}}: a person who cannot
    // open the policy's space but reads it through a published handbook is
    // sent into the handbook, and their mail names it. An override saved
    // before 1.18.3 has no {{handbook_line}} and simply leaves it out.
    text: ["requester_name", "doc_title", "change_note", "reason", "handbook_title"],
    compose: ["handbook_line"],
    optional: ["handbook_line", "handbook_title"],
    subject: '[{{org_name}}] {{request_label}}: confirm "{{doc_title}}"{{due_suffix}}',
    body:
      "**{{requester_name}}** {{request_type}} that you read and confirm:\n\n" +
      "> **{{doc_title}}**\n\n" +
      "{{handbook_line}}\n\n" +
      "{{change_note}}{{reason}}\n\n" +
      "{{due_line}}\n\n" +
      "[Open the document]({{doc_url}}) and confirm at the end that you have read and understood it.",
  },
  // 1.13.0 (E2): the hourly sweep's own notices. Like ack_request they go
  // out regardless of the personal master switch; the per-event email
  // choice (Policy reminders, Compliance escalations) is honoured.
  {
    key: "ack_due",
    label: "Read confirmation due reminder",
    description:
      "Sent automatically when a policy someone must confirm is due soon or overdue (per the policy's reminder cadence). Sent regardless of personal notification settings.",
    tags: [
      T("doc_title", "Policy title"),
      T("doc_url", "Link to the policy (lands on the confirmation card)"),
      T("due_date", "Due date (blank when the policy has no deadline)"),
      T("due_line", 'The sentence "Please confirm by 29 Oct 2026." (blank when there is no due date)'),
      T("status_label", "Due soon / Overdue / Reminder"),
      T("handbook_title", "The handbook the person reads the policy in (blank unless they read it only through a handbook)"),
      T("handbook_line", 'The sentence "It\'s in Employee Handbook." (blank unless they read it only through a handbook)'),
      T("org_name", "Workspace name"),
    ],
    // 1.18.3: the handbook tags and {{doc_url}} are each person's, as on ack_request.
    text: ["doc_title", "handbook_title"],
    compose: ["handbook_line"],
    optional: ["handbook_line", "handbook_title"],
    subject: '[{{org_name}}] {{status_label}}: confirm "{{doc_title}}"',
    body:
      "**{{status_label}}**: you still need to read and confirm **{{doc_title}}**.\n\n" +
      "{{handbook_line}}\n\n" +
      "{{due_line}}\n\n" +
      "[Open the document]({{doc_url}}) and confirm at the end that you have read and understood it.",
  },
  {
    key: "ack_due_bundle",
    label: "Read confirmation reminders, bundled",
    description:
      "Sent instead of several due reminders when one person has more than three policies to confirm in the same hour. Sent regardless of personal notification settings.",
    tags: [
      T("count", "How many policies"),
      T("policy_list", "The policies, one per line, with their due dates and, for one read through a handbook, \"(in {handbook})\""),
      T("portal_url", "Link to My policies"),
      T("org_name", "Workspace name"),
    ],
    text: ["policy_list"],
    subject: "[{{org_name}}] You have {{count}} policies to confirm",
    body:
      "You have **{{count}}** policies to read and confirm:\n\n" +
      "{{policy_list}}\n\n" +
      "[Open My policies]({{portal_url}}) to see where you stand and confirm each one at the end of the document.",
  },
  {
    key: "ack_escalation",
    label: "Overdue read confirmations, escalation",
    description:
      "Sent to a policy's owner (or whoever switched the requirement on, or the space's approvers) and to the overdue people's group leads once someone is past the escalation threshold. Sent regardless of personal notification settings.",
    tags: [
      T("policy_title", "Policy title"),
      T("overdue_count", "How many people are overdue"),
      T("overdue_list", "The overdue people, one per line, with their due dates"),
      T("portal_url", "Link to the policy: its row in the compliance portal for an owner or approver who holds the Compliance section, else its Record tab; the document itself for a group lead"),
      T("org_name", "Workspace name"),
    ],
    text: ["policy_title", "overdue_list"],
    subject: '[{{org_name}}] {{overdue_count}} overdue on "{{policy_title}}"',
    body:
      "**{{overdue_count}}** overdue on **{{policy_title}}**:\n\n" +
      "{{overdue_list}}\n\n" +
      "[Open the compliance portal]({{portal_url}}) to remind them, extend a due date or record an exemption.",
  },
  {
    key: "ack_welcome",
    label: "Welcome: policies to read",
    description:
      "Sent once to a new account that is enrolled in more than one policy, listing every policy they must read and confirm with its due date, instead of one request per policy. Sent regardless of personal notification settings.",
    // 1.13.0 (D1): the list is a text tag, one policy per line, so a title
    // is never read as markdown.
    tags: [
      T("count", "How many policies"),
      T("policy_list", "The policies, one per line, with their due dates and, for one read through a handbook, \"(in {handbook})\""),
      T("portal_url", "Link to My policies"),
      T("org_name", "Workspace name"),
    ],
    text: ["policy_list"],
    subject: "[{{org_name}}] Welcome: {{count}} policies to read",
    body:
      "Welcome. You have **{{count}}** policies to read and confirm:\n\n" +
      "{{policy_list}}\n\n" +
      "[Open My policies]({{portal_url}}) to read each one and confirm at the end that you have read and understood it.",
  },
  {
    key: "ack_program_report",
    label: "Compliance programme report",
    description:
      "Sent weekly or monthly to the recipients chosen under Compliance → Settings when the scheduled report is enabled: where read confirmations stand, with the hash of the latest monthly snapshot so it is anchored outside the database.",
    tags: [
      T("period", "The report period (2026-W42 or 2026-10)"),
      T("summary", "The report body (compliance, overdue people, lowest policies, deadlines)"),
      T("snapshot_sha256", "SHA-256 of the latest monthly snapshot (empty before the first)"),
      T("snapshot_label", "Which monthly snapshot the hash belongs to (2026-10)"),
      T("portal_url", "Link to Compliance → Evidence"),
      T("org_name", "Workspace name"),
    ],
    subject: "[{{org_name}}] Compliance report: {{period}}",
    body:
      "Here's where read confirmations stand for **{{period}}**:\n\n{{summary}}\n\n" +
      "Latest monthly snapshot {{snapshot_label}}: `{{snapshot_sha256}}`\n\n" +
      "[Open Compliance → Evidence]({{portal_url}}) to verify the snapshot or download the audit package.",
  },
  {
    key: "training_assigned",
    label: "Training assigned",
    description:
      "Sent when a training deck is assigned to someone (manually or automatically for new members).",
    tags: [
      T("assigner_name", "Who assigned it"),
      T("deck_title", "Training title"),
      T("due_line", "Due date sentence (or empty)"),
      T("training_url", "Link to My Training"),
      T("org_name", "Workspace name"),
    ],
    subject: '[{{org_name}}] Training assigned: "{{deck_title}}"',
    body:
      "**{{assigner_name}}** assigned you the training **{{deck_title}}**.{{due_line}}\n\n" +
      "[Open your training]({{training_url}}) — work through the slides and confirm at the end.",
  },
  {
    key: "training_due",
    label: "Training due reminder",
    description:
      "Sent when an assigned training is due within 3 days or overdue (at most every 3 days per assignment).",
    tags: [
      T("deck_title", "Training title"),
      T("due_date", "Due date"),
      T("training_url", "Link to My Training"),
      T("org_name", "Workspace name"),
    ],
    subject: '[{{org_name}}] Training due: "{{deck_title}}"',
    body:
      "Your assigned training **{{deck_title}}** is due by **{{due_date}}**.\n\n" +
      "[Open your training]({{training_url}}) to finish the remaining slides and confirm completion.",
  },
  {
    key: "training_report",
    label: "Monthly training report",
    description:
      "Sent monthly to the recipients chosen under Training → Overview when the scheduled report is enabled.",
    tags: [
      T("month", "Report month (YYYY-MM)"),
      T("summary", "The report body (completion, overdue, lowest decks)"),
      T("training_url", "Link to the training console"),
      T("org_name", "Workspace name"),
    ],
    subject: "[{{org_name}}] Training report — {{month}}",
    body:
      "Here's where training stands as of the {{month}} snapshot:\n\n{{summary}}\n\n" +
      "[Open the training console]({{training_url}}) for the full picture — the matching " +
      "point-in-time snapshot (with its SHA-256) is stored under Overview → Snapshots.",
  },
  {
    key: "training_team_digest",
    label: "Team digest (leads)",
    description:
      "Sent weekly to each group lead summarizing where their team stands: training when it is licensed, policies to confirm when read confirmations are licensed and Program settings let leads see them. An override saved before 1.14.0 must add {{policy_summary}} to show the policies section.",
    tags: [
      T("lead_name", "The lead's name"),
      T("summary", "Per-team training lines (blank when training is not licensed)"),
      T("policy_summary", "Per-team policy lines with the most overdue people (blank when not licensed or leads do not see policies)"),
      T("team_url", "Link to the team view"),
      T("org_name", "Workspace name"),
    ],
    subject: "[{{org_name}}] Your team this week",
    body:
      "Hi {{lead_name}} — here's where your team stands:\n\n{{summary}}\n\n{{policy_summary}}\n\n" +
      "[Open your team view]({{team_url}}) to see who's behind and nudge them along.",
  },
  {
    key: "workflow_event",
    label: "Workflow event (email channel)",
    description:
      "Sent to email-type notification channels for review/publish/suggestion events (Settings → Notifications).",
    tags: [
      T("event", "Event name"),
      T("summary", "What happened"),
      T("title", "Document / item title"),
      T("url", "Link"),
      T("org_name", "Workspace name"),
    ],
    subject: "CompassDocs — {{event}}: {{title}}",
    body: "{{summary}}\n\n[Open in CompassDocs]({{url}})",
    // Sent to whatever addresses the channel lists, which personal settings don't govern.
    manageLink: false,
  },
  {
    key: "review_due",
    label: "Content review due",
    description:
      "Sent to approvers and admins when a document with a review schedule comes due (once per due date).",
    tags: [
      T("doc_title", "Document title"),
      T("space_name", "Space name"),
      T("due_date", "Review due date"),
      T("doc_url", "Link to the document"),
      T("org_name", "Workspace name"),
    ],
    subject: '[{{org_name}}] Review due: "{{doc_title}}"',
    body:
      "**{{doc_title}}** (in {{space_name}}) is due for its periodic content review as of {{due_date}}.\n\n" +
      "[Open the document]({{doc_url}}), check that it's still accurate, and mark it as reviewed — " +
      "or update it, which resets the review clock automatically.",
  },
  // Helpdesk (1.19.0, Enterprise "helpdesk"): lib/helpdesk/email sends these.
  // Every value a person typed (a subject, a name, a message, a note) is a
  // `text` tag, so "**Urgent** [x](https://evil.example)" in a subject is
  // those characters in the mail. {{thread_ref}} ("[#1047 ref:…]") is what
  // threads a reply back into the ticket; the sender also puts the token in
  // the Reply-To address, so an override that drops it still threads.
  {
    key: "hd_request_received",
    label: "Helpdesk: request received",
    description: "Sent to the requester when their request is created (from Get help, the desk or by email).",
    tags: [
      T("ticket_number", "Request number (1047)"),
      T("subject", "Request subject"),
      T("request_type", "Request type (blank for a plain question)"),
      T("team_name", "Team handling it"),
      T("eta_line", 'The sentence "We usually reply within 4 hours." (blank when unknown)'),
      T("ticket_url", "Link to the request in Get help"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "request_type", "team_name"],
    optional: ["request_type", "eta_line"],
    subject: "[{{org_name}}] Request #{{ticket_number}} received: {{subject}} {{thread_ref}}",
    body:
      "We've got your request **#{{ticket_number}}**:\n\n" +
      "> {{subject}}\n\n" +
      "{{team_name}} will pick it up. {{eta_line}}\n\n" +
      "[Follow your request]({{ticket_url}}) or reply to this email to add more detail.",
  },
  {
    key: "hd_reply",
    label: "Helpdesk: new reply",
    description:
      "Sent to the requester when an agent replies (with the people copied on the request on Cc), and to the assignee (or the team) when the requester or a CC replies. Replying to the email adds to the ticket.",
    tags: [
      T("ticket_number", "Ticket number"),
      T("subject", "Ticket subject"),
      T("author_name", "Who wrote the reply"),
      T("message", "The reply text"),
      T("ticket_url", "Link to the request (requester) or the ticket in the desk (agent)"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "author_name", "message"],
    subject: "[{{org_name}}] Re: {{subject}} {{thread_ref}}",
    body:
      "**{{author_name}}** replied on **#{{ticket_number}}**:\n\n" +
      "{{message}}\n\n" +
      "[Open #{{ticket_number}}]({{ticket_url}}) or reply to this email.",
  },
  {
    key: "hd_assigned",
    label: "Helpdesk: ticket assigned",
    description: "Sent to an agent when a ticket is assigned to them.",
    tags: [
      T("ticket_number", "Ticket number"),
      T("subject", "Ticket subject"),
      T("requester_name", "Who asked"),
      T("assigner_name", "Who assigned it (or Automation)"),
      T("priority_label", "Priority (Low / Normal / High / Urgent)"),
      T("team_name", "Team"),
      T("ticket_url", "Link to the ticket in the desk"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "requester_name", "assigner_name", "team_name"],
    subject: "[{{org_name}}] Assigned to you: #{{ticket_number}} {{subject}} {{thread_ref}}",
    body:
      "**{{assigner_name}}** assigned you **#{{ticket_number}}** from {{requester_name}}:\n\n" +
      "> {{subject}}\n\n" +
      "Priority: **{{priority_label}}** · Team: {{team_name}}\n\n" +
      "[Open the ticket]({{ticket_url}})",
  },
  {
    key: "hd_approval_needed",
    label: "Helpdesk: approval needed",
    description: "Sent to the approver (a person, the requester's manager or each member of a team) when a request waits for their decision.",
    tags: [
      T("ticket_number", "Request number"),
      T("subject", "Request subject"),
      T("requester_name", "Who asked"),
      T("request_type", "Request type"),
      T("step_title", "The approval step (HR approves the hire)"),
      T("answers", "The form answers, one per line"),
      T("approvals_url", "Link to Approvals"),
      T("reminder_prefix", 'Subject prefix "Reminder: " on a reminder (blank otherwise)'),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "requester_name", "request_type", "step_title", "answers"],
    optional: ["reminder_prefix", "answers"],
    subject: "[{{org_name}}] {{reminder_prefix}}Approval needed: {{subject}} (#{{ticket_number}})",
    body:
      "**{{requester_name}}** needs your decision on **#{{ticket_number}}**:\n\n" +
      "> {{subject}}\n\n" +
      "{{step_title}} · {{request_type}}\n\n" +
      "{{answers}}\n\n" +
      "[Approve or decline]({{approvals_url}})",
  },
  {
    key: "hd_approval_decided",
    label: "Helpdesk: approval decided",
    description: "Sent to the requester when an approver approves or declines their request.",
    tags: [
      T("ticket_number", "Request number"),
      T("subject", "Request subject"),
      T("decision_label", "Approved / Declined (the subject's word)"),
      T("decision_verb", "approved / declined (the body's word)"),
      T("approver_name", "Who decided"),
      T("note", "The approver's note (blank when none)"),
      T("next_line", "What happens next"),
      T("ticket_url", "Link to the request"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "approver_name", "note"],
    optional: ["note", "next_line"],
    subject: "[{{org_name}}] {{decision_label}}: {{subject}} {{thread_ref}}",
    body:
      "**{{approver_name}}** {{decision_verb}} your request **#{{ticket_number}}**:\n\n" +
      "> {{subject}}\n\n" +
      "{{note}}\n\n" +
      "{{next_line}}\n\n" +
      "[Follow your request]({{ticket_url}})",
  },
  {
    key: "hd_task_assigned",
    label: "Helpdesk: workflow task",
    description: "Sent to a team (or the assignee) when a workflow creates a task for them.",
    tags: [
      T("ticket_number", "Task ticket number"),
      T("subject", "Task subject"),
      T("parent_number", "The request the task belongs to"),
      T("team_name", "Team"),
      T("due_line", 'The sentence "Due by Fri 14 Nov." (blank when there is no due date)'),
      T("ticket_url", "Link to the task in the desk"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "team_name"],
    optional: ["due_line"],
    subject: "[{{org_name}}] New task for {{team_name}}: {{subject}} {{thread_ref}}",
    body:
      "A workflow on request **#{{parent_number}}** needs **{{team_name}}**:\n\n" +
      "> {{subject}}\n\n" +
      "{{due_line}}\n\n" +
      "[Open task #{{ticket_number}}]({{ticket_url}}) and solve it when it's done.",
  },
  {
    key: "hd_solved_csat",
    label: "Helpdesk: request solved",
    description:
      "Sent to the requester when their request is solved. When satisfaction surveys are on, it asks one question with a rating from 1 to 5.",
    tags: [
      T("ticket_number", "Request number"),
      T("subject", "Request subject"),
      T("agent_name", "Who solved it"),
      T("csat_block", "The rating question with its links: 1 to 5 in Get help, Good / OK / Not good for customer portal requests (blank when surveys are off or it is already rated)"),
      T("ticket_url", "Link to the request"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "agent_name"],
    optional: ["csat_block"],
    subject: "[{{org_name}}] Solved: {{subject}} {{thread_ref}}",
    body:
      "**{{agent_name}}** marked your request **#{{ticket_number}}** as solved:\n\n" +
      "> {{subject}}\n\n" +
      "{{csat_block}}\n\n" +
      "Not fixed? [Open the request]({{ticket_url}}) or reply to this email and it reopens.",
  },
  {
    key: "hd_workflow_notify",
    label: "Helpdesk: workflow message",
    description: "Sent by a workflow's Notify step to the requester, a person or a team.",
    tags: [
      T("ticket_number", "Request number"),
      T("subject", "Request subject"),
      T("title", "The step's title (Tell the manager)"),
      T("message", "The step's message, placeholders filled"),
      T("ticket_url", "Link to the request (requester) or the ticket in the desk (others)"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "title", "message"],
    subject: "[{{org_name}}] {{title}}: {{subject}} {{thread_ref}}",
    body:
      "**{{title}}** on **#{{ticket_number}}**:\n\n" +
      "{{message}}\n\n" +
      "[Open #{{ticket_number}}]({{ticket_url}})",
  },
  {
    key: "hd_sla_warning",
    label: "Helpdesk: SLA nearing",
    description: "Sent to the assignee (or the team's leads) when a ticket's reply or resolution target is close.",
    tags: [
      T("ticket_number", "Ticket number"),
      T("subject", "Ticket subject"),
      T("target_label", "first reply / resolution"),
      T("due_time", "When the target is due"),
      T("priority_label", "Priority"),
      T("ticket_url", "Link to the ticket in the desk"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject"],
    subject: "[{{org_name}}] Due soon: #{{ticket_number}} {{subject}} {{thread_ref}}",
    body:
      "The **{{target_label}}** target on **#{{ticket_number}}** ({{priority_label}}) is due **{{due_time}}**:\n\n" +
      "> {{subject}}\n\n" +
      "[Open the ticket]({{ticket_url}})",
  },
  {
    key: "hd_sla_breach",
    label: "Helpdesk: SLA breached",
    description: "Sent to the assignee and the team's leads when a ticket misses its reply or resolution target.",
    tags: [
      T("ticket_number", "Ticket number"),
      T("subject", "Ticket subject"),
      T("target_label", "first reply / resolution"),
      T("due_time", "When the target was due"),
      T("priority_label", "Priority"),
      T("ticket_url", "Link to the ticket in the desk"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject"],
    subject: "[{{org_name}}] Overdue: #{{ticket_number}} {{subject}} {{thread_ref}}",
    body:
      "**#{{ticket_number}}** ({{priority_label}}) missed its **{{target_label}}** target, due {{due_time}}:\n\n" +
      "> {{subject}}\n\n" +
      "[Open the ticket]({{ticket_url}})",
  },
  {
    // Agent K (reports): a scheduled dashboard summary. {{summary}} is a
    // table the reports build with every typed name escaped.
    key: "hd_report_digest",
    label: "Helpdesk: report digest",
    description: "A scheduled summary of a desk dashboard, sent to the people and teams on its schedule. Each person sees only the numbers they may report on.",
    tags: [
      T("dashboard_name", "Dashboard name"),
      T("period_label", "The period covered (Last week, 3 to 9 November)"),
      T("summary", "The dashboard's numbers as a table"),
      T("download_line", "A link to the CSV or PDF, when the schedule sends one"),
      T("dashboard_url", "Link to the dashboard in the desk"),
      T("org_name", "Workspace name"),
    ],
    text: ["dashboard_name", "period_label"],
    optional: ["download_line"],
    subject: "[{{org_name}}] {{dashboard_name}}: {{period_label}}",
    body:
      "Your **{{dashboard_name}}** report for **{{period_label}}**:\n\n" +
      "{{summary}}\n\n" +
      "{{download_line}}\n\n" +
      "[Open the dashboard]({{dashboard_url}})",
  },
  {
    key: "hd_internal_note",
    label: "Helpdesk: internal note",
    description:
      "Sent to the assignee when another agent adds an internal note. Only agents see notes; the email is not a reply thread, so answer in the desk.",
    tags: [
      T("ticket_number", "Ticket number"),
      T("subject", "Ticket subject"),
      T("author_name", "Who wrote the note"),
      T("message", "The note text"),
      T("ticket_url", "Link to the ticket in the desk"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject", "author_name", "message"],
    subject: "[{{org_name}}] Internal note on #{{ticket_number}}: {{subject}}",
    body:
      "**{{author_name}}** added an internal note on **#{{ticket_number}}**. Only agents see it.\n\n" +
      "{{message}}\n\n" +
      "[Open #{{ticket_number}} in the desk]({{ticket_url}}) to answer. Don't reply to this email: notes are not sent by email.",
  },
  {
    key: "hd_merged",
    label: "Helpdesk: requests joined",
    description:
      "Sent to the requester when an agent merges their request into another ticket about the same thing, if the agent chose to tell them. Replies go to the ticket it was joined with.",
    tags: [
      T("ticket_number", "The requester's request number (now closed)"),
      T("subject", "Request subject"),
      T("target_number", "The ticket it was joined with"),
      T("ticket_url", "Link to the request"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["subject"],
    subject: "[{{org_name}}] Your request #{{ticket_number}} was joined with #{{target_number}} {{thread_ref}}",
    body:
      "Your request **#{{ticket_number}}** has been joined with **#{{target_number}}** so one person can help with both:\n\n" +
      "> {{subject}}\n\n" +
      "Nothing is lost: your messages are now part of #{{target_number}}. Reply to this email to add to it, or [open your request]({{ticket_url}}).",
  },
  // 1.19.2 (agent W1, lib/helpdesk/incidents): a major incident's update to
  // everyone on a linked ticket and everyone who said "Me too" in Get help.
  {
    key: "hd_incident_update",
    label: "Helpdesk: major incident update",
    description:
      "Sent when the desk posts an update on a major incident: to the requester of every open linked ticket (with the people copied on it), and to people who said \"Me too\" in Get help. Replies from a linked ticket's requester go to their request.",
    tags: [
      T("incident_title", "The incident's title, as Get help shows it"),
      T("message", "The update"),
      T("team_name", "The team running the incident"),
      T("request_line", "\"(your request #1099 is part of it)\", blank for Me too"),
      T("link_label", "Open your request, or See it in Get help"),
      T("reply_line", "\"or reply to this email.\" when replies reach a request"),
      T("ticket_number", "The linked request's number (blank for Me too)"),
      T("ticket_url", "Link to the request, or to Get help"),
      T("thread_ref", "Thread reference for email replies"),
      T("org_name", "Workspace name"),
    ],
    text: ["incident_title", "message", "team_name", "request_line", "link_label", "reply_line"],
    optional: ["request_line", "reply_line", "ticket_number"],
    subject: "[{{org_name}}] Update: {{incident_title}} {{thread_ref}}",
    body:
      "**{{team_name}}** posted an update on **{{incident_title}}**{{request_line}}:\n\n" +
      "{{message}}\n\n" +
      "[{{link_label}}]({{ticket_url}}){{reply_line}}",
  },
  // 1.19.1 (agent V6, lib/helpdesk/portal): the customer portal's one-time
  // sign-in link. Its recipients have no account, so no "Manage your
  // notifications" link; it is sign-in mail, never held by preferences.
  {
    key: "hd_portal_link",
    label: "Helpdesk: customer portal sign-in link",
    description:
      "Sent to someone outside your organisation who asks to sign in to the customer portal. The link works once and for 15 minutes.",
    tags: [
      T("portal_name", "The portal's name (Desk settings, Customer portal)"),
      T("signin_url", "The one-time sign-in link"),
      T("minutes", "How long the link works, in minutes"),
      T("org_name", "The portal's name"),
    ],
    text: ["portal_name"],
    manageLink: false,
    subject: "Your sign-in link for {{portal_name}}",
    body:
      "Here's your link to sign in to **{{portal_name}}** and raise or follow your requests:\n\n" +
      "[Sign in to {{portal_name}}]({{signin_url}})\n\n" +
      "The link works once and for {{minutes}} minutes. If you didn't ask for it, you can ignore this email: nobody can sign in without it.",
  },
];

/**
 * The {{handbook_line}} value for a person who reads the policy only
 * through a handbook (1.18.3); a `compose` tag, so {{handbook_title}} inside
 * it is filled in as the text tag it is. Blank for everyone else.
 */
export const HANDBOOK_LINE = "It's in **{{handbook_title}}**.";

/** Realistic per-template values used by the admin preview pane. */
export const SAMPLE_VARS: Record<string, Record<string, string>> = {
  training_assigned: {
    assigner_name: "Jordan Admin",
    deck_title: "Security awareness onboarding",
    due_line: " It's due by Aug 14, 2026.",
    training_url: "https://docs.example.com/training",
  },
  training_due: {
    deck_title: "Security awareness onboarding",
    due_date: "Aug 14, 2026",
    training_url: "https://docs.example.com/training",
  },
  training_report: {
    month: "2026-08",
    summary:
      "- **4** active decks · **32** people with assignments\n" +
      "- **86%** overall completion (98 completed, 12 waived, 18 open)\n" +
      "- **5** overdue · **7** in the needs-attention queue",
    training_url: "https://docs.example.com/training",
  },
  training_team_digest: {
    lead_name: "Dana Whitfield",
    summary: "**Training**\n- **Support**: 14 done · 3 open · **2 overdue**\n- **Field ops**: 9 done · 1 open",
    policy_summary:
      "**Policies**\n- **Support**: 38 confirmed · 6 open · **2 overdue**\n- **Field ops**: 12 confirmed · 1 open\n\n" +
      "Most overdue:\n- Ana Ruiz · Code of conduct · due 3 Oct 2026\n- Ben Lo · Acceptable use · due 9 Oct 2026",
    team_url: "https://docs.example.com/compliance/team",
  },
  doc_update: {
    doc_title: "Remote Work Policy",
    space_name: "HR & People",
    actor_name: "Dana Whitfield",
    action: "updated",
    doc_url: "/doc/42",
    manage_url: "/account/notifications",
  },
  announcement: {
    title: "Office closed Friday",
    body: "The office is closed this Friday for the building's annual electrical inspection. Badge access will be disabled from 6 pm Thursday.",
    author_name: "Dana Whitfield",
    dashboard_url: "/",
    level_prefix: "",
  },
  mention: {
    author_name: "Marcus Chen",
    doc_title: "Incident Response Runbook",
    comment: "@you — can you confirm step 4 still matches how we page the on-call?",
    doc_url: "/doc/42#comments",
    manage_url: "/account/notifications",
  },
  ack_request: {
    requester_name: "Dana Whitfield",
    doc_title: "Code of Conduct",
    doc_url: "/doc/42#confirm-reading",
    request_type: "changed the document and asks again",
    request_label: "Updated",
    change_note: "Section 4 now covers contractors as well as employees.",
    reason: "",
    due_date: "29 Oct 2026",
    due_line: "Please confirm by 29 Oct 2026.",
    due_suffix: " by 29 Oct 2026",
    days_left: "9",
    handbook_title: "",
    handbook_line: "",
  },
  ack_due: {
    doc_title: "Acceptable Use Policy",
    doc_url: "/handbooks/7/42#confirm-reading",
    due_date: "29 Oct 2026",
    due_line: "Please confirm by 29 Oct 2026.",
    status_label: "Due soon",
    handbook_title: "Employee Handbook",
    handbook_line: HANDBOOK_LINE,
  },
  ack_due_bundle: {
    count: "5",
    policy_list:
      "- Acceptable Use Policy (due 29 Oct 2026)\n- Code of Conduct (overdue)\n- Expense policy (due 3 Nov 2026)\n- Remote Work Policy (due 3 Nov 2026)\n- Travel policy (due 10 Nov 2026)",
    portal_url: "/compliance",
  },
  ack_escalation: {
    policy_title: "Acceptable Use Policy",
    overdue_count: "7",
    overdue_list: "- Ana Ruiz (due 1 Oct 2026)\n- Ben Lo (due 1 Oct 2026)\n- Chloe Park (due 3 Oct 2026)",
    portal_url: "/compliance/policies?policy=42",
  },
  ack_welcome: {
    count: "3",
    policy_list: "- Code of Conduct (due 3 Nov 2026)\n- Acceptable Use Policy (due 3 Nov 2026)\n- Remote Work Policy (due 3 Nov 2026)",
    portal_url: "/compliance",
  },
  ack_program_report: {
    period: "2026-W42",
    summary:
      "- **28** policies · **94%** compliance (1,412 confirmed, 61 pending, 23 overdue, 9 exempt)\n" +
      "- **17** people overdue · **4** escalations this period · **6** new joiners enrolled · **3** exemptions granted · **4** standing exemptions older than a year\n\n" +
      "Lowest compliance:\n- Travel policy: 71% (12 overdue)\n- Expense policy: 82% (6 overdue)\n\n" +
      "Deadlines in the next 14 days:\n- Acceptable Use Policy: 40 people due by 29 Oct 2026",
    snapshot_sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    snapshot_label: "2026-09",
    portal_url: "/compliance/evidence",
  },
  workflow_event: {
    event: "Change approved",
    summary: 'Marcus Chen approved "Remote Work Policy" for publishing.',
    title: "Remote Work Policy",
    url: "/doc/42",
  },
  review_due: {
    doc_title: "Incident Response Runbook",
    space_name: "Engineering",
    due_date: "Jul 20, 2026",
    doc_url: "/doc/42",
  },
  hd_request_received: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    request_type: "Report a problem",
    team_name: "IT",
    eta_line: "We usually reply within 4 hours.",
    ticket_url: "/help/requests/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_reply: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    author_name: "Priya Shah",
    message: "Thanks Matthew. Can you try the new VPN profile I've just pushed and tell me if it still drops?",
    ticket_url: "/help/requests/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_assigned: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    requester_name: "Matthew Felix",
    assigner_name: "Dana Whitfield",
    priority_label: "High",
    team_name: "IT",
    ticket_url: "/desk/tickets/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_approval_needed: {
    ticket_number: "1052",
    subject: "Developer laptop for Daniel Okafor",
    requester_name: "Daniel Okafor",
    request_type: "New laptop or device",
    step_title: "Manager approves",
    answers: "- What do you need?: Developer laptop\n- Needed by: 14 Nov 2026",
    approvals_url: "/help/approvals",
    reminder_prefix: "",
  },
  hd_approval_decided: {
    ticket_number: "1052",
    subject: "Developer laptop for Daniel Okafor",
    decision_label: "Approved",
    decision_verb: "approved",
    approver_name: "Sara Haddad",
    note: "Approved, go for the 16-inch.",
    next_line: "IT will order and set it up next.",
    ticket_url: "/help/requests/1052",
    thread_ref: "[#1052 ref:p3m8vw2r6tqa1b2c]",
  },
  hd_task_assigned: {
    ticket_number: "1053",
    subject: "Laptop and accounts: New starter Ana Ruiz",
    parent_number: "1050",
    team_name: "IT",
    due_line: "Due by Fri 14 Nov 2026.",
    ticket_url: "/desk/tickets/1053",
    thread_ref: "[#1053 ref:h4n7cx1b8zqa1b2c]",
  },
  hd_solved_csat: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    agent_name: "Priya Shah",
    csat_block:
      "**How did we do?** [1](/help/requests/1047?rate=1) · [2](/help/requests/1047?rate=2) · " +
      "[3](/help/requests/1047?rate=3) · [4](/help/requests/1047?rate=4) · [5](/help/requests/1047?rate=5) (5 is best)",
    ticket_url: "/help/requests/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_workflow_notify: {
    ticket_number: "1050",
    subject: "New starter: Ana Ruiz",
    title: "Tell the manager",
    message: "Everything is ready for Ana's first day: laptop, desk and HR induction are booked.",
    ticket_url: "/help/requests/1050",
    thread_ref: "[#1050 ref:h4n7cx1b8zqa1b2c]",
  },
  hd_sla_warning: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    target_label: "first reply",
    due_time: "today at 14:30",
    priority_label: "High",
    ticket_url: "/desk/tickets/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_sla_breach: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    target_label: "first reply",
    due_time: "today at 14:30",
    priority_label: "High",
    ticket_url: "/desk/tickets/1047",
    thread_ref: "[#1047 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_report_digest: {
    dashboard_name: "Overview",
    period_label: "Last week (2 to 8 November)",
    summary:
      "| Measure | Value | Change |\n| --- | --- | --- |\n| Tickets created | 184 | +12% |\n| Tickets solved | 171 | +8% |\n" +
      "| First reply time (median) | 1h 20m | −15m |\n| Satisfaction (CSAT) | 92.4% | +1.8 pts |",
    download_line: "[Download the CSV](/api/helpdesk/analytics/dashboards/1/export?format=csv)",
    dashboard_url: "/desk/reports?d=1",
  },
  hd_internal_note: {
    ticket_number: "1047",
    subject: "VPN drops every few minutes",
    author_name: "Dana Whitfield",
    message: "Legal is reviewing the contract. Don't promise a date to the requester yet.",
    ticket_url: "/desk/tickets/1047",
  },
  hd_merged: {
    ticket_number: "1051",
    subject: "VPN disconnects on hotel wifi",
    target_number: "1049",
    ticket_url: "/help/requests/1051",
    thread_ref: "[#1051 ref:m2r8kq4v7xqa1b2c]",
  },
  hd_incident_update: {
    incident_title: "VPN is down from home",
    message: "We've found the cause: an expired certificate on the VPN gateway. A new one is going in now.",
    team_name: "IT Service Desk",
    request_line: " (your request #1099 is part of it)",
    link_label: "Open your request",
    reply_line: " or reply to this email.",
    ticket_number: "1099",
    ticket_url: "/help/requests/1099",
    thread_ref: "[#1099 ref:k7q2xz9m4pqa1b2c]",
  },
  hd_portal_link: {
    portal_name: "Acme Support",
    signin_url: "/support/signin?token=sample",
    minutes: "15",
  },
};

export function templateDef(key: string): EmailTemplateDef | undefined {
  return EMAIL_TEMPLATES.find((t) => t.key === key);
}

// 1.19.0: templates are composed from parts (lib/email-parts): a header, the
// event's body (subject + markdown, what these three functions used to
// store as the `email_tpl_<key>` setting), a signature and a footer. The
// old single-template API keeps working on the event's built-in body; the
// seed carried every stored override over into it.

/** The event's built-in body when it differs from the shipped default (null otherwise). */
export async function templateOverride(
  key: string
): Promise<{ subject: string; body: string } | null> {
  const def = templateDef(key);
  if (!def) return null;
  const { builtinBody } = await import("./email-parts");
  const body = await builtinBody(key);
  if (!body || (body.subject === def.subject && body.content === def.body)) return null;
  return { subject: body.subject, body: body.content };
}

/** Write the event's built-in body. */
export async function saveTemplateOverride(
  key: string,
  subject: string,
  body: string
): Promise<void> {
  if (!templateDef(key)) return;
  const { writeBuiltinBody } = await import("./email-parts");
  await writeBuiltinBody(key, subject, body);
}

/** Put the event's built-in body back to the shipped default. */
export async function resetTemplate(key: string): Promise<void> {
  const def = templateDef(key);
  if (!def) return;
  const { writeBuiltinBody } = await import("./email-parts");
  await writeBuiltinBody(key, def.subject, def.body);
}

// --- Tags every part may use (1.19.0) ----------------------------------------------

const TAG = (tag: string, label: string) => ({ tag, label });

/**
 * Filled in by renderEmail for every event and every part (a value the
 * sender passes wins). {{logo}} is the workspace logo as an image, or
 * nothing when there is none.
 */
export const COMMON_TAGS = [
  TAG("org_name", "Workspace name"),
  TAG("workspace_url", "Link to the workspace"),
  TAG("accent", "Accent colour (#4f46e5)"),
  TAG("logo", "Workspace logo (an image; blank when there is none)"),
  TAG("recipient_name", "The recipient's name (blank when the sender does not know it)"),
  TAG("manage_notifications_url", "Link to the recipient's notification settings"),
];
/** Signature extras: the person and team the mail comes from (blank when there is none). */
export const SIGNATURE_TAGS = [
  TAG("sender_name", "Who the mail is from"),
  TAG("sender_title", "Their job title (from the directory)"),
  TAG("team_name", "Their helpdesk team"),
];
/** Values a person typed: rendered as written, never as markdown, in every part. */
export const COMMON_TEXT_TAGS = ["recipient_name", "sender_name", "sender_title", "team_name"];
/** Also as written in headers, signatures and footers (a body keeps its event's own rules, as before 1.19.0). */
export const FRAME_TEXT_TAGS = ["org_name"];
/** Blank, never a raw {{tag}}, when the sender gives no value. */
export const COMMON_OPTIONAL_TAGS = ["recipient_name", "sender_name", "sender_title", "team_name"];

/** Values for the frame tags in the admin preview. */
export const SAMPLE_FRAME_VARS: Record<string, string> = {
  recipient_name: "Matthew Felix",
  sender_name: "Priya Shah",
  sender_title: "IT Support Lead",
  team_name: "IT",
};

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w]+)\s*\}\}/g, (whole, tag) =>
    tag in vars ? vars[tag] : whole
  );
}

/** Rough plain-text rendering of the markdown body (for the text/plain part). */
function mdToText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, label, url) => (label ? `${label}: ${url}` : url))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A value rendered as text inside the html part: escaped, with its line breaks kept. */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br>");
}

/**
 * Substitute and render one template. Tags the definition marks as `text`
 * go through the markdown pass as inert placeholders (letters and digits
 * only, which nothing in the pipeline touches) and are put back afterwards:
 * HTML-escaped in the html part, verbatim in the subject and the text part.
 * Every other tag is substituted before rendering; the result passes through
 * the same sanitize pipeline as newsletters. The newsletter path itself is
 * untouched.
 */
async function renderParts(
  def: EmailTemplateDef | undefined,
  subjectTpl: string,
  bodyTpl: string,
  vars: Record<string, string>,
  accent: string,
  origin: string,
  /** 1.19.0, frames only: the template the text part is made from (images and markup removed); the body's is bodyTpl, as before. */
  textTpl?: string
): Promise<{ subject: string; text: string; html: string }> {
  for (const tag of def?.optional ?? []) if (!(tag in vars)) vars = { ...vars, [tag]: "" };
  const bodyVars = { ...vars };
  const tokens: [string, string][] = [];
  for (const tag of def?.text ?? []) {
    if (!(tag in vars)) continue;
    const value = vars[tag];
    // An empty value stays empty, so a line that held only this tag still
    // disappears from the rendered mail (the ack_request change-note line).
    if (value === "") continue;
    const token = `CDTEXTTAG${tokens.length}X`;
    bodyVars[tag] = token;
    tokens.push([token, value]);
  }
  // A `compose` value names text tags inside it: they are filled in the way
  // the text tags themselves are (a token in the body, the raw value in the
  // subject), and nothing else inside the value is substituted.
  const subjectVars = { ...vars };
  const textTags = new Set(def?.text ?? []);
  const fill = (value: string, from: Record<string, string>) =>
    value.replace(/\{\{\s*([\w]+)\s*\}\}/g, (whole, tag) => (textTags.has(tag) && tag in from ? from[tag] : whole));
  // A subject is plain text, never markdown: the sentence's own emphasis
  // ("It's in **{{handbook_title}}**.") is dropped there before the title is
  // filled in, so an admin who puts {{handbook_line}} in a subject reads
  // "It's in Title." and a title's own characters are kept as typed.
  const plainSentence = (value: string) =>
    value
      .split(/(\{\{\s*[\w]+\s*\}\})/g)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(/\*\*|__|[*`]/g, "")))
      .join("");
  for (const tag of def?.compose ?? []) {
    if (!(tag in vars)) continue;
    bodyVars[tag] = fill(vars[tag], bodyVars);
    subjectVars[tag] = fill(plainSentence(vars[tag]), vars);
  }
  const bodyMd = substitute(bodyTpl, bodyVars);
  let html = await renderBodyHtml(bodyMd, accent, origin);
  let text = mdToText(textTpl === undefined ? bodyMd : substitute(textTpl, bodyVars));
  for (const [token, value] of tokens) {
    html = html.split(token).join(escapeHtmlText(value));
    text = text.split(token).join(value);
  }
  return { subject: substitute(subjectTpl, subjectVars), text, html };
}

/**
 * renderParts as it rendered every email before 1.19.0 (one subject, one
 * body): exported for the regression test that proves the default
 * compositions send the same bytes.
 */
export const renderSingleTemplate = renderParts;

export interface RenderEmailOptions {
  /**
   * Which composition to use: 'hd_team:<id>' for a helpdesk team's variant
   * (lib/helpdesk/email passes it when the ticket has a team). Falls back
   * to 'all', slot by slot.
   */
  scope?: string | null;
  /** The person the mail is from: {{sender_name}} and {{sender_title}} (their directory title) unless vars carry them. */
  senderUserId?: number | null;
  /**
   * Who the mail goes to, when the sender knows: a workspace user fills
   * {{recipient_name}} (unless vars carry it); an address that is not an
   * active account's (an outside requester) gets no "Manage your
   * notifications" link, since there are no settings to manage.
   */
  recipientUserId?: number | null;
  recipientEmail?: string | null;
  /** false: no "Manage your notifications" link (a mail to several people, some maybe outside the workspace). */
  manageLink?: false;
}

/** The four texts an email is built from (header/signature/footer may be empty). */
export interface ComposedTemplate {
  header: string;
  subject: string;
  body: string;
  signature: string;
  footer: string;
}

/** Stands in for {{logo}} through the markdown pass (letters only, like the text tokens). */
const LOGO_TOKEN = "CDLOGOTAGX";

/** The accent the frame paints with when the stored one is unusable (lib/settings' default). */
const FALLBACK_ACCENT = "#2e75bd";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The accent as #rrggbb, whatever shape it is stored in (hex, or the
 * "R G B" triplet the CSS tokens use): email clients understand no
 * variables, and the value lands inside a style attribute.
 */
export function accentHex(value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  const m = /^(?:rgb\()?\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)?$/i.exec(v);
  if (m && m.slice(1).every((n) => Number(n) <= 255)) {
    return `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return FALLBACK_ACCENT;
}

/** Account → Notifications, at the section that governs the event when there is one (agent I's anchors). */
function manageNotificationsUrl(base: string, eventKey: string): string {
  const section = NOTIFY_EVENTS.find((e) => e.templates?.includes(eventKey))?.section;
  return `${base}/account/notifications${section ? `#notify-${section.replace(/_/g, "-")}` : ""}`;
}

/** The tags every part gets: workspace, links, accent and the logo placeholder. A value the sender passes wins. */
function frameVars(key: string, vars: Record<string, string>, settings: AppSettings, origin: string): Record<string, string> {
  const base = origin || (settings.custom_domain ? `https://${settings.custom_domain}` : "");
  const brand: Record<string, string> = {
    org_name: settings.company_name || "CompassDocs",
    workspace_url: `${base}/`,
    accent: accentHex(settings.accent_color),
    manage_notifications_url: manageNotificationsUrl(base, key),
    logo: LOGO_TOKEN,
  };
  return { ...brand, ...vars };
}

function logoHtml(settings: AppSettings, origin: string, orgName: string): string {
  const url = (settings.logo_url || "").trim();
  if (!url) return "";
  const abs = url.startsWith("/") && !url.startsWith("//") ? `${origin}${url}` : url;
  if (!/^(https?:|data:image\/)/i.test(abs) && !abs.startsWith("/")) return "";
  return (
    `<img src="${escapeAttr(abs)}" alt="${escapeAttr(orgName)}" width="28" height="28" ` +
    `style="display:inline-block;width:28px;height:28px;border:0;vertical-align:middle;border-radius:6px;margin-right:8px">`
  );
}

/** The event's rules plus the tags every part shares; frames also render the workspace name as written. */
function partDef(def: EmailTemplateDef | undefined, frame: boolean): EmailTemplateDef {
  const base: EmailTemplateDef = def ?? { key: "", label: "", description: "", tags: [], subject: "", body: "" };
  const text = new Set([...(base.text ?? []), ...COMMON_TEXT_TAGS, ...(frame ? FRAME_TEXT_TAGS : [])]);
  const optional = new Set([...(base.optional ?? []), ...COMMON_OPTIONAL_TAGS]);
  return { ...base, text: [...text], optional: [...optional] };
}

/** True when a rendered part shows nothing (a signature whose only tag was blank). */
function blankHtml(html: string): boolean {
  return !/<img\b/i.test(html) && html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "") === "";
}

const MANAGE_TAG = /\{\{\s*manage_(?:notifications_)?url\s*\}\}/;
const MANAGE_LINK = /!?\[[^\]]*\]\(\s*\{\{\s*manage_notifications_url\s*\}\}\s*\)|\{\{\s*manage_notifications_url\s*\}\}/g;

/**
 * A header, signature or footer without its "Manage your notifications"
 * link: the link goes, and so does the " · " that joined it to the rest of
 * its line (a line left empty goes too). Other lines are untouched.
 */
export function withoutManageLink(content: string): string {
  return content
    .split("\n")
    .flatMap((line) => {
      if (!line.match(MANAGE_LINK)) return [line];
      const indent = /^[ \t]*/.exec(line)![0];
      const rest = line
        .replace(MANAGE_LINK, "")
        .replace(/[ \t]*(?:[·•][ \t]*)*$/, "")
        .replace(/^[ \t]*(?:[·•][ \t]*)*/, indent)
        .replace(/[ \t]*(?:[·•][ \t]*){2,}/g, " · ");
      return rest.trim() ? [rest] : [];
    })
    .join("\n");
}

/** What a frame's text part is made from: images become their alt text, HTML tags go. */
function frameTextSource(content: string): string {
  return content.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<\/?[a-z][^>]*>/gi, "");
}

/** A frame's last paragraph needs no bottom margin: the frame's own padding spaces it. */
function tightFrame(html: string): string {
  const at = html.lastIndexOf('<p style="margin:0 0 12px;');
  return at < 0 ? html : `${html.slice(0, at)}<p style="margin:0;${html.slice(at + '<p style="margin:0 0 12px;'.length)}`;
}

const FRAME_FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TABLE_ATTRS = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

/**
 * The layout around a framed email (1.19.0): a centred column of at most
 * 600px, built from tables with inline styles only (what every mail client
 * renders, Outlook included). No background or text colour is set on the
 * column, so a client's dark mode recolours it like any plain mail; the
 * only fixed colours are the accent rule under the header, a hairline and
 * the footer's mid-grey (#64748b, readable on light and dark). With no
 * header, signature or footer the body is returned as it is, byte for byte.
 * The body's html sits untouched in its own cell.
 */
export function frameEmailHtml(
  parts: { header?: string | null; body: string; signature?: string | null; footer?: string | null },
  accent: string
): string {
  const { header, body, signature, footer } = parts;
  if (!header && !signature && !footer) return body;
  const rule = accentHex(accent);
  const rows: string[] = [];
  if (header) {
    rows.push(`<tr><td style="padding:0 0 12px;border-bottom:3px solid ${rule};font-size:16px;line-height:1.4">${header}</td></tr>`);
  }
  rows.push(`<tr><td style="padding:${header ? "20px" : "0"} 0 0">${body}</td></tr>`);
  if (signature) rows.push(`<tr><td style="padding:16px 0 0">${signature}</td></tr>`);
  if (footer) {
    rows.push(
      `<tr><td style="padding:24px 0 0"><table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse"><tr>` +
        `<td style="padding:12px 0 0;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#64748b">${footer}</td>` +
        `</tr></table></td></tr>`
    );
  }
  return (
    `<table ${TABLE_ATTRS} width="100%" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:0">` +
    `<table ${TABLE_ATTRS} width="600" style="width:100%;max-width:600px;border-collapse:collapse;text-align:left;font-family:${FRAME_FONT}">` +
    rows.join("") +
    `</table></td></tr></table>`
  );
}

export interface ComposeOptions {
  /** False: no "Manage your notifications" link in any frame (an outside recipient). */
  manageLink?: boolean;
}

/**
 * Render a composed email: the body as every email rendered before 1.19.0
 * (renderParts, with the event's text/compose/optional rules), and each
 * non-empty header, signature and footer through the same pipeline (the
 * event's tags, escaping and accent, plus the shared frame tags), laid out
 * by frameEmailHtml. With all three empty the html and text are exactly
 * the body's, byte for byte. The text part joins the parts' text with
 * blank lines; a frame's text has no markdown, image or HTML syntax, and no
 * logo.
 *
 * The frames leave out their "Manage your notifications" link when the
 * recipient has no account (opts.manageLink false), when the event says
 * personal settings don't govern it (def.manageLink false) and when the
 * body already carries its own manage link (doc_update, mention), so it is
 * never there twice.
 */
export async function renderComposedEmail(
  key: string,
  parts: ComposedTemplate,
  vars: Record<string, string>,
  origin: string,
  settings?: AppSettings,
  opts?: ComposeOptions
): Promise<{ subject: string; text: string; html: string }> {
  const def = templateDef(key);
  const s = settings ?? (await getAppSettings());
  const accent = s.accent_color;
  const all = frameVars(key, vars, s, origin);
  const logo = logoHtml(s, origin, all.org_name);
  const putLogo = (html: string) => html.split(LOGO_TOKEN).join(logo);
  const dropLogo = (t: string) => t.split(LOGO_TOKEN).join("").replace(/^[ \t]+/gm, "").trim();
  const manage =
    opts?.manageLink !== false && def?.manageLink !== false && !MANAGE_TAG.test(parts.body) && all.manage_notifications_url !== "";

  const body = await renderParts(partDef(def, false), parts.subject, parts.body, all, accent, origin);
  const frame = async (raw: string) => {
    const content = manage ? raw : withoutManageLink(raw);
    if (!content.trim()) return null;
    const r = await renderParts(partDef(def, true), "", content, all, accentHex(accent), origin, frameTextSource(content));
    const html = tightFrame(putLogo(r.html));
    if (blankHtml(html)) return null;
    return { html, text: dropLogo(r.text) };
  };
  const [header, signature, footer] = await Promise.all([frame(parts.header), frame(parts.signature), frame(parts.footer)]);

  const html = frameEmailHtml(
    { header: header?.html, body: putLogo(body.html), signature: signature?.html, footer: footer?.html },
    accent
  );
  const bodyText = body.text.includes(LOGO_TOKEN) ? dropLogo(body.text) : body.text;
  const text = [header?.text, bodyText, signature?.text, footer?.text].filter((t) => t).join("\n\n");
  const subject = body.subject.split(LOGO_TOKEN).join("");
  return { subject, text, html };
}

/**
 * Render an email through its composition (header + body + signature +
 * footer, lib/email-parts) for the event and, when given, the helpdesk
 * team scope. Values are substituted before markdown rendering (the
 * template's `text` tags as written, see renderParts); the result passes
 * through the same sanitize pipeline as newsletters, so tag values can't
 * inject HTML that survives.
 */
export async function renderEmail(
  key: string,
  vars: Record<string, string>,
  origin: string,
  opts?: RenderEmailOptions
): Promise<{ subject: string; text: string; html: string }> {
  const def = templateDef(key);
  if (!def) throw new Error(`Unknown email template: ${key}`);
  const parts: ComposedTemplate = { header: "", subject: def.subject, body: def.body, signature: "", footer: "" };
  let manageLink = opts?.manageLink !== false;
  try {
    const { resolveComposition, senderDetails, recipientDetails } = await import("./email-parts");
    const c = await resolveComposition(key, opts?.scope);
    // As before: an empty subject or body falls back to the shipped default.
    parts.subject = c.body?.subject || def.subject;
    parts.body = c.body?.content || def.body;
    parts.header = c.header?.content ?? "";
    parts.signature = c.signature?.content ?? "";
    parts.footer = c.footer?.content ?? "";
    if (opts?.senderUserId && (!("sender_name" in vars) || !("sender_title" in vars))) {
      const who = await senderDetails(opts.senderUserId);
      if (who) vars = { sender_name: who.name, sender_title: who.title, ...vars };
    }
    if (opts?.recipientUserId || opts?.recipientEmail) {
      const to = await recipientDetails({ userId: opts.recipientUserId, email: opts.recipientEmail });
      if (to) vars = { recipient_name: to.name, ...vars };
      else manageLink = false;
    }
  } catch (e) {
    // The mail still goes out with the shipped default rather than not at all.
    console.error(`[email-templates] composition for ${key} failed:`, e);
  }
  const settings = await getAppSettings();
  if (!("org_name" in vars)) {
    vars = { ...vars, org_name: settings.company_name || "CompassDocs" };
  }
  return renderComposedEmail(key, parts, vars, origin, settings, { manageLink });
}

/**
 * Render arbitrary (unsaved) subject/body with the template's sample values,
 * framed by the event's header, signature and footer: the live preview in
 * the admin editor.
 */
export async function previewEmail(
  key: string,
  subject: string,
  body: string,
  origin: string
): Promise<{ subject: string; html: string }> {
  const settings = await getAppSettings();
  const vars = {
    org_name: settings.company_name || "CompassDocs",
    ...SAMPLE_FRAME_VARS,
    ...(SAMPLE_VARS[key] ?? {}),
  };
  const parts: ComposedTemplate = { header: "", subject, body, signature: "", footer: "" };
  if (templateDef(key)) {
    try {
      const { resolveComposition } = await import("./email-parts");
      const c = await resolveComposition(key, "all");
      parts.header = c.header?.content ?? "";
      parts.signature = c.signature?.content ?? "";
      parts.footer = c.footer?.content ?? "";
    } catch (e) {
      console.error(`[email-templates] composition for ${key} failed:`, e);
    }
  }
  const out = await renderComposedEmail(key, parts, vars, origin, settings);
  return { subject: out.subject, html: out.html };
}
