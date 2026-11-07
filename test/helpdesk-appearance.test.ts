// Helpdesk 1.19.4 (C5): the desk's background artwork (lib/helpdesk/appearance;
// mock-ups t1 to t5). Covered:
//
//   contrast   the built-ins (public/desk-art) re-measured from their SVGs: the
//              constants in appearance-shared match, and at the alphas the desk
//              paints (Glass and Subtle, light and dark) every ink keeps 4.5:1
//              on the scrim and on a panel, everywhere on the picture. The
//              ratios are printed (the report quotes them), with the approved
//              mock-ups' bare alphas beside them for comparison. desk-look.css
//              paints the inks the measurement assumes.
//   upload     JPG/PNG/WebP only (GIF, SVG, HTML refused by the bytes), 8 MB,
//              1920 × 1080 after the camera's rotation, a truncated file; the
//              output is WebP at four widths with no EXIF/GPS/XMP left
//   routes     Appearance (settings.manage only; references checked; audited),
//              the library (upload, limit, removal clears a mode and deletes the
//              files), the image route (desk users only; someone's own upload
//              only for them), "My desk background" (choice, own upload replaces
//              the old one and its files, level; refused while agents may not
//              choose, removal still allowed), the layout's look
//   privacy    account removal deletes the person's own artwork files; the
//              personal data export carries it as a data URL
//
// Parallel-safe: people and uploads are this file's own (STAMP); the uploads
// volume is a temp dir. The workspace's appearance setting is changed under an
// advisory lock and restored.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-appearance.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "pg";
import sharp from "sharp";
import { pool, getSetting, createSession, deleteUser } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-appearance.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-appearance.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const contrastMod = require("../src/lib/helpdesk/appearance-contrast") as typeof import("../src/lib/helpdesk/appearance-contrast");
const shared = require("../src/lib/helpdesk/appearance-shared") as typeof import("../src/lib/helpdesk/appearance-shared");
const appearance = require("../src/lib/helpdesk/appearance") as typeof import("../src/lib/helpdesk/appearance");
const upload = require("../src/lib/helpdesk/appearance-upload") as typeof import("../src/lib/helpdesk/appearance-upload");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const adminRoute = require("../src/app/api/helpdesk/admin/appearance/route") as typeof import("../src/app/api/helpdesk/admin/appearance/route");
const adminArtRoute = require("../src/app/api/helpdesk/admin/appearance/art/route") as typeof import("../src/app/api/helpdesk/admin/appearance/art/route");
const adminArtIdRoute = require("../src/app/api/helpdesk/admin/appearance/art/[id]/route") as typeof import("../src/app/api/helpdesk/admin/appearance/art/[id]/route");
const imageRoute = require("../src/app/api/helpdesk/appearance/art/[id]/route") as typeof import("../src/app/api/helpdesk/appearance/art/[id]/route");
const meRoute = require("../src/app/api/helpdesk/me/appearance/route") as typeof import("../src/app/api/helpdesk/me/appearance/route");
const meArtRoute = require("../src/app/api/helpdesk/me/appearance/art/route") as typeof import("../src/app/api/helpdesk/me/appearance/art/route");
const exportRoute = require("../src/app/api/admin/users/[id]/personal-data/route") as typeof import("../src/app/api/admin/users/[id]/personal-data/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; buf: Buffer; type: string; cache: string; etag: string; retry: string }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const buf = Buffer.from(await res.arrayBuffer());
    let body: any = null;
    try {
      body = JSON.parse(buf.toString("utf8"));
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, buf, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", etag: res.headers.get("etag") ?? "", retry: res.headers.get("retry-after") ?? "" };
  } finally {
    currentRequest = null;
  }
}

function json(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "PUT"): Request {
  return new Request(`http://localhost/api${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A multipart upload as a browser sends it (with its Content-Length). */
async function multipart(url: string, session: string, file: Buffer, name: string, type = "image/jpeg"): Promise<Request> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], name, { type }));
  const res = new Response(form);
  const body = Buffer.from(await res.arrayBuffer());
  return new Request(`http://localhost/api${url}`, {
    method: "POST",
    headers: { cookie: `compass_session=${session}`, "content-type": res.headers.get("content-type")!, "content-length": String(body.length), host: "localhost" },
    body,
  });
}

