// What a composition amounts to, for a row or a picker: the part each slot
// uses and whether the email differs from what CompassDocs ships (any slot
// off its default, or the event's built-in body edited).

import type { EmailComposition, EmailPartKind, PartWithUsage } from "./types";
import { KINDS } from "./types";

export function defaultPart(parts: PartWithUsage[], kind: Exclude<EmailPartKind, "body">): PartWithUsage | undefined {
  return parts.find((p) => p.kind === kind && p.is_default);
}

export function builtinBodyOf(parts: PartWithUsage[], event: string): PartWithUsage | undefined {
  return parts.find((p) => p.kind === "body" && p.builtin_key === `body:${event}`);
}

/** The part a slot falls back to when it names none ('all' scope). */
export function fallbackPart(parts: PartWithUsage[], kind: EmailPartKind, event: string): PartWithUsage | undefined {
  return kind === "body" ? builtinBodyOf(parts, event) : defaultPart(parts, kind);
}

export interface SlotSummary {
  kind: EmailPartKind;
  name: string;
  /** This slot is not the shipped default. */
  changed: boolean;
}

export function summarize(
  comp: EmailComposition,
  parts: PartWithUsage[]
): { slots: SlotSummary[]; customized: boolean } {
  const slots = KINDS.map((kind) => {
    const slot = comp[kind];
    const fb = fallbackPart(parts, kind, comp.event_key);
    const own = parts.find((p) => p.id === slot.effective_id);
    const changed =
      (slot.effective_id ?? null) !== (fb?.id ?? null) || (kind === "body" && !!own?.builtin && !!own?.customized);
    return { kind, name: slot.effective_name || "None", changed };
  });
  return { slots, customized: slots.some((s) => s.changed) };
}
