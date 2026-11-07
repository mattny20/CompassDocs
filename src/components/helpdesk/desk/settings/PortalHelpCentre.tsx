"use client";

// Desk settings → Customer portal → Help centre (1.19.4, C3, mock h2): the
// articles people outside the organisation search at /support before they
// raise a request. Four cards: Show a help centre (with search engine
// indexing), What's public (documents in chosen
// spaces and/or documents tagged `public`; each an option card with a
// checkbox, the chosen spaces as chips with a "+ Space" menu), Categories
// (the spaces' folders as rows: a grip that drags, or opens Move up / Move
// down from a click or the keyboard, the article count, and an eye that
// switches a category off) and Last 30 days. One SaveRow for the page.
//
// What is actually public is the server's rule (lib/helpdesk/help-centre
// publicHelpArticles): drafts, private spaces, handbook-only policies,
// policies people must confirm, comments, history and authors never are,
// whatever is chosen here. The categories list is that same rule run on
// the selection on screen (a preview POST), so it is what customers would
// see once saved.

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Eye, EyeOff, GripVertical, Lock, Plus, X } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { SectionEmpty, Toggle } from "@/components/form";
import { MenuItem, Popover } from "@/components/Popover";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { articleCount, type HelpCentreSettings, type HelpCentreStats } from "@/lib/helpdesk/help-centre-shared";
import { getJson, sendJson } from "../api";

interface SpaceOption {
  id: number;
  name: string;
  private: boolean;
}

interface AdminCategory {
  key: string;
  name: string;
  count: number;
  hidden: boolean;
}

interface Loaded {
  settings: HelpCentreSettings;
  spaces: SpaceOption[];
  categories: AdminCategory[];
  stats: HelpCentreStats;
  portal_on: boolean;
}

const API = "/api/helpdesk/admin/portal/help-centre";

