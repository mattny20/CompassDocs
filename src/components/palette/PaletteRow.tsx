"use client";

// One result row in the command palette.
//
// Memoized because the palette re-renders on every keystroke and a long list of
// rows is the only thing in it that costs anything to paint.
//
// Two structural rules that look like details and are not:
//
//  1. A row is a `role="option"` DIV, never a <button>. Focus stays on the
//     search input for the palette's whole life (combobox +
//     aria-activedescendant), which is what keeps ↑↓/Enter/Tab working while
//     the user types. A button would be a tab stop and would take focus on
//     click.
//  2. `onMouseDown` is prevented, so pressing the mouse on a row does not blur
//     the input on the way to the click. Same trick DocLinkSuggest already uses
//     to keep the editor focused through a pick.
//
// Selected rows are `bg-compass-50 text-compass-700`. NOT text-compass-800:
// globals.css hand-lightens only .text-compass-600 and .text-compass-700 for
// dark mode, so compass-800 renders as dark blue on dark navy.

import { memo, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  FileText,
  FolderKanban,
  UserRound,
} from "lucide-react";
import type { PaletteItem, PaletteKind } from "@/lib/palette-types";
import { NAV_ITEMS } from "@/lib/nav-items";
import { PALETTE_COMMANDS } from "@/lib/palette-commands";
import { safeSnippet } from "@/lib/snippet";
import { initialsOf } from "@/components/UserAvatar";
import { Kbd } from "./Kbd";

/** Last-resort icon per kind, when the item matches no registry entry. */
const KIND_ICON: Record<PaletteKind, LucideIcon> = {
  recent: Clock,
  command: ChevronRight,
  nav: ArrowRight,
  doc: FileText,
  person: UserRound,
  space: FolderKanban,
};

// PaletteItem carries no icon (a LucideIcon reference can't ride along in the
// generic item shape), so the row looks the real one up from the same
// registries the item came from. Built once at module scope.
const NAV_ICONS = new Map(NAV_ITEMS.map((i) => [i.href, i.icon]));
const COMMAND_ICONS = new Map(PALETTE_COMMANDS.map((c) => [c.id, c.icon]));

function iconFor(item: PaletteItem, override?: LucideIcon): LucideIcon {
  if (override) return override;
  if (item.href) {
    const nav = NAV_ICONS.get(item.href);
    if (nav) return nav;
  }
  // Ids are namespaced ("command:doc.new"); the bare id is the registry key.
  const command = COMMAND_ICONS.get(item.id.slice(item.id.indexOf(":") + 1));
  if (command) return command;
  return KIND_ICON[item.kind];
}

/**
 * The matched characters of the label, emphasized. Plain text — the scorer's
 * ranges are indices into `label`, never markup, so this is not an HTML sink.
 * A <span> rather than a <mark>: the global `mark` rule in globals.css is
 * unlayered and would beat any Tailwind class put on it.
 */
function Highlight({ text, ranges }: { text: string; ranges?: [number, number][] }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(at, Math.min(rawStart, text.length));
    const end = Math.max(start, Math.min(rawEnd, text.length));
    if (end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} className="font-semibold text-compass-700">
        {text.slice(start, end)}
      </span>
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export interface PaletteRowProps {
  item: PaletteItem;
  selected: boolean;
  onPick: (item: PaletteItem) => void;
  /** Called when the pointer genuinely moves over the row, to move the cursor. */
  onHover: (item: PaletteItem) => void;
  /** Position in the flattened list; surfaced as `data-index` for tests. */
  index?: number;
  /**
   * DOM id override. Defaults to `item.id`, which is what the input's
   * `aria-activedescendant` points at — keep the two in step.
   */
  id?: string;
  /** Icon override, when the caller already knows better than the registries. */
  icon?: LucideIcon;
}

export const PaletteRow = memo(function PaletteRow({
  item,
  selected,
  onPick,
  onHover,
  index,
  id,
  icon,
}: PaletteRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const Icon = iconFor(item, icon);
  const isPerson = item.kind === "person";
  const hintKeys = item.hint ? item.hint.trim().split(/\s+/).filter(Boolean) : [];

  // The photo endpoint 404s for a person with no photo, so failure is routine
  // rather than exceptional — fall back to initials and reset when the row is
  // reused for someone else.
  useEffect(() => setPhotoFailed(false), [item.photoId]);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={ref}
      id={id ?? item.id}
      role="option"
      aria-selected={selected}
      data-palette-row=""
      data-index={index}
      // Keeps focus on the search input through a click (see the header note).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(item)}
      // mousemove, not mouseenter: the list scrolling under a parked cursor
      // fires enter events, which would let the mouse fight the keyboard over
      // what Enter is about to do.
      onMouseMove={() => {
        if (!selected) onHover(item);
      }}
      className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left ${
        selected ? "bg-compass-50 text-compass-700" : "text-slate-700 hover:bg-slate-50"
      }`}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center">
        {isPerson && item.photoId != null && !photoFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/directory/${item.photoId}/photo`}
            alt=""
            aria-hidden
            loading="lazy"
            onError={() => setPhotoFailed(true)}
            className="h-5 w-5 rounded-full object-cover"
          />
        ) : isPerson ? (
          <span
            aria-hidden
            className="grid h-5 w-5 place-items-center rounded-full bg-compass-100 text-[10px] font-semibold text-compass-700"
          >
            {initialsOf(item.label)}
          </span>
        ) : item.emoji ? (
          // A space's emoji is DB content the admin chose, not UI chrome — the
          // documented carve-out from the lucide-only rule, matching the sidebar.
          <span aria-hidden className="text-sm leading-none">
            {item.emoji}
          </span>
        ) : (
          <Icon className="h-4 w-4 text-slate-400" aria-hidden />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          <Highlight text={item.label} ranges={item.ranges} />
        </span>
        {item.sub && <span className="block truncate text-xs text-slate-500">{item.sub}</span>}
        {item.snippetHtml && (
          // The palette's ONE HTML sink, so the escaping happens here rather
          // than on trust: ts_headline copies document text verbatim and only
          // wraps matches in literal <mark>, so a doc author could otherwise
          // plant <img onerror=…>. safeSnippet escapes everything and restores
          // just our own <mark> tokens. Sanitizing at the sink means a new
          // result source can't reintroduce the hole by forgetting to call it.
          <span
            className="cmd-snippet block text-xs text-slate-400"
            dangerouslySetInnerHTML={{ __html: safeSnippet(item.snippetHtml) }}
          />
        )}
      </span>

      {(hintKeys.length > 0 || selected) && (
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Showing the shortcut on the slow path is how anyone ever learns it. */}
          {hintKeys.length > 0 && <Kbd keys={hintKeys} />}
          {selected && <Kbd keys={["Enter"]} />}
        </span>
      )}
    </div>
  );
});
