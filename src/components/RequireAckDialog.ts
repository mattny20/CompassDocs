"use client";

// The one "Require read confirmation?" question (A8, 1.10.1), shared by the
// compliance portal's Request and the document shield's switch-on (A5), so
// the two paths cannot drift: a confirmDialog with a secondary button. The
// count is the audience at that moment (the portal reads it from
// GET /api/admin/compliance?preview={docId}; the shield from the summary).
//
//   const choice = await requireAckDialog({ title: doc.title, count: 42 });
//   if (!choice) return;                       // Cancel: nothing is sent
//   post({ action: "request", notify: choice === "notify" });
//
// Sending mail is the genuinely irreversible case STYLEGUIDE §Feedback
// reserves a dialog for; the quiet choice switches the requirement on
// without a notice.

import { confirmDialog } from "./Dialog";

export type RequireAckChoice = "notify" | "quiet";

/** "42 people" / "1 person": counts are always of people (STYLEGUIDE §Vocabulary). */
export function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

export async function requireAckDialog({
  title,
  count,
}: {
  /** The document's title. Omit on the document page itself, where "this document" is enough. */
  title?: string;
  /** How many people will be asked: the audience at this moment. */
  count: number;
}): Promise<RequireAckChoice | null> {
  const answer = await confirmDialog({
    title: title ? `Require read confirmation for "${title}"?` : "Require read confirmation?",
    body: `Everyone who can see this space (${people(count)}) will be asked to read and confirm ${
      title ? "it" : "this document"
    }.`,
    confirmLabel: "Require and notify",
    secondary: { label: "Require quietly" },
  });
  if (answer === "secondary") return "quiet";
  return answer ? "notify" : null;
}
