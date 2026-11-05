"use client";

// The policy page's own metadata in the document editor's Properties
// (Handbooks 1.18.0): "In short" (up to five short points readers see first
// when the document is read in a handbook or printed with one) and "Applies
// to" (one short line, a fact beside Owner and Version). Controlled by
// DocEditor, saved with the document through PUT /api/documents/[id].
//
// The points are a list of dense inputs, each named for its row, with the
// shared label and help on the list (STYLEGUIDE §Forms): the filled points
// plus one empty slot until there are five. A point emptied mid-list keeps
// its row while the editor is open and is dropped on save.

import { useId } from "react";
import { Field, SectionEmpty, TextInput } from "@/components/form";

/** The server's limits (lib/handbooks parseSummaryPoints / parseAppliesTo). */
export const SUMMARY_POINTS_MAX = 5;
export const SUMMARY_POINT_MAX = 200;
export const APPLIES_TO_MAX = 200;

/** The points as they are saved: trimmed, non-empty, at most five. */
export function cleanPoints(points: string[]): string[] {
  return points.map((p) => p.trim()).filter(Boolean).slice(0, SUMMARY_POINTS_MAX);
}

/** The rows on screen: the points, plus one empty slot while there is room. */
function slotsFor(points: string[]): string[] {
  const last = points[points.length - 1];
  return points.length < SUMMARY_POINTS_MAX && (points.length === 0 || last.trim() !== "")
    ? [...points, ""]
    : points;
}

export function PolicyFactsFields({
  points,
  appliesTo,
  onPointsChange,
  onAppliesToChange,
  disabledReason,
  className = "",
}: {
  points: string[];
  appliesTo: string;
  onPointsChange: (next: string[]) => void;
  onAppliesToChange: (next: string) => void;
  /** Set when this person may not change them here (a published document without publish rights): the fields are read-only and this says why. */
  disabledReason?: string;
  className?: string;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const disabled = Boolean(disabledReason);
  const slots = disabled ? points : slotsFor(points);

  function setPoint(i: number, value: string) {
    const next = [...slots];
    next[i] = value;
    // Trailing empty rows collapse back into the one spare slot.
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    onPointsChange(next);
  }

  return (
    <div className={`space-y-3 ${className}`.trim()}>
      <fieldset>
        <legend className="mb-1 block text-xs font-medium text-slate-500">In short (optional)</legend>
        {slots.length === 0 ? (
          <SectionEmpty>No points yet.</SectionEmpty>
        ) : (
          <ol className="space-y-1.5">
            {slots.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-slate-500" aria-hidden>
                  {i + 1}
                </span>
                <TextInput
                  dense
                  value={p}
                  disabled={disabled}
                  maxLength={SUMMARY_POINT_MAX}
                  aria-label={`In short, point ${i + 1}`}
                  aria-describedby={helpId}
                  placeholder={i === 0 ? "e.g. You get 25 days a year plus public holidays" : undefined}
                  onChange={(e) => setPoint(i, e.target.value)}
                />
              </li>
            ))}
          </ol>
        )}
        <span id={helpId} className="mt-1 block text-xs text-slate-500">
          {disabledReason ?? "Up to five short points readers see first when this is read in a handbook."}
        </span>
      </fieldset>
      <Field label="Applies to (optional)" help={disabled ? undefined : "Who it is for, shown beside Owner and Version."}>
        <TextInput
          value={appliesTo}
          disabled={disabled}
          maxLength={APPLIES_TO_MAX}
          placeholder="e.g. All employees"
          onChange={(e) => onAppliesToChange(e.target.value)}
        />
      </Field>
    </div>
  );
}
