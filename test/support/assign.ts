// Since 1.13.0 (D1) a policy asks the people on its policy_assignments rows,
// not everyone who can see its space at read time. setAckRequired writes
// those rows for the people who exist when the requirement is switched on
// (the production path), so a fixture that inserts its people first needs
// nothing more. A fixture that adds a person AFTER switching a policy on
// (a raw INSERT INTO users, which fires no provisioning hook) calls this to
// bring the policy's rows in line, the way the hourly sweep would.

import { reconcilePolicyAssignments } from "../../src/lib/db";

/** Reconcile one policy's rows with its audience: everyone active who can see the space (space mode), or the rules. Answers the counts. */
export function assignEveryone(docId: number): Promise<{ added: number; closed: number; reopened: number }> {
  return reconcilePolicyAssignments(null, docId, { auto: false });
}
