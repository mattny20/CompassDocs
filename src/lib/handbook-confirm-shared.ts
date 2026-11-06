// Confirm the whole handbook (1.18.0): the types and sentences the server
// (lib/handbook-confirm) and the page (components/handbooks/confirm) share.
// Pure, so a client component can import it.

import type { DocType } from "./types";
import { handbookItemsLabel, handbookKind, handbookTypeCounts, itemKind, kindNoun, kindNounTitle } from "./handbook-shared";
import type { HandbookTypeCounts } from "./handbook-shared";

/**
 * Where one policy stands for this reader. 'confirmed': a confirmation
 * counts (the card's done state); 'to_confirm': asked, never confirmed;
 * 'updated': asked again after an earlier confirmation lapsed (a text
 * change or a re-ask); 'info': the policy does not ask this person.
 */
export type HandbookStanding = "confirmed" | "to_confirm" | "updated" | "info";

/** One row of the confirm page. */
export interface ConfirmItem {
  doc_id: number;
  /** "Policy k of N" (or "SOP k of N", "Document k of N": handbookPositionLabel). */
  number: number;
  title: string;
  /** The document's type (1.18.2): the counts and the statement name what the handbook holds. */
  type: DocType;
  section_title: string;
  space_name: string;
  standing: HandbookStanding;
  /** The version a confirmation must cite (the newest, as on the card); null for 'info'. */
  version_id: number | null;
  /** Its Version-history number ("v12"). */
  rev: number | null;
  /** The policy requires a typed signature. */
  signature: boolean;
  /**
   * The policy's own confirmation statement, when it has one that differs
   * from the handbook's sentence and the policy is waiting ('to_confirm' /
   * 'updated'); null otherwise. Listed under the handbook's statement and
   * stored on this policy's row.
   */
  statement: string | null;
  /** When the counting confirmation was recorded ('confirmed' only). */
  confirmed_at: string | null;
}

export interface ConfirmCounts {
  total: number;
  confirmed: number;
  to_confirm: number;
  updated: number;
  info: number;
  /** to_confirm + updated: what the button confirms. */
  outstanding: number;
}

export interface HandbookConfirmView {
  handbook: {
    id: number;
    title: string;
    confirm_whole: boolean;
    require_signature: boolean;
    fingerprint: string;
  };
  items: ConfirmItem[];
  counts: ConfirmCounts;
  /** The sentence the reader ticks, served by the server and stored on every row it writes that has no statement of its own. */
  statement: string;
  /**
   * The outstanding policies that ask in their own words (ConfirmItem
   * `statement`), in reading order: listed under `statement`, covered by the
   * same tick, each stored on its own row. [] when none does.
   */
  own_statements: { doc_id: number; title: string; statement: string }[];
  /**
   * Whether a signature is asked, and why: the titles of the outstanding
   * policies that require one, and whether the handbook's own switch does.
   * `local_account`: the account has a password to re-enter.
   */
  signature: { required: boolean; policies: string[]; handbook: boolean; local_account: boolean };
  /** The reader's handbook-level record of the contents as they stand now; null when there is none. */
  confirmed: { at: string } | null;
}

/** The answer of POST /api/handbooks/[id]/confirm. */
export interface ConfirmResult {
  ok: true;
  /** Rows written by this call. */
  confirmed: number;
  /** Policies still waiting after this call (0 unless a policy changed mid-call). */
  outstanding: number;
  /** Policies that changed between the check and their own write; nothing was written for them. */
  stale: number[];
  /** The handbook-level record was written by this call. */
  handbook_confirmed: boolean;
}

// --- Sentences ---------------------------------------------------------------------

/** The line above the policies that ask in their own words. */
export const OWN_STATEMENTS_INTRO = "These policies ask you to confirm in their own words:";

/** OWN_STATEMENTS_INTRO for what is listed: "These SOPs ask…", "These documents ask…" when mixed (1.18.2). */
export function ownStatementsIntro(listed: HandbookTypeCounts): string {
  const kind = handbookKind(listed);
  if (kind === "policy") return OWN_STATEMENTS_INTRO;
  return `These ${kindNoun(kind, 2)} ask you to confirm in their own words:`;
}

export const CONFIRM_NOT_ASKED = "This handbook doesn't ask for a confirmation.";
export const CONFIRM_TICK_FIRST = "Tick the statement to confirm the handbook.";
export const CONFIRM_ALREADY = "You have already confirmed this handbook as it stands.";
export const CONFIRM_STALE =
  "A policy in this handbook changed while you were reading. The page has been refreshed; please read the changes.";

/** CONFIRM_STALE for what the handbook holds: "An SOP in this handbook…", "A document in this handbook…" (1.18.2). */
export function confirmStale(c: HandbookTypeCounts): string {
  const kind = handbookKind(c);
  if (kind === "policy") return CONFIRM_STALE;
  return CONFIRM_STALE.replace("A policy", kind === "sop" ? "An SOP" : "A document");
}
export const CONFIRM_UNLICENSED = "Read confirmations are not included in your license.";
/** The visible help under the button until the statement is ticked. */
export const TICK_FIRST_HELP = "Tick the statement above to confirm";
/** The visible help under the button until the typed name matches (the card's SIGN_FIRST_HELP). */
export const SIGN_FIRST_HELP = "Sign above to confirm";

