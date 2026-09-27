import "server-only";

// What a signed-in viewer may see of the directory: the registry without
// admin-only fields, people with those values blanked. Admins see all.
// Every page and route that hands directory data to a non-admin goes
// through here, so a restriction set under Fields holds everywhere at once.

import type { SessionUser } from "./types";
import { getColumnVisibility, type DirectoryField, type DirectoryPerson } from "./directory";
import { hiddenKeysFor, redactPeople, visibleFields } from "./directory-visibility";

export interface ViewerScope {
  /** Column keys the viewer must not see; empty for admins. */
  hidden: Set<string>;
  fields: DirectoryField[];
  isAdmin: boolean;
}

export function isDirectoryAdmin(user: Pick<SessionUser, "role">): boolean {
  return user.role === "admin";
}

/** The registry as this viewer sees it, and the keys to strip from people. */
export async function viewerScope(user: Pick<SessionUser, "role">, fields: DirectoryField[]): Promise<ViewerScope> {
  const isAdmin = isDirectoryAdmin(user);
  const hidden = isAdmin ? new Set<string>() : hiddenKeysFor(fields, await getColumnVisibility(), false);
  return { hidden, fields: visibleFields(fields, hidden), isAdmin };
}

/** People with this viewer's hidden keys blanked. */
export function peopleForViewer(scope: ViewerScope, people: DirectoryPerson[]): DirectoryPerson[] {
  return redactPeople(people, scope.hidden);
}

export function personForViewer(scope: ViewerScope, person: DirectoryPerson): DirectoryPerson {
  return redactPeople([person], scope.hidden)[0];
}
