// Helpdesk 1.19.2: per-person "seen" records behind the desk settings
// rail's "New" chips and the release strip (agent W5; the list is
// lib/helpdesk/whats-new-shared). Server-only.
//
// A page counts as seen the first time its person opens it (the rail
// records it from the browser: POST /api/helpdesk/whats-new {item}); the
// strip counts as seen when they dismiss it. Each is one row in
// hd_desk_seen, written once (ON CONFLICT DO NOTHING) and audited once
// (helpdesk.whats_new.seen), and only for an item of the current list, so
// the table holds a handful of rows per person.

import "server-only";
import { audit } from "../audit";
import { hq, hqOne } from "./db-core";
import { DESK_NEW_PAGES, DESK_NEW_RELEASE, DESK_NEW_STRIP, isDeskNewItem, type DeskNewState } from "./whats-new-shared";

export * from "./whats-new-shared";

/** What this person has not seen yet, among the pages `visibleHrefs` (their rail) shows. */
export async function deskNewState(userId: number, visibleHrefs: readonly string[]): Promise<DeskNewState> {
  const items = [...DESK_NEW_PAGES.map((p) => p.href), DESK_NEW_STRIP];
  let seen = new Set<string>();
  try {
    const rows = await hq<{ item: string }>("SELECT item FROM hd_desk_seen WHERE user_id = $1 AND item = ANY($2::text[])", [userId, items]);
    seen = new Set(rows.map((r) => r.item));
  } catch {
    // Before the boot schema has run (a 1.19.1 database): nothing is flagged.
    return { release: DESK_NEW_RELEASE, unseen: [], strip: false };
  }
  const unseen = DESK_NEW_PAGES.filter((p) => visibleHrefs.includes(p.href) && !seen.has(p.href)).map((p) => p.href);
  // The strip names the pages this person can open; with none, there is nothing to tell.
  const reachable = DESK_NEW_PAGES.some((p) => visibleHrefs.includes(p.href));
  return { release: DESK_NEW_RELEASE, unseen, strip: reachable && !seen.has(DESK_NEW_STRIP) };
}

/** Record that this person has seen an item. Answers false for an item not on the list; true otherwise (new or not). */
export async function markDeskSeen(user: { id: number; name?: string; username?: string; role?: string | null }, item: unknown): Promise<boolean> {
  if (!isDeskNewItem(item)) return false;
  const row = await hqOne<{ item: string }>(
    "INSERT INTO hd_desk_seen (user_id, item) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING item",
    [user.id, item]
  );
  if (row) {
    await audit({
      actor: { id: user.id, name: user.name || user.username || "", role: (user.role ?? null) as never },
      action: "helpdesk.whats_new.seen",
      targetType: "helpdesk_whats_new",
      targetLabel: item,
      details: { release: DESK_NEW_RELEASE, item, dismissed: item === DESK_NEW_STRIP },
    });
  }
  return true;
}
