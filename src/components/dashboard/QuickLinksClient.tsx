"use client";

// The interactive half of the dashboard's Quick links tile (1.17.0): the
// three groups (Pinned by you, From your admin, Most used), the Add dialog
// with its two tabs (pin a link from the Links page, or add one of your
// own) and the edit mode that reorders and removes pins. Every change is
// applied here first and then sent to /api/quick-links; a refusal puts the
// list back and toasts the server's reason, and a success refreshes the
// route so the other groups re-de-duplicate against the new pins.
//
// Curated links go through TrackedLink so a click is counted (the href is
// the real one); a person's own links are plain new-tab anchors.

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, ChevronUp, ExternalLink, Pencil, Pin, Plus, Star, TrendingUp, X } from "lucide-react";
import type { QuickLinkItem } from "@/lib/quick-links";
import { TrackedLink } from "@/components/TrackedLink";
import { Button, iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { Field, FormError, SectionEmpty, TextInput } from "@/components/form";
import { Modal } from "@/components/Modal";
import { Segmented } from "@/components/Segmented";
import { toast } from "@/components/Toasts";
import { DashboardTile, TileLabel } from "./DashboardTile";

/** The API's limits (POST /api/quick-links), checked here first. */
const MAX_PINS = 12;
const TITLE_MAX = 60;
const URL_MAX = 2000;
/** A group's links: one column in the side column, two when the tile is wide. */
const LIST = "grid @xl:grid-cols-2 @xl:gap-x-4";
const FULL_MESSAGE = `You can pin up to ${MAX_PINS} links. Remove one to make room.`;

type Result = { ok: true; data: { item?: QuickLinkItem } } | { ok: false; error: string };

async function send(path: string, method: string, body: unknown, fallback: string): Promise<Result> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error || fallback };
    return { ok: true, data };
  } catch {
    return { ok: false, error: fallback };
  }
}

/** The body that re-creates a pin (Undo, and the dialog's Pin). */
function pinBody(item: QuickLinkItem) {
  return item.kind === "curated" && item.linkId != null ? { linkId: item.linkId } : { title: item.title, url: item.url };
}

/** Same rules as the API: http(s) only, a real host, at most 2000 characters. */
function quickLinkUrlProblem(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return "Enter the address of the page.";
  if (v.length > URL_MAX) return `Keep the address under ${URL_MAX} characters.`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Enter the full address, starting with https:// or http://.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only https:// and http:// addresses can be added.";
  if (!u.hostname) return "Enter the full address, starting with https:// or http://.";
  return undefined;
}