const STAMP = `hdap-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
let lock: Client;
let savedSetting: string | undefined;
let uploadDirectory = "";

async function personRow(key: string, deskRole: string | null, role = "viewer") {
  const name = `${key} ${STAMP}`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [`${STAMP}-${key}`, name, `${STAMP}-${key}@example.test`, role]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name };
}

/** A photo-like test picture: a gradient, so the probe has something to measure. */
async function picture(width: number, height: number, format: "jpeg" | "png" | "webp" | "gif" = "jpeg", opts: { exif?: boolean; orientation?: number } = {}): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  let img = sharp(Buffer.from(svg));
  if (opts.exif) img = img.withExif({ IFD0: { Make: "CompassCam", Model: STAMP, ImageDescription: "secret place" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.toFormat(format).toBuffer();
}

const filesOf = async (id: number) => Object.values(((await pool().query("SELECT files FROM hd_desk_art WHERE id = $1", [id])).rows[0]?.files ?? {}) as Record<string, string>);
const onDisk = (name: string) => existsSync(path.join(uploadDirectory, name));
const auditRows = async (action: string) => (await pool().query("SELECT actor_id, target_id, details FROM audit_log WHERE action = $1 AND actor_id = ANY($2) ORDER BY id", [action, userIds])).rows;

before(async () => {
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-desk-art-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  // One writer of the workspace's appearance at a time; restored in after().
  lock = new Client({ connectionString: DB });
  await lock.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('helpdesk_appearance_settings_test'))");
  savedSetting = (await pool().query("SELECT value FROM settings WHERE key = 'helpdesk_appearance'")).rows[0]?.value;
  await pool().query("DELETE FROM settings WHERE key = 'helpdesk_appearance'");
  await personRow("admin", "admin");
  await personRow("agent", "agent");
  await personRow("other", "agent");
  await personRow("req", null);
  await personRow("wsadmin", null, "admin");
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  const own = await pool().query("SELECT id FROM hd_desk_art WHERE created_by = ANY($1) OR owner_user_id = ANY($1)", [userIds]);
  for (const r of own.rows) await pool().query("DELETE FROM hd_desk_art WHERE id = $1", [r.id]);
  if (savedSetting === undefined) await pool().query("DELETE FROM settings WHERE key = 'helpdesk_appearance'");
  else await pool().query("INSERT INTO settings (key, value) VALUES ('helpdesk_appearance', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [savedSetting]);
  await lock.query("SELECT pg_advisory_unlock(hashtext('helpdesk_appearance_settings_test'))");
  await lock.end();
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_id = ANY($2::text[])", [userIds, userIds.map(String)]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Contrast -----------------------------------------------------------------------------------

describe("readability on the built-in artworks", () => {
  const PUBLIC = path.join(__dirname, "..", "public");
  // The desk's ordinary inks (globals.css), before desk-look.css strengthens them over artwork.
  const PLAIN_INKS: Record<"light" | "dark", [number, number, number][]> = {
    light: [[90, 105, 128], [46, 117, 189], [220, 38, 38], [180, 83, 9], [4, 120, 87]],
    dark: [[148, 161, 181], [130, 180, 224], [248, 113, 113], [252, 211, 77], [110, 231, 183]],
  };

  test("the built-ins' needs and tints match what their SVGs measure", async () => {
    for (const art of shared.HD_DESK_BUILTINS) {
      const svg = readFileSync(path.join(PUBLIC, art.src));
      const need = await upload.deskArtNeed(svg);
      assert.equal(art.need.light, need.light, `${art.label} light`);
      assert.equal(art.need.dark, need.dark, `${art.label} dark`);
      assert.match(art.tint, /^#[0-9a-f]{6}$/);
      assert.ok(!/<script|on\w+=|href=/i.test(svg.toString("utf8")), `${art.label}: a plain picture, no script or links`);
    }
  });

  test("every ink keeps 4.5:1 on the scrim and on a panel, Glass and Subtle, light and dark (ratios printed)", async () => {
    const rows: string[] = [];
    for (const art of shared.HD_DESK_BUILTINS) {
      const cells = contrastMod.probeCells(await upload.deskArtProbe(readFileSync(path.join(PUBLIC, art.src))));
      for (const theme of ["light", "dark"] as const) {
        for (const level of ["glass", "subtle"] as const) {
          const a = contrastMod.deskAlphas(art.need[theme], level);
          const scrim = contrastMod.worstRatio(cells, theme, a.scrim);
          const panel = contrastMod.worstRatio(cells, theme, a.composite);
          const body = contrastMod.worstRatio(cells, theme, a.scrim, [contrastMod.HD_DESK_BODY_INK[theme]]);
          const base = contrastMod.HD_DESK_LEVEL_ALPHA[level];
          // The mock-ups as drawn: the bare level alpha and the desk's ordinary inks.
          const mockScrim = contrastMod.worstRatio(cells, theme, base.scrim, PLAIN_INKS[theme]);
          rows.push(
            `${art.label.padEnd(12)} ${theme.padEnd(5)} ${level.padEnd(6)} scrim ${a.scrim.toFixed(3)} panel ${a.composite.toFixed(3)} | weakest ink ${scrim.toFixed(2)} on scrim, ${panel.toFixed(2)} on panel, body ${body.toFixed(2)} | mock as drawn (${base.scrim}, plain inks): ${mockScrim.toFixed(2)}`
          );
          assert.ok(scrim >= contrastMod.HD_DESK_AA, `${art.label} ${theme} ${level}: ${scrim.toFixed(2)} on the scrim`);
          assert.ok(panel >= contrastMod.HD_DESK_AA, `${art.label} ${theme} ${level}: ${panel.toFixed(2)} on a panel`);
        }
      }
    }
    console.log(`\n${rows.join("\n")}\n`);
  });

  test("a thin bright line counts at full strength (review C5 finding 6): navy with 50px white bands", async () => {
    const w = 2560;
    const h = 1440;
    const bands = Array.from({ length: 6 }, (_, i) => `<rect x="0" y="${120 + i * 220}" width="${w}" height="50" fill="#ffffff"/>`).join("");
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#141e46"/>${bands}</svg>`);
    const png = await sharp(svg).png().toBuffer();
    const need = await upload.deskArtNeed(png);
    // An average over a cell (the first probe) put the dark scrim near 0.55, where the band reads at
    // about 2:1; a white pixel needs 0.79 for the weakest dark-mode ink to keep 4.5:1.
    assert.ok(need.dark >= 0.78, `dark need ${need.dark}`);
    // At that scrim, the band's middle as painted (blurred σ 8) keeps 4.5:1 for every dark-mode ink.
    const { data } = await sharp(png).blur(8).raw().toBuffer({ resolveWithObject: true });
    const mid = (120 + 25) * w * 3 + (w / 2) * 3;
    const band: [number, number, number] = [data[mid], data[mid + 1], data[mid + 2]];
    assert.ok(contrastMod.worstRatio([band], "dark", contrastMod.deskAlphas(need.dark, "glass").scrim) >= contrastMod.HD_DESK_AA);
    // Light mode on the navy between the bands is measured as well.
    assert.ok(need.light >= 0.75, `light need ${need.light}`);
  });

  test("the level bases are the approved mock-ups' (.38 / .6 scrim; panels compose to .6 / .84)", () => {
    const g = contrastMod.deskAlphas(0, "glass");
    const s = contrastMod.deskAlphas(0, "subtle");
    assert.equal(g.scrim, 0.38);
    assert.ok(Math.abs(g.composite - 0.6) < 0.002, String(g.composite));
    assert.equal(s.scrim, 0.6);
    assert.ok(Math.abs(s.composite - 0.84) < 0.002, String(s.composite));
    // A stronger need raises the scrim and never lowers the panel.
    const hi = contrastMod.deskAlphas(0.8, "glass");
    assert.equal(hi.scrim, 0.8);
    assert.ok(hi.composite > hi.scrim);
    assert.equal(contrastMod.deskAlphas(Number.NaN, "glass").scrim, 1);
  });

  test("desk-look.css paints the inks the measurement assumes, only under .desk-art, screen only", () => {
    const css = readFileSync(path.join(__dirname, "..", "src", "components", "helpdesk", "desk", "appearance", "desk-look.css"), "utf8");
    for (const rgb of ["71 85 105", "153 27 27", "146 64 14", "6 95 70", "176 187 204", "252 165 165"]) assert.ok(css.includes(rgb), rgb);
    const inks = contrastMod.HD_DESK_INKS;
    assert.deepEqual(inks.light["secondary (slate-600)"], [71, 85, 105]);
    assert.deepEqual(inks.dark["secondary (slate-600)"], [176, 187, 204]);
    assert.ok(/color-mix\(in srgb, rgb\(var\(--compass-ink-strong\)\) 70%, white\)/.test(css), "dark accent ink lifted by 30% white");
    // The top bar sits above every in-page layer (popovers 30, the pinned Save row 20) and under modals and toasts (50, outside the root).
    assert.match(css, /> header\.bg-surface \{\s*position: relative;\s*z-index: 40;/);
    assert.match(css, /isolation: isolate/);
    // Every rule that paints is inside @media screen and hangs off .desk-art.
    const screen = css.slice(css.indexOf("@media screen"));
    const body = screen.slice(0, screen.indexOf("@keyframes"));
    for (const sel of body.match(/^\s{2}[^\s@}][^{]*\{/gm) ?? []) assert.ok(sel.includes(".desk-art"), sel.trim());
    // No bare var() colour: every colour token is wrapped (CLAUDE.md).
    assert.ok(!/(?<!rgb\()var\(--(slate|compass|surface)-?[a-z0-9-]*\)(?!\s*\/)/.test(css.replace(/rgb\(var\(--[a-z0-9-]+\)( \/ [^)]+)?\)/g, "")), "bare var()");
  });

  test("resolveDeskLook: Solid or nothing is the plain desk; each mode gets its own scrim", () => {
    const ridge = shared.builtinView(shared.HD_DESK_BUILTINS.find((a) => a.key === "night-ridge")!);
    const aurora = shared.builtinView(shared.HD_DESK_BUILTINS.find((a) => a.key === "aurora")!);
    assert.equal(shared.resolveDeskLook(aurora, ridge, "solid"), null);
    assert.equal(shared.resolveDeskLook(null, null, "glass"), null);
    const look = shared.resolveDeskLook(aurora, ridge, "glass")!;
    assert.equal(look.light!.scrim, aurora.need.light);
    assert.equal(look.dark!.scrim, ridge.need.dark);
    assert.equal(shared.resolveDeskLook(aurora, null, "subtle")!.dark, null);
    assert.match(shared.heavyScrimNote(ridge, "light", "glass") ?? "", /covers Night ridge 80%/);
    assert.equal(shared.heavyScrimNote(ridge, "dark", "glass"), null, "its own mode: a little over the base, no note");
    assert.equal(shared.heavyScrimNote(aurora, "light", "glass"), null);
    assert.equal(shared.workspaceArtLine("Fernwood brand", "Night ridge"), "Fernwood brand · Night ridge in dark mode");
  });
});

