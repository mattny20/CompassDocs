// Since 1.13.0 (D1) a policy asks the people on its policy_assignments rows,
// not everyone who can see its space at read time. setAckRequired writes
// those rows for the people who exist when the requirement is switched on
// (the production path), so a fixture that inserts its people first needs
// nothing more. A fixture that adds a person AFTER switching a policy on
// (a raw INSERT INTO users, which fires no provisioning hook) calls this to
// bring the policy's rows in line, the way the hourly sweep would.

import { reconcilePolicyAssignments, setAckRequired } from "../../src/lib/db";
import { isTeardownRace, retryOnTeardownRace } from "./retry";

/** Reconcile one policy's rows with its audience: everyone active who can see the space (space mode), or the rules. Answers the counts. Repeated when another file's teardown races it (retry.ts). */
export function assignEveryone(docId: number): Promise<{ added: number; closed: number; reopened: number }> {
  return retryOnTeardownRace(() => reconcilePolicyAssignments(null, docId, { auto: false }));
}

/**
 * setAckRequired(docId, true, opts) for a fixture whose space every active
 * account can see: the switch-on's reconcile inserts a row for each of
 * them, and another file may delete one of its accounts mid-statement
 * (retry.ts, isTeardownRace). The flip commits before the reconcile, so a
 * switch-on that lost that race is repeated as the reconcile alone, the way
 * the switch-on runs it (not automatic, the first audience's deadline).
 */
export async function switchOn(docId: number, opts: Parameters<typeof setAckRequired>[2] = {}): Promise<void> {
  try {
    await setAckRequired(docId, true, opts);
  } catch (e) {
    if (!isTeardownRace(e)) throw e;
    await retryOnTeardownRace(() => reconcilePolicyAssignments(null, docId, { auto: false, initial: true }));
  }
}