export function PortalHelpCentre() {
  const [data, setData] = useState<Loaded | null>(null);
  const [s, setS] = useState<HelpCentreSettings | null>(null);
  const [cats, setCats] = useState<AdminCategory[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);
  const selection = s ? JSON.stringify([s.from_spaces, s.spaces, s.tagged]) : "";
  const loadedSelection = useRef("");

  function take(d: Loaded) {
    setData(d);
    setS(d.settings);
    setCats(d.categories);
    loadedSelection.current = JSON.stringify([d.settings.from_spaces, d.settings.spaces, d.settings.tagged]);
  }

  useEffect(() => {
    getJson<Loaded>(API, "Couldn't load the help centre settings.")
      .then(take)
      .catch((e: Error) => setError(e.message));
  }, []);

  // A changed selection previews its categories (the same rule as the portal).
  useEffect(() => {
    if (!s || !selection || selection === loadedSelection.current) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(API, {
          method: "POST",
          signal: ctl.signal,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ preview: s }),
        });
        const body = (await res.json().catch(() => ({}))) as { categories?: AdminCategory[] };
        if (!ctl.signal.aborted && res.ok && body.categories) {
          loadedSelection.current = selection;
          setCats(body.categories);
        }
      } catch {
        /* the list keeps what it had; Save checks again */
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  if (error && !s) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!s || !data || !cats) return <LoadingRow className="py-10" />;

  const set = (p: Partial<HelpCentreSettings>) => {
    markDirty();
    setS({ ...s, ...p });
  };
  const spaceName = (id: number) => data.spaces.find((x) => x.id === id);
  const addable = data.spaces.filter((x) => !x.private && !s.spaces.includes(x.id));

  function moveCat(key: string, by: number) {
    if (!cats) return;
    const from = cats.findIndex((c) => c.key === key);
    const to = from + by;
    if (from < 0 || to < 0 || to >= cats.length) return;
    const next = [...cats];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    setCats(next);
    set({ order: next.map((c) => c.key) });
  }

  function toggleHidden(c: AdminCategory) {
    if (!s || !cats) return;
    const hide = !c.hidden;
    setCats(cats.map((x) => (x.key === c.key ? { ...x, hidden: hide } : x)));
    set({ hidden: hide ? [...s.hidden, c.key] : s.hidden.filter((k) => k !== c.key) });
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const d = await sendJson<Loaded>(API, "PUT", { ...s, order: cats ? cats.map((c) => c.key) : s.order }, "Couldn't save the help centre settings.");
      take(d);
      markClean(JSON.stringify(d.settings));
      toast("ok", d.settings.enabled ? "Help centre saved. It's showing in the portal." : "Help centre saved. It's hidden from the portal.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visible = cats.filter((c) => !c.hidden);
  const shownArticles = visible.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <div className="flex flex-col gap-4">
        <Card>
          <Toggle
            label="Show a help centre"
            help="Customers search these articles before raising a request, and see suggestions as they type."
            checked={s.enabled}
            onChange={(v) => set({ enabled: v })}
            size="full"
          />
          {s.enabled && !data.portal_on && (
            <p className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm">
              The customer portal is off, so nobody sees the help centre yet. Turn the portal on in the Settings tab.
            </p>
          )}
          <Toggle
            className="mt-4"
            label="Let search engines index the help centre"
            help="Off: the help centre asks search engines not to list it. Your requests and sign-in are never indexed."
            checked={s.indexing}
            onChange={(v) => set({ indexing: v })}
            size="full"
          />
        </Card>

        <Card title="What's public">
          <div className="space-y-2.5">
            <OptionCard
              checked={s.from_spaces}
              onChange={(v) => set({ from_spaces: v })}
              title="Documents in chosen spaces"
              body="Only published documents. Drafts, private spaces, handbook-only policies and internal notes are never shown."
            />
            {s.from_spaces && (
              <div className="flex flex-wrap items-center gap-1.5 pl-1" aria-label="Chosen spaces" role="group">
                {s.spaces.length === 0 && <SectionEmpty className="mr-1">No spaces chosen yet.</SectionEmpty>}
                {s.spaces.map((id) => {
                  const sp = spaceName(id);
                  const name = sp?.name ?? "A deleted space";
                  return (
                    <span key={id} className={chipClass(sp?.private ? "error" : "neutral", "md", "max-w-full pr-1 text-sm")}>
                      {sp?.private && <Lock className="h-3 w-3 shrink-0" aria-hidden />}
                      <span className="truncate">{name}</span>
                      {sp?.private && <span className="sr-only"> (private, never shown)</span>}
                      <button
                        type="button"
                        className="ml-0.5 rounded-full p-0.5 hover:bg-slate-200"
                        aria-label={`Remove ${name}`}
                        data-tt={sp?.private ? "Private spaces are never public. Remove it." : "Remove"}
                        onClick={() => set({ spaces: s.spaces.filter((x) => x !== id) })}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  );
                })}
                <AddSpace spaces={addable} onAdd={(id) => set({ spaces: [...s.spaces, id] })} />
              </div>
            )}
            <OptionCard
              checked={s.tagged}
              onChange={(v) => set({ tagged: v })}
              title={
                <>
                  Documents tagged <code className="rounded bg-slate-100 px-1 py-px font-mono text-[0.85em] text-slate-800">public</code>
                </>
              }
              body="From any space except private ones."
            />
          </div>
        </Card>

        <Card
          title="Categories"
          description={
            cats.length
              ? `From the spaces' folders. Drag to reorder. ${articleCount(shownArticles)} in ${visible.length === 1 ? "1 category" : `${visible.length} categories`}.`
              : "From the spaces' folders."
          }
        >
          {cats.length === 0 ? (
            <SectionEmpty>Nothing is public yet. Choose a space with published documents, or tag documents public.</SectionEmpty>
          ) : (
            <CategoryRows cats={cats} onMove={moveCat} onToggle={toggleHidden} />
          )}
        </Card>

        <Card title="Last 30 days">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Stat label="Searches" value={data.stats.searches.toLocaleString("en")} />
            <Stat label="Answered without a request" value={data.stats.answered_pct === null ? null : `${data.stats.answered_pct}%`} hint="Of the visits that searched or opened an article, the share that opened one and raised no request within 30 minutes." />
            <Stat label="Top search" value={data.stats.top_search} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">Counted without personal data: no names, addresses or sign-ins, and typed emails and numbers are blanked.</p>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save help centre" className="mt-4" />
    </>
  );
}

