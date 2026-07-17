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
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { toHtml } from "hast-util-to-html";
import { MD_SANITIZE_SCHEMA, rehypeFilterStyles } from "./md-html";
import {
  listAnnouncementRecipients,
  getSetting,
  setSetting,
  createDocument,
  getSpaceById,
} from "./db";
import type { Newsletter } from "./db";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { sendMail } from "./mailer";

const MAX_RECIPIENTS = 1000;

// --- Sender addresses ---------------------------------------------------------
// Admins curate a list of From addresses ("Team News <news@acme.com>" or plain
// addresses); each newsletter may pick one. Stored one-per-line in a setting.

const FROM_SETTING = "newsletter_from_addresses";
const FROM_RE = /^(?:[^<>@\n]{1,80}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

export function isValidFromAddress(entry: string): boolean {
  return FROM_RE.test(entry.trim());
}

export async function listNewsletterFromAddresses(): Promise<string[]> {
  const raw = (await getSetting(FROM_SETTING)) || "";
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function saveNewsletterFromAddresses(entries: string[]): Promise<string[]> {
  const clean = [...new Set(entries.map((e) => e.trim()).filter(Boolean))].slice(0, 20);
  await setSetting(FROM_SETTING, clean.join("\n"));
  return clean;
}

// --- Email appearance ---------------------------------------------------------
// Admin-set content width and an optional custom header banner (replaces the
// default logo + org-name bar when set).

export const EMAIL_WIDTH_MIN = 480;
export const EMAIL_WIDTH_MAX = 900;
export const EMAIL_WIDTH_DEFAULT = 640;

export interface NewsletterAppearance {
  /** Email content width in px. */
  width: number;
  /** Header banner image URL ('' = default logo bar). */
  header_image: string;
}

export async function getNewsletterAppearance(): Promise<NewsletterAppearance> {
  const w = Number((await getSetting("newsletter_email_width")) || EMAIL_WIDTH_DEFAULT);
  return {
    width: Number.isInteger(w)
      ? Math.min(EMAIL_WIDTH_MAX, Math.max(EMAIL_WIDTH_MIN, w))
      : EMAIL_WIDTH_DEFAULT,
    header_image: (await getSetting("newsletter_header_image")) || "",
  };
}

export async function saveNewsletterAppearance(
  patch: Partial<NewsletterAppearance>
): Promise<NewsletterAppearance> {
  if (patch.width !== undefined) {
    await setSetting(
      "newsletter_email_width",
      String(Math.min(EMAIL_WIDTH_MAX, Math.max(EMAIL_WIDTH_MIN, Math.round(patch.width))))
    );
  }
  if (patch.header_image !== undefined) {
    await setSetting("newsletter_header_image", patch.header_image);
  }
  return getNewsletterAppearance();
}

// --- Archive -------------------------------------------------------------------

/**
 * File a sent newsletter as a published document in its chosen archive space.
 * Returns the new document's id, or null when no archive is configured (or
 * the space has since been deleted). Best-effort: never throws.
 */
export async function archiveNewsletter(n: Newsletter): Promise<number | null> {
  if (!n.archive_space_id) return null;
  try {
    const space = await getSpaceById(n.archive_space_id);
    if (!space) return null;
    const doc = await createDocument({
      space_id: n.archive_space_id,
      category_id: null,
      title: n.subject,
      type: "knowledge",
      status: "published",
      content: n.body,
      summary: `Newsletter sent ${new Date().toLocaleDateString()}.`,
      tags: ["newsletter"],
      author: n.author_name,
    });
    return doc.id;
  } catch (e) {
    console.error(`[newsletter] archiving #${n.id} failed:`, e);
    return null;
  }
}

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
    img: "max-width:100%;border-radius:8px;vertical-align:top",
    table: "border-collapse:collapse;margin:0 0 12px;width:100%",
    th: "border:1px solid #e2e8f0;padding:6px 10px;background:#f8fafc;text-align:left",
    td: "border:1px solid #e2e8f0;padding:6px 10px",
    hr: "border:none;border-top:1px solid #e2e8f0;margin:20px 0",
  };
}

// Cells inside a transparent (layout) table lose borders and shading.
const BORDERLESS_CELL = "border:none;padding:6px 10px;vertical-align:top";

/**
 * Recursively stamp inline styles onto a hast tree. Styles already on a node
 * (alignment, indent, spacer height — sanitized upstream) are kept and win
 * over the per-tag defaults. Newsletter blocks get their email look here:
 * a.email-btn becomes a real button, div.nl-spacer collapses to pure height.
 */
