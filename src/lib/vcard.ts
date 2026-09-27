// vCard 3.0 for a directory person — what "Save contact" hands a phone or
// Outlook. Version 3.0 rather than 4.0 because iOS, Android and Outlook all
// import it without complaint, and 4.0's gains (no line folding, IANA
// mime) buy nothing here.
//
// Pure module: the caller supplies the person, the office block and the
// origin; nothing is read here.

import type { PersonLike, FieldLike } from "./directory-display";
import { displayValue, linkNames } from "./directory-display";

export interface VCardInput {
  person: PersonLike & { source?: string; photo_large?: string; photo?: string };
  fields: FieldLike[];
  /** Workspace / company name for ORG. */
  company: string;
  /** Absolute profile URL, or "" when the workspace has no configured domain. */
  profileUrl: string;
  /** The person's office block: address and main phone, when a profile exists. */
  office?: { name: string; address?: string; phone?: string; fax?: string } | null;
  /** Include the photo (large, else thumb). Off for a QR code — too many bytes. */
  photo?: boolean;
}

/** RFC 6350 text escaping: backslash, comma, semicolon, newline. */
export function vcardEscape(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Fold a content line at 75 octets with a leading space on continuations. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let chunk = "";
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74;
    if (size + n > limit) {
      out.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  if (chunk) out.push(chunk);
  return out.map((c, i) => (i === 0 ? c : ` ${c}`)).join("\r\n");
}

/** "Smith, Jane" → {family: Smith, given: Jane}; "Jane Q. Smith" → {family: Smith, given: Jane Q.}. */
export function splitName(name: string): { family: string; given: string } {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return { family: "", given: "" };
  const comma = n.indexOf(",");
  if (comma > 0) return { family: n.slice(0, comma).trim(), given: n.slice(comma + 1).trim() };
  const parts = n.split(" ");
  if (parts.length === 1) return { family: "", given: parts[0] };
  const suffix = /^(jr|sr|ii|iii|iv|esq)\.?$/i.test(parts[parts.length - 1]) ? parts.pop() : "";
  const family = parts.pop() ?? "";
  return { family: suffix ? `${family} ${suffix}` : family, given: parts.join(" ") };
}

/**
 * A phone as typed, whitespace trimmed. Phones and Outlook parse "602-555-0100
 * x218" themselves; stripping it to digits would lose the extension, and
 * vCard 3.0 has no clean place to put one.
 */
function telValue(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function buildVCard(input: VCardInput): string {
  const { person, fields, company } = input;
  const { family, given } = splitName(person.name);
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  lines.push(`N:${vcardEscape(family)};${vcardEscape(given)};;;`);
  lines.push(`FN:${vcardEscape(person.name.trim())}`);
  const org = [company, person.department].filter(Boolean).map(vcardEscape).join(";");
  if (org) lines.push(`ORG:${org}`);
  if (person.title) lines.push(`TITLE:${vcardEscape(person.title)}`);
  if (person.email) lines.push(`EMAIL;TYPE=INTERNET,WORK,PREF:${vcardEscape(person.email)}`);
  if (person.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vcardEscape(telValue(person.phone))}`);
  if (person.mobile) lines.push(`TEL;TYPE=CELL:${vcardEscape(telValue(person.mobile))}`);
  // Extra phone-display fields ride along as work numbers, labelled.
  for (const f of fields) {
    if (f.display === "phone" && !f.builtin && person.custom?.[f.key]) {
      lines.push(`item${lines.length}.TEL;TYPE=WORK:${vcardEscape(telValue(person.custom[f.key]))}`);
      lines.push(`item${lines.length - 1}.X-ABLabel:${vcardEscape(f.label)}`);
    }
  }
  if (input.office) {
    const o = input.office;
    if (o.address) {
      const parts = o.address.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // ADR: PO box; extended; street; locality; region; postal; country. We
      // keep the address as typed in the street slot, one line per row — the
      // phone shows it as written, which beats guessing which line is the city.
      lines.push(`ADR;TYPE=WORK:;;${parts.map(vcardEscape).join("\\n")};;;;`);
      lines.push(`LABEL;TYPE=WORK:${vcardEscape(parts.join("\n"))}`);
    }
    if (o.phone && !person.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vcardEscape(telValue(o.phone))}`);
    if (o.fax) lines.push(`TEL;TYPE=WORK,FAX:${vcardEscape(telValue(o.fax))}`);
  }
  if (input.profileUrl) lines.push(`URL:${vcardEscape(input.profileUrl)}`);
  const officeName = fields.find((f) => f.key === "office");
  const officeShown = officeName ? displayValue(officeName, person.office) : person.office;
  const notes: string[] = [];
  if (officeShown) notes.push(`Office: ${officeShown}`);
  for (const f of fields) {
    if (f.kind === "people") {
      const out = linkNames(person, f.key, "out");
      if (out) notes.push(`${f.label}: ${out}`);
      continue;
    }
    if (f.builtin || f.display === "phone" || !f.show_in_card) continue;
    const v = person.custom?.[f.key];
    if (v) notes.push(`${f.label}: ${displayValue(f, v)}`);
  }
  if (notes.length) lines.push(`NOTE:${vcardEscape(notes.join("\n"))}`);
  if (input.photo !== false) {
    const src = person.photo_large || person.photo || "";
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (m) lines.push(`PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`);
  }
  lines.push(`REV:${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** File name for one person's card: "jane-smith.vcf". */
export function vcardFilename(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "contact";
  return `${base}.vcf`;
}
