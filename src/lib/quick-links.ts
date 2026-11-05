import "server-only";

// Quick links (1.17.0): what the dashboard's Quick links tile, its Add dialog
// and the sign-in page show. Three groups, de-duplicated in this order:
//
//   pinned    the viewer's own pins, by position: a curated link (skipped
//             while it is not visible to them) or their own title + URL
//   featured  links an admin put on everyone's dashboard, visible to the
//             viewer, by position
//   mostUsed  the viewer's most-clicked visible links over 30 days (with
//             counts), topped up to four from the workspace's most-clicked
//             visible links (without counts; mostUsedIsWorkspace)
//
// Visibility is the Links page's: an unrestricted link, or one granted to a
// group the viewer is in; admins see every link. Clicks are recorded by the
// beacon in lib/link-beacon, never by rewriting a link's href.

import {
  listLinksVisibleTo,
  listSignInLinkRows,
  listUserQuickLinks,
  rankedLinkClicks,
  type QuickLink,
  type UserQuickLinkRow,
} from "./db";
import { getAppSettings } from "./settings-store";
import type { SessionUser } from "./types";

export type QuickLinkItem = {
  key: string;
  kind: "curated" | "own";
  linkId: number | null;
  pinId: number | null;
  title: string;
  url: string;
  host: string;
  iconUrl: string | null;
  letter: string;
  isNew: boolean;
  count?: number;
};

/** How many links "Most used" shows. */
export const MOST_USED_LIMIT = 4;
/** The window clicks are counted over, everywhere they are shown. */
export const CLICK_WINDOW_DAYS = 30;
/** A curated link younger than this carries the "New" chip. */
const NEW_FOR_MS = 7 * 24 * 3600_000;
/** The sign-in page shows at most this many links. */
export const MAX_SIGNIN_LINKS = 8;

/** The host a link points at, for the line under its title ("www." dropped). */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** The letter tile's letter: the title's first character, upper-cased. */
export function linkLetter(title: string): string {
  return (Array.from(title.trim())[0] || "?").toUpperCase();
}

/**
 * Where a curated link's icon comes from: the cached favicon or custom upload
 * (served by /api/links/icon/{id}, which applies the link's visibility), the
 * workspace logo for a brand link, or null for a letter tile.
 */
function iconFor(link: QuickLink, brandLogo: string): string | null {
  if (link.icon_file && link.icon_mime) return `/api/links/icon/${link.id}`;
  if (link.icon_type === "brand" && brandLogo) return brandLogo;
  return null;
}

function curatedItem(
  link: QuickLink,
  brandLogo: string,
  extra: { key?: string; pinId?: number | null; count?: number } = {}
): QuickLinkItem {
  const item: QuickLinkItem = {
    key: extra.key ?? `link-${link.id}`,
    kind: "curated",
    linkId: link.id,
    pinId: extra.pinId ?? null,
    title: link.title,
    url: link.url,
    host: linkHost(link.url),
    iconUrl: iconFor(link, brandLogo),
    letter: linkLetter(link.title),
    isNew: Date.now() - new Date(link.created_at).getTime() < NEW_FOR_MS,
  };
  if (extra.count !== undefined) item.count = extra.count;
  return item;
}

function ownItem(pin: UserQuickLinkRow): QuickLinkItem {
  return {
    key: `pin-${pin.id}`,
    kind: "own",
    linkId: null,
    pinId: pin.id,
    title: pin.title,
    url: pin.url,
    host: linkHost(pin.url),
    iconUrl: null,
    letter: linkLetter(pin.title),
    isNew: false,
  };
}

/** The viewer's pins as items, in their order; a curated pin they can no longer see is skipped. */
function pinnedItems(
  pins: UserQuickLinkRow[],
  visible: Map<number, QuickLink>,
  brandLogo: string
): QuickLinkItem[] {
  const out: QuickLinkItem[] = [];
  for (const pin of pins) {
    if (pin.link_id === null) {
      out.push(ownItem(pin));
      continue;
    }
    const link = visible.get(pin.link_id);
    if (link) out.push(curatedItem(link, brandLogo, { key: `pin-${pin.id}`, pinId: pin.id }));
  }
  return out;
}

async function visibleLinks(user: SessionUser): Promise<QuickLink[]> {
  return listLinksVisibleTo(user.role === "admin" ? "all" : user.id);
}

/** The viewer's pins only (GET /api/quick-links, and after each change). */
export async function getPinnedQuickLinks(user: SessionUser): Promise<QuickLinkItem[]> {
  const [links, pins, settings] = await Promise.all([
    visibleLinks(user),
    listUserQuickLinks(user.id),
    getAppSettings(),
  ]);
  return pinnedItems(pins, new Map(links.map((l) => [l.id, l])), settings.logo_url || "");
}

