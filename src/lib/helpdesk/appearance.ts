import "server-only";

// Helpdesk 1.19.4: the desk's background artwork, the server (mock-ups t1
// to t5; client-safe parts in appearance-shared, the readability rule in
// appearance-contrast, the image work in appearance-upload).
//
//   Workspace   settings key helpdesk_appearance: an artwork for light mode
//               and one for dark mode ("none", a built-in from
//               public/desk-art, or an upload from the library), the level
//               (Solid, Subtle, Glass) and "Let agents choose their own".
//               Desk settings → Appearance (settings.manage) writes it.
//   Library     hd_desk_art rows with no owner: uploads re-encoded to WebP
//               in the uploads volume, served by
//               /api/helpdesk/appearance/art/[id] to desk users only.
//               Removing one in use sets that mode back to none.
//   Agents      hd_desk_look: workspace / own / none and their own level,
//               honoured only while the workspace lets agents choose. Their
//               own upload is an hd_desk_art row they own, served to them
//               alone; a new one replaces it. It is personal data: account
//               removal deletes it (retention's anonymiseRemovedAccountTx
//               calls removeOwnArtTx, the files go after the commit) and
//               the personal data export lists it with the picture.
//
// Every write is audited by its route (helpdesk.appearance.*).

import { getSetting, withAdvisoryLock, type Queryable } from "../db";
import { deleteUpload, saveUpload, uploadExists, uploadReadStream } from "../uploads";
import { hq, hqOne } from "./db-core";
import {
  DeskArtError,
  isArtId,
  HD_APPEARANCE_DEFAULTS,
  HD_ART_LIBRARY_MAX,
  HD_ART_WIDTHS,
  HD_DESK_BUILTINS,
  builtinView,
  isDeskBgChoice,
  isDeskLevel,
  parseArtRef,
  resolveDeskLook,
  type HdAppearanceAdminView,
  type HdAppearanceSettings,
  type HdArtRef,
  type HdArtView,
  type HdArtWidth,
  type HdDeskBgChoice,
  type HdDeskLevel,
  type HdDeskLook,
  type HdMyDeskView,
} from "./appearance-shared";

export * from "./appearance-shared";

/** sharp loads only when a picture is uploaded, not with the desk's layout. */
async function processDeskArt(input: Buffer) {
  return (await import("./appearance-upload")).processDeskArt(input);
}

export const HD_APPEARANCE_KEY = "helpdesk_appearance";
/** Library uploads and removals take turns under this lock (the limit and the settings' fallback). */
const LOCK = "hd_desk_art";
/** One person's own artwork: storeOwnArt, removeOwnArt and account removal (removeOwnArtTx) take turns under it. */
const ownLock = (userId: number) => `${LOCK}:own:${userId}`;

interface ArtRow {
  id: number;
  owner_user_id: number | null;
  label: string;
  files: Record<string, string>;
  width: number;
  height: number;
  tint: string;
  need_light: number;
  need_dark: number;
  created_by_name: string;
  created_at: string;
}

const ART_COLS = "id, owner_user_id, label, files, width, height, tint, need_light, need_dark, created_by_name, created_at";

/** The address of one stored width (rows never change, so the id is the version). */
export function artUrl(id: number, w: HdArtWidth): string {
  return `/api/helpdesk/appearance/art/${id}?w=${w}`;
}

function viewOf(r: ArtRow): HdArtView {
  return {
    ref: `upload:${r.id}`,
    label: r.label || "Uploaded artwork",
    builtin: false,
    thumb: artUrl(r.id, 480),
    src: artUrl(r.id, 1920),
    srcset: HD_ART_WIDTHS.filter((w) => w !== 480).map((w) => ({ w, url: artUrl(r.id, w) })),
    tint: /^#[0-9a-f]{6}$/.test(r.tint) ? r.tint : "#64748b",
    need: { light: Number(r.need_light), dark: Number(r.need_dark) },
    width: r.width,
    height: r.height,
    created_at: r.created_at,
    created_by_name: r.created_by_name,
  };
}

