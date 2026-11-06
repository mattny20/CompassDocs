"use client";

// The left pane of a library tab (1.19.0): one rail row per part, lit when
// it is in the editor, with chips for what is worth knowing before opening
// it (Default, Built-in, Edited) and a "Used by N" line. Rows are buttons:
// picking a part changes what the editor shows, not the page (the export
// presets' recipe, STYLEGUIDE §Settings pages). Bodies are grouped under
// their email event; the other kinds are one list. One secondary New
// button in the footer row.

import { FileText, Plus } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { RAIL_GROUP_TEXT, railIconClass, railRowClass } from "@/components/RailLink";
import { SectionEmpty } from "@/components/form";
import { KIND_LABEL, KIND_PLURAL } from "./types";
import type { EmailPartKind, EventInfo, PartWithUsage } from "./types";

export function usedLabel(n: number): string {
  return n === 0 ? "Not used" : n === 1 ? "Used by 1 template" : `Used by ${n} templates`;
}

/** The kind's default is used by every email that follows it, chosen or not. */
export function defaultLabel(n: number | undefined): string | null {
  return n ? (n === 1 ? "Default for 1 email" : `Default for ${n} emails`) : null;
}

function Row({
  p,
  active,
  onSelect,
  kind,
  forEvent,
}: {
  p: PartWithUsage;
  active: boolean;
  onSelect: () => void;
  kind: EmailPartKind;
  /** A custom body: the email it is for. */
  forEvent: string;
}) {
  const used = p.used_by.length;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={`w-full text-left ${railRowClass(active, { dense: true })}`}
      >
        <FileText className={`mt-0.5 h-4 w-4 self-start ${railIconClass(active)}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{p.name}</span>
          {(p.is_default || p.builtin) && (
            <span className="mt-0.5 flex flex-wrap gap-1">
              {p.is_default && kind !== "body" && (
                <span className={chipClass("info", "sm")}>
                  <span className="sr-only">, </span>Default
                </span>
              )}
              {p.builtin && (
                <span className={chipClass("neutral", "sm")}>
                  <span className="sr-only">, </span>Built-in
                </span>
              )}
              {p.builtin && p.customized && (
                <span className={chipClass("warn", "sm")}>
                  <span className="sr-only">, </span>Edited
                </span>
              )}
            </span>
          )}
          <span className="mt-0.5 block truncate text-2xs font-normal text-slate-500">
            <span className="sr-only">, </span>
            {forEvent ? `For ${forEvent} · ` : ""}
            {defaultLabel(p.default_for) ? `${defaultLabel(p.default_for)}${used ? ` · ${usedLabel(used).toLowerCase()}` : ""}` : usedLabel(used)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Bodies by the area of their email, in the events' order, the built-in body first. */
export function bodyGroups(parts: PartWithUsage[], events: EventInfo[]) {
  const order = new Map(events.map((e, i) => [e.key, i]));
  const out: { key: string; label: string; parts: PartWithUsage[] }[] = [];
  for (const e of events) {
    let g = out.find((x) => x.key === e.area);
    if (!g) out.push((g = { key: e.area, label: e.area, parts: [] }));
  }
  const sorted = parts
    .filter((p) => p.event_key && order.has(p.event_key))
    .sort((a, b) => order.get(a.event_key!)! - order.get(b.event_key!)! || Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  for (const p of sorted) {
    const area = events[order.get(p.event_key!)!].area;
    out.find((g) => g.key === area)!.parts.push(p);
  }
  return out.filter((g) => g.parts.length > 0);
}

export function PartList({
  kind,
  parts,
  events,
  selected,
  onSelect,
  onNew,
  creating,
}: {
  kind: EmailPartKind;
  parts: PartWithUsage[];
  events: EventInfo[];
  /** The part in the editor (null while a new one is). */
  selected: number | null;
  onSelect: (id: number) => void;
  /** Absent for a read-only library. */
  onNew?: () => void;
  creating: boolean;
}) {
  const groups = kind === "body" ? bodyGroups(parts, events) : [{ key: "all", label: "", parts }];
  const eventLabel = (key: string | null) => events.find((e) => e.key === key)?.label ?? "";

  return (
    <Card padding="none" title={KIND_PLURAL[kind]} className="self-start @3xl:sticky @3xl:top-6">
      {parts.length === 0 ? (
        <SectionEmpty className="px-4 py-6">No {KIND_PLURAL[kind].toLowerCase()} yet.</SectionEmpty>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto p-2">
          {groups.map((g) => (
            <div key={g.key} className={g.label ? "mt-2 first:mt-0" : ""}>
              {g.label && <p className={`px-3 pb-1 pt-1 ${RAIL_GROUP_TEXT}`}>{g.label}</p>}
              <ul role="list" className="space-y-0.5" aria-label={g.label || KIND_PLURAL[kind]}>
                {g.parts.map((p) => (
                  <Row
                    key={p.id}
                    p={p}
                    kind={kind}
                    forEvent={kind === "body" && !p.builtin ? eventLabel(p.event_key) : ""}
                    active={!creating && p.id === selected}
                    onSelect={() => onSelect(p.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {onNew && (
        <div className="border-t border-slate-100 px-4 py-3">
          <Button variant="secondary" icon={<Plus />} onClick={onNew} disabled={creating}>
            New {KIND_LABEL[kind].toLowerCase()}
          </Button>
        </div>
      )}
    </Card>
  );
}
