import "server-only";

// The sign-in page's artwork (1.16.0): an image an admin uploads under
// Settings → Workspace → Sign-in page. Uploaded bytes are never served as
// they came: the type is read from the magic bytes (no SVG, nothing
// animated), and sharp re-encodes the first frame to WebP at three widths,
// which also drops the camera's metadata (GPS included). The files live in
// the uploads volume like the logo and are served before sign-in by
// /api/brand/artwork, each width under a URL that changes with every upload,
// so browsers may cache them for good. A tiny blurred copy and the image's
// average colour are kept in settings, so the page paints something of the
// picture at once while the real one loads.

import sharp from "sharp";
import { getSetting, setSetting } from "./db";
import { deleteUpload, saveUpload, sniffImage, uploadExists } from "./uploads";
import { SIGN_IN_TEXT_DEFAULTS, asFocus, asSide, type SignInText } from "./sign-in-text";

/** The widths the artwork is stored at; the page picks one per screen with srcset. */
export const ART_WIDTHS = [960, 1600, 2560] as const;
export type ArtWidth = (typeof ART_WIDTHS)[number];

/** Uploads above this are refused before they are read (a phone photo fits). */
export const ART_MAX_BYTES = 15 * 1024 * 1024;
/** The smallest artwork accepted, after the camera's rotation is applied. */
export const ART_MIN = { width: 1280, height: 720 } as const;

const KEY = {
  files: "sign_in_art_files",
  version: "sign_in_art_version",
  color: "sign_in_art_color",
  placeholder: "sign_in_art_placeholder",
  size: "sign_in_art_size",
} as const;

/** The admin's text and layout choices for the page (lib/sign-in-text). */
const TEXT_KEY = {
  headline: "sign_in_headline",
  tagline: "sign_in_tagline",
  caption: "sign_in_caption",
  help: "sign_in_help",
  help_url: "sign_in_help_url",
  example: "sign_in_example",
  focus: "sign_in_art_focus",
  side: "sign_in_side",
  show_text: "sign_in_art_text",
} as const;

export interface SignInArt {
  /** Changes with every upload; part of every URL. */
  version: string;
  /** "#rrggbb": the picture's average colour, painted while it loads. */
  color: string;
  /** A ~20px-wide blurred WebP as a data: URL. */
  placeholder: string;
  /** `src` (the middle width) and `srcSet` for an <img>. */
  src: string;
  srcSet: string;
  /** The stored image's size in pixels (the largest copy's source). */
  width: number;
  height: number;
}

/** Everything the sign-in page shows that an admin chose. */
export interface SignInLook extends SignInText {
  art: SignInArt | null;
  /** The name and headline are drawn on the cover: always on the default art, the admin's choice over a photo. */
  showText: boolean;
}

export class ArtworkError extends Error {}

function artUrl(width: ArtWidth, version: string): string {
  return `/api/brand/artwork?w=${width}&v=${version}`;
}

/** The stored artwork, or null when none is set (or its files are gone, as after a database-only restore). */
export async function getSignInArt(): Promise<SignInArt | null> {
  const [files, version, color, placeholder, size] = await Promise.all([
    getSetting(KEY.files),
    getSetting(KEY.version),
    getSetting(KEY.color),
    getSetting(KEY.placeholder),
    getSetting(KEY.size),
  ]);
  const map = parseFiles(files);
  if (!map || !version) return null;
  if (!(await uploadExists(map[1600]))) return null;
  const [w, h] = (size ?? "").split("x").map(Number);
  return {
    width: Number.isFinite(w) && w > 0 ? w : 0,
    height: Number.isFinite(h) && h > 0 ? h : 0,
    version,
    color: /^#[0-9a-f]{6}$/.test(color ?? "") ? color! : "#334155",
    placeholder: (placeholder ?? "").startsWith("data:image/webp;base64,") ? placeholder! : "",
    src: artUrl(1600, version),
    srcSet: ART_WIDTHS.map((w) => `${artUrl(w, version)} ${w}w`).join(", "),
  };
}

function parseFiles(raw: string | undefined): Record<ArtWidth, string> | null {
  try {
    const v = JSON.parse(raw ?? "");
    if (v && ART_WIDTHS.every((w) => typeof v[w] === "string")) return v;
  } catch {}
  return null;
}

/** The stored file for a requested width: the smallest stored width at least that wide, else the largest. */
export async function artFileFor(width: number): Promise<string | null> {
  const map = parseFiles(await getSetting(KEY.files));
  if (!map) return null;
  const w = ART_WIDTHS.find((x) => x >= width) ?? ART_WIDTHS[ART_WIDTHS.length - 1];
  return map[w];
}

