// The preset editor's inline rules and the blank preset a New starts from.
// Shared by the page shell (which validates every preset before Save) and
// the editor (which shows the one on screen); the server keeps the same
// rules, so what is typed is what is saved.

import type { ExportPreset } from "@/lib/directory-export-config";

/** "Wrap after": characters per line a limited column holds (the contract's 8..120). */
export const LIMIT_MIN = 8;
export const LIMIT_MAX = 120;
/** Custom margins, in inches (the contract's 0.2..2.0). */
export const MARGIN_MIN = 0.2;
export const MARGIN_MAX = 2;
export const MARGIN_SIDES = ["top", "right", "bottom", "left"] as const;
export type MarginSide = (typeof MARGIN_SIDES)[number];
export const MARGIN_LABEL: Record<MarginSide, string> = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" };

/** Inline validation for a margin: a one-decimal number between 0.2 and 2 inches, the same rule the server keeps, so what is typed is what is saved. */
export function marginError(value: number | string): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || Number.isNaN(n)) return "Enter a number.";
  if (n < MARGIN_MIN || n > MARGIN_MAX) return `Must be between ${MARGIN_MIN} and ${MARGIN_MAX}.`;
  if (Math.abs(Math.round(n * 10) / 10 - n) > 1e-9) return "Use one decimal place.";
  return undefined;
}

export const PRESET_BLANK: Omit<ExportPreset, "id" | "name"> = {
  title: "",
  subtitle: "",
  paper: "letter",
  orientation: "portrait",
  density: "normal",
  logo: true,
  columns: ["name", "title", "department", "phone", "email"],
  group_by: "",
  section_order: [],
  sort: "name",
  sort_dir: "asc",
  sort2: "",
  sort2_dir: "asc",
  page_columns: 1,
  zebra: true,
  filter: null,
  photos: false,
  pinned_first: false,
  page_numbers: true,
  printed_date: true,
  footer_note: "",
  filename: "",
  office_info: true,
  office_columns: 2,
  layout: "table",
  cards_per_row: 4,
  split_by: "",
  schedule: { frequency: "off", day: 1, hour: 6, recipients: [], format: "pdf" },
  column_limits: {},
  assistant_fields: [],
  margins: "normal",
  margin_custom: { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 },
  markers: [],
  name_format: "as_written",
  is_default: false,
};
