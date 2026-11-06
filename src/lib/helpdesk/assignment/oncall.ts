// Helpdesk 1.19.0: the on-call rota's view (agent N). The rotation (an
// ordered list of people, a turn length in days, a handover time in a
// timezone, the first handover's date) is computed, not stored shift by
// shift: rotationShifts (./shared) works out any window, the same wall-clock
// handover across DST. One-off cover is stored in hd_on_call (source
// 'override') and wins over the rotation while it lasts. A rule with assign
// 'on_call' gives the ticket to whoever this says is on call now.
// Server-only.

import "server-only";
import { hq } from "../db-core";
import { getRotation, listOverrides } from "./store";
import { onCallAt, onCallStrip, type HdOnCallRotation, type HdOnCallShift } from "./shared";

export interface OnCallView {
  rotation: HdOnCallRotation | null;
  /** Cover from now on (and any running now). */
  overrides: (HdOnCallShift & { name: string })[];
  now: (HdOnCallShift & { name: string }) | null;
  /** Days from today in the rotation's timezone (UTC without one). */
  strip: { date: string; segments: (HdOnCallShift & { name: string })[] }[];
  timezone: string;
  /** user id → name for everyone mentioned. */
  people: Record<number, string>;
}

export async function onCallView(teamId: number, now: Date = new Date(), days = 28): Promise<OnCallView> {
  const rotation = await getRotation(teamId);
  const tz = rotation?.timezone ?? "UTC";
  const until = new Date(now.getTime() + (days + 2) * 86_400_000);
  const overrides = await listOverrides(teamId, new Date(now.getTime() - 2 * 86_400_000), until);
  const strip = onCallStrip(rotation, overrides, now.getTime(), days, tz);
  const current = onCallAt(rotation, overrides, now.getTime());
  const ids = new Set<number>([...(rotation?.user_ids ?? []), ...overrides.map((o) => o.user_id)]);
  const rows = ids.size ? await hq<{ id: number; name: string }>("SELECT id, name FROM users WHERE id = ANY($1::int[])", [[...ids]]) : [];
  const people: Record<number, string> = {};
  for (const r of rows) people[r.id] = r.name;
  const named = <T extends HdOnCallShift>(s: T) => ({ ...s, name: people[s.user_id] ?? "Someone" });
  return {
    rotation,
    overrides: overrides.filter((o) => Date.parse(o.ends_at) > now.getTime()).map(named),
    now: current ? named(current) : null,
    strip: strip.map((d) => ({ date: d.date, segments: d.segments.map(named) })),
    timezone: tz,
    people,
  };
}
