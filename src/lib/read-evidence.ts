// Reading evidence on the attestation record (C3, 1.11.0): the pure rules
// behind the two columns the record carries beside each confirmation.
//
// read_seconds is derived on the server when the confirmation is posted
// (src/lib/analytics.ts readSecondsSince: the view heartbeats for this person
// and document since everyone was last asked) and copied onto the row because
// doc_views is not retained with the document. reached_end is the reader's
// own report from use-reached-end.ts and is labelled as such everywhere it is
// shown. Neither is proof of comprehension, and no control is gated by either.
//
// Nothing here touches the database, so the Record page, the CSV route, the
// confirmation route and the tests share one definition of the threshold,
// the labels and the body parsing.

/** Reading speed the "typical read" of a document is measured at. */
export const WORDS_PER_MINUTE = 200;

/** Below this share of a typical read the Read time cell takes the warn tone. */
export const SHORT_READ_SHARE = 0.25;

/** The warn tone's tooltip on the Record page. */
export const SHORT_READ_TOOLTIP = "Shorter than a typical read of this document";

/**
 * The roster CSV header (GET /api/documents/[id]/acknowledgements?format=csv).
 * Existing columns stay in place and new ones are appended, never renamed:
 * the two evidence columns follow the provenance pair at the end.
 */
export const ROSTER_CSV_HEADER =
  "name,username,email,role,status,acknowledged_at,document,revision_as_of,version,version_id,content_sha256,version_source,former_staff,asked_at,asked_by,reason,kept_since_asked,ip,user_agent,version_published_by,version_approved_by,read_seconds,reached_end_self_reported";

/**
 * Words in a document's text, counted the way the change heuristic counts
 * them (a token with at least one letter or digit): markup-only tokens such
 * as "##" or "---" are not words. Tags are stripped first so HTML content
 * counts its text, not its markup.
 */
export function documentWordCount(content: string): number {
  const text = (content ?? "").replace(/<[^>]+>/g, " ");
  return (text.match(/\S+/g) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Seconds a typical read of `words` words takes at WORDS_PER_MINUTE. */
export function typicalReadSeconds(words: number): number {
  return (Math.max(0, words) / WORDS_PER_MINUTE) * 60;
}

/**
 * The threshold rule: the warn tone applies only when a recorded read time is
 * below SHORT_READ_SHARE of a typical read of the document. An unknown read
 * time (null: no view was recorded, or a confirmation from before 1.11.0)
 * is never flagged, and neither is a document with no words to read.
 */
export function isShortRead(readSeconds: number | null | undefined, words: number): boolean {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return false;
  if (words <= 0) return false;
  return readSeconds < SHORT_READ_SHARE * typicalReadSeconds(words);
}

/**
 * The Read time cell: "under 1 min", "6 min", "1 h 5 min"; blank when the
 * record holds no read time.
 */
export function readTimeLabel(readSeconds: number | null | undefined): string {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return "";
  const seconds = Math.max(0, Math.floor(readSeconds));
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The self-reported flag from the confirmation body: true only for the JSON
 * boolean `true`. A string, a number, a missing field or a body that is not
 * an object all read as false, so the record never says "reached the end"
 * on anything but the card's own report.
 */
export function reachedEndFromBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as { reached_end?: unknown }).reached_end === true;
}

/**
 * The seconds a confirmation stores: a whole non-negative number, or null
 * when nothing was recorded.
 */
export function storedReadSeconds(readSeconds: number | null | undefined): number | null {
  if (readSeconds === null || readSeconds === undefined || !Number.isFinite(readSeconds)) return null;
  return Math.max(0, Math.floor(readSeconds));
}

/**
 * The two evidence cells of a roster CSV row, before csvCell: read_seconds as
 * a number or blank, reached_end_self_reported as "yes" / "no" on a
 * confirmed row and blank on a pending one (no confirmation, no report).
 */
export function evidenceCsvCells(row: {
  acknowledged_at: string | null;
  read_seconds: number | null;
  reached_end: boolean | null;
}): [string | number, string] {
  if (!row.acknowledged_at) return ["", ""];
  return [row.read_seconds ?? "", row.reached_end ? "yes" : "no"];
}