// --- The upload -----------------------------------------------------------------------------------

describe("processing an upload", () => {
  test("two pictures at a time per process: a third is told the server is busy (503, Retry-After), and nothing is decoded", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const a = upload.withDeskArtSlot(() => held);
    const b = upload.withDeskArtSlot(() => held);
    try {
      await assert.rejects(upload.processDeskArt(await picture(1920, 1080)), (e: unknown) => e instanceof upload.DeskArtError && e.status === 503 && /busy/.test(e.message));
      // Through the route: 503 with Retry-After (agents_choose is off here, so the admin library route).
      const r = await call(adminArtRoute.POST, await multipart("/helpdesk/admin/appearance/art", P.admin.session, await picture(1920, 1080), "busy.jpg"));
      assert.equal(r.status, 503);
      assert.equal(r.retry, "30");
    } finally {
      release();
      await Promise.all([a, b]);
    }
    // Free again.
    assert.equal((await upload.processDeskArt(await picture(1920, 1080))).width, 1920);
  });

  test("the pixel cap is sharp's own limit too, and every copy comes from one 2560-wide decode", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "lib", "helpdesk", "appearance-upload.ts"), "utf8");
    assert.ok(!/limitInputPixels:\s*false/.test(src), "no unlimited decode");
    assert.equal((src.match(/limitInputPixels: HD_ART_MAX_PIXELS/g) ?? []).length, 2);
    // processDeskArt decodes the upload once (src…raw()), then works only on the master.
    const body = src.slice(src.indexOf("export async function processDeskArt"));
    assert.equal((body.match(/\bsrc\b\s*\n?\s*\.rotate\(\)/g) ?? []).length, 1);
    assert.ok(!/\bbase\.clone\(\)/.test(body));
  });

  test("re-encodes to WebP at four widths with no metadata left (EXIF, GPS)", async () => {
    const input = await picture(2400, 1350, "jpeg", { exif: true });
    assert.ok((await sharp(input).metadata()).exif, "the input carries EXIF");
    const out = await upload.processDeskArt(input);
    assert.deepEqual(out.files.map((f) => f.width), [480, 1280, 1920, 2560]);
    assert.equal(out.width, 2400);
    assert.equal(out.height, 1350);
    for (const f of out.files) {
      const m = await sharp(f.buf).metadata();
      assert.equal(m.format, "webp");
      assert.equal(m.exif, undefined, "no EXIF");
      assert.equal(m.xmp, undefined, "no XMP");
      assert.equal(m.iptc, undefined, "no IPTC");
      assert.ok(!f.buf.includes(Buffer.from(STAMP)), "the camera's text is gone");
      assert.ok(!f.buf.includes(Buffer.from("secret place")));
      assert.equal(m.width, Math.min(f.width, 2400));
    }
    assert.match(out.tint, /^#[0-9a-f]{6}$/);
    assert.ok(out.need.light >= 0 && out.need.light <= 1 && out.need.dark >= 0 && out.need.dark <= 1);
  });

  test("the camera's rotation counts: a sideways 1080 × 1920 photo shown as 1920 × 1080 is accepted", async () => {
    const out = await upload.processDeskArt(await picture(1080, 1920, "jpeg", { orientation: 6 }));
    assert.equal(out.width, 1920);
    assert.equal(out.height, 1080);
  });

  test("refusals: too small, wrong type by the bytes, too big, truncated, empty", async () => {
    const refuse = async (buf: Buffer, status: number, msg: RegExp) => {
      await assert.rejects(upload.processDeskArt(buf), (e: unknown) => e instanceof upload.DeskArtError && e.status === status && msg.test(e.message));
    };
    await refuse(await picture(1600, 900), 422, /1600 × 900 pixels\. Use one at least 1920 × 1080/);
    await refuse(await picture(1920, 1080, "gif"), 415, /JPG, PNG or WebP/);
    await refuse(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><script>alert(1)</script></svg>`), 415, /JPG, PNG or WebP/);
    await refuse(Buffer.from("<html><body>not a picture</body></html>"), 415, /JPG, PNG or WebP/);
    await refuse(Buffer.alloc(8 * 1024 * 1024 + 1, 0xff), 413, /8 MB/);
    const good = await picture(2000, 1200, "jpeg");
    await refuse(good.subarray(0, Math.floor(good.length / 2)), 422, /could not be read/);
    await refuse(Buffer.alloc(0), 400, /empty/);
    // Landscape only, at most 4:1 (the desk paints it with cover on a landscape screen).
    await refuse(await picture(1920, 2400), 422, /Use a landscape picture/);
    await refuse(await picture(8000, 1500), 422, /no more than four times as wide/);
    // PNG and WebP are accepted.
    assert.equal((await upload.processDeskArt(await picture(1920, 1080, "png"))).width, 1920);
    assert.equal((await upload.processDeskArt(await picture(1920, 1080, "webp"))).width, 1920);
  });
});

// --- Routes -----------------------------------------------------------------------------------------

describe("Desk settings → Appearance and My desk background", () => {
  let artId = 0;
  let artFiles: string[] = [];

  test("only settings.manage opens the page's routes; it starts as the plain desk", async () => {
    assert.equal((await call(adminRoute.GET, json("/helpdesk/admin/appearance", P.agent.session))).status, 403);
    assert.equal((await call(adminRoute.GET, json("/helpdesk/admin/appearance", P.req.session))).status, 403);
    const r = await call(adminRoute.GET, json("/helpdesk/admin/appearance", P.admin.session));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings, shared.HD_APPEARANCE_DEFAULTS);
    assert.deepEqual(
      r.body.library.filter((a: any) => a.builtin).map((a: any) => a.label),
      ["Aurora", "Night ridge", "Sunrise"]
    );
    // Off by default (review C5 finding 1): no menu row, no choices, no uploads until an admin allows them.
    assert.equal(shared.HD_APPEARANCE_DEFAULTS.agents_choose, false);
    assert.deepEqual(await appearance.deskLookFor(P.agent.id), { look: null, menu: false });
    assert.equal((await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { choice: "none" }))).status, 403);
    const early = await call(meArtRoute.POST, await multipart("/helpdesk/me/appearance/art", P.agent.session, await picture(1920, 1080), "x.jpg"));
    assert.equal(early.status, 403);
    assert.match(early.body.error, /admin has set/);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_desk_art WHERE owner_user_id = $1", [P.agent.id])).rows[0].n, 0);
  });

  test("upload to the library: stored re-encoded, audited; served to desk users only", async () => {
    const up = await call(adminArtRoute.POST, await multipart("/helpdesk/admin/appearance/art", P.admin.session, await picture(2400, 1350, "jpeg", { exif: true }), "Fernwood_brand.jpg"));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.art.label, "Fernwood brand");
    artId = Number(up.body.art.ref.slice("upload:".length));
    artFiles = await filesOf(artId);
    assert.equal(artFiles.length, 4);
    for (const f of artFiles) assert.ok(onDisk(f), f);
    assert.equal(up.body.view.library[0].ref, `upload:${artId}`, "newest upload first");
    assert.equal((await auditRows("helpdesk.appearance.art_uploaded")).length, 1);
    // Not by an agent.
    assert.equal((await call(adminArtRoute.POST, await multipart("/helpdesk/admin/appearance/art", P.agent.session, await picture(1920, 1080), "x.jpg"))).status, 403);
    // A refused picture says why.
    const small = await call(adminArtRoute.POST, await multipart("/helpdesk/admin/appearance/art", P.admin.session, await picture(1280, 720), "small.jpg"));
    assert.equal(small.status, 422);
    assert.match(small.body.error, /at least 1920 × 1080/);

    const img = await call(imageRoute.GET, json(`/helpdesk/appearance/art/${artId}?w=1920`, P.agent.session), { id: String(artId) });
    assert.equal(img.status, 200);
    assert.equal(img.type, "image/webp");
    assert.match(img.cache, /private/);
    assert.equal((await sharp(img.buf).metadata()).width, 1920);
    assert.equal((await sharp(img.buf).metadata()).exif, undefined);
    assert.equal((await call(imageRoute.GET, json(`/helpdesk/appearance/art/${artId}?w=300`, P.agent.session), { id: String(artId) })).status, 200);
    assert.equal((await call(imageRoute.GET, json(`/helpdesk/appearance/art/${artId}`, P.req.session), { id: String(artId) })).status, 403, "no desk access");
    const anon = new Request(`http://localhost/api/helpdesk/appearance/art/${artId}`);
    assert.equal((await call(imageRoute.GET, anon, { id: String(artId) })).status, 401);
    assert.equal((await call(imageRoute.GET, json("/helpdesk/appearance/art/999999999", P.agent.session), { id: "999999999" })).status, 404);
    // Past Postgres's integer range: the same 404, never a 500 (review C5 finding 4).
    for (const id of ["9999999999", "2147483648", "0", "-1", "12abc", "99999999999999999999"]) {
      assert.equal((await call(imageRoute.GET, json(`/helpdesk/appearance/art/${id}`, P.agent.session), { id })).status, 404, id);
    }
    assert.equal((await call(adminArtIdRoute.DELETE, json("/helpdesk/admin/appearance/art/9999999999", P.admin.session, undefined, "DELETE"), { id: "9999999999" })).status, 404);
    // A library picture never changes under its id: cached privately for good.
    assert.match(img.cache, /^private, max-age=31536000, immutable$/);
  });

  test("save: references checked, audited; the agents' desk shows it per mode", async () => {
    const bad = await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { light: "upload:999999999" }));
    assert.equal(bad.status, 400);
    for (const ref of ["upload:9999999999", "upload:2147483648"]) {
      assert.equal((await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { light: ref }))).status, 400, ref);
    }
    assert.equal((await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { light: "builtin:nope" }))).status, 400);
    assert.equal((await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { level: "frosted" }))).status, 400);
    assert.equal((await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.agent.session, { level: "glass" }))).status, 403);
    const ok = await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { light: `upload:${artId}`, dark: "builtin:night-ridge", level: "glass", agents_choose: true }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.settings, { light: `upload:${artId}`, dark: "builtin:night-ridge", level: "glass", agents_choose: true });
    const audits = await auditRows("helpdesk.appearance.changed");
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].details.changed, ["light", "dark", "agents_choose"]);
    // Saving the same again writes nothing.
    await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { level: "glass" }));
    assert.equal((await auditRows("helpdesk.appearance.changed")).length, 1);

    const { look } = await appearance.deskLookFor(P.agent.id);
    assert.equal(look?.level, "glass");
    assert.equal(look?.light?.label, "Fernwood brand");
    assert.equal(look?.light?.src, `/api/helpdesk/appearance/art/${artId}?w=1920`);
    assert.deepEqual(look?.light?.srcset?.map((s) => s.w), [1280, 1920, 2560]);
    assert.equal(look?.dark?.src, "/desk-art/night-ridge.svg");
    assert.equal(look?.dark?.scrim, 0.51);
    assert.equal(look?.panel, 0.355);
  });

  test("My desk background: workspace, own (replaces the old files), none, level; only they see their own", async () => {
    const v0 = await call(meRoute.GET, json("/helpdesk/me/appearance", P.agent.session));
    assert.equal(v0.status, 200);
    assert.equal(v0.body.allowed, true);
    assert.equal(v0.body.choice, "workspace");
    assert.deepEqual(v0.body.workspace, { light: "Fernwood brand", dark: "Night ridge", level: "glass" });
    assert.equal((await call(meRoute.GET, json("/helpdesk/me/appearance", P.req.session))).status, 403);
    assert.equal((await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { choice: "own" }))).status, 400, "no upload yet");

    const up1 = await call(meArtRoute.POST, await multipart("/helpdesk/me/appearance/art", P.agent.session, await picture(1920, 1080, "png"), "my-dog.png", "image/png"));
    assert.equal(up1.status, 201, JSON.stringify(up1.body));
    assert.equal(up1.body.choice, "own");
    assert.equal(up1.body.own.label, "my-dog");
    const id1 = Number(up1.body.own.ref.slice("upload:".length));
    const files1 = await filesOf(id1);
    assert.equal(up1.body.look.light.label, "my-dog");
    assert.equal(up1.body.look.dark.label, "my-dog", "their own shows in both modes");
    // Only they can fetch it: the same 404 as a missing one for anyone else, admins included.
    const mine = await call(imageRoute.GET, json(`/helpdesk/appearance/art/${id1}`, P.agent.session), { id: String(id1) });
    assert.equal(mine.status, 200);
    // Revalidated on every use, so the owner check always runs (review C5 finding 5): never a long immutable cache.
    assert.equal(mine.cache, "private, no-cache");
    assert.match(mine.etag, /^"[a-f0-9]{32}\.webp"$/);
    const again = (session: string) =>
      new Request(`http://localhost/api/helpdesk/appearance/art/${id1}`, { headers: { cookie: `compass_session=${session}`, "if-none-match": mine.etag, host: "localhost" } });
    assert.equal((await call(imageRoute.GET, again(P.agent.session), { id: String(id1) })).status, 304, "the owner revalidates cheaply");
    assert.equal((await call(imageRoute.GET, again(P.other.session), { id: String(id1) })).status, 404, "anyone else, even holding the validator, gets nothing");
    assert.equal((await call(imageRoute.GET, json(`/helpdesk/appearance/art/${id1}`, P.other.session), { id: String(id1) })).status, 404);
    assert.equal((await call(imageRoute.GET, json(`/helpdesk/appearance/art/${id1}`, P.admin.session), { id: String(id1) })).status, 404);
    // Nor can it be chosen as the workspace's.
    assert.equal((await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { light: `upload:${id1}` }))).status, 400);
    // Not in the library.
    assert.ok(!(await call(adminRoute.GET, json("/helpdesk/admin/appearance", P.admin.session))).body.library.some((a: any) => a.ref === `upload:${id1}`));

    // A second upload replaces the first and deletes its files.
    const up2 = await call(meArtRoute.POST, await multipart("/helpdesk/me/appearance/art", P.agent.session, await picture(2560, 1440), "beach.jpg"));
    assert.equal(up2.status, 201);
    const id2 = Number(up2.body.own.ref.slice("upload:".length));
    assert.notEqual(id2, id1);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_desk_art WHERE owner_user_id = $1", [P.agent.id])).rows[0].n, 1);
    for (const f of files1) assert.ok(!onDisk(f), `old file ${f} deleted`);

    const lvl = await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { level: "subtle" }));
    assert.equal(lvl.status, 200);
    assert.equal(lvl.body.look.level, "subtle");
    assert.equal((await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { level: "neon" }))).status, 400);
    const none = await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { choice: "none" }));
    assert.equal(none.body.look, null);
    assert.equal((await appearance.deskLookFor(P.agent.id)).look, null);
    const back = await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { choice: "own" }));
    assert.equal(back.body.look.light.label, "beach");
    const audits = await auditRows("helpdesk.appearance.my_background_changed");
    assert.ok(audits.length >= 3);
    assert.equal((await auditRows("helpdesk.appearance.my_art_uploaded")).length, 2);
    // Other agents still get the workspace's.
    assert.equal((await appearance.deskLookFor(P.other.id)).look?.light?.label, "Fernwood brand");
    // Cross-origin writes are refused.
    const evil = new Request("http://localhost/api/helpdesk/me/appearance", {
      method: "PUT",
      headers: { cookie: `compass_session=${P.agent.session}`, origin: "https://evil.example", host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ choice: "none" }),
    });
    assert.equal((await call(meRoute.PUT, evil)).status, 403);
  });

  test("a level change sent while an upload commits never reverts the choice (review C5 finding 9)", async () => {
    assert.equal((await call(meRoute.PUT, json("/helpdesk/me/appearance", P.other.session, { level: "subtle" }))).status, 200);
    const client = await pool().connect();
    let put: Promise<unknown> | null = null;
    try {
      await client.query("BEGIN");
      // What storeOwnArt does as it commits: choice 'own', the row locked until COMMIT.
      await client.query("UPDATE hd_desk_look SET choice = 'own' WHERE user_id = $1", [P.other.id]);
      // The level change reads the old choice ('workspace'), then waits for the row.
      put = appearance.saveMyDesk(P.other.id, { level: "glass" });
      await new Promise((r) => setTimeout(r, 400));
      await client.query("COMMIT");
      await put;
    } finally {
      client.release();
    }
    const row = (await pool().query("SELECT choice, level FROM hd_desk_look WHERE user_id = $1", [P.other.id])).rows[0];
    assert.deepEqual({ ...row }, { choice: "own", level: "glass" }, "only the level was written");
    await pool().query("UPDATE hd_desk_look SET choice = 'workspace', level = '' WHERE user_id = $1", [P.other.id]);
  });

  test("agents may not choose: everyone gets the workspace's; their choice is refused; removing their upload still works", async () => {
    await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { agents_choose: false }));
    const { look, menu } = await appearance.deskLookFor(P.agent.id);
    assert.equal(look?.light?.label, "Fernwood brand", "their own is not shown");
    assert.equal(look?.level, "glass", "nor their level");
    assert.equal(menu, true, "the menu stays while they have an upload, so they can remove it");
    assert.equal((await appearance.deskLookFor(P.other.id)).menu, false);
    assert.equal((await call(meRoute.PUT, json("/helpdesk/me/appearance", P.agent.session, { choice: "none" }))).status, 403);
    assert.equal((await call(meArtRoute.POST, await multipart("/helpdesk/me/appearance/art", P.agent.session, await picture(1920, 1080), "x.jpg"))).status, 403);
    const own = await pool().query("SELECT id FROM hd_desk_art WHERE owner_user_id = $1", [P.agent.id]);
    const files = await filesOf(own.rows[0].id);
    const gone = await call(meArtRoute.DELETE, json("/helpdesk/me/appearance/art", P.agent.session, undefined, "DELETE"));
    assert.equal(gone.status, 200);
    assert.equal(gone.body.own, null);
    for (const f of files) assert.ok(!onDisk(f));
    assert.equal((await auditRows("helpdesk.appearance.my_art_removed")).length, 1);
    await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { agents_choose: true }));
  });

  test("Solid is the plain desk", async () => {
    await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { level: "solid" }));
    assert.equal((await appearance.deskLookFor(P.other.id)).look, null);
    await call(adminRoute.PUT, json("/helpdesk/admin/appearance", P.admin.session, { level: "glass" }));
  });

  test("removing a library artwork in use: that mode goes back to none, the files go, audited", async () => {
    assert.equal((await call(adminArtIdRoute.DELETE, json(`/helpdesk/admin/appearance/art/${artId}`, P.agent.session, undefined, "DELETE"), { id: String(artId) })).status, 403);
    const r = await call(adminArtIdRoute.DELETE, json(`/helpdesk/admin/appearance/art/${artId}`, P.admin.session, undefined, "DELETE"), { id: String(artId) });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.light, "none");
    assert.equal(r.body.settings.dark, "builtin:night-ridge");
    for (const f of artFiles) assert.ok(!onDisk(f), `${f} deleted`);
    const a = await auditRows("helpdesk.appearance.art_removed");
    assert.deepEqual(a[0].details.cleared, ["light"]);
    assert.equal((await call(adminArtIdRoute.DELETE, json(`/helpdesk/admin/appearance/art/${artId}`, P.admin.session, undefined, "DELETE"), { id: String(artId) })).status, 404);
    const look = (await appearance.deskLookFor(P.other.id)).look;
    assert.equal(look?.light, null);
    assert.equal(look?.dark?.label, "Night ridge");
  });

  test("the library holds twelve", async () => {
    const before = (await pool().query("SELECT count(*)::int AS n FROM hd_desk_art WHERE owner_user_id IS NULL")).rows[0].n as number;
    const pic = await picture(1920, 1080);
    const mine: number[] = [];
    try {
      for (let i = before; i < shared.HD_ART_LIBRARY_MAX; i++) {
        const v = await appearance.storeWorkspaceArt(pic, `fill ${i}.jpg`, { id: P.admin.id, name: P.admin.name });
        mine.push(Number(v.ref.slice(7)));
      }
      await assert.rejects(appearance.storeWorkspaceArt(pic, "one too many.jpg", { id: P.admin.id, name: P.admin.name }), (e: unknown) => e instanceof upload.DeskArtError && e.status === 409);
      const webp = (await readdir(uploadDirectory)).filter((n) => n.endsWith(".webp"));
      assert.equal(webp.length, mine.length * 4, "a refused upload leaves no files");
    } finally {
      for (const id of mine) await appearance.removeWorkspaceArt(id);
    }
  });
});