// The workspace ranking counts people, not clicks (one person's script
// cannot lift a link for everyone), over every click in the window: the
// same for every viewer, so one process-wide copy serves all dashboards
// for WORKSPACE_TTL_MS before visibility is applied per viewer.
const WORKSPACE_TTL_MS = 5 * 60_000;
let workspaceCache: { at: number; rows: Promise<{ link_id: number; n: number }[]> } | null = null;
function workspaceRanking(): Promise<{ link_id: number; n: number }[]> {
  const now = Date.now();
  if (!workspaceCache || now - workspaceCache.at > WORKSPACE_TTL_MS) {
    const rows = rankedLinkClicks(null, CLICK_WINDOW_DAYS);
    workspaceCache = { at: now, rows };
    rows.catch(() => {
      if (workspaceCache?.rows === rows) workspaceCache = null;
    });
  }
  return workspaceCache.rows;
}

/** Everything the dashboard's Quick links tile shows, already de-duplicated. */
export async function getDashboardQuickLinks(user: SessionUser): Promise<{
  pinned: QuickLinkItem[];
  featured: QuickLinkItem[];
  mostUsed: QuickLinkItem[];
  mostUsedIsWorkspace: boolean;
}> {
  const [links, pins, mine, settings] = await Promise.all([
    visibleLinks(user),
    listUserQuickLinks(user.id),
    rankedLinkClicks(user.id, CLICK_WINDOW_DAYS),
    getAppSettings(),
  ]);
  const brandLogo = settings.logo_url || "";
  const visible = new Map(links.map((l) => [l.id, l]));

  const pinned = pinnedItems(pins, visible, brandLogo);
  const shown = new Set(pinned.map((p) => p.linkId).filter((id): id is number => id !== null));

  const featured: QuickLinkItem[] = [];
  for (const link of links) {
    if (!link.dashboard_featured || shown.has(link.id)) continue;
    featured.push(curatedItem(link, brandLogo));
    shown.add(link.id);
  }

  const mostUsed: QuickLinkItem[] = [];
  for (const r of mine) {
    if (mostUsed.length >= MOST_USED_LIMIT) break;
    const link = visible.get(r.link_id);
    if (!link || shown.has(link.id)) continue;
    mostUsed.push(curatedItem(link, brandLogo, { count: r.n }));
    shown.add(link.id);
  }
  let mostUsedIsWorkspace = false;
  // The workspace filler only when the viewer's own clicks leave room; it
  // is the same for everyone, so it is shared for a few minutes.
  const workspace = mostUsed.length < MOST_USED_LIMIT ? await workspaceRanking() : [];
  for (const r of workspace) {
    if (mostUsed.length >= MOST_USED_LIMIT) break;
    const link = visible.get(r.link_id);
    if (!link || shown.has(link.id)) continue;
    mostUsed.push(curatedItem(link, brandLogo));
    shown.add(link.id);
    mostUsedIsWorkspace = true;
  }

  return { pinned, featured, mostUsed, mostUsedIsWorkspace };
}

/** Every curated link the viewer can see, by position: the Add dialog's list. */
export async function listPinnableLinks(user: SessionUser): Promise<QuickLinkItem[]> {
  const [links, settings] = await Promise.all([visibleLinks(user), getAppSettings()]);
  const brandLogo = settings.logo_url || "";
  return links.map((l) => curatedItem(l, brandLogo));
}

/**
 * The sign-in page's links (public: the page renders before anyone signs
 * in). Only flagged, unrestricted links, at most eight, by position. The
 * icon route serves these links' icons without a session.
 */
export async function listSignInLinks(): Promise<
  { id: number; title: string; url: string; host: string; iconUrl: string | null; letter: string }[]
> {
  const [rows, settings] = await Promise.all([
    listSignInLinkRows(MAX_SIGNIN_LINKS),
    getAppSettings(),
  ]);
  const brandLogo = settings.logo_url || "";
  return rows.map((l) => ({
    id: l.id,
    title: l.title,
    url: l.url,
    host: linkHost(l.url),
    iconUrl: iconFor(l, brandLogo),
    letter: linkLetter(l.title),
  }));
}

/**
 * An own link's address: http(s) only, at most 2000 characters, normalised
 * by URL. Returns null for anything else (javascript:, mailto:, relative).
 */
export function validOwnLinkUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    const out = u.toString();
    return out.length > 2000 ? null : out;
  } catch {
    return null;
  }
}
