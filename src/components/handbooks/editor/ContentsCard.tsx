"use client";

// The handbook editor's Contents card (1.18.0, mock-ups 1-editor and
// 7-where-found): the sections in order, each an eyebrow with its number and
// a Rename / Remove pair, then its policies numbered across the whole
// handbook, each with "Where people find it", Move up / Move down (crossing
// into the neighbouring section at an edge) and Remove. Every change is
// local until the page's Save. Focus never falls to <body>: a move keeps
// focus on the button that was pressed, a remove moves it to the next row's
// Remove (the previous row's, else Add section). A move or a remove is also
// said in a polite live region ("Moved Leave policy to 3 of 8, in Time
// off."), since a pressed arrow that keeps focus gives no other feedback.
//
// A document from a space this editor can't add from (HandbookItem.restricted)
// is a locked placeholder: a Lock and "A document you can't open" in muted
// ink, a line saying why, and only Move up / Move down / Remove — no "Where
// people find it" menu and nothing that opens it (its title, space and
// version never reach this page).

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Lock, Pencil, Plus, X } from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { promptDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import { CardTitle, EYEBROW_TEXT } from "@/components/Heading";
import { useFormatDate } from "@/components/SettingsProvider";
import type { FindMode } from "@/lib/handbooks";
import { FindModeMenu } from "./FindModeMenu";
import {
  SECTIONS_MAX,
  SECTION_TITLE_MAX,
  allItems,
  canMove,
  policies,
  type DraftSection,
} from "./model";

function sectionTitleProblem(v: string): string | undefined {
  const t = v.trim();
  if (!t) return "Give the section a name.";
  if (t.length > SECTION_TITLE_MAX) return `Up to ${SECTION_TITLE_MAX} characters.`;
  return undefined;
}

export function ContentsCard({
  sections,
  published,
  disabled,
  onAddSection,
  onRenameSection,
  onRemoveSection,
  onMove,
  onRemove,
  onFindMode,
  emptyHint,
}: {
  sections: DraftSection[];
  /** The handbook is published: "Handbook only" is in effect (the no-orphans rule). */
  published: boolean;
  disabled: boolean;
  onAddSection: (title: string) => void;
  onRenameSection: (key: string, title: string) => void;
  onRemoveSection: (key: string) => void;
  onMove: (docId: number, direction: "up" | "down") => void;
  onRemove: (docId: number) => void;
  onFindMode: (docId: number, mode: FindMode) => void;
  /** What fills the card while it is empty (the new page has no Add policies panel yet). */
  emptyHint: string;
}) {
  const fmt = useFormatDate();
  const titleId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ doc: number; act: string } | { add: true } | null>(null);
  const [said, setSaid] = useState("");

  const flat = allItems(sections);
  const total = flat.length;
  const hidden = flat.filter((i) => i.find_mode === "handbook_only").length;

  // Focus lands after React has committed the moved or shortened list; the
  // live region says where the moved row now is, from that same list.
  useEffect(() => {
    if (!focusAfter) return;
    if ("add" in focusAfter) addRef.current?.focus();
    else {
      if (focusAfter.act === "up" || focusAfter.act === "down") {
        const list = allItems(sections);
        const at = list.findIndex((i) => i.doc_id === focusAfter.doc);
        const home = sections.find((x) => x.items.some((i) => i.doc_id === focusAfter.doc));
        if (at >= 0 && home) setSaid(`Moved ${list[at].title} to ${at + 1} of ${list.length}, in ${home.title}.`);
      }
      const row = listRef.current?.querySelector<HTMLElement>(`[data-doc="${focusAfter.doc}"]`);
      const want = row?.querySelector<HTMLButtonElement>(`[data-act="${focusAfter.act}"]`);
      // At the top (or bottom) the pressed arrow is now disabled: its partner takes focus.
      const partner = focusAfter.act === "up" ? "down" : focusAfter.act === "down" ? "up" : "remove";
      (want && !want.disabled ? want : row?.querySelector<HTMLElement>(`[data-act="${partner}"]`))?.focus();
    }
    setFocusAfter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per press, against the list it committed
  }, [focusAfter]);

  async function addSection() {
    const title = await promptDialog({
      title: "Add section",
      label: "Section name",
      placeholder: "Working here",
      confirmLabel: "Add section",
      validate: sectionTitleProblem,
    });
    if (title !== null) onAddSection(title);
  }

  async function rename(s: DraftSection) {
    const title = await promptDialog({
      title: "Rename section",
      label: "Section name",
      initial: s.title,
      confirmLabel: "Rename section",
      validate: sectionTitleProblem,
    });
    if (title !== null && title.trim() !== s.title) onRenameSection(s.key, title);
  }

  function move(docId: number, direction: "up" | "down") {
    onMove(docId, direction);
    setFocusAfter({ doc: docId, act: direction });
  }

  function remove(docId: number) {
    const i = flat.findIndex((x) => x.doc_id === docId);
    const neighbour = flat[i + 1] ?? flat[i - 1];
    if (i >= 0) setSaid(`Removed ${flat[i].title} from the handbook.`);
    onRemove(docId);
    setFocusAfter(neighbour ? { doc: neighbour.doc_id, act: "remove" } : { add: true });
  }

  function removeSection(key: string) {
    const gone = sections.find((x) => x.key === key);
    if (gone) setSaid(`Removed section ${gone.title}.`);
    onRemoveSection(key);
    setFocusAfter({ add: true });
  }

  let n = 0;
  return (
    // CARD_CLASS rather than <Card padding="none">: that Card clips its
    // overflow, and each row's "Where people find it" menu hangs below it.
    <section className={CARD_CLASS} aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <CardTitle id={titleId} className="min-w-0 flex-wrap">
          Contents{" "}
          <span className="text-sm font-normal text-slate-500">
            · {policies(total)}
            {hidden > 0 && ` · ${hidden} handbook only`}
          </span>
        </CardTitle>
        <button
          ref={addRef}
          type="button"
          disabled={disabled || sections.length >= SECTIONS_MAX}
          onClick={addSection}
          className={buttonClass("secondary", "sm")}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add section
        </button>
      </div>
      {hidden > 0 && !published && (
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          Handbook only takes effect once the handbook is published. Until then these documents stay listed in their spaces.
        </p>
      )}
      {/* Always mounted, so a screen reader is listening before the first move. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </p>
      <div ref={listRef}>
        {sections.length === 0 || total === 0 ? (
          <>
            {sections.map((s, si) => (
              <SectionHeader key={s.key} number={si + 1} section={s} disabled={disabled} canRemove={sections.length > 1} onRename={() => rename(s)} onRemove={() => removeSection(s.key)} />
            ))}
            <SectionEmpty className="px-4 py-6">{emptyHint}</SectionEmpty>
          </>
        ) : (
          sections.map((s, si) => (
            <section key={s.key} aria-labelledby={`hb-sec-${s.key}`}>
              <SectionHeader
                number={si + 1}
                section={s}
                disabled={disabled}
                canRemove={sections.length > 1}
                onRename={() => rename(s)}
                onRemove={() => removeSection(s.key)}
              />
              {s.items.length === 0 ? (
                <SectionEmpty className="border-t border-slate-100 px-4 py-3">Empty. Move policies here with the arrows.</SectionEmpty>
              ) : (
                <ol className="list-none">
                  {s.items.map((item) => {
                    n += 1;
                    // Placeholders share one title: their controls are told apart by number.
                    const name = item.restricted ? `item ${n} (a document you can't open)` : item.title;
                    const meta = [item.version !== null ? `v${item.version}` : "", item.version_at ? fmt.date(item.version_at) : ""].filter(Boolean);
                    return (
                      <li
                        key={item.doc_id}
                        data-doc={item.doc_id}
                        data-title={item.title}
                        // On a phone the title takes the first line whole and the
                        // controls follow under it, in the same order.
                        className="relative flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 px-4 py-2.5 sm:flex-nowrap"
                      >
                        <span className="w-5 shrink-0 text-sm font-semibold text-slate-500" aria-hidden>
                          {n}
                        </span>
                        {item.restricted ? (
                          // The locked placeholder: muted, a Lock, and why.
                          <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-2rem)]" data-restricted="">
                            {/* items-start + a nudge: the Lock leads the title's first line however it wraps. */}
                            <span className="flex items-start gap-1.5 text-sm font-medium text-slate-500">
                              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                              <span className="min-w-0 [overflow-wrap:anywhere] sm:truncate">
                                <span className="sr-only">{n}. </span>
                                {item.title}
                              </span>
                            </span>
                            <span className="block text-xs text-slate-500">From a space you can&apos;t add from. You can move or remove it.</span>
                          </span>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 max-sm:basis-[calc(100%-2rem)]">
                              <span className="block text-sm font-semibold [overflow-wrap:anywhere] text-slate-900 sm:truncate">
                                <span className="sr-only">{n}. </span>
                                {item.title}
                              </span>
                              <span className="block truncate text-xs text-slate-500">
                                {item.space_icon && <span aria-hidden>{item.space_icon} </span>}
                                {item.space_name}
                                {meta.length > 0 && ` · ${meta.join(" · ")}`}
                                {item.doc_status !== "published" && " · draft, hidden from readers"}
                              </span>
                            </span>
                            <span className="pl-8 sm:pl-0">
                              <FindModeMenu
                                mode={item.find_mode}
                                title={item.title}
                                spaceName={item.space_name}
                                disabled={disabled}
                                onChange={(m) => onFindMode(item.doc_id, m)}
                              />
                            </span>
                          </>
                        )}
                        <span className="ml-auto flex items-center sm:ml-0">
                          <button
                            type="button"
                            data-act="up"
                            data-tt="Move up"
                            aria-label={`Move ${name} up`}
                            disabled={disabled || !canMove(sections, item.doc_id, "up")}
                            onClick={() => move(item.doc_id, "up")}
                            className={iconButtonClass("quiet", "sm")}
                          >
                            <ChevronUp aria-hidden />
                          </button>
                          <button
                            type="button"
                            data-act="down"
                            data-tt="Move down"
                            aria-label={`Move ${name} down`}
                            disabled={disabled || !canMove(sections, item.doc_id, "down")}
                            onClick={() => move(item.doc_id, "down")}
                            className={iconButtonClass("quiet", "sm")}
                          >
                            <ChevronDown aria-hidden />
                          </button>
                          <button
                            type="button"
                            data-act="remove"
                            // Short: the bubble is centred on a button at the
                            // row's right edge, and a long label widens a phone's
                            // page. The aria-label keeps the full sentence.
                            data-tt="Remove"
                            aria-label={`Remove ${name} from the handbook`}
                            disabled={disabled}
                            onClick={() => remove(item.doc_id)}
                            className={iconButtonClass("quiet", "sm", "hover-danger")}
                          >
                            <X aria-hidden />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function SectionHeader({
  number,
  section,
  disabled,
  canRemove,
  onRename,
  onRemove,
}: {
  number: number;
  section: DraftSection;
  disabled: boolean;
  canRemove: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
      <h4 id={`hb-sec-${section.key}`} className={`${EYEBROW_TEXT} min-w-0 flex-1 truncate sm:flex-none`}>
        {number} · {section.title}
      </h4>
      <span className="hidden h-px flex-1 bg-slate-100 sm:block" aria-hidden />
      {/* Under sm the words give way to the pencil; the name stays for readers.
          Icon-only there, so it carries the tooltip there and only there
          (sm:after:hidden! hides the bubble beside the visible words). */}
      <Button
        size="sm"
        variant="ghost"
        icon={<Pencil />}
        disabled={disabled}
        onClick={onRename}
        data-tt="Rename section"
        className="sm:after:hidden!"
      >
        <span className="max-sm:sr-only">Rename section</span>
        <span className="sr-only"> {section.title}</span>
      </Button>
      {canRemove && (
        <button
          type="button"
          // Short, as on the rows: it sits at the card's right edge.
          data-tt="Remove"
          aria-label={`Remove section ${section.title}`}
          disabled={disabled}
          onClick={onRemove}
          className={iconButtonClass("quiet", "sm", "hover-danger")}
        >
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}
