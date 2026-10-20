import "server-only";
import { getSetting, setSetting } from "./db";
import { getAppSettings } from "./settings-store";
import { renderBodyHtml } from "./newsletter";

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
      T("org_name", "Workspace name"),
    ],
    // 1.13.0 (E1): the due tags come from each recipient's own assignment row,
    // so one fan-out may render as several mails when people's dates differ.
    text: ["requester_name", "doc_title", "change_note", "reason"],
    subject: '[{{org_name}}] {{request_label}}: confirm "{{doc_title}}"{{due_suffix}}',
    body:
      "**{{requester_name}}** {{request_type}} that you read and confirm:\n\n" +
      "> **{{doc_title}}**\n\n" +
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
      T("org_name", "Workspace name"),
    ],
    text: ["doc_title"],
    subject: '[{{org_name}}] {{status_label}}: confirm "{{doc_title}}"',
    body:
      "**{{status_label}}**: you still need to read and confirm **{{doc_title}}**.\n\n" +
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
      T("policy_list", "The policies, one per line, with their due dates"),
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
      T("policy_list", "The policies, one per line, with their due dates"),
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
    label: "Team training digest (leads)",
    description:
      "Sent weekly to each group lead summarizing where their team stands on assigned training.",
    tags: [
      T("lead_name", "The lead's name"),
      T("summary", "Per-team status lines"),
      T("team_url", "Link to the team view"),
      T("org_name", "Workspace name"),
    ],
    subject: "[{{org_name}}] Your team's training this week",
    body:
      "Hi {{lead_name}} — here's where your team stands:\n\n{{summary}}\n\n" +
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
];

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
    summary: "- **Support**: 14 done · 3 open · **2 overdue**\n- **Field ops**: 9 done · 1 open",
    team_url: "https://docs.example.com/training/team",
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
  },
  ack_due: {
    doc_title: "Acceptable Use Policy",
    doc_url: "/doc/42#confirm-reading",
    due_date: "29 Oct 2026",
    due_line: "Please confirm by 29 Oct 2026.",
    status_label: "Due soon",
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
};

export function templateDef(key: string): EmailTemplateDef | undefined {
  return EMAIL_TEMPLATES.find((t) => t.key === key);
}

export async function templateOverride(
  key: string
): Promise<{ subject: string; body: string } | null> {
  const raw = await getSetting(`email_tpl_${key}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.subject === "string" && typeof parsed?.body === "string") return parsed;
  } catch {
    /* fall through to default */
  }
  return null;
}

export async function saveTemplateOverride(
  key: string,
  subject: string,
  body: string
): Promise<void> {
  await setSetting(`email_tpl_${key}`, JSON.stringify({ subject, body }));
}

export async function resetTemplate(key: string): Promise<void> {
  await setSetting(`email_tpl_${key}`, "");
}

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
  origin: string
): Promise<{ subject: string; text: string; html: string }> {
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
  const bodyMd = substitute(bodyTpl, bodyVars);
  let html = await renderBodyHtml(bodyMd, accent, origin);
  let text = mdToText(bodyMd);
  for (const [token, value] of tokens) {
    html = html.split(token).join(escapeHtmlText(value));
    text = text.split(token).join(value);
  }
  return { subject: substitute(subjectTpl, vars), text, html };
}

/**
 * Render an email through its (possibly customized) template.
 * Values are substituted before markdown rendering (the template's `text`
 * tags as written, see renderParts); the result passes through the same
 * sanitize pipeline as newsletters, so tag values can't inject HTML that
 * survives.
 */
export async function renderEmail(
  key: string,
  vars: Record<string, string>,
  origin: string
): Promise<{ subject: string; text: string; html: string }> {
  const def = templateDef(key);
  if (!def) throw new Error(`Unknown email template: ${key}`);
  const override = await templateOverride(key);
  const subjectTpl = override?.subject || def.subject;
  const bodyTpl = override?.body || def.body;

  const settings = await getAppSettings();
  if (!("org_name" in vars)) {
    vars = { ...vars, org_name: settings.company_name || "CompassDocs" };
  }
  return renderParts(def, subjectTpl, bodyTpl, vars, settings.accent_color, origin);
}

/**
 * Render arbitrary (unsaved) subject/body with the template's sample values —
 * the live preview in the admin editor.
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
    ...(SAMPLE_VARS[key] ?? {}),
  };
  const parts = await renderParts(templateDef(key), subject, body, vars, settings.accent_color, origin);
  return { subject: parts.subject, html: parts.html };
}