/** A label from a file name: no extension, plain words, 60 characters at most. */
export function artLabel(filename: unknown): string {
  const base = String(filename ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return base || "Uploaded artwork";
}

// --- Workspace settings --------------------------------------------------------------

/** Fill and check: what every read returns and every write stores. Never throws. */
export function normalizeAppearance(raw: unknown): HdAppearanceSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ref = (x: unknown): HdArtRef => {
    const p = parseArtRef(x);
    if (!p || p.kind === "none") return "none";
    return p.kind === "builtin" ? `builtin:${p.art.key}` : `upload:${p.id}`;
  };
  return {
    light: ref(v.light),
    dark: ref(v.dark),
    level: isDeskLevel(v.level) ? v.level : HD_APPEARANCE_DEFAULTS.level,
    agents_choose: typeof v.agents_choose === "boolean" ? v.agents_choose : HD_APPEARANCE_DEFAULTS.agents_choose,
  };
}

export async function getAppearanceSettings(client?: Queryable): Promise<HdAppearanceSettings> {
  let raw: string | undefined;
  if (client) raw = (await client.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [HD_APPEARANCE_KEY])).rows[0]?.value;
  else raw = await getSetting(HD_APPEARANCE_KEY);
  try {
    return normalizeAppearance(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...HD_APPEARANCE_DEFAULTS };
  }
}

/**
 * Save the workspace's choice. A reference must be a built-in or a library
 * upload that exists (400 otherwise). Answers the stored value and the
 * names of the fields that changed.
 */
export async function saveAppearanceSettings(body: Record<string, unknown>): Promise<{ settings: HdAppearanceSettings; changed: (keyof HdAppearanceSettings)[] }> {
  return withAdvisoryLock(LOCK, async (client) => {
    const before = await getAppearanceSettings(client);
    const next: HdAppearanceSettings = { ...before };
    for (const k of ["light", "dark"] as const) {
      if (!(k in body)) continue;
      const p = parseArtRef(body[k]);
      if (!p) throw new DeskArtError(`Choose an artwork for ${k} mode from the list.`, 400);
      if (p.kind === "upload") {
        const row = await client.query("SELECT 1 FROM hd_desk_art WHERE id = $1 AND owner_user_id IS NULL", [p.id]);
        if (!row.rowCount) throw new DeskArtError("That artwork has been removed. Choose another.", 400);
        next[k] = `upload:${p.id}`;
      } else next[k] = p.kind === "builtin" ? `builtin:${p.art.key}` : "none";
    }
    if ("level" in body) {
      if (!isDeskLevel(body.level)) throw new DeskArtError("Transparency is Solid, Subtle or Glass.", 400);
      next.level = body.level;
    }
    if ("agents_choose" in body) {
      if (typeof body.agents_choose !== "boolean") throw new DeskArtError("“Let agents choose their own” is on or off.", 400);
      next.agents_choose = body.agents_choose;
    }
    const changed = (Object.keys(next) as (keyof HdAppearanceSettings)[]).filter((k) => next[k] !== before[k]);
    if (changed.length) {
      await client.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [HD_APPEARANCE_KEY, JSON.stringify(next)]
      );
    }
    return { settings: next, changed };
  });
}

// --- The library ---------------------------------------------------------------------

async function workspaceUploads(): Promise<ArtRow[]> {
  return hq<ArtRow>(`SELECT ${ART_COLS} FROM hd_desk_art WHERE owner_user_id IS NULL ORDER BY created_at DESC, id DESC`);
}

/** Built-ins and workspace uploads, as the admin page and the agent's panel list them. */
export async function appearanceAdminView(): Promise<HdAppearanceAdminView> {
  const [settings, uploads] = await Promise.all([getAppearanceSettings(), workspaceUploads()]);
  return { settings, library: [...uploads.map(viewOf), ...HD_DESK_BUILTINS.map(builtinView)], uploads: uploads.length };
}

/** The artwork a reference names, or null ("none", or an upload since removed). */
async function artFor(ref: HdArtRef, uploads?: Map<number, ArtRow>): Promise<HdArtView | null> {
  const p = parseArtRef(ref);
  if (!p || p.kind === "none") return null;
  if (p.kind === "builtin") return builtinView(p.art);
  const row = uploads?.get(p.id) ?? (await hqOne<ArtRow>(`SELECT ${ART_COLS} FROM hd_desk_art WHERE id = $1 AND owner_user_id IS NULL`, [p.id]));
  return row ? viewOf(row) : null;
}