/** Re-encode an upload and make it the artwork. Throws ArtworkError with a sentence for the admin. */
export async function storeSignInArt(input: Buffer): Promise<SignInArt> {
  if (input.length === 0) throw new ArtworkError("The file is empty.");
  if (input.length > ART_MAX_BYTES) throw new ArtworkError("Artwork is limited to 15 MB.");
  if (!sniffImage(input)) throw new ArtworkError("Use a JPEG, PNG, WebP or GIF image.");
  let encoded: Buffer[];
  let placeholder: Buffer;
  let color: string;
  let width = 0;
  let height = 0;
  try {
    const base = sharp(input, { failOn: "none", animated: false }).rotate();
    const meta = await base.metadata();
    // The size as shown: a phone photo stored sideways is rotated by EXIF.
    const shown = meta.autoOrient ?? { width: meta.width ?? 0, height: meta.height ?? 0 };
    width = shown.width;
    height = shown.height;
    if (width < ART_MIN.width || height < ART_MIN.height) {
      throw new ArtworkError(
        `That image is ${width} × ${height} pixels. Use one at least ${ART_MIN.width} pixels wide and ${ART_MIN.height} pixels tall.`
      );
    }
    encoded = await Promise.all(
      ART_WIDTHS.map((w) => base.clone().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer())
    );
    placeholder = await base.clone().resize({ width: 20 }).blur(1).webp({ quality: 40 }).toBuffer();
    const { channels } = await base.clone().resize({ width: 32 }).stats();
    const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
    color = `#${hex(channels[0].mean)}${hex(channels[1]?.mean ?? channels[0].mean)}${hex(channels[2]?.mean ?? channels[0].mean)}`;
  } catch (e) {
    if (e instanceof ArtworkError) throw e;
    throw new ArtworkError("That image could not be read. Try saving it as a JPEG or PNG.");
  }
  const names = await Promise.all(encoded.map((b) => saveUpload(b, ".webp")));
  const files = Object.fromEntries(ART_WIDTHS.map((w, i) => [w, names[i]])) as Record<ArtWidth, string>;
  const before = parseFiles(await getSetting(KEY.files));
  const version = names[1].slice(0, 12);
  await setSetting(KEY.files, JSON.stringify(files));
  await setSetting(KEY.version, version);
  await setSetting(KEY.color, color);
  await setSetting(KEY.placeholder, `data:image/webp;base64,${placeholder.toString("base64")}`);
  await setSetting(KEY.size, `${width}x${height}`);
  if (before) await Promise.all(Object.values(before).map((n) => deleteUpload(n)));
  return (await getSignInArt())!;
}

/** Remove the artwork: the page goes back to the accent default. */
export async function removeSignInArt(): Promise<void> {
  const before = parseFiles(await getSetting(KEY.files));
  await Promise.all(Object.values(KEY).map((k) => setSetting(k, "")));
  if (before) await Promise.all(Object.values(before).map((n) => deleteUpload(n)));
}

/** The admin's text and layout choices, as stored (normalised on save). */
export async function getSignInText(): Promise<SignInText> {
  const keys = Object.keys(TEXT_KEY) as (keyof typeof TEXT_KEY)[];
  const values = await Promise.all(keys.map((k) => getSetting(TEXT_KEY[k])));
  const raw = Object.fromEntries(keys.map((k, i) => [k, values[i] ?? ""])) as Record<keyof typeof TEXT_KEY, string>;
  return {
    headline: raw.headline,
    tagline: raw.tagline,
    caption: raw.caption,
    help: raw.help,
    help_url: raw.help_url,
    example: raw.example,
    focus: asFocus(raw.focus || SIGN_IN_TEXT_DEFAULTS.focus),
    side: asSide(raw.side),
    show_text: raw.show_text !== "0",
  };
}

/** Store the admin's text and layout choices (already parsed by parseSignInText). */
export async function saveSignInText(value: SignInText): Promise<void> {
  await Promise.all([
    setSetting(TEXT_KEY.headline, value.headline),
    setSetting(TEXT_KEY.tagline, value.tagline),
    setSetting(TEXT_KEY.caption, value.caption),
    setSetting(TEXT_KEY.help, value.help),
    setSetting(TEXT_KEY.help_url, value.help_url),
    setSetting(TEXT_KEY.example, value.example),
    setSetting(TEXT_KEY.focus, value.focus),
    setSetting(TEXT_KEY.side, value.side),
    setSetting(TEXT_KEY.show_text, value.show_text ? "1" : "0"),
  ]);
}

/** The artwork and the admin's choices together: what AuthShell renders. */
export async function getSignInLook(): Promise<SignInLook> {
  const [art, text] = await Promise.all([getSignInArt(), getSignInText()]);
  return { ...text, art, showText: !art || text.show_text };
}
