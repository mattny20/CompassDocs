"use client";

// Canned responses in the composer (1.19.2, agent W4; design d1): text-only
// snippets inserted at the cursor in a reply or an internal note. They
// never change the ticket (macros do that).
//
// Two ways in:
//   ";" typed at the start of a word, then at least two letters ("Thanks.
//       ;vpn"): the picker shows under the toolbar once a response's NAME
//       or FOLDER matches, and filters as you keep typing in the reply box;
//       ↑/↓ choose, Enter or Tab inserts in place of ";vpn", Escape closes
//       and leaves what you typed. With nothing shown, Enter and Tab are
//       the box's own (a bare " ;" then Enter is a line break; ";D", ";P"
//       or a word no name matches never insert anything). ";" mid-word or in
//       a URL ("a;b", "…;jsessionid=") never arms it, nor does "; " or ";)"
//       (canned-shared cannedTrigger). Keys during IME composition are left
//       alone. The "/" macro trigger (an empty box) and "[[" (articles) are
//       untouched.
//   the Canned response button: the same picker with its own search box.
//
// Groups: the ticket's team, your other teams, Workspace, Mine. Picking one
// asks the server to fill the placeholders for this ticket and you (POST
// /api/helpdesk/canned/[id]/use, which also counts the use). If the server
// refuses (gone, no longer shared with you, too many), nothing is inserted:
// the error shows and the list reloads. Only when it can't be reached (or
// fails, 5xx) is the text filled here from what the composer knows, any
// other placeholder left out, never sent as {{braces}}.
//
// The composer keeps this in one hook (useCannedPicker) plus the toolbar
// button (CannedButton); its own code only forwards input, keys and the
// textarea's aria props.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { MessageSquareText, Search } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { Popover } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty, controlClass } from "@/components/form";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import { toast } from "@/components/Toasts";
import { cannedTrigger, inlinePickerShows, groupCanned, renderCanned, type HdCanned } from "@/lib/helpdesk/canned-shared";
import { ApiError, getJson, listOf, sendJson } from "../api";

/** At most this many rows are drawn; typing narrows the rest. */
const MAX_SHOWN = 40;

const KBD = "rounded-sm border border-slate-200 bg-canvas px-1.5 py-0.5 font-sans text-2xs text-slate-500";

// The list per ticket, kept briefly so reopening is instant (a fresh fetch
// follows each open anyway).
const cache = new Map<number, { items: HdCanned[]; teamId: number | null }>();

export type CannedMode = "inline" | "button";

