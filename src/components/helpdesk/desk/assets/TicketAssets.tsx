"use client";

// A ticket's assets (1.19.3; mock-up i1), in the side column: the Package
// eyebrow "Assets" with "+ Link", then each linked asset: its picture (from
// its category), name, "TAG · Snipe-IT", Status (a chip), Assigned and
// Warranty, "N earlier tickets on this asset" (to the asset's page) and
// "Open in Snipe-IT". Unlink is an icon button on the asset's row.
//
// "+ Link" opens the picker: a search box ("Asset tag, serial or name"),
// the requester's own assets first ("Assigned to <requester>", looked up in
// Snipe-IT when the cache has none), then what the search matches, each
// with its source chip; a linked one says so and can't be picked again.
// Arrow keys walk the options, Enter links. When the options say no source
// is connected (`connected: false`), it shows only that notice.
//
// "+ Link" shows while a source is connected and the ticket is open
// (can_edit); at ten linked (a merge can bring more) it is disabled inside a
// Tooltip saying why. Unlink shows on an open ticket whether or not a
// source is connected (can_unlink), so a wrong device link stays removable.
//
// 1.19.4 (mock-up i1): an asset Intune also manages has an "Intune" row
// (compliance · seen 2h ago); an Intune-only asset reads "SERIAL · Intune",
// and an Intune device's picker line adds "Intune: compliant".
//
// Agents who work the ticket only (the routes answer 404 to anyone else);
// the card stays away when no asset source is set up and nothing is linked.
// GET/POST /api/helpdesk/tickets/[number]/assets, GET …/assets/options,
// DELETE …/assets/[assetId].

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Computer, ExternalLink, History, Laptop, Monitor, Package, Plus, Printer, Search, Smartphone, Tablet, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Popover } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty, controlClass } from "@/components/form";
import { toast } from "@/components/Toasts";
import { Tooltip } from "@/components/Tooltip";
import {
  ASSET_LIMITS,
  HD_ASSET_PROVIDER_LABEL,
  assetIcon,
  complianceLabel,
  earlierTicketsLabel,
  intuneSeenLine,
  statusText,
  statusTone,
  warrantyLabel,
  type HdAssetIcon,
  type HdAssetOption,
  type HdAssetOptions,
  type HdLinkedAsset,
  type HdTicketAssetsView,
} from "@/lib/helpdesk/assets-shared";
import { getJson, sendJson } from "../api";

const ICONS: Record<HdAssetIcon, typeof Laptop> = {
  laptop: Laptop,
  desktop: Computer,
  monitor: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  printer: Printer,
  other: Package,
};

export function AssetGlyph({ a, size = "md" }: { a: { category: string; model: string; name: string }; size?: "sm" | "md" | "lg" }) {
  const Icon = ICONS[assetIcon(a)];
  const box = size === "lg" ? "h-12 w-12 rounded-xl" : size === "md" ? "h-9 w-9 rounded-lg" : "";
  const glyph = size === "lg" ? "h-6 w-6" : size === "md" ? "h-4.5 w-4.5" : "h-4 w-4";
  if (size === "sm") return <Icon className={`${glyph} shrink-0 text-slate-500`} aria-hidden />;
  return (
    <span className={`grid shrink-0 place-items-center bg-compass-50 text-compass-700 ${box}`} aria-hidden>
      <Icon className={glyph} />
    </span>
  );
}

export const assetHref = (id: number) => `/desk/assets/${id}`;