async function saveFiles(files: { width: HdArtWidth; buf: Buffer }[]): Promise<Record<string, string>> {
  // One failed write (a full volume) takes the copies that did land with it.
  const settled = await Promise.allSettled(files.map((f) => saveUpload(f.buf, ".webp")));
  const names = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) {
    await Promise.all(names.map((n) => deleteUpload(n)));
    throw failed.reason;
  }
  return Object.fromEntries(files.map((f, i) => [String(f.width), names[i]]));
}

async function dropFiles(files: Record<string, string> | null | undefined): Promise<void> {
  for (const n of Object.values(files ?? {})) if (typeof n === "string") await deleteUpload(n);
}

/** Add an upload to the workspace library. Throws DeskArtError with a sentence for the admin. */
export async function storeWorkspaceArt(input: Buffer, filename: unknown, by: { id: number; name: string }): Promise<HdArtView> {
  const art = await processDeskArt(input);
  const files = await saveFiles(art.files);
  try {
    const row = await withAdvisoryLock(LOCK, async (client) => {
      const n = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM hd_desk_art WHERE owner_user_id IS NULL");
      if (Number(n.rows[0]?.n ?? 0) >= HD_ART_LIBRARY_MAX) {
        throw new DeskArtError(`The library holds up to ${HD_ART_LIBRARY_MAX} artworks. Remove one first.`, 409);
      }
      const r = await client.query(
        `INSERT INTO hd_desk_art (owner_user_id, label, files, width, height, tint, need_light, need_dark, created_by, created_by_name)
         VALUES (NULL, $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9) RETURNING ${ART_COLS}`,
        [artLabel(filename), JSON.stringify(files), art.width, art.height, art.tint, art.need.light, art.need.dark, by.id, by.name]
      );
      return r.rows[0] as ArtRow;
    });
    return viewOf({ ...row, created_at: new Date(row.created_at).toISOString() });
  } catch (e) {
    await dropFiles(files);
    throw e;
  }
}

/**
 * Remove a library upload and its files. A mode that showed it goes back to
 * none. Answers its label and the modes that changed, or null when it was
 * not in the library.
 */
export async function removeWorkspaceArt(id: number): Promise<{ label: string; cleared: ("light" | "dark")[] } | null> {
  if (!isArtId(id)) return null;
  const out = await withAdvisoryLock(LOCK, async (client) => {
    const r = await client.query<{ label: string; files: Record<string, string> }>(
      "DELETE FROM hd_desk_art WHERE id = $1 AND owner_user_id IS NULL RETURNING label, files",
      [id]
    );
    if (!r.rowCount) return null;
    const s = await getAppearanceSettings(client);
    const cleared = (["light", "dark"] as const).filter((k) => s[k] === `upload:${id}`);
    if (cleared.length) {
      for (const k of cleared) s[k] = "none";
      await client.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [HD_APPEARANCE_KEY, JSON.stringify(s)]);
    }
    return { label: r.rows[0].label, files: r.rows[0].files, cleared };
  });
  if (!out) return null;
  // Only after the commit: a rolled-back delete leaves them named.
  await dropFiles(out.files);
  return { label: out.label, cleared: out.cleared };
}

// --- One agent's own background ------------------------------------------------------

interface LookRow {
  choice: string;
  level: string;
}

