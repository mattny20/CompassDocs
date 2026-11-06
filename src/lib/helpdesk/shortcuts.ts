// Helpdesk 1.19.1: shortcut defaults, the server half (agent V5, mock-up
// #7; words and shapes in ./shortcuts-shared). Desk settings → Shortcuts
// picks, for each CompassDocs trigger, the request type it opens or
// Hidden; the trigger resolution (components/helpdesk/help/trigger-type)
// reads this first and falls back to 1.19.0's slug and category rule.
//
//   Request access keeps the 1.19.0 review rule (S1): only a "Request
//   access" type (lib/helpdesk/space-access isAccessRequestType: its
//   workflow asks the space's owner) may carry a space, so only such a
//   type may be chosen for it, and a choice whose workflow has since
//   changed falls back rather than opening a type that would drop the space.
//
// Server-only.

import "server-only";
import { getSetting, setSetting } from "../db";
import { hq } from "./db-core";
import { isAccessRequestType } from "./space-access";
import { HD_SHORTCUT_KEYS, HD_SHORTCUTS_KEY, normalizeShortcuts } from "./shortcuts-shared";
import type { HdShortcutChoice, HdShortcutKey, HdShortcuts, HdShortcutTypeOption } from "./shortcuts-shared";

export async function getShortcuts(): Promise<HdShortcuts> {
  const raw = await getSetting(HD_SHORTCUTS_KEY);
  try {
    return normalizeShortcuts(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeShortcuts(null);
  }
}

/** One shortcut's choice (null: automatic). */
export async function shortcutChoice(key: HdShortcutKey): Promise<HdShortcutChoice> {
  return (await getShortcuts())[key];
}

/** Every request type, as the settings page offers it (access = may open Request access). */
export async function shortcutTypeOptions(): Promise<HdShortcutTypeOption[]> {
  const rows = await hq<{ id: number; title: string; team_name: string | null; active: number; definition: { steps?: unknown[] } | null }>(
    `SELECT rt.id, rt.title, tm.name AS team_name, rt.active,
            (SELECT w.definition FROM hd_workflows w
              WHERE w.published = 1 AND (w.id = rt.workflow_id OR (rt.workflow_id IS NULL AND (w.definition->'trigger'->>'request_type_id')::int = rt.id))
              ORDER BY w.id LIMIT 1) AS definition
       FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id
      ORDER BY rt.position, rt.title, rt.id`
  );
  const { spaceApprovalKeys } = await import("./space-access");
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    team_name: r.team_name,
    active: r.active === 1,
    access: r.active === 1 && spaceApprovalKeys(r.definition).size > 0,
  }));
}

export class ShortcutError extends Error {}

/**
 * Check and save a patch ({ doc: 12, link: "hidden", handbook: null }).
 * A chosen type must exist and be active; Request access takes only a
 * "Request access" type. Returns the saved value and the keys that changed.
 */
export async function saveShortcuts(patch: Record<string, unknown>): Promise<{ shortcuts: HdShortcuts; changed: HdShortcutKey[] }> {
  const before = await getShortcuts();
  const next: HdShortcuts = { ...before };
  for (const [k, v] of Object.entries(patch)) {
    if (!(HD_SHORTCUT_KEYS as readonly string[]).includes(k)) throw new ShortcutError(`There is no shortcut called "${k}".`);
    const key = k as HdShortcutKey;
    if (v === null || v === "auto" || v === "") next[key] = null;
    else if (v === "hidden") next[key] = "hidden";
    else if (typeof v === "number" && Number.isInteger(v) && v > 0) {
      const ok = await hq<{ id: number }>("SELECT id FROM hd_request_types WHERE id = $1 AND active = 1", [v]);
      if (!ok.length) throw new ShortcutError("That request type is gone or turned off. Choose another.");
      if (key === "space_access" && !(await isAccessRequestType(v))) {
        throw new ShortcutError("Request access can only open a request type whose workflow asks the space's owner.");
      }
      next[key] = v;
    } else throw new ShortcutError("Choose a request type, Hidden or Automatic.");
  }
  const changed = HD_SHORTCUT_KEYS.filter((k) => next[k] !== before[k]);
  if (changed.length) await setSetting(HD_SHORTCUTS_KEY, JSON.stringify(next));
  return { shortcuts: next, changed };
}

/**
 * The configured type for a trigger, when it still applies to this person:
 * "hidden", a type id they may use (an access type for Request access), or
 * null to fall back to the automatic rule. `usable` is the person's types.
 */
export async function configuredShortcut(key: HdShortcutKey, usable: { id: number }[]): Promise<"hidden" | number | null> {
  const choice = await shortcutChoice(key);
  if (choice === "hidden") return "hidden";
  if (choice === null) return null;
  if (!usable.some((t) => t.id === choice)) return null;
  if (key === "space_access" && !(await isAccessRequestType(choice))) return null;
  return choice;
}