/**
 * The statement the reader ticks: "I have read and understood all 8
 * policies in Employee Handbook 2026, and I agree to follow them." It is
 * stored on every row it covers, so a handbook of policies only keeps the
 * 1.18.0 sentence byte for byte (including "all 2 policies"). `mix`
 * (1.18.2) names what the handbook holds when it is not policies only:
 * "all 4 SOPs in …", "both SOPs in …", or for a mix "all 5 documents in …
 * (3 policies and 2 SOPs), …" and "both documents in … (1 policy and 1
 * SOP), …". Without `mix`, the policy sentence.
 */
export function handbookStatement(title: string, count: number, mix?: HandbookTypeCounts): string {
  const kind = mix ? handbookKind(mix) : "policy";
  if (kind === "policy" || !mix) {
    if (count === 1) return `I have read and understood the policy in ${title}, and I agree to follow it.`;
    return `I have read and understood all ${count} policies in ${title}, and I agree to follow them.`;
  }
  const one = kindNoun(kind, 1);
  if (count === 1) return `I have read and understood the ${one} in ${title}, and I agree to follow it.`;
  // A mix names its parts; one kind throughout (SOPs only, or other documents only) needs no breakdown.
  const parts = mix.policy + mix.sop > 0 && kind === "document" ? ` (${handbookItemsLabel(mix)})` : "";
  const quantity = count === 2 ? "both" : `all ${count}`;
  return `I have read and understood ${quantity} ${kindNoun(kind, count)} in ${title}${parts}, and I agree to follow them.`;
}

/** The statement for these items, in reading order: handbookStatement with the kinds counted. */
export function handbookStatementFor(title: string, items: readonly { type: DocType }[]): string {
  return handbookStatement(title, items.length, handbookTypeCounts(items));
}

/** "3 confirmed · 4 to confirm · 1 updated · 2 for information": zero counts are left out. */
export function countsLine(c: ConfirmCounts): string {
  return [
    c.confirmed ? `${c.confirmed} confirmed` : "",
    c.to_confirm ? `${c.to_confirm} to confirm` : "",
    c.updated ? `${c.updated} updated` : "",
    c.info ? `${c.info} for information` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The button: "Confirm 5 policies"; "Confirm the handbook" when every policy
 * already counts. `mix` (1.18.2), the kinds of the outstanding ones:
 * "Confirm 2 SOPs", "Confirm 3 policies and 2 SOPs".
 */
export function confirmButtonLabel(outstanding: number, mix?: HandbookTypeCounts): string {
  if (outstanding === 0) return "Confirm the handbook";
  if (mix && handbookKind(mix) !== "policy") return `Confirm ${handbookItemsLabel(mix)}`;
  return `Confirm ${outstanding} ${outstanding === 1 ? "policy" : "policies"}`;
}

/** The confirm page's list heading: "5 policies", "3 policies and 2 SOPs". */
export function confirmListTitle(items: readonly { type: DocType }[]): string {
  return handbookItemsLabel(handbookTypeCounts(items));
}

/**
 * "Policy 3: " before a title for a screen reader. With the item's own
 * `type` (1.18.2) it names that item's kind, so a mixed handbook's list
 * reads "Policy 1: ", "SOP 3: ", "Document 4: "; the number stays the
 * handbook's. Without it, the handbook's kind.
 */
export function confirmItemPrefix(c: HandbookTypeCounts, n: number, type?: DocType): string {
  return `${kindNounTitle(type ? itemKind(type) : handbookKind(c))} ${n}: `;
}

/** The success toast. */
export function confirmedToast(r: Pick<ConfirmResult, "confirmed">): string {
  if (r.confirmed === 0) return "Handbook confirmation recorded.";
  return r.confirmed === 1 ? "1 confirmation recorded." : `${r.confirmed} confirmations recorded.`;
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Why the signature is asked, in one sentence under the fields. */
export function signatureReason(sig: HandbookConfirmView["signature"]): string {
  const what = sig.local_account ? "Your name and password are" : "Your name is";
  if (sig.policies.length === 0) return `${what} asked because this handbook requires a typed signature.`;
  // Three named policies at most; the rest are counted, so a long handbook keeps one line.
  const shown = sig.policies.length > 3 ? [...sig.policies.slice(0, 3), `${sig.policies.length - 3} more`] : sig.policies;
  const verb = sig.policies.length === 1 ? "requires" : "require";
  return `${what} asked because ${listOf(shown)} ${verb} a typed signature.`;
}

/** Whitespace-collapsed, case-insensitive name comparison: the rule lib/attestation applies on the server. */
export const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