async function ownRow(userId: number): Promise<ArtRow | undefined> {
  return hqOne<ArtRow>(`SELECT ${ART_COLS} FROM hd_desk_art WHERE owner_user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]);
}

async function lookRow(userId: number): Promise<{ choice: HdDeskBgChoice; level: HdDeskLevel | null }> {
  const r = await hqOne<LookRow>("SELECT choice, level FROM hd_desk_look WHERE user_id = $1", [userId]);
  return { choice: isDeskBgChoice(r?.choice) ? r.choice : "workspace", level: isDeskLevel(r?.level) ? r.level : null };
}

/** The look for a person: the workspace's, or (while agents may choose) their own choice. */
async function lookFor(userId: number, s: HdAppearanceSettings): Promise<{ look: HdDeskLook | null; mine: Awaited<ReturnType<typeof lookRow>>; own: ArtRow | undefined; ws: { light: HdArtView | null; dark: HdArtView | null } }> {
  const [mine, own, light, dark] = await Promise.all([lookRow(userId), ownRow(userId), artFor(s.light), artFor(s.dark)]);
  const ws = { light, dark };
  if (!s.agents_choose) return { look: resolveDeskLook(light, dark, s.level), mine, own, ws };
  const level = mine.level ?? s.level;
  if (mine.choice === "none") return { look: null, mine, own, ws };
  if (mine.choice === "own" && own) {
    const v = viewOf(own);
    return { look: resolveDeskLook(v, v, level), mine, own, ws };
  }
  return { look: resolveDeskLook(light, dark, level), mine, own, ws };
}

/** What the desk's layout needs: the look, and whether the user menu offers "Desk background". */
export async function deskLookFor(userId: number): Promise<{ look: HdDeskLook | null; menu: boolean }> {
  try {
    const s = await getAppearanceSettings();
    const r = await lookFor(userId, s);
    return { look: r.look, menu: s.agents_choose || !!r.own };
  } catch {
    // Before the boot schema has run: the plain desk.
    return { look: null, menu: false };
  }
}

/** "My desk background". */
export async function myDeskView(userId: number): Promise<HdMyDeskView> {
  const s = await getAppearanceSettings();
  const r = await lookFor(userId, s);
  return {
    allowed: s.agents_choose,
    choice: r.mine.choice === "own" && !r.own ? "workspace" : r.mine.choice,
    level: r.mine.level,
    workspace: { light: r.ws.light?.label ?? null, dark: r.ws.dark?.label ?? null, level: s.level },
    own: r.own ? viewOf(r.own) : null,
    look: r.look,
  };
}

/** Store an agent's choice ("own" needs their upload). 403 while agents may not choose. */
export async function saveMyDesk(userId: number, body: Record<string, unknown>): Promise<{ view: HdMyDeskView; changed: string[] }> {
  const s = await getAppearanceSettings();
  if (!s.agents_choose) throw new DeskArtError("Your admin has set the desk's background for everyone.", 403);
  const before = await lookRow(userId);
  const next = { ...before };
  if ("choice" in body) {
    if (!isDeskBgChoice(body.choice)) throw new DeskArtError("Choose the workspace artwork, your own, or none.", 400);
    if (body.choice === "own" && !(await ownRow(userId))) throw new DeskArtError("Upload your artwork first.", 400);
    next.choice = body.choice;
  }
  if ("level" in body) {
    if (body.level !== null && !isDeskLevel(body.level)) throw new DeskArtError("Transparency is Solid, Subtle or Glass.", 400);
    next.level = body.level as HdDeskLevel | null;
  }
  const changed = [...(next.choice !== before.choice ? ["choice"] : []), ...(next.level !== before.level ? ["level"] : [])];
  // Only the fields this request changed are written (review C5 finding 9): `before` is an
  // unlocked read, and an upload committing choice = 'own' meanwhile must not be reverted by a
  // level change sent while it ran.
  if (changed.includes("choice")) {
    await hq(
      `INSERT INTO hd_desk_look (user_id, choice, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`,
      [userId, next.choice]
    );
  }
  if (changed.includes("level")) {
    await hq(
      `INSERT INTO hd_desk_look (user_id, level, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
      [userId, next.level ?? ""]
    );
  }
  return { view: await myDeskView(userId), changed };
}

/** Store an agent's own artwork (replacing any earlier one) and choose it. */
export async function storeOwnArt(input: Buffer, filename: unknown, user: { id: number; name: string }): Promise<HdMyDeskView> {
  const s = await getAppearanceSettings();
  if (!s.agents_choose) throw new DeskArtError("Your admin has set the desk's background for everyone.", 403);
  const art = await processDeskArt(input);
  const files = await saveFiles(art.files);
  let old: Record<string, string>[] = [];
  try {
    old = await withAdvisoryLock(ownLock(user.id), async (client) => {
      const gone = await client.query<{ files: Record<string, string> }>("DELETE FROM hd_desk_art WHERE owner_user_id = $1 RETURNING files", [user.id]);
      await client.query(
        `INSERT INTO hd_desk_art (owner_user_id, label, files, width, height, tint, need_light, need_dark, created_by, created_by_name)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $1, $9)`,
        [user.id, artLabel(filename), JSON.stringify(files), art.width, art.height, art.tint, art.need.light, art.need.dark, user.name]
      );
      await client.query(
        `INSERT INTO hd_desk_look (user_id, choice, level, updated_at) VALUES ($1, 'own', '', now())
         ON CONFLICT (user_id) DO UPDATE SET choice = 'own', updated_at = now()`,
        [user.id]
      );
      return gone.rows.map((r) => r.files);
    });
  } catch (e) {
    await dropFiles(files);
    // The account was removed while the picture was being processed (users row gone: the FK refuses).
    if ((e as { code?: string })?.code === "23503") throw new DeskArtError("Your account no longer exists.", 410);
    throw e;
  }
  for (const f of old) await dropFiles(f);
  return myDeskView(user.id);
}

/** Remove an agent's own artwork; their choice goes back to the workspace's. False when they had none. */
export async function removeOwnArt(userId: number): Promise<boolean> {
  const files = await withAdvisoryLock(ownLock(userId), async (client) => {
    const gone = await client.query<{ files: Record<string, string> }>("DELETE FROM hd_desk_art WHERE owner_user_id = $1 RETURNING files", [userId]);
    await client.query("UPDATE hd_desk_look SET choice = 'workspace', updated_at = now() WHERE user_id = $1 AND choice = 'own'", [userId]);
    return gone.rows.map((r) => r.files);
  });
  for (const f of files) await dropFiles(f);
  return files.length > 0;
}

/**
 * Account removal (lib/helpdesk/retention anonymiseRemovedAccountTx, inside
 * lib/db deleteUser's transaction): the person's own artwork rows go now
 * (they would cascade anyway) and their stored files are returned, to be
 * deleted after the commit. Tolerates a database without the table.
 */
export async function removeOwnArtTx(client: Queryable, userId: number): Promise<string[]> {
  const exists = await client.query("SELECT to_regclass('hd_desk_art') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return [];
  // The lock storeOwnArt holds while it writes (review C5 findings 3 and 8): an upload already
  // writing finishes first and its row is deleted here; one that starts later waits for the
  // removal to commit, then finds the account gone (the FK refuses) and deletes its own files.
  // Held to the end of deleteUser's transaction.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownLock(userId)]);
  const r = await client.query<{ files: Record<string, string> }>("DELETE FROM hd_desk_art WHERE owner_user_id = $1 RETURNING files", [userId]);
  return r.rows.flatMap((row) => Object.values(row.files ?? {}).filter((n): n is string => typeof n === "string"));
}

/** The person's own desk background for their personal data export, with the picture (the 1920 copy) as a data URL. */
export async function deskArtForExport(userId: number): Promise<{
  choice: HdDeskBgChoice;
  level: HdDeskLevel | null;
  own_artwork: { label: string; width: number; height: number; uploaded_at: string; image: string | null } | null;
} | null> {
  try {
    const [mine, own, hasRow] = await Promise.all([
      lookRow(userId),
      ownRow(userId),
      hqOne<{ ok: number }>("SELECT 1 AS ok FROM hd_desk_look WHERE user_id = $1", [userId]),
    ]);
    if (!own && !hasRow) return null;
    let image: string | null = null;
    const name = own?.files?.["1920"];
    if (name && (await uploadExists(name))) {
      const stream = uploadReadStream(name);
      if (stream) {
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(c as Buffer);
        image = `data:image/webp;base64,${Buffer.concat(chunks).toString("base64")}`;
      }
    }
    return {
      choice: mine.choice,
      level: mine.level,
      own_artwork: own ? { label: own.label, width: own.width, height: own.height, uploaded_at: new Date(own.created_at).toISOString(), image } : null,
    };
  } catch {
    return null;
  }
}

// --- Serving ---------------------------------------------------------------------------

/**
 * The stored file for one artwork at a width (the smallest stored width at
 * least that wide, else the largest), if this viewer may see it: a library
 * upload, or their own. Null otherwise (the route answers 404 either way).
 */
export async function artFileFor(id: number, width: number, viewerId: number): Promise<{ file: string; own: boolean } | null> {
  if (!isArtId(id)) return null;
  const row = await hqOne<{ owner_user_id: number | null; files: Record<string, string> }>(
    "SELECT owner_user_id, files FROM hd_desk_art WHERE id = $1",
    [id]
  );
  if (!row || (row.owner_user_id !== null && row.owner_user_id !== viewerId)) return null;
  const w = HD_ART_WIDTHS.find((x) => x >= width) ?? HD_ART_WIDTHS[HD_ART_WIDTHS.length - 1];
  const file = row.files?.[String(w)];
  return file ? { file, own: row.owner_user_id !== null } : null;
}
