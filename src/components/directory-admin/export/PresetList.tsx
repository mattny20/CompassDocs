"use client";

// The left pane of the Export page: one rail row per preset (STYLEGUIDE
// §Rails and navigation rows), lit when it is the one in the editor, with a
// chip for each state worth seeing before opening it: the default preset, a
// zip (one file per value), a schedule, whose sentence reads under the chips
// (not as a tooltip: the chip sits inside the row button, which cannot hold
// a focusable, and the card clips its overflow). Rows are buttons, not
// links: picking a preset changes what the editor shows, not the page. The
// sr-only commas and expansions make the row's accessible name a sentence:
// "Phone list, Default, ZIP, one file per value, Scheduled, Every Friday at
// 07:00 UTC".

import { FileText, Plus } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { railIconClass, railRowClass } from "@/components/RailLink";
import type { ExportPreset } from "@/lib/directory-export-config";
import { describeSchedule } from "@/lib/directory-export-schedule-rules";

export function PresetList({
  presets,
  selected,
  onSelect,
  onNew,
}: {
  presets: ExportPreset[];
  /** The index of the preset in the editor. */
  selected: number;
  onSelect: (index: number) => void;
  onNew: () => void;
}) {
  return (
    <Card id="presets" padding="none" title="Presets" className="scroll-mt-6 lg:sticky lg:top-6">
      <ul role="list" className="space-y-0.5 p-2">
        {presets.map((p, i) => {
          const active = i === selected;
          const scheduled = p.schedule.frequency !== "off";
          const chips = p.is_default || Boolean(p.split_by) || scheduled;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={active ? "true" : undefined}
                className={`w-full text-left ${railRowClass(active, { dense: true })}`}
              >
                <FileText className={`h-4 w-4 ${railIconClass(active)}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name || "Untitled preset"}</span>
                  {chips && (
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {p.is_default && (
                        <span className={chipClass("info", "sm")}>
                          <span className="sr-only">, </span>Default
                        </span>
                      )}
                      {p.split_by && (
                        <span className={chipClass("neutral", "sm")}>
                          <span className="sr-only">, </span>ZIP<span className="sr-only">, one file per value</span>
                        </span>
                      )}
                      {scheduled && (
                        <span className={chipClass("accent", "sm")}>
                          <span className="sr-only">, </span>Scheduled
                        </span>
                      )}
                    </span>
                  )}
                  {scheduled && (
                    <span className="mt-0.5 block truncate text-2xs font-normal text-slate-500">
                      <span className="sr-only">, </span>
                      {describeSchedule(p.schedule)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-slate-100 px-4 py-3">
        <Button variant="secondary" icon={<Plus />} onClick={onNew}>
          New preset
        </Button>
      </div>
    </Card>
  );
}
