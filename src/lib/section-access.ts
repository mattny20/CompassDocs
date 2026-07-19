// Delegated access to operational sections that live in the main navigation
// (Announcements, Compliance). Admins always have access; beyond that, an
// admin can grant individual users and/or groups per section — a comms lead
// can run announcements, an HR manager can run the compliance program,
// neither needs the admin role. Grants are stored as JSON in settings and
// enforced by pages, APIs, and the sidebar alike. Server-only.

import "server-only";
import { pool, getSetting, setSetting } from "./db";
import type { Role } from "./types";

export type Section = "announcements" | "compliance";
export const SECTIONS: { key: Section; label: string; description: string }[] = [
  {
    key: "announcements",
    label: "Announcements",
    description: "Post, edit, and expire org-wide announcements (with email/chat delivery).",
  },
  {
    key: "compliance",
    label: "Compliance",
    description:
      "Run the policy-acknowledgement program: progress, requests, reminders, exports.",
  },
];

export interface SectionGrants {
  users: number[];
  groups: number[];
}

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];

export async function getSectionGrants(section: Section): Promise<SectionGrants> {
  const raw = await getSetting(`section_access_${section}`);
  if (!raw) return { users: [], groups: [] };
  try {
    const parsed = JSON.parse(raw);
    return { users: ids(parsed?.users), groups: ids(parsed?.groups) };
  } catch {
    return { users: [], groups: [] };
  }
}

export async function setSectionGrants(section: Section, grants: SectionGrants): Promise<void> {
  await setSetting(
    `section_access_${section}`,
    JSON.stringify({ users: ids(grants.users), groups: ids(grants.groups) })
  );
}

/** Admins always; otherwise granted directly or via group membership. */
export async function canAccessSection(
  user: { id: number; role: Role },
  section: Section
): Promise<boolean> {
  if (user.role === "admin") return true;
  const g = await getSectionGrants(section);
  if (g.users.includes(user.id)) return true;
  if (g.groups.length === 0) return false;
  const rows = await pool().query(
    "SELECT 1 FROM group_members WHERE user_id = $1 AND group_id = ANY($2) LIMIT 1",
    [user.id, g.groups]
  );
  return (rows.rowCount ?? 0) > 0;
}
