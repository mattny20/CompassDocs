// Helpdesk 1.19.1 import: a ticket or message body from an export, as the
// safe markdown the desk renders. Same rule as inbound email (agent C,
// inbound-parse): HTML is never stored or rendered. It is walked as a tree
// and written out as text (scripts, styles, forms and embeds dropped),
// then escaped so markdown shows exactly those characters. One difference
// for exports: an image becomes a link ("Image: alt (https://…)") instead
// of vanishing, because an old ticket's screenshot may matter; a data: or
// cid: image (no address to keep) becomes "[image]". Pure.

import { htmlToText, textToSafeMarkdown } from "./inbound-parse";

export const IMPORT_BODY_MAX = 50_000;

/** Does this look like HTML (a tag or an entity-escaped tag)? */
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i.test(s) || /<!--|&lt;\/?(p|div|br|span)\b/i.test(s);
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Every <img> as a link we write (http(s) only), or "[image]". */
export function imagesToLinks(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = decodeEntities(attr(tag, "src")).trim();
    const alt = decodeEntities(attr(tag, "alt")).replace(/\s+/g, " ").trim().slice(0, 120);
    if (/^https?:\/\//i.test(src) && src.length <= 2000) {
      return ` <a href="${escapeHtml(src)}">${escapeHtml(alt ? `Image: ${alt}` : "Image")}</a> `;
    }
    return alt ? ` [image: ${escapeHtml(alt)}] ` : " [image] ";
  });
}

/** An export's body (HTML or plain text) as safe markdown, capped. */
export function importBodyToMarkdown(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\u0000/g, "");
  if (looksLikeHtml(text)) text = htmlToText(imagesToLinks(text));
  text = text.replace(/\r\n?/g, "\n").trim();
  let note = "";
  if (text.length > IMPORT_BODY_MAX) {
    text = text.slice(0, IMPORT_BODY_MAX);
    note = "\n\n_(The rest of this message was too long and was left out.)_";
  }
  return text ? textToSafeMarkdown(text) + note : "";
}
