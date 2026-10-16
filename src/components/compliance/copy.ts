// Shared compliance copy (1.10.1): the three edit-default options, the
// portal's chip labels for them and the people() count, in one small
// client-safe module. The shield popover (AckSettings), the portal
// (CompliancePanel), the re-ask control (ReconfirmButton), the editor's
// question (ReconfirmModal), the shared "Require read confirmation?" dialog
// (RequireAckDialog) and the Program settings form all read it here, so no
// surface keeps a private copy of a sentence another one shows, and the
// document page does not pull the settings form (its SaveRow, Card and
// unsaved-changes hooks) into its bundle for three labels. No React in
// here: a plain module both server and client components can import.

import type { EditDefault } from "@/lib/compliance-settings";

/** "42 people" / "1 person": counts are always of people (STYLEGUIDE §Vocabulary). */
export function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** The three answers to "when the text of a policy changes", in the order
 *  the Selects show them (Program settings E4, the shield popover A5). The
 *  popover suffixes the one equal to the workspace value with "(workspace
 *  default)", dropping "(recommended)" first so no option carries two
 *  parentheticals. */
export const EDIT_DEFAULT_OPTIONS: { value: EditDefault; label: string; help: string }[] = [
  {
    value: "ask",
    label: "Ask the editor each time (recommended)",
    help: "Every text save opens the question: editorial fix, or material change. The editor decides and the record keeps the choice.",
  },
  {
    value: "material",
    label: "Ask only when a change looks material",
    help: "Good for procedures that change often: typo-sized edits pass quietly and are recorded; anything that looks material still asks.",
  },
  {
    value: "reset",
    label: "Always ask everyone to re-confirm",
    help: "Good for signed-off policies: every text change asks everyone to re-confirm, and the change note is required.",
  },
];

/** The per-policy edit-default chip on the portal row (A5): a short state;
 *  the full option sentence is its tooltip (CompliancePanel's editDefaultTip). */
export const EDIT_DEFAULT_CHIP: Record<EditDefault, string> = {
  ask: "Asks editor",
  material: "Asks when material",
  reset: "Always re-asks",
};