export function QuickLinksClient(props: {
  pinned: QuickLinkItem[];
  featured: QuickLinkItem[];
  mostUsed: QuickLinkItem[];
  mostUsedIsWorkspace: boolean;
  /** The curated links the viewer may pin (the Add dialog's first tab). */
  pinnable: QuickLinkItem[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pinned, setPinned] = useState(props.pinned);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Keys of pins whose request is still out (their controls wait). */
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());

  // The list as last rendered, for handlers that resume after an await.
  const latest = useRef(pinned);
  latest.current = pinned;

  // Requests in flight. While any is out, a refreshed server list must not
  // overwrite the optimistic one (it may predate the change); once the last
  // one lands the route refreshes and the server's list takes over.
  const inflight = useRef(0);
  const orderQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (inflight.current === 0) setPinned(props.pinned);
  }, [props.pinned]);

  function refreshWhenIdle() {
    if (inflight.current === 0) startTransition(() => router.refresh());
  }
  function begin(key?: string) {
    inflight.current++;
    if (key) setSaving((s) => new Set(s).add(key));
  }
  function end(key?: string) {
    inflight.current--;
    if (key)
      setSaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    refreshWhenIdle();
  }

  // Focus that must survive a re-render: a moved row's button, the next
  // row after a removal, Done on entering the edit mode.
  const controls = useRef(new Map<string, HTMLElement | null>());
  const focusNext = useRef<string[] | null>(null);
  const ref = (id: string) => (el: HTMLElement | null) => {
    controls.current.set(id, el);
  };
  useLayoutEffect(() => {
    const wanted = focusNext.current;
    if (!wanted) return;
    focusNext.current = null;
    for (const id of wanted) {
      const el = controls.current.get(id);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        return;
      }
    }
  });

  // ---- Mutations ------------------------------------------------------

  async function pin(link: QuickLinkItem) {
    if (pinned.length >= MAX_PINS) {
      toast("error", FULL_MESSAGE);
      return;
    }
    const temp: QuickLinkItem = { ...link, key: `pending-link-${link.linkId}`, pinId: null, count: undefined };
    setPinned((p) => [...p, temp]);
    begin(temp.key);
    const res = await send("/api/quick-links", "POST", pinBody(link), `Couldn't pin “${link.title}”.`);
    if (res.ok && res.data.item) {
      const item = res.data.item;
      setPinned((p) => p.map((x) => (x.key === temp.key ? item : x)));
    } else {
      setPinned((p) => p.filter((x) => x.key !== temp.key));
      toast("error", res.ok ? `Couldn't pin “${link.title}”.` : res.error);
    }
    end(temp.key);
  }

  /** Remove a pin; from the edit mode it offers Undo (§Feedback). */
  async function unpin(item: QuickLinkItem, opts: { undo: boolean }) {
    if (item.pinId == null) return;
    const index = pinned.findIndex((x) => x.key === item.key);
    setPinned((p) => p.filter((x) => x.key !== item.key));
    begin(item.key);
    const res = await send(`/api/quick-links/${item.pinId}`, "DELETE", undefined, `Couldn't remove “${item.title}”.`);
    if (!res.ok) {
      setPinned((p) => [...p.slice(0, index), item, ...p.slice(index)]);
      toast("error", res.error);
    } else if (opts.undo) {
      toast("ok", `Removed “${item.title}” from your quick links.`, {
        action: { label: "Undo", onClick: () => void restore(item, index) },
      });
    }
    end(item.key);
  }

  /** Undo a removal: pin it again and put it back where it was. */
  async function restore(item: QuickLinkItem, index: number) {
    begin();
    const res = await send("/api/quick-links", "POST", pinBody(item), `Couldn't put “${item.title}” back.`);
    if (!res.ok || !res.data.item) {
      toast("error", res.ok ? `Couldn't put “${item.title}” back.` : res.error);
      end();
      return;
    }
    const back = res.data.item;
    const rest = latest.current.filter((x) => x.key !== back.key);
    const order = [...rest.slice(0, index), back, ...rest.slice(index)];
    setPinned(order);
    saveOrder(order);
    end();
  }

  /** Orders go out one at a time, in the order they were made. */
  function saveOrder(order: QuickLinkItem[]) {
    const pinIds = order.map((x) => x.pinId).filter((id): id is number => id != null);
    begin();
    orderQueue.current = orderQueue.current.then(async () => {
      const res = await send("/api/quick-links/order", "PATCH", { pinIds }, "Couldn't save the new order.");
      // On a refusal the refresh below puts the server's order back.
      if (!res.ok) toast("error", res.error);
      end();
    });
  }

  function move(index: number, by: -1 | 1, control: "up" | "down") {
    const to = index + by;
    if (to < 0 || to >= pinned.length) return;
    const next = [...pinned];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    setPinned(next);
    // Keep focus on the button that was pressed; at either end it is
    // disabled, so the other arrow of the same row takes it.
    focusNext.current = [`${item.key}:${control}`, `${item.key}:${control === "up" ? "down" : "up"}`];
    saveOrder(next);
  }

  function remove(index: number) {
    const item = pinned[index];
    const neighbour = pinned[index + 1] ?? pinned[index - 1];
    focusNext.current = neighbour ? [`${neighbour.key}:remove`, "done"] : ["done"];
    void unpin(item, { undo: true });
  }

  function startEditing() {
    focusNext.current = ["done"];
    setEditing(true);
  }
  function stopEditing() {
    focusNext.current = ["edit", "add"];
    setEditing(false);
  }

  // ---- What shows -----------------------------------------------------

  // Pinned wins: a link pinned since the page loaded leaves the other
  // groups at once rather than on the refresh.
  const pinnedLinks = new Set(pinned.map((p) => p.linkId).filter((id) => id != null));
  const featured = props.featured.filter((f) => f.linkId == null || !pinnedLinks.has(f.linkId));
  const mostUsed = props.mostUsed.filter((m) => m.linkId == null || !pinnedLinks.has(m.linkId));
  const personalCounts = mostUsed.some((m) => m.count != null);
  const empty = pinned.length === 0 && featured.length === 0 && mostUsed.length === 0;
  const anySaving = saving.size > 0;

  const actions = (
    <span className="flex items-center gap-1 print:hidden">
      <button
        ref={ref("add")}
        type="button"
        onClick={() => setAdding(true)}
        data-tt="Add a quick link"
        aria-label="Add a quick link"
        className={iconButtonClass("bordered", "sm")}
      >
        <Plus />
      </button>
      {editing ? (
        <Button ref={ref("done")} variant="secondary" size="sm" onClick={stopEditing}>
          Done
        </Button>
      ) : (
        pinned.length > 0 && (
          <button
            ref={ref("edit")}
            type="button"
            onClick={startEditing}
            data-tt="Edit quick links"
            aria-label="Edit quick links"
            className={iconButtonClass("bordered", "sm")}
          >
            <Pencil />
          </button>
        )
      )}
    </span>
  );

  const footer = (
    <>
      {empty ? (
        <span />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 font-medium text-compass-700 hover:underline print:hidden [&>svg]:h-3.5 [&>svg]:w-3.5"
        >
          <Plus aria-hidden />
          Add a quick link
        </button>
      )}
      <Link href="/links" className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700 [&>svg]:h-3.5 [&>svg]:w-3.5">
        All links
        <ArrowRight aria-hidden />
      </Link>
    </>
  );

  return (
    <DashboardTile id="quick_links" title="Quick links" actions={actions} footer={footer}>
      {empty && !editing ? (
        <div className="px-2 pb-2 pt-1">
          <SectionEmpty>Pin the tools you use every day, or add a link of your own. Only you see your pins.</SectionEmpty>
          <Button variant="secondary" size="sm" icon={<Plus />} className="mt-3 print:hidden" onClick={() => setAdding(true)}>
            Add a quick link
          </Button>
        </div>
      ) : (
        // Beside the main column the tile is 19rem: one link per row. Where
        // the dashboard stacks it full width, two.
        <div className="@container">
          {(pinned.length > 0 || editing) && (
            <>
              <TileLabel icon={<Pin aria-hidden />}>Pinned by you</TileLabel>
              {editing && pinned.length === 0 ? (
                <SectionEmpty className="px-2 py-1.5">Nothing pinned yet.</SectionEmpty>
              ) : (
                <ul className={editing ? "" : LIST}>
                  {pinned.map((item, i) => (
                    <li key={item.key}>
                      {editing ? (
                        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.75">
                          <LinkTile item={item} />
                          <LinkText item={item} />
                          <span className="flex shrink-0 items-center">
                            <button
                              ref={ref(`${item.key}:up`)}
                              type="button"
                              onClick={() => move(i, -1, "up")}
                              disabled={i === 0 || anySaving}
                              data-tt="Move up"
                              aria-label={`Move ${item.title} up`}
                              className={iconButtonClass("quiet", "sm")}
                            >
                              <ChevronUp />
                            </button>
                            <button
                              ref={ref(`${item.key}:down`)}
                              type="button"
                              onClick={() => move(i, 1, "down")}
                              disabled={i === pinned.length - 1 || anySaving}
                              data-tt="Move down"
                              aria-label={`Move ${item.title} down`}
                              className={iconButtonClass("quiet", "sm")}
                            >
                              <ChevronDown />
                            </button>
                            <button
                              ref={ref(`${item.key}:remove`)}
                              type="button"
                              onClick={() => remove(i)}
                              disabled={item.pinId == null || saving.has(item.key)}
                              data-tt="Remove"
                              aria-label={`Remove ${item.title}`}
                              className={iconButtonClass("quiet", "sm", "hover-danger")}
                            >
                              <X />
                            </button>
                          </span>
                        </div>
                      ) : (
                        <LinkRow item={item} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {featured.length > 0 && (
            <>
              <TileLabel icon={<Star fill="currentColor" aria-hidden />}>From your admin</TileLabel>
              <ul className={LIST}>
                {featured.map((item) => (
                  <li key={item.key}>
                    <LinkRow item={item} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {mostUsed.length > 0 && (
            <>
              <TileLabel icon={<TrendingUp aria-hidden />}>
                {props.mostUsedIsWorkspace && !personalCounts ? "Popular in your workspace" : "Most used · last 30 days"}
              </TileLabel>
              <ul className={LIST}>
                {mostUsed.map((item) => (
                  <li key={item.key}>
                    <LinkRow item={item} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <AddQuickLinkDialog
        open={adding}
        onClose={() => setAdding(false)}
        pinnable={props.pinnable}
        pinned={pinned}
        saving={saving}
        onPin={pin}
        onUnpin={(item) => void unpin(item, { undo: false })}
        onAdded={(item) => {
          setPinned((p) => [...p.filter((x) => x.key !== item.key), item]);
          refreshWhenIdle();
        }}
      />
    </DashboardTile>
  );
}

// ---- Rows ---------------------------------------------------------------

/** 30px: the link's icon on a white brand tile, else its letter in the accent. */
function LinkTile({ item }: { item: QuickLinkItem }) {
  if (item.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={item.iconUrl} alt="" className="h-7.5 w-7.5 shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-slate-100" />
    );
  }
  return (
    <span
      aria-hidden
      className="grid h-7.5 w-7.5 shrink-0 place-items-center rounded-lg bg-compass-100 text-sm font-bold text-compass-700"
    >
      {item.letter}
    </span>
  );
}

function LinkText({ item, external = false }: { item: QuickLinkItem; external?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-semibold text-slate-800 group-hover:text-compass-700">{item.title}</span>
        {external && (
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-compass-500" aria-hidden />
        )}
        {item.isNew && <span className={chipClass("accent", "sm", "shrink-0")}>New</span>}
      </span>
      <span className="block truncate text-xs text-slate-500">{item.host}</span>
    </span>
  );
}

function LinkRow({ item }: { item: QuickLinkItem }) {
  const cls = "group flex items-center gap-2.5 rounded-lg px-2 py-1.75 transition hover:bg-slate-50";
  const body = (
    <>
      <LinkTile item={item} />
      <LinkText item={item} external />
      {item.count != null && (
        <span className="shrink-0 text-xs tabular-nums text-slate-500">
          {item.count}
          <span className="sr-only"> clicks</span>
        </span>
      )}
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
  // Curated links are counted on click (same-origin beacon, real href);
  // a person's own links are theirs alone and are not tracked.
  return item.kind === "curated" && item.linkId != null ? (
    <TrackedLink linkId={item.linkId} href={item.url} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </TrackedLink>
  ) : (
    <a href={item.url} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </a>
  );
}

// ---- Add dialog -----------------------------------------------------------

type Tab = "links" | "own";

function AddQuickLinkDialog({
  open,
  onClose,
  pinnable,
  pinned,
  saving,
  onPin,
  onUnpin,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  pinnable: QuickLinkItem[];
  pinned: QuickLinkItem[];
  saving: ReadonlySet<string>;
  onPin: (link: QuickLinkItem) => void;
  onUnpin: (pin: QuickLinkItem) => void;
  onAdded: (item: QuickLinkItem) => void;
}) {
  const [tab, setTab] = useState<Tab>("links");
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab(pinnable.length > 0 ? "links" : "own");
    setQuery("");
    setTitle("");
    setUrl("");
    setTried(false);
    setError("");
    // Only on opening: the list of pinnable links does not reset the tabs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const full = pinned.length >= MAX_PINS;
  const pinOf = new Map<number, QuickLinkItem>();
  for (const p of pinned) if (p.kind === "curated" && p.linkId != null) pinOf.set(p.linkId, p);
  const q = query.trim().toLowerCase();
  const matches = q
    ? pinnable.filter((l) => l.title.toLowerCase().includes(q) || l.host.toLowerCase().includes(q))
    : pinnable;

  const titleError = !title.trim()
    ? "Give the link a name."
    : title.trim().length > TITLE_MAX
      ? `Keep the name under ${TITLE_MAX} characters.`
      : undefined;
  const urlError = quickLinkUrlProblem(url);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setError("");
    if (titleError || urlError) {
      (titleError ? titleInput : urlInput).current?.focus();
      return;
    }
    if (full) {
      setError(FULL_MESSAGE);
      return;
    }
    setBusy(true);
    const res = await send("/api/quick-links", "POST", { title: title.trim(), url: url.trim() }, "Couldn't add that link.");
    setBusy(false);
    if (!res.ok || !res.data.item) {
      setError(res.ok ? "Couldn't add that link." : res.error);
      return;
    }
    onAdded(res.data.item);
    toast("ok", `Added “${res.data.item.title}” to your quick links.`);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="ql-add-title"
      describedBy="ql-add-desc"
      className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id="ql-add-title" className="text-lg font-semibold text-slate-900">
        Add a quick link
      </h2>
      <p id="ql-add-desc" className="mt-1 text-sm text-slate-500">
        Pin a link from the Links page, or add one of your own. Only you see these.
      </p>
      <Segmented
        className="mt-4"
        label="Where the link comes from"
        value={tab}
        onChange={(v) => {
          setTab(v);
          setError("");
        }}
        options={[
          { value: "links", label: "From the Links page" },
          { value: "own", label: "Your own link" },
        ]}
      />

      {tab === "links" ? (
        <div className="mt-3">
          {pinnable.length === 0 ? (
            <SectionEmpty
              className="py-3"
              action={{ label: "Add your own link", onClick: () => setTab("own") }}
            >
              Your admin hasn&apos;t added any links yet.
            </SectionEmpty>
          ) : (
            <>
              <TextInput
                data-autofocus
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search links…"
                aria-label="Search links"
                autoComplete="off"
              />
              {full && <p className="mt-2 text-xs text-slate-500">{FULL_MESSAGE}</p>}
              {matches.length === 0 ? (
                <SectionEmpty className="py-4">No links match “{query.trim()}”.</SectionEmpty>
              ) : (
                <ul className="mt-1.5 max-h-72 overflow-y-auto" aria-label="Links">
                  {matches.map((link) => {
                    const pin = link.linkId != null ? pinOf.get(link.linkId) : undefined;
                    const on = Boolean(pin);
                    const waiting = pin ? saving.has(pin.key) || pin.pinId == null : false;
                    return (
                      <li key={link.key} className="flex items-center gap-2.5 border-b border-slate-100 px-1.5 py-2 last:border-b-0">
                        <LinkTile item={link} />
                        <LinkText item={link} />
                        <button
                          type="button"
                          aria-pressed={on}
                          disabled={waiting || (!on && full)}
                          onClick={() => (pin ? onUnpin(pin) : onPin(link))}
                          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 [&>svg]:h-3.5 [&>svg]:w-3.5 ${
                            on
                              ? "bg-compass-600 text-white hover:opacity-90"
                              : "border border-slate-300 text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <Pin aria-hidden />
                          {/* One name in both states ("Pin Teams"); aria-pressed says which. */}
                          <span aria-hidden>{on ? "Pinned" : "Pin"}</span>
                          <span className="sr-only">Pin {link.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="mt-1">
          <Field label="Title" error={tried ? titleError : undefined} className="mt-3">
            <TextInput
              ref={titleInput}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              autoComplete="off"
              placeholder="Payroll portal"
            />
          </Field>
          <Field
            label="Address"
            help="Starts with https:// or http://."
            error={tried ? urlError : undefined}
            className="mt-3"
          >
            <TextInput
              ref={urlInput}
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              maxLength={URL_MAX}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://payroll.example.com"
            />
          </Field>
          <FormError className="mt-3">{error}</FormError>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Add quick link
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
