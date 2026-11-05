import "server-only";
import { pool } from "./db";

// The home dashboard's sections (1.17.0) and which of them a person has
// switched off with Edit dashboard. A hidden section is not rendered and its
// data is not fetched. The keys are the `id` each section hands DashboardTile
// (STYLEGUIDE §Dashboard tiles), stored per person in users.dashboard_hidden.
// The pinned blocks above the grid (announcements, newsletters, Needs your
// attention, Pick up where you left off) are not sections: they are things
// waiting on the person, so they cannot be hidden.

export type DashboardColumn = "top" | "left" | "right";

export const DASHBOARD_SECTIONS: { key: string; label: string; column: DashboardColumn; help: string }[] = [
  { key: "status", label: "System status", column: "top", help: "The services on the Status page, when any are tracked." },
  { key: "latest", label: "Latest in your spaces", column: "left", help: "Recently updated documents." },
  { key: "popular", label: "Popular this week", column: "left", help: "The most-read documents of the last 7 days." },
  { key: "spaces", label: "Spaces", column: "left", help: "Your most recently active spaces." },
  { key: "training", label: "My training", column: "left", help: "Shown while you have training to finish." },
  { key: "compliance", label: "Team compliance", column: "left", help: "Shown when people report to you." },
  { key: "quick_links", label: "Quick links", column: "right", help: "Your pins, your admin's picks and your most-used links." },
  { key: "my_team", label: "My team", column: "right", help: "Your manager, team and reports from the directory." },
  { key: "people", label: "People this week", column: "right", help: "New starters, work anniversaries and birthdays." },
];

const KEYS = new Set(DASHBOARD_SECTIONS.map((s) => s.key));

export function isDashboardSection(key: unknown): key is string {
  return typeof key === "string" && KEYS.has(key);
}

/** The sections this person has hidden; unknown (retired) keys are dropped. */
export async function getHiddenDashboardSections(userId: number): Promise<Set<string>> {
  const rows = (
    await pool().query<{ dashboard_hidden: string[] | null }>("SELECT dashboard_hidden FROM users WHERE id = $1", [userId])
  ).rows;
  return new Set((rows[0]?.dashboard_hidden ?? []).filter(isDashboardSection));
}

/** Store the hidden set (known keys only, once each, in section order). */
export async function setHiddenDashboardSections(userId: number, hidden: string[]): Promise<string[]> {
  const want = new Set(hidden);
  const clean = DASHBOARD_SECTIONS.map((s) => s.key).filter((k) => want.has(k));
  await pool().query("UPDATE users SET dashboard_hidden = $1::text[] WHERE id = $2", [clean, userId]);
  return clean;
}
