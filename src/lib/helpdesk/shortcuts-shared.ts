// Helpdesk 1.19.1: shortcut defaults (agent V5, mock-up #7). The four ways
// to start a request from elsewhere in CompassDocs (agent E's triggers) and,
// per shortcut, the request type it opens, or Hidden. Pure: the settings
// page and the server share the keys, the words and the validation.
//
// Stored under the settings key `helpdesk_shortcuts` (lib/helpdesk/shortcuts):
// { doc: 12, handbook: "hidden", link: null, space_access: 7 }. null or
// missing = automatic: the trigger picks a type by its starter slug and
// category, as 1.19.0 did (components/helpdesk/help/trigger-type).

export const HD_SHORTCUT_KEYS = ["doc", "handbook", "space_access", "link"] as const;
export type HdShortcutKey = (typeof HD_SHORTCUT_KEYS)[number];

/** A shortcut's setting: a request type id, "hidden", or null (automatic). */
export type HdShortcutChoice = number | "hidden" | null;
export type HdShortcuts = Record<HdShortcutKey, HdShortcutChoice>;

export const HD_SHORTCUTS_KEY = "helpdesk_shortcuts";

export const HD_SHORTCUT_DEFAULTS: HdShortcuts = { doc: null, handbook: null, space_access: null, link: null };

/** The rows of Desk settings → Shortcuts, in the mock-up's order. */
export const HD_SHORTCUT_ROWS: { key: HdShortcutKey; label: string; where: string }[] = [
  { key: "doc", label: "Report a problem with this page", where: "Every document's side rail" },
  { key: "handbook", label: "Ask about this policy", where: "Handbook policy pages" },
  { key: "space_access", label: "Request access", where: "A space's address you can't open" },
  { key: "link", label: "Report a broken link", where: "Quick links and the Links page" },
];

/** Fill and clean a stored value: unknown keys dropped, bad values automatic. Never throws. */
export function normalizeShortcuts(raw: unknown): HdShortcuts {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: HdShortcuts = { ...HD_SHORTCUT_DEFAULTS };
  for (const k of HD_SHORTCUT_KEYS) {
    const c = v[k];
    if (c === "hidden") out[k] = "hidden";
    else if (typeof c === "number" && Number.isInteger(c) && c > 0) out[k] = c;
  }
  return out;
}

/** One request type as the page offers it. */
export interface HdShortcutTypeOption {
  id: number;
  title: string;
  team_name: string | null;
  active: boolean;
  /** Its workflow asks the space's owner: the only kind Request access may open (1.19.0 review fix, S1). */
  access: boolean;
}

/** "Content problem · Knowledge team" / "Access to a space · approved by its owner". */
export function shortcutTypeLabel(t: Pick<HdShortcutTypeOption, "title" | "team_name" | "access">): string {
  if (t.access) return `${t.title} · approved by its owner`;
  return t.team_name ? `${t.title} · ${t.team_name}` : t.title;
}
