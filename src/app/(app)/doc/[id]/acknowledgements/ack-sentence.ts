// The one sentence under the Read confirmation title (C1, 1.10.0): how many
// people have confirmed the version everyone was asked to read, and when,
// by whom and why they were last asked. Pure, so the omission rules can be
// pinned without a database: the reason is dropped when empty, and "by
// {name}" is dropped when the ask came from an edit by the version's own
// author (the version line on the document already names them).

/** The ledger row behind the current marker: the newest 'reset' decision. */
export interface AskedDecision {
  decided_at: string;
  decided_by_name: string;
  source: string;
  reason: string;
}

export function confirmationSentence({
  current,
  eligible,
  rev,
  author,
  asked,
  resetAt,
  formatDate,
}: {
  /** People with a current confirmation. */
  current: number;
  /** People who are asked (the denominator). */
  eligible: number;
  /** The marker version's number, null before the first version. */
  rev: number | null;
  /** The marker version's author (getAckVersionInfo().author). */
  author: string;
  /** The newest reset decision, or null before the ledger has one. */
  asked: AskedDecision | null;
  /** documents.ack_revision_at: the ask date when no decision row exists yet. */
  resetAt: string;
  /** Workspace-formatted date, e.g. "Mar 3, 2026". */
  formatDate: (iso: string) => string;
}): string {
  const people = eligible === 1 ? "person has" : "people have";
  const version = rev ? `version ${rev}` : "the current version";
  return `${current} of ${eligible} ${people} confirmed ${version} · ${askedClause({ asked, author, resetAt, formatDate })}`;
}

/** 'asked 3 Mar 2026 by Matt: "Section 4 now covers contractors"'. */
export function askedClause({
  asked,
  author,
  resetAt,
  formatDate,
}: {
  asked: AskedDecision | null;
  author: string;
  resetAt: string;
  formatDate: (iso: string) => string;
}): string {
  if (!asked) return `asked ${formatDate(resetAt)}`;
  const by = (asked.decided_by_name ?? "").trim();
  const reason = (asked.reason ?? "").trim();
  // An edit by the version's own author: the version line already says
  // "published {date} by {author}", so the name is not repeated here.
  const authorsOwnEdit = asked.source === "edit" && sameName(by, author);
  let out = `asked ${formatDate(asked.decided_at)}`;
  if (by && !authorsOwnEdit) out += ` by ${by}`;
  if (reason) out += `: "${reason}"`;
  return out;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}
