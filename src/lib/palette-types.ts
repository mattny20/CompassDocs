// Shared shapes for the command palette. Isomorphic: no server-only imports,
// no React — safe from both server components and client bundles.

export type PaletteKind = "doc" | "person" | "space" | "nav" | "command" | "recent";

/** Which slice of the world the palette is searching right now. */
export type PaletteMode = "all" | "commands" | "people" | "spaces" | "help";

export interface PaletteItem {
  /** Stable, unique across sources — used as the React key and the a11y id. */
  id: string;
  kind: PaletteKind;
  label: string;
  /** Second line: space name, job title, section description… */
  sub?: string;
  /** Where Enter goes. Mutually exclusive with `run`. */
  href?: string;
  /** What Enter does, for action commands. Mutually exclusive with `href`. */
  run?: () => void | Promise<void>;
  /** Character ranges in `label` that matched the query, for highlighting. */
  ranges?: [number, number][];
  /** Pre-sanitized snippet HTML from the search API (docs only). */
  snippetHtml?: string;
  /** Space emoji, for doc/space rows. */
  emoji?: string;
  /** Directory person id, for the avatar endpoint. */
  photoId?: number;
  /** Keyboard hint shown on the right of the row (e.g. "g p"). */
  hint?: string;
  /** Higher sorts first within a group. */
  score?: number;
}

export const GROUP_ORDER: PaletteKind[] = [
  "recent",
  "command",
  "nav",
  "doc",
  "person",
  "space",
];

export const GROUP_LABEL: Record<PaletteKind, string> = {
  recent: "Recent",
  command: "Actions",
  nav: "Go to",
  doc: "Documents",
  person: "People",
  space: "Spaces",
};

/** Which modes show which groups. "all" shows everything. */
export const MODE_GROUPS: Record<PaletteMode, PaletteKind[] | null> = {
  all: null,
  commands: ["command"],
  people: ["person"],
  spaces: ["space"],
  help: [],
};

export const MODE_LABEL: Record<PaletteMode, string> = {
  all: "",
  commands: "Actions",
  people: "People",
  spaces: "Spaces",
  help: "Shortcuts",
};

export const MODE_PLACEHOLDER: Record<PaletteMode, string> = {
  all: "Search documents, people, and actions…",
  commands: "Run an action…",
  people: "Search people…",
  spaces: "Jump to a space…",
  help: "Keyboard shortcuts",
};