// --- Privacy -----------------------------------------------------------------------------------------

describe("an agent's own artwork is personal data", () => {
  test("account removal and an own-art upload take turns: an upload that lands after it leaves no files (review C5 findings 3, 8)", async () => {
    await personRow("racer", "agent");
    const webp = async () => (await readdir(uploadDirectory)).filter((n) => n.endsWith(".webp"));
    const before = new Set(await webp());
    const client = await pool().connect();
    let settled = false;
    try {
      await client.query("BEGIN");
      // deleteUser's first step (retention anonymiseRemovedAccountTx): takes the person's own-art lock.
      assert.deepEqual(await appearance.removeOwnArtTx(client, P.racer.id), []);
      const up = appearance.storeOwnArt(await picture(1920, 1080), "late.jpg", { id: P.racer.id, name: P.racer.name });
      up.then(
        () => (settled = true),
        () => (settled = true)
      );
      // The picture is processed and its files written, then it waits on the lock.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(settled, false, "the upload waits for the removal to commit");
      await client.query("DELETE FROM users WHERE id = $1", [P.racer.id]);
      await client.query("COMMIT");
      await assert.rejects(up, (e: unknown) => e instanceof upload.DeskArtError && e.status === 410);
    } finally {
      client.release();
    }
    userIds.splice(userIds.indexOf(P.racer.id), 1);
    assert.deepEqual((await webp()).filter((n) => !before.has(n)), [], "the late upload's files were deleted");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_desk_art WHERE owner_user_id = $1", [P.racer.id])).rows[0].n, 0);
  });

  test("the personal data export carries it (with the picture); account removal deletes it and its files", async () => {
    await personRow("leaver", "agent");
    const up = await call(meArtRoute.POST, await multipart("/helpdesk/me/appearance/art", P.leaver.session, await picture(1920, 1080), "Holiday 2026.jpg"));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const id = Number(up.body.own.ref.slice(7));
    const files = await filesOf(id);

    const exp = await call(exportRoute.GET, json(`/admin/users/${P.leaver.id}/personal-data`, P.wsadmin.session), { id: String(P.leaver.id) });
    assert.equal(exp.status, 200, exp.buf.toString("utf8").slice(0, 200));
    const d = exp.body.desk_background;
    assert.equal(d.choice, "own");
    assert.equal(d.own_artwork.label, "Holiday 2026");
    assert.match(d.own_artwork.image, /^data:image\/webp;base64,/);
    const pic = Buffer.from(d.own_artwork.image.split(",")[1], "base64");
    assert.equal((await sharp(pic).metadata()).width, 1920);
    // Someone with nothing stored has no section.
    const none = await call(exportRoute.GET, json(`/admin/users/${P.wsadmin.id}/personal-data`, P.wsadmin.session), { id: String(P.wsadmin.id) });
    assert.equal(none.body.desk_background, undefined);

    assert.equal(await deleteUser(P.leaver.id), true);
    userIds.splice(userIds.indexOf(P.leaver.id), 1);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_desk_art WHERE id = $1", [id])).rows[0].n, 0);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_desk_look WHERE user_id = $1", [P.leaver.id])).rows[0].n, 0);
    for (const f of files) assert.ok(!onDisk(f), `${f} deleted with the account`);
  });
});