function applyStyles(
  node: any,
  styles: Record<string, string>,
  accent: string,
  inBorderlessTable = false
): void {
  let borderless = inBorderlessTable;
  if (node?.type === "element") {
    const classes: string[] = Array.isArray(node.properties?.className)
      ? node.properties.className.map(String)
      : [];
    const own = node.properties?.style ? String(node.properties.style) : "";
    let base = styles[node.tagName] || "";
    if (node.tagName === "a" && classes.includes("email-btn")) {
      base = `display:inline-block;background:${accent};color:#ffffff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px`;
      delete node.properties.className;
    } else if (node.tagName === "div" && classes.includes("nl-spacer")) {
      base = "font-size:0;line-height:0";
      delete node.properties.className;
    } else if (node.tagName === "div" && classes.includes("nl-panel")) {
      // Color panel: bg + ink arrive inline (sanitized); add the pill shape.
      base = "padding:16px 20px;border-radius:12px;margin:0 0 12px";
      delete node.properties.className;
    } else if (node.tagName === "table" && classes.includes("nl-borderless")) {
      borderless = true;
      base = "border-collapse:collapse;margin:0 0 12px;width:100%";
      delete node.properties.className;
    } else if (borderless && (node.tagName === "th" || node.tagName === "td")) {
      base = BORDERLESS_CELL;
    } else if (node.tagName === "img") {
      // Author-chosen display width travels in the title token ("w=45%") —
      // turn it into a real width so side-by-side photos work in inboxes.
      const m = /^w=(\d{1,3})%$/.exec(String(node.properties?.title ?? ""));
      if (m) {
        base = `${base};width:${Math.min(100, Number(m[1]))}%`;
        delete node.properties.title;
      }
    } else if (/^h[1-3]$/.test(node.tagName) && /background-color/.test(own)) {
      // Highlighted headings get their pill look inline.
      base = `${base};padding:6px 12px;border-radius:8px`;
    }
    const style = [base, own].filter(Boolean).join(";");
    if (style) {
      node.properties = { ...node.properties, style };
    }
  }
  for (const child of node?.children ?? []) applyStyles(child, styles, accent, borderless);
}

/** Make relative app links/images absolute so they work from an inbox. */
function absolutize(markdown: string, origin: string): string {
  if (!origin) return markdown;
  return markdown
    .replace(/(\]\()\/(?!\/)/g, `$1${origin}/`)
    // Same for the editor's HTML islands (buttons, aligned images).
    .replace(/((?:href|src)=")\/(?!\/)/g, `$1${origin}/`);
}

/** Render newsletter markdown to inline-styled HTML (no template wrapper). */
export async function renderBodyHtml(markdown: string, accent: string, origin: string): Promise<string> {
  // The editor's HTML islands (alignment, buttons, spacers) pass through the
  // same sanitize + style-whitelist rules as the in-app view before styling.
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, MD_SANITIZE_SCHEMA)
    .use(rehypeFilterStyles);
  const hast = await processor.run(processor.parse(absolutize(markdown, origin)));
  applyStyles(hast, tagStyles(accent), accent);
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
  const { width, header_image } = await getNewsletterAppearance();
  const logoAbs = input.logoUrl
    ? input.logoUrl.startsWith("/")
      ? `${input.origin}${input.logoUrl}`
      : input.logoUrl
    : "";
  const headerAbs = header_image
    ? header_image.startsWith("/")
      ? `${input.origin}${header_image}`
      : header_image
    : "";
  // Custom banner replaces the default logo + org-name bar entirely.
  const header = headerAbs
    ? `<img src="${headerAbs}" alt="${escapeHtml(input.orgName)}" width="100%" style="display:block;width:100%;height:auto">`
    : `<div style="padding:18px 28px;border-bottom:3px solid ${input.accent}">
        ${logoAbs ? `<img src="${logoAbs}" alt="" width="28" height="28" style="vertical-align:middle;border-radius:6px;margin-right:10px">` : ""}
        <span style="font-size:16px;font-weight:700;color:#0f172a;vertical-align:middle">${escapeHtml(input.orgName)}</span>
      </div>`;

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9">
  <div style="max-width:${width}px;margin:0 auto;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      ${header}
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
  /** Optional From override (admin-curated list); '' = SMTP default. */
  from?: string;
  /** Files sent WITH the email as real attachments. */
  attachments?: { filename: string; path: string }[];
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
      await sendMail([r.email], input.subject, text, html, input.from || undefined, input.attachments);
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