export function TicketAssetsCard({ number, canWork, refreshKey }: { number: number; canWork: boolean; refreshKey?: string }) {
  const [view, setView] = useState<HdTicketAssetsView | null>(null);
  const [open, setOpen] = useState(false);
  const linkBtn = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  const load = useCallback(() => {
    getJson<HdTicketAssetsView>(`/api/helpdesk/tickets/${number}/assets`)
      .then(setView)
      .catch(() => setView(null));
  }, [number]);

  useEffect(() => {
    if (canWork) load();
  }, [canWork, load, refreshKey]);

  // Ten linked by hand is the limit; a merge may have brought more.
  const full = !!view && view.assets.length >= ASSET_LIMITS.perTicket;
  const canEdit = !!view?.can_edit;
  // The picker lives in the live Link branch only: close it when that branch goes, so an
  // Unlink back under ten (or Link coming back) doesn't reopen it and take focus.
  useEffect(() => {
    if (full || !canEdit) setOpen(false);
  }, [full, canEdit]);

  if (!canWork || !view || !view.configured) return null;

  async function link(o: HdAssetOption) {
    if (o.linked) return;
    try {
      const v = await sendJson<HdTicketAssetsView>(`/api/helpdesk/tickets/${number}/assets`, "POST", { asset_id: o.id }, "Couldn't link the asset.");
      setView(v);
      setOpen(false);
      toast("ok", `Linked ${o.tag || o.name}.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function unlink(a: HdLinkedAsset) {
    try {
      const v = await sendJson<HdTicketAssetsView>(`/api/helpdesk/tickets/${number}/assets/${a.id}`, "DELETE", undefined, "Couldn't unlink the asset.");
      setView(v);
      toast("ok", `Unlinked ${a.tag || a.name}.`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <section aria-labelledby={headingId} className={`${CARD_CLASS} px-4 py-3.5`} data-testid="assets-side">
      <div className="flex items-center gap-2">
        <h3 id={headingId} className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
          <Package className="h-3.5 w-3.5" aria-hidden /> Assets
        </h3>
        {view.can_edit && full && (
          <Tooltip label={`A ticket can have up to ${ASSET_LIMITS.perTicket} assets.`} className="ml-auto">
            <button type="button" disabled className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-slate-500 cursor-not-allowed">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Link
            </button>
          </Tooltip>
        )}
        {view.can_edit && !full && (
          <div className="relative ml-auto">
            <button
              ref={linkBtn}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-compass-700 hover:bg-compass-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Link
            </button>
            <AssetPicker open={open} onClose={() => setOpen(false)} triggerRef={linkBtn} number={number} view={view} onPick={link} />
          </div>
        )}
      </div>
      {view.assets.length === 0 ? (
        <SectionEmpty className="mt-2">No asset linked yet. Link the device this ticket is about to see its history.</SectionEmpty>
      ) : (
        <ul className="mt-2">
          {view.assets.map((a) => (
            <li key={a.id} className="border-b border-slate-100 py-2.5 first:pt-1 last:border-b-0 last:pb-0" data-testid="asset-linked">
              <div className="flex items-start gap-2.5">
                <AssetGlyph a={a} />
                <div className="min-w-0 flex-1">
                  <Link href={assetHref(a.id)} className="block break-words text-sm font-semibold text-slate-900 hover:underline">
                    {a.name}
                  </Link>
                  <p className="break-all text-xs text-slate-500">
                    {[a.tag || a.serial, a.provider_label].filter(Boolean).join(" · ")}
                    {a.gone ? " · no longer in the source" : ""}
                  </p>
                </div>
                {view.can_unlink && (
                  <button type="button" className={iconButtonClass("quiet", "sm")} aria-label={`Unlink ${a.tag || a.name}`} data-tt="Unlink" onClick={() => unlink(a)}>
                    <X aria-hidden />
                  </button>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
                {statusText(a) && (
                  <>
                    <dt className="text-slate-500">Status</dt>
                    <dd>
                      <span className={chipClass(statusTone(a.status_kind), "sm")}>{statusText(a)}</span>
                    </dd>
                  </>
                )}
                <dt className="text-slate-500">Assigned</dt>
                <dd className="truncate text-slate-800">{a.assigned_name || "Nobody"}</dd>
                {a.warranty_end && (
                  <>
                    <dt className="text-slate-500">Warranty</dt>
                    <dd className="text-slate-800">{warrantyLabel(a.warranty_end)}</dd>
                  </>
                )}
                {a.intune && (
                  <>
                    <dt className="text-slate-500">Intune</dt>
                    <dd className="text-slate-800" data-testid="asset-intune-line">
                      {intuneSeenLine(a.intune)}
                    </dd>
                  </>
                )}
              </dl>
              <div className="mt-2 flex flex-col gap-1 border-t border-slate-100 pt-2 text-xs">
                <Link href={assetHref(a.id)} className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 hover:underline">
                  <History className="h-3.5 w-3.5" aria-hidden />
                  {a.earlier_tickets ? earlierTicketsLabel(a.earlier_tickets) : "No earlier tickets on this asset"}
                </Link>
                {a.url && (
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    Open in {a.provider_label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AssetPicker({
  open,
  onClose,
  triggerRef,
  number,
  view,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  number: number;
  view: HdTicketAssetsView;
  onPick: (o: HdAssetOption) => void;
}) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<HdAssetOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const t = setTimeout(
      () => {
        setLoading(true);
        getJson<HdAssetOptions>(`/api/helpdesk/tickets/${number}/assets/options?q=${encodeURIComponent(q.trim())}`, "Couldn't load the assets.", ctrl.signal)
          .then((d) => {
            setData(d);
            setError("");
            setActive(0);
          })
          .catch((e: Error) => {
            if (e.name !== "AbortError") setError(e.message);
          })
          .finally(() => setLoading(false));
      },
      q.trim() ? 250 : 0
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, q, number]);

  const all = [...(data?.assigned ?? []), ...(data?.results ?? [])];
  const pickable = all.filter((o) => !o.linked);

  const row = (o: HdAssetOption) => {
    const i = pickable.indexOf(o);
    const on = i === active && !o.linked;
    return (
      <div
        key={o.id}
        id={`${listId}-${o.id}`}
        role="option"
        aria-selected={on}
        aria-disabled={o.linked || undefined}
        onMouseEnter={() => i >= 0 && setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(o)}
        className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 ${o.linked ? "cursor-default" : "cursor-pointer"} ${on ? "bg-compass-50" : ""}`}
      >
        <span className="mt-0.5">
          <AssetGlyph a={o} size="sm" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900">{o.name}</span>
          <span className="block truncate text-xs text-slate-500">
            {[
              o.tag || o.serial,
              o.linked ? "linked" : "",
              o.assigned_name && !data?.assigned.includes(o) ? o.assigned_name : "",
              // As in mock-up i1: an Intune device's own line says its compliance; a matched one reads as its Snipe-IT asset.
              o.intune && o.provider_label === HD_ASSET_PROVIDER_LABEL.intune ? `Intune: ${complianceLabel(o.intune.compliance).toLowerCase()}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className={chipClass("neutral", "sm", "shrink-0")}>{o.provider_label}</span>
      </div>
    );
  };

  return (
    <Popover open={open} onClose={onClose} triggerRef={triggerRef} role="dialog" label="Link an asset" align="end" width="w-[min(26rem,calc(100vw-2rem))]" padding="p-0">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(pickable.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && pickable[active]) {
              e.preventDefault();
              onPick(pickable[active]);
            }
          }}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={pickable[active] ? `${listId}-${pickable[active].id}` : undefined}
          aria-label="Asset tag, serial or name"
          placeholder="Asset tag, serial or name"
          className={controlClass(false, "h-8 border-0 px-0 shadow-none focus:ring-0", true)}
        />
      </div>
      <div id={listId} role="listbox" aria-label="Assets" className="max-h-80 overflow-y-auto p-1.5">
        {error && <p className="px-2.5 py-3 text-sm ink-warn">{error}</p>}
        {!error && !data && <LoadingRow className="py-4" />}
        {/* No source connected: nothing can be linked, so only the reason shows, not two empty groups. */}
        {data && !data.connected && <SectionEmpty className="px-2.5 py-3">{data.notice}</SectionEmpty>}
        {data?.connected && view.requester && (
          <div role="group" aria-label={`Assigned to ${view.requester.name}`}>
            <p className={`${EYEBROW_TEXT} px-2.5 pb-1 pt-1.5`} aria-hidden>
              Assigned to {view.requester.name}
            </p>
            {data.assigned.length ? data.assigned.map(row) : <SectionEmpty className="px-2.5 py-1.5">Nothing assigned to them in the asset list.</SectionEmpty>}
          </div>
        )}
        {data?.connected && q.trim() !== "" && (
          <div role="group" aria-label="Matching assets">
            <p className={`${EYEBROW_TEXT} px-2.5 pb-1 pt-2.5`} aria-hidden>
              Matching assets
            </p>
            {data.results.length ? data.results.map(row) : <SectionEmpty className="px-2.5 py-1.5">{loading ? "Searching…" : "No asset matches that."}</SectionEmpty>}
          </div>
        )}
      </div>
      {data?.connected !== false && (
        <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
          {data?.notice
            ? data.notice
            : view.search_all
              ? "Or search every asset by tag or serial."
              : "Search finds the assets of people whose tickets you work."}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {data ? (data.connected ? `${all.length} ${all.length === 1 ? "asset" : "assets"}` : data.notice) : ""}
      </p>
    </Popover>
  );
}
