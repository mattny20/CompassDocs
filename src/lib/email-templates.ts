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
    label: "Acknowledgement request",
    description:
      "Sent when an admin requests (or re-requests) acknowledgement of a policy. Sent regardless of personal notification settings.",
    tags: [
      T("requester_name", "Requesting admin"),
      T("doc_title", "Policy title"),
      T("doc_url", "Link to the policy"),
      T("request_type", "requested / sent a reminder"),
      T("request_label", "Action required / Reminder"),
      T("org_name", "Workspace name"),
    ],
    subject: '[{{org_name}}] {{request_label}}: acknowledge "{{doc_title}}"',
    body:
      "**{{requester_name}}** {{request_type}} that you read and acknowledge:\n\n" +
      "> **{{doc_title}}**\n\n" +
      '[Open the document]({{doc_url}}) and click *"I\'ve read and understood"*.\n\n' +
      "This acknowledgement is recorded for compliance.",
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
];

/** Realistic per-template values used by the admin preview pane. */
export const SAMPLE_VARS: Record<string, Record<string, string>> = {
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
    doc_url: "/doc/42",
    request_type: "requested",
    request_label: "Action required",
  },
  workflow_event: {
    event: "Change approved",
    summary: 'Marcus Chen approved "Remote Work Policy" for publishing.',
    title: "Remote Work Policy",
    url: "/doc/42",
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

/**
 * Render an email through its (possibly customized) template.
 * Values are substituted before markdown rendering; the result passes through
 * the same sanitize pipeline as newsletters, so tag values can't inject HTML
 * that survives.
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
  const subject = substitute(subjectTpl, vars);
  const bodyMd = substitute(bodyTpl, vars);
  const html = await renderBodyHtml(bodyMd, settings.accent_color, origin);
  return { subject, text: mdToText(bodyMd), html };
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
  return {
    subject: substitute(subject, vars),
    html: await renderBodyHtml(substitute(body, vars), settings.accent_color, origin),
  };
}
