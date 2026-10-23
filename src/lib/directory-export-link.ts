// Download links for directory export presets (1.15.0).
//
// A link names a preset and a file type: /directory/download/<preset> for a
// PDF (a ZIP when the preset splits into one file per value), with
// ?format=csv or ?format=vcf for the other two. It is a page, not the API:
// a signed-out visitor is sent through sign-in with the page as `?next=`
// (lib/auth requireUser, lib/return-to) and lands on it, and the page then
// fetches GET /api/directory/export with the visitor's own session, so the
// file carries exactly what that person may see. The link holds no secret
// and grants nothing: anyone who opens it needs an account that can read
// the directory.
//
// Client-safe: the admin preset editor, the Directory page's Export menu and
// the landing page all build and read links with these functions.

export const EXPORT_LINK_FORMATS = ["pdf", "csv", "vcf"] as const;
export type ExportLinkFormat = (typeof EXPORT_LINK_FORMATS)[number];

/** The file type a link asks for; anything else is a PDF, as the export route reads it. */
export function parseExportLinkFormat(raw: unknown): ExportLinkFormat {
  const v = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).toLowerCase();
  return (EXPORT_LINK_FORMATS as readonly string[]).includes(v) ? (v as ExportLinkFormat) : "pdf";
}

/** The page path of a preset's download link: the id encoded, the format only when it is not a PDF. */
export function exportLinkPath(presetId: string, format: ExportLinkFormat = "pdf"): string {
  const base = `/directory/download/${encodeURIComponent(presetId)}`;
  return format === "pdf" ? base : `${base}?format=${format}`;
}

/** The full link: `origin` (the custom domain when one is set) plus the path, with no trailing slash doubled. */
export function exportLinkUrl(origin: string, presetId: string, format: ExportLinkFormat = "pdf"): string {
  return `${String(origin ?? "").replace(/\/+$/, "")}${exportLinkPath(presetId, format)}`;
}

/** What the export API is asked for on the landing page; `via=link` marks the audit row. */
export function exportLinkApiPath(presetId: string, format: ExportLinkFormat): string {
  return `/api/directory/export?preset=${encodeURIComponent(presetId)}&format=${format}&via=link`;
}

/** What the file is, in words: the format picker's options and the landing page's sentence. */
export function exportLinkFileLabel(format: ExportLinkFormat, split = false): string {
  if (format === "csv") return "CSV spreadsheet";
  if (format === "vcf") return "contact cards (.vcf)";
  return split ? "ZIP of PDFs, one per section" : "PDF";
}

/** The format picker's options for one preset. */
export function exportLinkFormatOptions(split = false): { value: ExportLinkFormat; label: string }[] {
  return [
    { value: "pdf", label: split ? "ZIP of PDFs" : "PDF" },
    { value: "csv", label: "CSV" },
    { value: "vcf", label: "Contact cards (.vcf)" },
  ];
}

/** The file name a Content-Disposition header carries (`filename="…"` or RFC 5987 `filename*=`), or `fallback`. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const h = String(header ?? "");
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")) || fallback;
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/.exec(h) ?? /filename\s*=\s*([^;]+)/.exec(h);
  const name = plain ? plain[1].trim() : "";
  // A file name, never a path.
  return name.replace(/[\\/]/g, "_") || fallback;
}
