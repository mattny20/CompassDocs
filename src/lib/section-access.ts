// Delegated access to operational sections that live in the main navigation
// (Announcements, Compliance). Admins always have access; beyond that, an
// admin can grant individual users and/or groups per section — a comms lead
// can run announcements, an HR manager can run the compliance program,
// neither needs the admin role. Grants are stored as JSON in settings and
// enforced by pages, APIs, and the sidebar alike. Server-only.

import "server-only";
import { pool, getSetting, setSetting } from "./db";
import type { Role } from "./types";

export type Section = "announcements" | "compliance" | "training";
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
  {
    key: "training",
    label: "Training",
    description:
      "Create training decks, assign them, and track completion (everyone always sees their own assignments).",
  },
];

export interface SectionGrants {
  users: number[];
  groups: number[];
}

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];

/**
 * Who is granted this section, as users and groups.
 *
 * Since 0.94 the storage is role assignments of the seeded section role, not
 * the JSON blob this module used to keep in `settings` — but the shape the
 * settings page works with is unchanged, so the console did not have to learn
 * a new vocabulary to gain a shared model.
 *
 * Only the SEEDED role's assignments are listed. Someone who reaches the
 * section through a custom role won't appear here, and must not: this page
 * would then offer to revoke a grant it doesn't own. The Roles console is
 * where the whole picture lives.
 */
export async function getSectionGrants(section: Section): Promise<SectionGrants> {
  const { sectionRoleGrants } = await import("./db");
  const key = sectionRoleKey(section);
  return key ? sectionRoleGrants(key) : { users: [], groups: [] };
}

export async function setSectionGrants(section: Section, grants: SectionGrants): Promise<void> {
  const { setSectionRoleGrants } = await import("./db");
  const key = sectionRoleKey(section);
  if (!key) return;
  await setSectionRoleGrants(key, ids(grants.users), ids(grants.groups));
}

function sectionRoleKey(section: Section): string | null {
  return (
    { announcements: "announcements-manager", compliance: "compliance-manager", training: "training-manager" }[
      section
    ] ?? null
  );
}

/** The pre-0.94 store, read only by the break-glass path below. */
async function storedSectionGrants(section: Section): Promise<SectionGrants> {
  const raw = await getSetting(`section_access_${section}`);
  if (!raw) return { users: [], groups: [] };
  try {
    const parsed = JSON.parse(raw);
    return { users: ids(parsed?.users), groups: ids(parsed?.groups) };
  } catch {
    return { users: [], groups: [] };
  }
}



/**
 * May this user reach the section?
 *
 * Since 0.94 this is an ordinary permission check. The grants above are no
 * longer consulted — they were migrated into role assignments of the seeded
 * section roles on first boot, and the Section access page now edits those
 * assignments. What changed in practice: admins pass because the Administrator
 * preset holds the key rather than because of a hard-coded `role === "admin"`,
 * a custom role can open a section without any of this module's help, and the
 * Roles console can explain the result like any other decision.
 *
 * The legacy break-glass still applies: with COMPASSDOCS_AUTHZ_LEGACY=1 the
 * pre-0.93 rules decide, which for sections means the stored grants.
 */
export async function canAccessSection(
  user: { id: number; role: Role },
  section: Section
): Promise<boolean> {
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) return legacyCanAccessSection(user, section);
  const { SECTION_GATE } = await import("./permissions");
  const key = SECTION_GATE[section];
  if (!key) return false;
  return admits(await grantsFor(user.id), key);
}

/** Pre-0.94 rules, kept for the break-glass path only. */
async function legacyCanAccessSection(
  user: { id: number; role: Role },
  section: Section
): Promise<boolean> {
  if (user.role === "admin") return true;
  const g = await storedSectionGrants(section);
  if (g.users.includes(user.id)) return true;
  if (g.groups.length === 0) return false;
  const rows = await pool().query(
    "SELECT 1 FROM group_members WHERE user_id = $1 AND group_id = ANY($2) LIMIT 1",
    [user.id, g.groups]
  );
  return (rows.rowCount ?? 0) > 0;
}
