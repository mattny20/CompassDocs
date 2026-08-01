"use client";

// The command palette: one overlay that floats in front of whatever page the
// user is on, searching documents, people, spaces, navigation, and actions —
// and the global hotkey layer that opens it.
//
// Two rules shape everything here:
//   1. A shortcut must never steal a keystroke meant for text (lib/hotkeys).
//   2. What the palette shows is a UX filter, never the permission boundary —
//      every destination and action re-checks server-side.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, ArrowUp, ArrowDown } from "lucide-react";
import type { SearchHit } from "@/lib/types";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  MODE_GROUPS,
  MODE_LABEL,
  MODE_PLACEHOLDER,
  type PaletteItem,
  type PaletteMode,
} from "@/lib/palette-types";
import { blockBareKey, blockModKey, CHORD_TIMEOUT_MS } from "@/lib/hotkeys";
import { overlayOpen } from "@/lib/overlay-stack";
import { useModalOverlay } from "@/components/overlay/useModalOverlay";
import { navChords, type CapKey } from "@/lib/nav-items";
import { frecencyScores, recordPick } from "@/lib/palette-recents";
import { applyThemePref, storeThemePref } from "@/components/ThemeToggle";
import { PaletteRow } from "./PaletteRow";
import { ShortcutSheet } from "./ShortcutSheet";
import { Kbd } from "./Kbd";
import {
  commandItems,
  docItems,
  navItems,
  personItems,
  recentItems,
  spaceItems,
  type PersonHit,
  type RecentDoc,
  type SpaceLite,
  type SourceContext,
} from "./sources";
import {
  currentPageCommands,
  onPageCommandsChange,
  onPaletteOpen,
  openPalette,
  type PageCommand,
} from "./palette-store";

const DEBOUNCE_MS = 120;
const MIN_REMOTE_CHARS = 2;
const MODE_CYCLE: PaletteMode[] = ["all", "commands", "people", "spaces", "help"];

