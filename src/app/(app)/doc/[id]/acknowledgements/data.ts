import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { ackStatusForDocument } from "@/lib/db";
import { cachedDocument } from "@/lib/page-data";

// What every Read confirmation page shares (1.10.0): the guards and the
// roster. React's cache() is per request, so the layout and the page it
// wraps check the permission once and read the roster once, and a later
// write is never served stale.

/**
 * The guards today's roster page had, in one place: the roster permission,
 * the policy_ack licence and the viewer's space scope. The layout calls it
 * to keep the chrome from rendering for someone about to be redirected;
 * each page calls it again (the settings convention) and gets the memoised
 * answer.
 */
export const ackPageContext = cache(async (docId: number) => {
  const user = await requirePermission("approver", "document.ack_roster_read");
  if (!(await featureEnabled("policy_ack"))) notFound();
  const doc = await cachedDocument(docId);
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) notFound();
  return { user, doc };
});

/** The roster, read once: the layout counts it and the Record page lists it. */
export const cachedAckRows = cache((docId: number) => ackStatusForDocument(docId));
