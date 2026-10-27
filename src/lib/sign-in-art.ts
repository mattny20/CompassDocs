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

/** The widths the artwork is stored at; the page picks one per screen with srcset. */
export const ART_WIDTHS = [960, 1600, 2560] as const;
export type ArtWidth = (typeof ART_WIDTHS)[number];

/** Uploads above this are refused before they are read (a phone photo fits). */
export const ART_MAX_BYTES = 15 * 1024 * 1024;

const KEY = {
  files: "sign_in_art_files",
  version: "sign_in_art_version",
  color: "sign_in_art_color",
  placeholder: "sign_in_art_placeholder",
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
}

export class ArtworkError extends Error {}

function artUrl(width: ArtWidth, version: string): string {
  return `/api/brand/artwork?w=${width}&v=${version}`;
}

/** The stored artwork, or null when none is set (or its files are gone, as after a database-only restore). */
export async function getSignInArt(): Promise<SignInArt | null> {
  const [files, version, color, placeholder] = await Promise.all([
    getSetting(KEY.files),
    getSetting(KEY.version),
    getSetting(KEY.color),
    getSetting(KEY.placeholder),
  ]);
  const map = parseFiles(files);
  if (!map || !version) return null;
  if (!(await uploadExists(map[1600]))) return null;
  return {
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
  if (!sniffImage(input)) throw new ArtworkError("Use a PNG, JPEG, WebP or GIF image.");
  let encoded: Buffer[];
  let placeholder: Buffer;
  let color: string;
  try {
    const base = sharp(input, { failOn: "none", animated: false }).rotate();
    const meta = await base.metadata();
    if ((meta.width ?? 0) < 640 || (meta.height ?? 0) < 480) {
      throw new ArtworkError("The image is too small: use one at least 1600 pixels wide.");
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
  if (before) await Promise.all(Object.values(before).map((n) => deleteUpload(n)));
  return (await getSignInArt())!;
}

/** Remove the artwork: the page goes back to the accent default. */
export async function removeSignInArt(): Promise<void> {
  const before = parseFiles(await getSetting(KEY.files));
  await Promise.all(Object.values(KEY).map((k) => setSetting(k, "")));
  if (before) await Promise.all(Object.values(before).map((n) => deleteUpload(n)));
}
