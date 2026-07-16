// Newsletter rendering + sending. The body is the same markdown the document
// editor produces; we render it with the same remark/GFM pipeline the app's
// viewer uses, serialize to HTML, and inline conservative styles per tag —
// the only styling email clients reliably honor — inside a simple branded
// template (logo, org name, accent bar, footer). Server-only.

import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { listAnnouncementRecipients } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";

const MAX_RECIPIENTS = 1000;

// Per-tag inline styles: dark text on white, accent for links/quotes.
function tagStyles(accent: string): Record<string, string> {
  return {
    h1: "font-size:24px;margin:24px 0 8px;color:#0f172a",
    h2: "font-size:20px;margin:20px 0 8px;color:#0f172a",
    h3: "font-size:17px;margin:16px 0 6px;color:#0f172a",
    p: "margin:0 0 12px;line-height:1.6",
    ul: "margin:0 0 12px;padding-left:22px",
    ol: "margin:0 0 12px;padding-left:22px",
    li: "margin:0 0 4px;line-height:1.55",
    blockquote: `margin:0 0 12px;padding:6px 14px;border-left:3px solid ${accent};color:#475569`,
    code: "background:#f1f5f9;border-radius:4px;padding:1px 5px;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace",
    pre: "background:#f1f5f9;border-radius:8px;padding:12px 14px;overflow:auto;font-size:13px;margin:0 0 12px",
    a: `color:${accent}`,
    img: "max-width:100%;border-radius:8px",
    table: "border-collapse:collapse;margin:0 0 12px;width:100%",
    th: "border:1px solid #e2e8f0;padding:6px 10px;background:#f8fafc;text-align:left",
    td: "border:1px solid #e2e8f0;padding:6px 10px",
    hr: "border:none;border-top:1px solid #e2e8f0;margin:20px 0",
  };
}

/** Recursively stamp inline styles onto a hast tree. */
function applyStyles(node: any, styles: Record<string, string>): void {
  if (node?.type === "element") {
    const style = styles[node.tagName];
    if (style) {
      node.properties = { ...node.properties, style };
    }
  }
  for (const child of node?.children ?? []) applyStyles(child, styles);
}

/** Make relative app links/images absolute so they work from an inbox. */
function absolutize(markdown: string, origin: string): string {
  if (!origin) return markdown;
  return markdown.replace(/(\]\()\/(?!\/)/g, `$1${origin}/`);
}

/** Render newsletter markdown to inline-styled HTML (no template wrapper). */
export async function renderBodyHtml(markdown: string, accent: string, origin: string): Promise<string> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const hast = await processor.run(processor.parse(absolutize(markdown, origin)));
  applyStyles(hast, tagStyles(accent));
  return toHtml(hast as any);
}

export async function renderNewsletterHtml(input: {
  subject: string;
  markdown: string;
  orgName: string;
  logoUrl: string;
  accent: string;
  origin: string;
  authorName: string;
}): Promise<string> {
  const bodyHtml = await renderBodyHtml(input.markdown, input.accent, input.origin);
  const logoAbs = input.logoUrl
    ? input.logoUrl.startsWith("/")
      ? `${input.origin}${input.logoUrl}`
      : input.logoUrl
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9">
  <div style="max-width:640px;margin:0 auto;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="padding:18px 28px;border-bottom:3px solid ${input.accent}">
        ${logoAbs ? `<img src="${logoAbs}" alt="" width="28" height="28" style="vertical-align:middle;border-radius:6px;margin-right:10px">` : ""}
        <span style="font-size:16px;font-weight:700;color:#0f172a;vertical-align:middle">${escapeHtml(input.orgName)}</span>
      </div>
      <div style="padding:28px">
        <h1 style="font-size:26px;margin:0 0 18px;color:#0f172a">${escapeHtml(input.subject)}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:14px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">
        Sent by ${escapeHtml(input.authorName)} · ${escapeHtml(input.orgName)}
        ${input.origin ? ` · <a href="${input.origin}/" style="color:#64748b">open the knowledge base</a>` : ""}
      </div>
    </div>
  </div>
</body>
</html>`;
}

/** Plain-text fallback for the multipart body. */
export function newsletterText(input: {
  subject: string;
  markdown: string;
  orgName: string;
  authorName: string;
  origin: string;
}): string {
  return (
    `${input.subject}\n\n${input.markdown}\n\n— ${input.authorName} · ${input.orgName}` +
    (input.origin ? `\n${input.origin}/` : "")
  );
}

export async function sendNewsletter(input: {
  subject: string;
  markdown: string;
  orgName: string;
  logoUrl: string;
  accent: string;
  origin: string;
  authorName: string;
  /** "all", selected group ids, or explicit addresses (test sends). */
  to: "all" | number[] | { emails: string[] };
}): Promise<{ sent: number; error?: string }> {
  if (!smtpConfigured(await getSmtpConfig())) {
    return { sent: 0, error: "SMTP isn't configured (Settings → Notifications)." };
  }
  const recipients =
    typeof input.to === "object" && !Array.isArray(input.to)
      ? input.to.emails.map((email) => ({ email }))
      : (await listAnnouncementRecipients(input.to)).slice(0, MAX_RECIPIENTS);
  if (recipients.length === 0) return { sent: 0, error: "No recipients matched." };

  const html = await renderNewsletterHtml(input);
  const text = newsletterText(input);
  let sent = 0;
  for (const r of recipients) {
    try {
      await sendMail([r.email], input.subject, text, html);
      sent++;
    } catch (e) {
      console.error(`Newsletter to ${r.email} failed:`, e);
    }
  }
  return { sent };
}

/**
 * Best-effort plain-text workflow notification (review requests, decisions).
 * Silently skips when SMTP isn't configured — the in-app thread is the source
 * of truth; email is a convenience.
 */
export async function sendWorkflowNotice(
  emails: string[],
  subject: string,
  text: string
): Promise<void> {
  if (emails.length === 0) return;
  if (!smtpConfigured(await getSmtpConfig())) return;
  for (const email of [...new Set(emails)].slice(0, 50)) {
    try {
      await sendMail([email], subject, text);
    } catch (e) {
      console.error(`Workflow notice to ${email} failed:`, e);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
