// Helpdesk 1.19.1: merge and bulk edit pieces the desk (client) and the
// server share (agent V2), so the dialog previews exactly what the server
// writes. No server imports here.

/** Tickets merged into one at a time. */
export const MERGE_MAX = 50;
/** Tickets one bulk edit may change. */
export const BULK_MAX = 200;

/** The requester-facing sentence on a merged request (the dialog previews it). */
export function mergedNote(keepNumber: number): string {
  return `Your request has been joined with #${keepNumber} so one person can help with both.`;
}

/** "#1051", "#1051 and #1052", "#1051, #1052 and #1053". */
export function listNumbers(numbers: number[]): string {
  const s = numbers.map((n) => `#${n}`);
  return s.length <= 1 ? s.join("") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

/** "Priya Natarajan", "Priya Natarajan and Daniel Okafor", "A, B and C". */
export function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the ticket pane shows about merges (agents only). */
export interface HdMergeInfo {
  /** This ticket was merged into … */
  /** `deleted`: it is in the recycle bin (1.19.4): show "a deleted ticket", never its number or subject. */
  into: { number: number; subject: string; deleted?: boolean } | null;
  /** … and these were merged into this one. */
  merged_in: { number: number; subject: string }[];
  /** Message id → the number of the ticket it came from ("from #1051"). */
  message_origins: Record<number, number>;
}

/** POST /api/helpdesk/tickets/bulk patch. */
export interface HdBulkPatch {
  status?: string;
  priority?: string;
  team_id?: number | null;
  assignee_id?: number | null;
  add_tags?: string[];
  remove_tags?: string[];
}

/** One ticket's outcome in a bulk edit. */
export interface HdBulkResult {
  number: number;
  ok: boolean;
  /** Why it was skipped. */
  error?: string;
  /** The fields that changed (ok with [] = already as asked). */
  changed?: string[];
}