/** An option card: the whole card is the checkbox's label; on, it takes the accent edge and tint. */
function OptionCard({ checked, onChange, title, body }: { checked: boolean; onChange: (v: boolean) => void; title: React.ReactNode; body: string }) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-sm transition ${
        checked ? "border-compass-400 bg-compass-50" : "border-slate-200 bg-surface hover:bg-slate-50"
      }`}
    >
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block font-semibold text-slate-900">{title}</span>
        <span className="mt-0.5 block text-slate-500">{body}</span>
      </span>
    </label>
  );
}

/** "+ Space": a menu of the spaces not chosen yet (private ones are never offered). */
function AddSpace({ spaces, onAdd }: { spaces: SpaceOption[]; onAdd: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <span className="relative">
      <button
        ref={ref}
        type="button"
        className={buttonClass("secondary", "sm")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={spaces.length === 0}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Space
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={ref} role="menu" label="Add a space" width="w-64" className="max-h-72 overflow-y-auto">
        {spaces.map((x) => (
          <MenuItem key={x.id} icon={<BookOpen />} onClick={() => (setOpen(false), onAdd(x.id))}>
            {x.name}
          </MenuItem>
        ))}
        <p className="border-t border-slate-100 px-2.5 py-2 text-xs text-slate-500">Private spaces can&apos;t be public, so they aren&apos;t listed.</p>
      </Popover>
    </span>
  );
}

/**
 * The categories as hairline rows: a grip (drags with a pointer; clicked,
 * or from the keyboard, it opens Move up / Move down, and Alt+Arrow moves
 * straight away), the name and count, and the eye that switches it off.
 */
function CategoryRows({ cats, onMove, onToggle }: { cats: AdminCategory[]; onMove: (key: string, by: number) => void; onToggle: (c: AdminCategory) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const [announce, setAnnounce] = useState("");

  function move(key: string, by: number) {
    const from = cats.findIndex((c) => c.key === key);
    const to = from + by;
    if (from < 0 || to < 0 || to >= cats.length) return;
    onMove(key, by);
    setAnnounce(`${cats[from].name} moved to position ${to + 1} of ${cats.length}.`);
    requestAnimationFrame(() => grips.current.get(key)?.focus());
  }

  return (
    <>
      <ol aria-label="Categories, in the order customers see them">
        {cats.map((c, i) => (
          <li
            key={c.key}
            draggable={drag === c.key}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", c.key);
            }}
            onDragOver={(e) => {
              if (!drag || drag === c.key) return;
              e.preventDefault();
              const from = cats.findIndex((x) => x.key === drag);
              if (from >= 0 && from !== i) onMove(drag, i - from);
            }}
            onDragEnd={() => setDrag(null)}
            className={`flex items-center gap-2 border-b border-slate-100 py-1.5 last:border-b-0 ${drag === c.key ? "opacity-60" : ""}`}
          >
            <GripMenu
              label={c.name}
              first={i === 0}
              last={i === cats.length - 1}
              buttonRef={(el) => (el ? grips.current.set(c.key, el) : grips.current.delete(c.key))}
              onPointerDown={() => setDrag(c.key)}
              onPointerUp={() => setDrag(null)}
              onMove={(by) => move(c.key, by)}
            />
            <span className={`min-w-0 flex-1 truncate text-sm ${c.hidden ? "text-slate-500" : "text-slate-800"}`}>{c.name}</span>
            {c.hidden && <span className={chipClass("neutral", "sm")}>Hidden</span>}
            <span className="hidden shrink-0 text-xs text-slate-500 sm:inline">{articleCount(c.count)}</span>
            <button
              type="button"
              onClick={() => onToggle(c)}
              aria-pressed={!c.hidden}
              aria-label={`Show ${c.name} in the help centre`}
              data-tt={c.hidden ? "Hidden: its articles aren't public. Show it." : "Showing. Hide it and its articles."}
              className={iconButtonClass("quiet", "sm")}
            >
              {c.hidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </button>
          </li>
        ))}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </>
  );
}

function GripMenu({
  label,
  first,
  last,
  buttonRef,
  onPointerDown,
  onPointerUp,
  onMove,
}: {
  label: string;
  first: boolean;
  last: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  onMove: (by: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <span className="relative">
      <button
        ref={(el) => {
          ref.current = el;
          buttonRef(el);
        }}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${label}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        data-tt="Drag to move, or click for Move up and Move down"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          if (e.key === "ArrowUp" && !first) onMove(-1);
          if (e.key === "ArrowDown" && !last) onMove(1);
        }}
        className={`${iconButtonClass("quiet", "sm")} cursor-grab active:cursor-grabbing`}
      >
        <GripVertical aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={ref} role="menu" label={`Move ${label}`} width="w-44">
        <MenuItem icon={<ArrowUp />} disabled={first} onClick={() => (setOpen(false), onMove(-1))}>
          Move up
        </MenuItem>
        <MenuItem icon={<ArrowDown />} disabled={last} onClick={() => (setOpen(false), onMove(1))}>
          Move down
        </MenuItem>
      </Popover>
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-slate-500">
        {hint ? (
          <span data-tt={hint} data-tt-wrap="" tabIndex={0} className="cursor-help underline decoration-slate-300 decoration-dotted underline-offset-4">
            {label}
          </span>
        ) : (
          label
        )}
      </dt>
      <dd className={`mt-0.5 truncate ${value === null ? "text-sm text-slate-500" : "text-xl font-bold text-slate-900"}`}>{value ?? "Not enough yet"}</dd>
    </div>
  );
}