export function CommandPaletteClient({
  userId,
  caps,
  commandIds,
  spaces,
}: {
  userId: number;
  caps: Record<string, boolean>;
  commandIds: string[];
  spaces: SpaceLite[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("all");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [docs, setDocs] = useState<SearchHit[]>([]);
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageCmds, setPageCmds] = useState<PageCommand[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chordRef = useRef<{ key: string; at: number } | null>(null);
  const bootstrapped = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every keystroke so a slow response can never overwrite results
  // for a newer query — or move the user's selection out from under them.
  const seqRef = useRef(0);

  const commandIdSet = useMemo(() => new Set(commandIds), [commandIds]);
  const allowedNav = useCallback(
    (cap: CapKey | null) => (cap === null ? true : !!caps[cap]),
    [caps]
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setMode("all");
    setCursor(0);
    setDocs([]);
    setPeople([]);
    abortRef.current?.abort();
  }, []);

  useModalOverlay(open, close);

  // --- data ---------------------------------------------------------------

  const loadBootstrap = useCallback(async () => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    try {
      const res = await fetch("/api/palette/bootstrap");
      if (!res.ok) return;
      const data = await res.json();
      setRecents(Array.isArray(data.recent_docs) ? data.recent_docs : []);
    } catch {
      // Recents are a nicety; the palette works fully without them.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadBootstrap();
    setPageCmds(currentPageCommands());
    return onPageCommandsChange(() => setPageCmds(currentPageCommands()));
  }, [open, loadBootstrap]);

  // Remote sources: debounced, abortable, and ignored if superseded.
  useEffect(() => {
    if (!open || mode === "help") return;
    const q = query.trim();
    const wantDocs = mode === "all";
    const wantPeople = mode === "all" || mode === "people";
    if (q.length < MIN_REMOTE_CHARS) {
      setDocs([]);
      setPeople([]);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const qs = encodeURIComponent(q);
      const jobs: Promise<void>[] = [];
      if (wantDocs) {
        jobs.push(
          fetch(`/api/search?q=${qs}&limit=8`, { signal: ac.signal })
            .then((r) => (r.ok ? r.json() : { hits: [] }))
            .then((d) => {
              if (seq === seqRef.current) setDocs(d.hits ?? []);
            })
            .catch(() => {})
        );
      }
      if (wantPeople) {
        jobs.push(
          fetch(`/api/directory/search?q=${qs}&limit=8`, { signal: ac.signal })
            .then((r) => (r.ok ? r.json() : { people: [] }))
            .then((d) => {
              if (seq === seqRef.current) setPeople(d.people ?? []);
            })
            .catch(() => {})
        );
      }
      await Promise.all(jobs);
      if (seq === seqRef.current) setLoading(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, query, mode]);

  // --- results ------------------------------------------------------------

  const groups = useMemo(() => {
    const frecency = frecencyScores(userId);
    const ctx: SourceContext = {
      query: query.trim(),
      allowedNav,
      commandIds: commandIdSet,
      spaces,
      recents,
      pageCommands: pageCmds,
      frecency: (id) => frecency.get(id) ?? 0,
    };
    const all: Record<string, PaletteItem[]> = {
      recent: recentItems(ctx),
      command: commandItems(ctx),
      nav: navItems(ctx),
      doc: docItems(docs),
      person: personItems(people),
      space: spaceItems(ctx),
    };
    const allowedKinds = MODE_GROUPS[mode];
    return GROUP_ORDER.filter((k) => !allowedKinds || allowedKinds.includes(k))
      .map((kind) => ({ kind, items: all[kind] ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [query, allowedNav, commandIdSet, spaces, recents, pageCmds, docs, people, mode, userId]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    // A new result set always starts at the top; the cursor is never left
    // pointing past the end of a shorter list.
    setCursor((c) => (c >= flat.length ? 0 : c));
  }, [flat.length]);

  const activate = useCallback(
    (item: PaletteItem | undefined, newTab = false) => {
      if (!item) return;
      recordPick(userId, item.id);
      // Close first so any toast the action raises isn't hidden behind us.
      close();
      if (item.href) {
        if (newTab) window.open(item.href, "_blank", "noopener,noreferrer");
        else router.push(item.href);
        return;
      }
      void item.run?.();
    },
    [close, router, userId]
  );

  const runCommandById = useCallback(
    (id: string) => {
      if (id === "theme.toggle") {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        const next = dark ? "light" : "dark";
        applyThemePref(next);
        storeThemePref(next);
        return true;
      }
      if (id === "help.shortcuts") {
        setMode("help");
        setQuery("");
        return true;
      }
      return false;
    },
    []
  );

  // --- global hotkeys -----------------------------------------------------

  useEffect(() => {
    const chords = navChords(allowedNav);

    function onKeyDown(e: KeyboardEvent) {
      // ⌘K works even while typing — it's the one escape hatch people expect.
      if (!blockModKey(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open) return; // in-palette keys are handled on the panel
      if (blockBareKey(e, overlayOpen)) {
        chordRef.current = null;
        return;
      }

      // Second key of a `g` chord.
      const armed = chordRef.current;
      if (armed && Date.now() - armed.at < CHORD_TIMEOUT_MS) {
        chordRef.current = null;
        const target = chords.get(e.key);
        if (target) {
          e.preventDefault();
          router.push(target.href);
        }
        return;
      }
      chordRef.current = null;

      switch (e.key) {
        case "g":
          chordRef.current = { key: "g", at: Date.now() };
          return;
        case "/":
          e.preventDefault();
          openPalette("all");
          return;
        case "@":
          e.preventDefault();
          openPalette("people");
          return;
        case ">":
          e.preventDefault();
          openPalette("commands");
          return;
        case "#":
          e.preventDefault();
          openPalette("spaces");
          return;
        case "?":
          e.preventDefault();
          openPalette("help");
          return;
        case "c":
          if (caps.canAuthor) {
            e.preventDefault();
            router.push("/doc/new");
          }
          return;
        default: {
          const hit = currentPageCommands().find((p) => p.hotkey === e.key);
          if (hit) {
            e.preventDefault();
            void hit.run();
          }
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, allowedNav, router, caps.canAuthor]);

  useEffect(
    () =>
      onPaletteOpen(({ mode: m, seed }) => {
        setMode(m);
        setQuery(seed);
        setCursor(0);
        setOpen(true);
      }),
    []
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the selected row in view without scrolling the page behind us.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  if (!open) return null;

  const activeId = flat[cursor]?.id;

  function onPanelKeyDown(e: React.KeyboardEvent) {
    const move = (delta: number) => {
      e.preventDefault();
      if (!flat.length) return;
      setCursor((c) => (c + delta + flat.length) % flat.length);
    };
    switch (e.key) {
      case "ArrowDown":
        return move(1);
      case "ArrowUp":
        return move(-1);
      case "PageDown":
        e.preventDefault();
        return setCursor((c) => Math.min(flat.length - 1, c + 8));
      case "PageUp":
        e.preventDefault();
        return setCursor((c) => Math.max(0, c - 8));
      case "Home":
        e.preventDefault();
        return setCursor(0);
      case "End":
        e.preventDefault();
        return setCursor(Math.max(0, flat.length - 1));
      case "Enter": {
        e.preventDefault();
        const item = flat[cursor];
        if (item?.id.startsWith("command:")) {
          const id = item.id.slice("command:".length);
          if (runCommandById(id)) {
            recordPick(userId, item.id);
            if (id === "theme.toggle") close();
            return;
          }
        }
        return activate(item, e.metaKey || e.ctrlKey);
      }
      case "Escape":
        e.preventDefault();
        return close();
      case "Tab": {
        e.preventDefault();
        const i = MODE_CYCLE.indexOf(mode);
        const next = MODE_CYCLE[(i + (e.shiftKey ? -1 : 1) + MODE_CYCLE.length) % MODE_CYCLE.length];
        setMode(next);
        setCursor(0);
        return;
      }
      case "Backspace":
        if (!query && mode !== "all") {
          e.preventDefault();
          setMode("all");
        }
        return;
      default:
        return;
    }
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    // A leading mode prefix switches mode and is consumed, so the query stays
    // clean. `/` is deliberately not a prefix — people type it in paths.
    if (!query && v.length === 1) {
      const prefix: Record<string, PaletteMode> = {
        ">": "commands",
        "@": "people",
        "#": "spaces",
        "?": "help",
      };
      const m = prefix[v];
      if (m) {
        setMode(m);
        setQuery("");
        setCursor(0);
        return;
      }
    }
    setQuery(v);
    setCursor(0);
  }

  return (
    <div
      className="cmd-scrim fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh] print:hidden"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-2xl dark:border-slate-700"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 dark:border-slate-800">
          <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          {mode !== "all" && (
            <span className="shrink-0 rounded-full bg-compass-50 px-2 py-0.5 text-[11px] font-medium text-compass-700">
              {MODE_LABEL[mode]}
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={onChange}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={MODE_PLACEHOLDER[mode]}
            placeholder={MODE_PLACEHOLDER[mode]}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent py-3 text-sm text-slate-800 outline-hidden placeholder:text-slate-400 dark:text-slate-100"
          />
          {loading && <span className="shrink-0 text-xs text-slate-400">…</span>}
        </div>

        <div
          ref={listRef}
          id="cmd-listbox"
          role="listbox"
          aria-label="Results"
          className="max-h-[52vh] overflow-y-auto py-1"
        >
          {mode === "help" ? (
            <ShortcutSheet caps={caps} commandIds={commandIds} />
          ) : flat.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">
              {query.trim() ? "No matches." : "Start typing to search."}
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.kind}>
                <p className="px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {GROUP_LABEL[g.kind]}
                </p>
                {g.items.map((item) => {
                  const index = flat.indexOf(item);
                  return (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      index={index}
                      selected={index === cursor}
                      onHover={() => setCursor(index)}
                      onPick={() => {
                        if (item.id.startsWith("command:")) {
                          const id = item.id.slice("command:".length);
                          if (runCommandById(id)) {
                            recordPick(userId, item.id);
                            if (id === "theme.toggle") close();
                            return;
                          }
                        }
                        activate(item);
                      }}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-800">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" aria-hidden />
              <ArrowDown className="h-3 w-3" aria-hidden />
              move
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" aria-hidden /> open
            </span>
            <span className="hidden sm:inline">Tab switches mode</span>
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys={["?"]} /> shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}