/** A key that belongs to an IME composition (Safari sends Enter as keyCode 229 after compositionend). */
export function imeKey(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export interface CannedPickerState {
  open: CannedMode | null;
  query: string;
  setQuery: (q: string) => void;
  items: HdCanned[] | null;
  error: string;
  groups: ReturnType<typeof groupCanned>;
  flat: HdCanned[];
  active: number;
  setActive: (i: number) => void;
  listId: string;
  optionId: (c: HdCanned) => string;
  pick: (c: HdCanned) => void;
  close: () => void;
  toggleButton: () => void;
  area: RefObject<HTMLTextAreaElement | null>;
}

export function useCannedPicker({
  area,
  number,
  requesterName,
  agentName,
  disabled = false,
  setText,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  number: number;
  requesterName: string;
  agentName: string;
  disabled?: boolean;
  /** The composer's change(): writes the box and its draft. */
  setText: (v: string) => void;
}) {
  const [open, setOpen] = useState<CannedMode | null>(null);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [data, setData] = useState<{ items: HdCanned[]; teamId: number | null } | null>(cache.get(number) ?? null);
  const [error, setError] = useState("");
  /** The ";" the agent closed with Escape: it does not reopen while they type on. */
  const dismissed = useRef<number | null>(null);
  const latest = useRef({ setText, requesterName, agentName, number });
  latest.current = { setText, requesterName, agentName, number };
  const listId = useId();
  // What onInput just decided, for onCaret in the same keystroke (state lags a render).
  const now = useRef<{ open: CannedMode | null; start: number | null }>({ open: null, start: null });
  now.current.open = open;
  if (trigger) now.current.start = trigger.start;

  // Another ticket: nothing carries over.
  useEffect(() => {
    setOpen(null);
    setTrigger(null);
    dismissed.current = null;
    setData(cache.get(number) ?? null);
  }, [number]);

  const load = useCallback(() => {
    setError("");
    getJson<{ canned?: HdCanned[]; ticket_team_id?: number | null }>(`/api/helpdesk/canned?ticket=${number}`, "Couldn't load the canned responses.")
      .then((d) => {
        const next = { items: listOf<HdCanned>(d, "canned"), teamId: typeof d.ticket_team_id === "number" ? d.ticket_team_id : null };
        cache.set(number, next);
        if (latest.current.number === number) setData(next);
      })
      .catch((e: Error) => setError(e.message));
  }, [number]);

  const query = open === "inline" ? (trigger?.query ?? "") : search;
  const groups = useMemo(() => {
    // The ";" picker matches names and folders only; the button's search the text too.
    const all = groupCanned(data?.items ?? [], query, data?.teamId ?? null, open === "inline" ? "label" : "all");
    // Cap the rows drawn, keeping group order.
    let left = MAX_SHOWN;
    return all
      .map((g) => {
        const items = g.items.slice(0, Math.max(0, left));
        left -= items.length;
        return { ...g, items };
      })
      .filter((g) => g.items.length);
  }, [data, query, open]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // What is on screen: the button's picker, or the ";" picker once at least
  // two letters follow the ";" and a name or folder matches. Armed but not
  // shown, it handles no key.
  const shown: CannedMode | null =
    open === "button" ? "button" : open === "inline" && inlinePickerShows(query, flat.length) ? "inline" : null;
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);

  const close = useCallback(() => {
    if (open === "inline" && trigger) dismissed.current = trigger.start;
    now.current = { open: null, start: null };
    setOpen(null);
  }, [open, trigger]);

  function openAt(mode: CannedMode) {
    setActive(0);
    if (mode === "button") setSearch("");
    setOpen(mode);
    load();
  }

  /** After the box changed by typing: open, follow or close the ";" picker. */
  function onInput(value: string, caret: number) {
    if (disabled) return;
    const t = cannedTrigger(value, caret);
    if (!t) {
      dismissed.current = null;
      now.current = { open: null, start: null };
      if (open === "inline") setOpen(null);
      return;
    }
    if (dismissed.current === t.start) return;
    dismissed.current = null;
    now.current = { open: "inline", start: t.start };
    setTrigger(t);
    if (open !== "inline") openAt("inline");
    else setActive(0);
  }

  /** The caret moved (click, arrows): close when it left the ";" word. */
  function onCaret() {
    if (now.current.open !== "inline" || !area.current) return;
    const el = area.current;
    const t = el.selectionStart === el.selectionEnd ? cannedTrigger(el.value, el.selectionStart) : null;
    if (!t || t.start !== now.current.start) {
      now.current = { open: null, start: null };
      setOpen(null);
    }
  }

  /** The reply box's keys while the ";" picker is open; true = handled. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (shown !== "inline") return false;
    if (e.altKey || e.ctrlKey || e.metaKey || imeKey(e)) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!flat.length) return false;
      e.preventDefault();
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % flat.length : (a - 1 + flat.length) % flat.length));
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
      const c = flat[active];
      if (!c) return false;
      e.preventDefault();
      pick(c);
      return true;
    }
    return false;
  }

  async function pick(c: HdCanned) {
    const mode = open;
    const trig = trigger;
    setOpen(null);
    dismissed.current = null;
    const { requesterName: rn, agentName: an, number: n } = latest.current;
    let body: string;
    try {
      const d = await sendJson<{ body?: string }>(`/api/helpdesk/canned/${c.id}/use`, "POST", { number: n }, "Couldn't insert the canned response.");
      body = typeof d.body === "string" ? d.body : renderCanned(c.body, { requesterName: rn, ticketNumber: n, teamName: "", agentName: an });
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        // Refused (deleted, no longer shared with you, rate limit): insert nothing, say why, refresh the list.
        toast("error", err.message);
        cache.delete(n);
        setData(null);
        load();
        requestAnimationFrame(() => area.current?.focus());
        return;
      }
      // Unreachable or failing: fill what the composer knows (the server also fills the team's name).
      body = renderCanned(c.body, { requesterName: rn, ticketNumber: n, teamName: "", agentName: an });
    }
    const el = area.current;
    if (!el) return;
    const text = el.value;
    let from = el.selectionStart ?? text.length;
    let to = el.selectionEnd ?? text.length;
    if (mode === "inline" && trig && text.slice(trig.start, trig.start + 1 + trig.query.length) === `;${trig.query}`) {
      from = trig.start;
      to = trig.start + 1 + trig.query.length;
    }
    latest.current.setText(text.slice(0, from) + body + text.slice(to));
    requestAnimationFrame(() => {
      el.focus();
      const pos = from + body.length;
      el.setSelectionRange(pos, pos);
    });
  }

  const optionId = (c: HdCanned) => `${listId}-c${c.id}`;
  const state: CannedPickerState = {
    open: shown,
    query,
    setQuery: (q) => {
      setSearch(q);
      setActive(0);
    },
    items: data?.items ?? null,
    error,
    groups,
    flat,
    active,
    setActive,
    listId,
    optionId,
    pick: (c) => void pick(c),
    close,
    toggleButton: () => (open === "button" ? setOpen(null) : openAt("button")),
    area,
  };

  /** Spread on the reply box: the open list and its active row, for screen readers. */
  const textareaProps =
    shown === "inline"
      ? {
          "aria-controls": listId,
          "aria-autocomplete": "list" as const,
          "aria-activedescendant": flat[active] ? optionId(flat[active]) : undefined,
        }
      : {};

  return { state, onInput, onKeyDown, onCaret, textareaProps, close };
}

/** The toolbar's Canned response button and the picker it anchors. */
export function CannedButton({ picker, disabled }: { picker: ReturnType<typeof useCannedPicker>; disabled?: boolean }) {
  const s = picker.state;
  const btn = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!s.open) return;
    const raf = requestAnimationFrame(() => {
      if (s.open === "button") search.current?.focus();
      panel.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [s.open]);

  // Keep the active row in view.
  useEffect(() => {
    const c = s.flat[s.active];
    if (s.open && c) document.getElementById(s.optionId(c))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.active, s.open, s.flat]);

  const count = s.flat.length;
  const announce = !s.open || s.items === null ? "" : count ? `${count} canned ${count === 1 ? "response" : "responses"}. Up and down to choose, Enter to insert.` : "No canned responses match.";

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={s.open !== null}
        onClick={s.toggleButton}
        disabled={disabled}
        className={buttonClass("secondary", "sm")}
      >
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
        Canned response
      </button>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <Popover
        open={s.open !== null}
        onClose={s.close}
        triggerRef={s.open === "inline" ? s.area : btn}
        role="dialog"
        label="Canned responses"
        width="w-[min(29rem,calc(100vw-2rem))]"
        padding="p-0"
        className="max-sm:-left-24"
      >
        <div ref={panel} className="scroll-mb-4">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
            {s.open === "button" ? (
              <input
                ref={search}
                type="search"
                value={s.query}
                onChange={(e) => s.setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (!s.flat.length || imeKey(e)) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    s.setActive((s.active + 1) % s.flat.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    s.setActive((s.active - 1 + s.flat.length) % s.flat.length);
                  } else if (e.key === "Enter" && s.flat[s.active]) {
                    e.preventDefault();
                    s.pick(s.flat[s.active]);
                  }
                }}
                role="combobox"
                aria-expanded
                aria-controls={s.listId}
                aria-autocomplete="list"
                aria-activedescendant={s.flat[s.active] ? s.optionId(s.flat[s.active]) : undefined}
                aria-label="Search canned responses"
                placeholder="Search canned responses…"
                className={controlClass(false, "h-7 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus:ring-0", true)}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800" aria-hidden>
                {s.query || <span className="text-slate-500">Keep typing to search</span>}
              </span>
            )}
            <kbd className={KBD} aria-hidden>
              ;
            </kbd>
          </div>
          <div id={s.listId} role="listbox" aria-label="Canned responses" className="max-h-80 overflow-y-auto py-1">
            {s.error && <p className="px-3 py-3 text-sm text-red-600">{s.error}</p>}
            {!s.error && s.items === null && <LoadingRow className="py-4" />}
            {s.items !== null && count === 0 && (
              <SectionEmpty className="px-3 py-3">
                {s.items.length === 0
                  ? "No canned responses yet. Add them in Desk settings, Canned responses."
                  : `No canned responses match "${s.query.trim()}".`}
              </SectionEmpty>
            )}
            {s.groups.map((g) => (
              <div key={g.key} role="group" aria-labelledby={`${s.listId}-${g.key}`}>
                <p id={`${s.listId}-${g.key}`} className={`${RAIL_GROUP_TEXT} px-3 pb-0.5 pt-2`}>
                  {g.label}
                </p>
                {g.items.map((c) => {
                  const i = s.flat.indexOf(c);
                  const on = i === s.active;
                  return (
                    <div
                      key={c.id}
                      id={s.optionId(c)}
                      role="option"
                      aria-selected={on}
                      onMouseEnter={() => s.setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => s.pick(c)}
                      className={`flex cursor-pointer items-start gap-2.5 px-3 py-2 ${on ? "bg-compass-50" : ""}`}
                    >
                      <MessageSquareText className={`mt-0.5 h-4 w-4 shrink-0 ${on ? "text-compass-600" : "text-slate-400"}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{c.title}</span>
                        <span className="line-clamp-2 text-xs text-slate-500">{c.body}</span>
                      </span>
                      {on && (
                        <kbd className={`${KBD} mt-0.5`} aria-hidden>
                          ↵
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            Inserts text at the cursor. Canned responses never change the ticket; use a macro for that.
          </p>
        </div>
      </Popover>
    </div>
  );
}
